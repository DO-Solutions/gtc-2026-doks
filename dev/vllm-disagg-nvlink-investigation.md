# vLLM Disaggregated Serving — NVLink KV Transfer Investigation

**Dates**: 2026-02-18 (Test 1), 2026-02-19 (Test 2)
**Cluster**: do-ams3-gtc-demo (DOKS, 1x gpu-h100x8-640gb node)
**Stack**: Dynamo 0.9.0, vLLM 0.14.1, NIXL 0.9.0, CUDA 12.9.1, Driver 575.57.08

## Goal

Test whether vLLM disaggregated serving can transfer KV cache over NVLink between
co-located worker pods on the same 8-GPU node.

## Background

### Disaggregated Serving

Standard LLM inference has two phases: **prefill** (processing the full input prompt,
compute-bound) and **decode** (generating tokens one at a time, memory-bandwidth-bound).
Disaggregated serving splits these into separate workers so each can be independently
scaled and optimized. After prefill completes, the KV cache must be transferred from
the prefill worker to the decode worker so it can continue generation.

### KV Transfer Chain

The transfer path is: **vLLM NixlConnector → NIXL → UCX → wire transport**

- **NixlConnector**: vLLM's connector class that interfaces with NIXL for KV cache
  movement between disaggregated workers.
- **NIXL**: NVIDIA's Inference Xfer Library. Abstracts data transfer across backends
  (UCX, GDS, POSIX). Uses **RMA (Remote Memory Access)** for KV cache data transfer.
- **UCX**: Unified Communication X. Selects wire transport based on peer locality
  detection. Compares network namespace identifiers to determine if peers are on the
  same host.
- **Wire transport**: `cuda_ipc` for same-host GPU-to-GPU (NVLink), `tcp` for
  cross-host or when locality detection fails.

### Why NVLink Matters

NVLink provides direct GPU-to-GPU memory bandwidth (900 GB/s on H100 NVSwitch) vs
TCP over the pod network (~25 Gbps = ~3.1 GB/s). For KV cache transfer of a 70B model
with long context, this is the difference between sub-millisecond and multi-millisecond
transfer latency.

## Architecture

**Manifest**: `k8s/dynamo/dev-disagg-vllm.yaml`

```
┌─────────────────────────────────────────────────┐
│           gpu-h100x8-640gb node                 │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Frontend │  │ Prefill  │  │ Decode   │      │
│  │ (mgmt)   │──│ Worker   │──│ Worker   │      │
│  └──────────┘  │ GPU(s)   │  │ GPU(s)   │      │
│                └──────────┘  └──────────┘      │
│                     │              │            │
│                     └──── NIXL ────┘            │
│                        KV transfer              │
└─────────────────────────────────────────────────┘
```

- **Test 1**: TP=4, Llama 70B FP8, standard pod networking
- **Test 2**: TP=1, Llama 8B FP8, hostNetwork mode (fast iteration)

Both configurations: 1 Frontend, 1 Prefill worker (`--is-prefill-worker`), 1 Decode
worker, NIXL connector with UCX backend.

## Baseline: Disaggregated Serving Works

The disagg pipeline is fully functional. Request flow confirmed via logs:

**Prefill worker** receives request, computes prefill, returns KV transfer params:
```
Prefill Request ID: 8af82813-af98-4385-8aa5-ae3ae7792b1b
kv transfer params: {
  'do_remote_prefill': True,
  'do_remote_decode': False,
  'remote_block_ids': [1, 2, 3],
  'remote_engine_id': 'ea09adda-a2c2-48b2-9c48-caa380204944',
  'remote_host': '172.16.17.59',
  'remote_port': 5600,
  'tp_size': 4
}
Prefill completed for request 8af82813: generated 1 token(s), has_kv_params=True
```

**Decode worker** receives KV state and generates tokens:
```
Decode Request ID: 8af82813-af98-4385-8aa5-ae3ae7792b1b
Using disaggregated params from prefill for request 8af82813
NIXL compatibility check passed (hash: fa900ca5d0acf65048b1c3ab7339c958a07da4781ed870bdaa55375f21004794)
Completed token generation for request 8af82813: 32 output tokens, finish_reason=stop
```

NIXL loaded these backend plugins:
```
Discovered and loaded backend plugin: OBJ
Discovered and loaded backend plugin: UCX
Discovered and loaded backend plugin: GDS
Discovered and loaded backend plugin: GDS_MT
Discovered and loaded backend plugin: POSIX
```

`ucx_info -d` confirms `cuda_ipc` is compiled in and available:
```
# Memory domain: cuda_ipc
#     Component: cuda_ipc
#      Transport: cuda_ipc
#         Device: cuda
```

---

## Test 1: Default Pod Networking (2026-02-18)

**Configuration**: TP=4, Llama 70B FP8, standard K8s pod network namespaces (no
hostNetwork).

### Evidence 1a: TCP Connections Between Pods

From the decode worker pod (`172.16.17.11`), `/proc/net/tcp` shows ~20 established
TCP connections to the prefill worker (`172.16.17.59` = hex `3B1110AC`):

```
$ cat /proc/net/tcp | grep "3B1110AC"
  99: 0B1110AC:BD61 3B1110AC:92EF 01 ...
 120: 0B1110AC:DF73 3B1110AC:BD95 01 ...
 125: 0B1110AC:C1A3 3B1110AC:D0BF 01 ...
 142: 0B1110AC:E105 3B1110AC:92EF 01 ...
 ... (20+ connections)
```

If NVLink/cuda_ipc were used for the data path, only 1-2 NIXL side-channel TCP
connections would exist. The ~20 connections correspond to 4 TP ranks × multiple UCX
endpoints (each rank has its own connection set).

### Evidence 1b: NVLink Counter Delta (TP Traffic Only)

NVLink hardware counters on the decode worker show traffic consistent with TP=4
NCCL all-reduce only.

**Methodology:**
- Pod: `gtc-demo-0-vllmdecodeworker-9sm94` (decode worker, IP `172.16.17.11`)
- GPU: GPU 0 (NVIDIA H100 80GB HBM3, UUID `GPU-d2916751-...`)
- Command: `nvidia-smi nvlink -gt d -i 0`
- Procedure: Snapshot before, send 5 requests, snapshot after
- Note: `nvidia-smi nvlink -r 0` (counter reset) is deprecated on driver 575.57.08

**Results (Link 0):**
```
Before: Tx: 35,008,038,772 KiB  Rx: 34,474,160,897 KiB
After:  Tx: 35,008,709,165 KiB  Rx: 34,474,866,191 KiB
Delta:  Tx:       670,393 KiB  Rx:       705,294 KiB  (~1.3 GiB total)
```

The ~1.3 GiB delta is consistent with TP=4 NCCL all-reduce traffic within the decode
pod (GPUs 0-3 communicating during forward passes). KV cache bulk transfer from prefill
(GPUs 4-7) to decode (GPUs 0-3) would produce significantly larger deltas. The 18
NVLink sub-links per GPU include physical links to GPUs 4-7 (in the prefill pod), but
those links carry no KV transfer traffic.

### Evidence 1c: Network Namespace Isolation

Each pod has its own network namespace:
```
Decode worker:  net:[4026537732]
Prefill worker: (separate namespace)
```

UCX determines peer locality by comparing network namespace identifiers. Pods in
separate namespaces are classified as **remote** even when on the same physical node.
This prevents UCX from selecting `cuda_ipc`, which requires same-host detection.

### Test 1 Conclusion

KV transfer uses TCP. K8s network namespace isolation causes UCX to classify co-located
pods as remote hosts, preventing selection of the `cuda_ipc` transport that would use
NVLink.

---

## Test 2: hostNetwork Mode (2026-02-19)

**Hypothesis**: `hostNetwork: true` puts both pods in the host's network namespace,
so UCX should detect same-host locality and select cuda_ipc → NVLink.

**Configuration**: TP=1, Llama 8B FP8 (fast iteration), with:
- `hostNetwork: true` — shared host network namespace
- `hostIPC: true` — shared IPC namespace (shared memory for cuda_ipc)
- `shareProcessNamespace: true` — shared PID namespace
- `dnsPolicy: ClusterFirstWithHostNet` — required for K8s DNS resolution with hostNetwork

### Deployment Issues Encountered

Three issues required workarounds before the hostNetwork test could proceed.

#### 1. Cilium CNI Port Conflict

Cilium (the DOKS CNI) uses **hostPort 9090** for its Prometheus metrics endpoint on
every node. Dynamo's default system port is also 9090. With hostNetwork, both workers
tried to bind 9090 on the host, conflicting with Cilium.

**Fix**: Offset system ports — decode worker uses 9092, prefill worker uses 9091.
Set via `DYN_SYSTEM_PORT` env var and matching probe ports.

#### 2. Operator Hardcodes containerPort

The Dynamo operator injects `containerPort: 9090, hostPort: 9090` into worker pods
regardless of the `DYN_SYSTEM_PORT` environment variable.

**Fix**: Override via `mainContainer.ports` in the DGD spec with explicit port numbers:
```yaml
mainContainer:
  ports:
    - containerPort: 9092
      hostPort: 9092
      name: system
      protocol: TCP
```

#### 3. Public IP Registration

With hostNetwork, workers register with `eth0`'s public IP (`164.92.214.18`) instead
of `eth1`'s VPC IP (`10.200.16.5`). The frontend can't reach public IPs on ephemeral
ports.

DOKS node network layout:
```
eth0:   164.92.214.18  (public IP)
eth1:   10.200.16.5    (VPC IP)
anchor: 10.18.0.11     (anchor IP)
```

**Fix**: Set `DYN_TCP_RPC_HOST` env via Kubernetes downward API:
```yaml
env:
  - name: DYN_TCP_RPC_HOST
    valueFrom:
      fieldRef:
        fieldPath: status.podIP
```

On DOKS, `status.podIP` returns the VPC IP (eth1) even with hostNetwork.

### Evidence 2a: Locality Detection Fixed

Both pods share network namespace inode `4026531840`:
```
Decode net ns:
  File: /proc/self/ns/net
  Inode: 4026531840

Prefill net ns:
  File: /proc/self/ns/net
  Inode: 4026531840
```

Identical inodes confirm both pods are in the host's network namespace.

### Evidence 2b: UCX Transport Selection

UCX log from decode worker (with `UCX_LOG_LEVEL=info`):
```
ucp_context_0 intra-node cfg#2
  rma_am(tcp/cilium_host)
  amo_am(tcp/cilium_host)
  am(tcp/cilium_host tcp/anchor tcp/cpbridge tcp/eth1 tcp/lo tcp/eth0 cuda_ipc/cuda)
  ka(tcp/cilium_host)
```

Key observations:
- **`intra-node`** — UCX correctly classifies pods as same-host (was inter-node in
  Test 1)
- **`cuda_ipc/cuda` in the AM transport list** — cuda_ipc is available for Active
  Messages
- **`rma_am(tcp/cilium_host)`** — the RMA data path (used by NIXL for KV transfer)
  still selects TCP

### Evidence 2c: NVLink Counter Delta = Zero

Before and after a test request on the decode worker's GPU:
```
Before:  Link 0: Tx: 34,915,667,801 KiB  Rx: 34,649,166,071 KiB
After:   Link 0: Tx: 34,915,667,801 KiB  Rx: 34,649,166,071 KiB
Delta:   Tx: 0 KiB  Rx: 0 KiB
```

With TP=1, there is zero NCCL all-reduce baseline — any NVLink traffic would come
exclusively from KV transfer. None was observed.

### Evidence 2d: Disagg Pipeline Functional

Test request via frontend succeeded:
```
$ curl -s http://localhost:8888/v1/chat/completions -d '{"model":"/models/nvidia/Llama-3.1-8B-Instruct-FP8","messages":[{"role":"user","content":"What is 2+2?"}]}'
{"id":"chatcmpl-0230eeb7-...","choices":[{"message":{"content":"2 + 2 = 4","role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":19,"completion_tokens":8,"total_tokens":27}}
```

Prefill worker logs confirm KV transfer:
```
NixlConnector setting KV cache layout to HND for better xfer performance.
kv transfer params: {
  'do_remote_prefill': True,
  'do_remote_decode': False,
  'remote_block_ids': [1, 2],
  'remote_engine_id': 'bc8784aa-6f8e-453d-acaf-de1fd8fe6104',
  'remote_host': '127.0.1.1',
  'remote_port': 5601,
  'tp_size': 1
}
```

Workers register on VPC IP `10.200.16.5` (after `DYN_TCP_RPC_HOST` fix).

### Test 2 Conclusion

hostNetwork fixes UCX locality detection and makes `cuda_ipc` available in the AM
transport list, but the RMA path (used by NIXL for KV data transfer) still falls
back to TCP.

---

## Root Cause Analysis

### Why Test 1 Failed

K8s assigns each pod its own network namespace. UCX detects peer locality by comparing
network namespace identifiers. Since prefill and decode pods have different namespaces,
UCX classifies them as remote hosts and selects TCP for all transports.

### Why Test 2 Partially Succeeded

`hostNetwork: true` puts both pods in the host's network namespace. UCX correctly
detects intra-node locality. `cuda_ipc/cuda` appears in the Active Messages (AM)
transport list — this is progress.

### Why Test 2 Still Uses TCP for KV Data

UCX's `cuda_ipc` transport implements **Active Messages (AM) only** — it does **not**
implement **Remote Memory Access (RMA)**. NIXL uses RMA (`rma_am`) for KV cache data
transfer. Since `cuda_ipc` is not an RMA-capable transport, UCX falls back to
TCP-emulated RMA (`rma_am(tcp/cilium_host)`) even for intra-node transfers.

**Transport capability matrix:**

| Transport  | AM  | RMA  | Used by NIXL for KV data?                     |
|------------|-----|------|-----------------------------------------------|
| tcp        | Yes | Yes* | Yes (via `rma_am` = RMA emulated over AM)     |
| cuda_ipc   | Yes | No   | No (cannot do RMA)                            |

\* TCP's RMA support is emulated over Active Messages, not native RDMA.

---

## Conclusion

NVLink-based KV transfer between disaggregated vLLM workers is **not achievable** with
the current NIXL + UCX architecture, even with hostNetwork. The limitation is
fundamental:

1. `hostNetwork` is **necessary** for UCX to detect co-location (fixes locality check)
2. `hostNetwork` is **not sufficient** because NIXL uses RMA for KV data, and UCX's
   `cuda_ipc` transport does not support RMA

Achieving NVLink KV transfer would require one of:
- **NIXL changes** to use AM-based transfer instead of RMA (would enable cuda_ipc)
- **New UCX transport** that supports RMA over CUDA IPC
- **Direct CUDA IPC bypass** in the vLLM NixlConnector that skips UCX RMA entirely
- **Single pod** with both workers (eliminates cross-pod transfer, but loses DGD
  orchestration)

For now, the KV transfer path remains: **vLLM → NIXL → UCX → TCP** regardless of
host namespace sharing.

---

## DOKS-Specific Reference

Findings specific to DigitalOcean Kubernetes that may help future investigations:

| Item                              | Detail                                                              |
|-----------------------------------|---------------------------------------------------------------------|
| Node network layout               | eth0=public IP, eth1=VPC IP, anchor=anchor IP                       |
| Cilium CNI                        | Uses hostPort 9090 for Prometheus on all nodes                      |
| `status.podIP` with hostNetwork   | Returns VPC IP (eth1) on DOKS                                       |
| `DYN_TCP_RPC_HOST`                | Dynamo env var controlling TCP RPC advertise address                 |
| `mainContainer.ports`             | Overrides operator's hardcoded containerPort in DGD spec            |
| `dnsPolicy`                       | Must be `ClusterFirstWithHostNet` for K8s service DNS with hostNet  |
