# Why KV Cache Transfer Cannot Use NVLink (NIXL + UCX on Kubernetes)

## Summary

NVIDIA's inference transfer library (NIXL) uses UCX's Remote Memory Access (RMA) API to move KV cache data between disaggregated prefill and decode workers. UCX's `cuda_ipc` transport — the only path to NVLink — does not implement RMA. UCX therefore falls back to TCP for all KV data, routing every byte through host memory staging buffers and the PCIe bus, even when prefill and decode GPUs share a 900 GB/s NVLink interconnect on the same physical node.

On systems with RDMA hardware (RoCE or InfiniBand), NVLink **does** get used — but not because the RDMA NIC carries GPU data. The RDMA transport satisfies UCX's lane selection prerequisites, which unlocks `cuda_ipc` as a bulk data lane. Without RDMA, that prerequisite is never met and `cuda_ipc` sits unused. The RDMA hardware acts as a "key" that lets NVLink do the actual work.

This is not a configuration problem. It is an architectural mismatch between NIXL's transfer API and UCX's transport capability model. Our DOKS cluster has Ethernet NICs but no RoCE configuration, so NVLink remains locked out.

---

## The Core Problem

```
NIXL KV Transfer Call
    │
    ▼
ucp_put_nbx() / ucp_get_nbx()         ← RMA API
    │
    ▼
UCX Wireup: select transport for RMA
    │
    ├─ cuda_ipc?  Has PUT_ZCOPY + GET_ZCOPY only
    │              Needs PUT_SHORT or AM_BCOPY → ❌ REJECTED
    │
    └─ tcp?       Has AM_BCOPY → ✅ rma_am(tcp) selected
                       │
                       ▼
              GPU → PCIe → Host RAM → TCP → Host RAM → PCIe → GPU
              (NVLink bandwidth: 900 GB/s — completely unused)
```

The transport capability matrix explains why:

| Transport  | Active Messages (AM) | Remote Memory Access (RMA) | Used by NIXL for KV data? |
|------------|---------------------|---------------------------|---------------------------|
| `tcp`      | Yes                 | Yes (emulated via AM)     | **Yes** — `rma_am(tcp/...)` |
| `cuda_ipc` | Yes                 | **No**                    | **No** — excluded from RMA lanes |

The cruel detail: `cuda_ipc` **can** perform direct GPU-to-GPU copies via `cuMemcpyDtoDAsync()` over NVLink. UCX's protocol layer just never asks it to, because the transport lacks the capability flags that the RMA lane selection algorithm requires.

---

## Why This Happens: The UCT-UCP Layer Gap

### UCX's Two-Layer Architecture

UCX has two layers: **UCT** (transport) and **UCP** (protocol). UCT transports advertise capability flags. UCP's wireup algorithm selects transports for communication lanes based on those flags.

`cuda_ipc` at the UCT level implements `cuMemcpyDtoDAsync()` — a direct device-to-device copy that uses NVLink when available. But its capability flags are deliberately minimal:

```c
// cuda_ipc_iface.c:278-283
iface_attr->cap.flags = UCT_IFACE_FLAG_PUT_ZCOPY |
                        UCT_IFACE_FLAG_GET_ZCOPY |
                        UCT_IFACE_FLAG_CONNECT_TO_IFACE |
                        UCT_IFACE_FLAG_PENDING |
                        UCT_IFACE_FLAG_ERRHANDLE_PEER_FAILURE |
                        UCT_IFACE_FLAG_DEVICE_EP;
```

Zero AM capabilities (`AM_SHORT`, `AM_BCOPY`, `AM_ZCOPY`). Zero short/bcopy RMA capabilities (`PUT_SHORT`, `PUT_BCOPY`, `GET_BCOPY`). Only zcopy PUT and GET.

### The Three-Gate Filter

When NIXL calls `ucp_put_nbx()`, UCP's wireup evaluates transports through three gates. `cuda_ipc` fails at every one:

| Gate | Required Capability | cuda_ipc Has It? | Consequence |
|------|-------------------|-------------------|-------------|
| **Native RMA lane** | `PUT_SHORT` + `PUT_BCOPY` + `GET_BCOPY` | No (only zcopy) | Cannot be RMA lane |
| **AM-emulated RMA** (`rma_am`) | `AM_BCOPY` minimum | No (no AM at all) | Cannot participate in rma_am |
| **RMA_BW lane** (zcopy bulk) | `PUT_ZCOPY` or `GET_ZCOPY` | **Yes** — has both | Qualifies, but... |

That third gate is the cruelest detail. `cuda_ipc` qualifies for **RMA_BW lanes** (bandwidth-optimized lanes for large zero-copy transfers), but RMA_BW lanes are only allocated when a native RMA lane already exists. Without RDMA hardware (RoCE or InfiniBand), no native RMA lane can be established — TCP itself lacks `PUT_SHORT` — so wireup falls back to `rma_am` emulation and **never allocates RMA_BW lanes**.

### Why cuda_ipc Appears in the AM Lane But Cannot Help RMA

The UCX wireup log from our decode worker shows:

```
ucp_context_0 intra-node cfg#2
  rma_am(tcp/cilium_host)                                          ← All RMA via TCP
  amo_am(tcp/cilium_host)                                          ← All atomics via TCP
  am(tcp/cilium_host tcp/anchor tcp/cpbridge tcp/eth1 tcp/lo tcp/eth0 cuda_ipc/cuda)
  ka(tcp/cilium_host)                                              ← Keepalive on TCP
```

`cuda_ipc/cuda` is in the `am()` lane list. This means it participates in the **AM rendezvous data path** — when large Active Messages are sent via `ucp_am_send_nbx()`, the rendezvous protocol uses TCP for control (RTS/RTR headers) and `cuda_ipc`'s `put_zcopy`/`get_zcopy` for bulk data over NVLink.

If NIXL used `ucp_am_send_nbx()` instead of `ucp_put_nbx()`, `cuda_ipc` **would** carry KV data over NVLink. But NIXL's architecture is built around one-sided RMA semantics — `ucp_mem_map()` → `ucp_rkey_pack()` → `ucp_put_nbx()`/`ucp_get_nbx()` — and that path never triggers the AM rendezvous code where `cuda_ipc` participates.

### The Actual Data Path

For CUDA source memory, the `rma_am` pipeline becomes:

```
Source GPU → cuda_copy → Host staging buffer → TCP AM_BCOPY →
  Remote host staging buffer → cuda_copy → Destination GPU
```

Every byte of KV cache data crosses the PCIe bus twice (GPU→host, host→GPU) and traverses TCP — even when source and destination GPUs share NVLink on the same physical node. The theoretical NVLink bandwidth (900 GB/s bidirectional on H100 NVSwitch) goes entirely unused. TCP throughput on loopback is typically 10–30 GB/s at best.

### How RDMA Hardware Unlocks NVLink

The mechanism is somewhat ironic. RDMA hardware (RoCE or InfiniBand) wouldn't carry the actual GPU-to-GPU KV data for intra-node transfers. It just satisfies the wireup's prerequisite that unlocks the lane where `cuda_ipc` does.

Here's the chain:

1. RDMA verbs (`rc_mlx5`) advertise the full RMA capability set — `PUT_SHORT`, `PUT_BCOPY`, `PUT_ZCOPY`, `GET_BCOPY`, `GET_ZCOPY` — passing all three gates in `select.c`
2. Wireup creates a **native RMA lane** on the RDMA transport
3. With that lane established, wireup proceeds to allocate **RMA_BW lanes** for bandwidth-optimized bulk transfers
4. `cuda_ipc` qualifies for RMA_BW (has `PUT_ZCOPY`/`GET_ZCOPY`)
5. Proto v2 evaluates protocols for `(PUT, CUDA_memory, large_message_size)` and selects `cuda_ipc`'s `put_zcopy` on the RMA_BW lane — which calls `cuMemcpyDtoDAsync` and routes over NVLink

The wireup log on a node **with** RDMA hardware would look like:

```
ucp_context_0 intra-node cfg#X
  rma(rc_mlx5/mlx5_0:1)              ← Native RMA lane on RDMA (the "key")
  rma_bw(cuda_ipc/cuda)              ← Bulk RMA lane on cuda_ipc (NVLink!)
  am(rc_mlx5/mlx5_0:1 cuda_ipc/cuda)
  ka(rc_mlx5/mlx5_0:1)
```

Compare that to what we observe **without** RDMA:

```
ucp_context_0 intra-node cfg#2
  rma_am(tcp/cilium_host)             ← No native RMA lane, AM fallback on TCP
  am(tcp/cilium_host ... cuda_ipc/cuda)
  ka(tcp/cilium_host)
```

The `rma_bw(cuda_ipc/cuda)` line is the one that's missing — and it can only appear when `rma(...)` (not `rma_am(...)`) exists above it.

The RDMA lane essentially acts as the **control plane** for RMA — handling small messages, key exchanges, and protocol negotiation via `PUT_SHORT`/`PUT_BCOPY` — while `cuda_ipc` serves as the **data plane** for large zero-copy GPU transfers. For inter-node transfers (prefill on node A, decode on node B), RDMA would carry the actual data via GPUDirect RDMA. But for intra-node, `cuda_ipc` takes over for large payloads and the RDMA transport just needs to **exist** to satisfy the lane allocator.

This is why the LMCache 99 GB/s benchmark almost certainly ran on DGX or HGX systems with both NVLink and RDMA NICs — not because the RDMA NIC was fast enough for that throughput (ConnectX-7 tops out around 50 GB/s), but because its presence was the prerequisite that let `cuda_ipc` do the actual work over NVLink.

### UCX FAQ Acknowledgment

UCX's own [FAQ](https://openucx.readthedocs.io/en/master/faq.html) acknowledges this plainly:

> "Remote memory access APIs, including atomic operations, have an incomplete support for GPU memory; the full support is planned for future releases."

### UCX v1.19/v1.20 Device API Changes

UCX versions 1.19.0 and 1.20.0 introduced changes targeting this problem:

- "Added device API implementation for CUDA_IPC transport"
- "Added device put multi, put partial, and atomic operations for CUDA_IPC"
- "Fixed CUDA IPC RMA operations by using correct context for local buffers"
- "Added new GPU device API for direct GPU-to-GPU communication" (v1.20)
- "Added GDAKI transport with endpoint export to GPU" (v1.20)

Our test environment runs UCX 1.20.0, and the device API changes did not resolve the standard RMA path for KV transfer. The device API appears targeted at MoE (Mixture of Experts) workloads with GPU-initiated transfers, which is architecturally distinct from the CPU-initiated KV cache RMA transfers in disaggregated serving.

### UCX GitHub Issues

Multiple upstream issues document this behavior:

- [Issue #3123](https://github.com/openucx/ucx/issues/3123) — "Question - using RMA with shared memory transports": shows `"cma/cma - no put short, knem/knem - no put short"` during RMA lane selection
- [Issue #3156](https://github.com/openucx/ucx/issues/3156) — "Question: cannot get cuda_ipc to work": directly demonstrates `"cuda_ipc/cudaipc0 does not support operation put short"`
- [Issue #6124](https://github.com/openucx/ucx/issues/6124) — shows `"tcp/eth0 - no put short"` in RMA lane selection
- [Issue #7912](https://github.com/openucx/ucx/issues/7912) — "Can I expect `ucp_{get,put}_nb()` to work on GPU memory?": proto v1 would `memcpy()` on device pointers causing segfaults; proto v2 fixes the crash but still routes through TCP
- [Discussion #9896](https://github.com/openucx/ucx/discussions/9896) — "How to use nvlink in ucx": UCX maintainer confirms `cuda_ipc`'s `put_zcopy` calls `cuMemcpyDtoDAsync` and routes over NVLink, but this describes UCT-level and AM rendezvous paths — not the UCP RMA path NIXL uses

The more fundamental lane allocation problem — RMA_BW lanes not being created without a native RMA lane from RDMA hardware — appears untracked in any upstream issue.

---

## Experimental Results

### Test Environment

| Component | Version/Detail |
|-----------|---------------|
| Cluster | DOKS `do-ams3-gtc-demo`, 1x `gpu-h100x8-640gb` node (8x H100 80GB, NVSwitch) |
| Model | Llama 3.1 8B Instruct FP8 (`nvidia/Llama-3.1-8B-Instruct-FP8`) |
| Tensor Parallelism | TP=1 (single GPU per worker — eliminates NCCL all-reduce baseline) |
| Dynamo | 0.9.0 |
| vLLM | 0.14.1 |
| NIXL | 0.9.0 (git: 2d475e4a) |
| UCX | 1.20.0 |
| CUDA | 12.9.1 |
| Driver | 575.57.08 |
| Network mode | `hostNetwork: true` + `hostIPC: true` + `shareProcessNamespace: true` |

Architecture: 1 Frontend + 1 Prefill Worker (GPU 1) + 1 Decode Worker (GPU 0), NIXL connector with UCX backend.

### Evidence 1: Network Namespace Sharing Confirmed

Both pods share the host's network namespace (identical inode):

```
Decode worker:   /proc/self/ns/net  Inode: 4026531840
Prefill worker:  /proc/self/ns/net  Inode: 4026531840
```

UCX correctly classifies the connection as **intra-node** (was inter-node without hostNetwork).

### Evidence 2: UCX Transport Selection

UCX wireup log from the decode worker (`UCX_LOG_LEVEL=info`):

```
ucp_context_0 intra-node cfg#2
  rma_am(tcp/cilium_host)
  amo_am(tcp/cilium_host)
  am(tcp/cilium_host tcp/anchor tcp/cpbridge tcp/eth1 tcp/lo tcp/eth0 cuda_ipc/cuda)
  ka(tcp/cilium_host)
```

Key observations:
- **`intra-node`** — UCX correctly detects co-location
- **`cuda_ipc/cuda` in AM lane** — transport is available and reachable
- **`rma_am(tcp/cilium_host)`** — RMA data path (used by NIXL) selects TCP, not cuda_ipc

### Evidence 3: NVLink Counter Delta = 0

NVLink hardware counters on the decode worker's GPU 0 before and after 10 disaggregated serving requests (each generating ~200 tokens):

**Before test (all 18 sub-links):**
```
Link  0: Tx: 34,915,667,801 KiB  Rx: 34,649,166,071 KiB
Link  1: Tx: 34,915,281,383 KiB  Rx: 34,649,330,140 KiB
Link  2: Tx: 34,458,202,430 KiB  Rx: 34,728,942,914 KiB
Link  3: Tx: 34,459,453,652 KiB  Rx: 34,965,060,744 KiB
Link  4: Tx: 34,677,382,221 KiB  Rx: 34,758,376,024 KiB
Link  5: Tx: 34,676,994,559 KiB  Rx: 34,758,628,186 KiB
Link  6: Tx: 34,692,878,479 KiB  Rx: 34,742,457,585 KiB
Link  7: Tx: 34,693,244,255 KiB  Rx: 34,742,416,045 KiB
Link  8: Tx: 34,934,700,388 KiB  Rx: 34,734,449,102 KiB
Link  9: Tx: 34,933,938,312 KiB  Rx: 35,036,419,227 KiB
Link 10: Tx: 34,456,486,788 KiB  Rx: 34,696,185,645 KiB
Link 11: Tx: 34,458,414,102 KiB  Rx: 34,875,967,820 KiB
Link 12: Tx: 34,464,802,433 KiB  Rx: 34,173,503,461 KiB
Link 13: Tx: 34,464,591,258 KiB  Rx: 34,173,809,841 KiB
Link 14: Tx: 34,672,956,825 KiB  Rx: 34,639,615,894 KiB
Link 15: Tx: 34,676,081,722 KiB  Rx: 34,753,412,100 KiB
Link 16: Tx: 34,939,231,554 KiB  Rx: 34,676,199,998 KiB
Link 17: Tx: 34,939,570,438 KiB  Rx: 34,675,940,379 KiB
```

**After test (10 requests, ~2,000 tokens generated):**
```
All 18 links: identical values — Tx delta: 0 KiB, Rx delta: 0 KiB
```

With TP=1, there is zero NCCL all-reduce baseline. Any NVLink traffic would come exclusively from KV cache transfer. **None was observed across any of the 18 NVLink sub-links.**

The existing counter values (~34 TiB) are from prior model loading and NCCL operations during earlier tests. Counter reset (`nvidia-smi nvlink -r 0`) is deprecated on driver 575.57.08, so we rely on delta measurement — which shows exactly zero.

### Evidence 4: Disaggregated Pipeline Functional

The pipeline is working correctly. Requests flow through the full disagg path:

**Frontend response (request 1 of 10):**
```json
{
  "id": "chatcmpl-cfe8f011-cd4c-4277-9e6a-881f0d2b250e",
  "choices": [{
    "message": {"content": "Quantum computing is a new and exciting field...", "role": "assistant"},
    "finish_reason": "length"
  }],
  "usage": {"prompt_tokens": 19, "completion_tokens": 200, "total_tokens": 219}
}
```

**Prefill worker logs (KV transfer params for each request):**
```
kv transfer params: {
  'do_remote_prefill': True,
  'do_remote_decode': False,
  'remote_block_ids': [5, 6],
  'remote_engine_id': 'bc8784aa-6f8e-453d-acaf-de1fd8fe6104',
  'remote_host': '127.0.1.1',
  'remote_port': 5601,
  'tp_size': 1
}
```

All 10 requests completed with `do_remote_prefill: True`, confirming the decode worker received KV cache from the prefill worker via NIXL — it just traveled over TCP instead of NVLink.

---

## Source Code Analysis

### NIXL Uses RMA for KV Data Transfer

NIXL's UCX plugin exclusively uses RMA (Remote Memory Access) operations for bulk KV cache data transfer. Active Messages are used only for lightweight notifications.

| Evidence | Source |
|----------|--------|
| UCX context requests `UCP_FEATURE_RMA` as primary feature | [`ucx_utils.cpp:433`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L433) |
| KV data transfer calls `ucp_get_nbx()` (RMA GET) | [`ucx_utils.cpp:304`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L304) |
| KV data transfer calls `ucp_put_nbx()` (RMA PUT) | [`ucx_utils.cpp:330`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L330) |
| `RNDV_THRESH=inf` forces RMA for all payload sizes | [`ucx_utils.cpp:461`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L461) |
| GPU memory registered for RMA via `ucp_mem_map()` | [`ucx_utils.cpp:578`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L578) |
| Remote keys packed via `ucp_rkey_pack()` for RMA | [`ucx_utils.cpp:608`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp#L608) |
| `sendXferRangeBatch()` calls `ep.read()`/`ep.write()` (RMA) for actual KV transfer | [`ucx_backend.cpp:1205-1206`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_backend.cpp#L1205-L1206) |
| Active Messages used only for notifications, not data | [`ucx_backend.cpp:1501`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_backend.cpp#L1501) |

### UCX cuda_ipc Cannot Serve RMA

UCX's `cuda_ipc` transport only implements PUT/GET zcopy (which are `cuMemcpyDtoDAsync()` wrappers). It cannot participate in RMA lanes.

| Evidence | Source |
|----------|--------|
| cuda_ipc capability flags: only `PUT_ZCOPY` + `GET_ZCOPY`, no AM flags | [`cuda_ipc_iface.c:278-283`](https://github.com/openucx/ucx/blob/a2687d50/src/uct/cuda/cuda_ipc/cuda_ipc_iface.c#L278-L283) |
| cuda_ipc iface_ops: no `.ep_am_short`, `.ep_am_bcopy`, `.ep_am_zcopy` | [`cuda_ipc_iface.c:334`](https://github.com/openucx/ucx/blob/a2687d50/src/uct/cuda/cuda_ipc/cuda_ipc_iface.c#L334) |
| put/get zcopy are `cuMemcpyDtoDAsync()` wrappers, not one-sided RMA | [`cuda_ipc_ep.c:195-235`](https://github.com/openucx/ucx/blob/a2687d50/src/uct/cuda/cuda_ipc/cuda_ipc_ep.c#L195-L235) |
| TCP iface_ops includes all AM operations (contrast) | [`tcp_iface.c:539`](https://github.com/openucx/ucx/blob/a2687d50/src/uct/tcp/tcp_iface.c#L539) |

### UCX Lane Selection Excludes cuda_ipc for RMA

When NIXL calls `ucp_put_nbx()`/`ucp_get_nbx()`, UCX's wireup selects a lane for the RMA operation. `cuda_ipc` is excluded at every selection path:

| Evidence | Source |
|----------|--------|
| RMA lanes require `PUT_SHORT`/`PUT_BCOPY`/`GET_BCOPY` (cuda_ipc only has zcopy) | [`select.c:1173-1182`](https://github.com/openucx/ucx/blob/a2687d50/src/ucp/wireup/select.c#L1173-L1182) |
| AM-based RMA fallback (PUT) requires `AM_BCOPY` on `AM` lane type | [`put_am.c:111-113`](https://github.com/openucx/ucx/blob/a2687d50/src/ucp/rma/put_am.c#L111-L113) |
| AM-based RMA fallback (GET) requires `AM_BCOPY` | [`get_am.c:107`](https://github.com/openucx/ucx/blob/a2687d50/src/ucp/rma/get_am.c#L107) |
| Lane filtering rejects transports missing required capability flags | [`proto_common.c:633`](https://github.com/openucx/ucx/blob/a2687d50/src/ucp/proto/proto_common.c#L633) |

### Complete Data Path Diagram

```
NIXL KV Transfer (e.g., 2 KV cache blocks for 8B model)
    │
    ▼
ucp_put_nbx() / ucp_get_nbx()               ← NIXL calls RMA API
    │
    ▼
UCX Proto v2: select protocol for (PUT, CUDA_memory, size)
    │
    ├─ Native RMA lane?
    │   Requires: PUT_SHORT or PUT_BCOPY or GET_BCOPY
    │   cuda_ipc: only PUT_ZCOPY/GET_ZCOPY → ❌ REJECTED
    │   tcp: no native RMA → ❌ REJECTED
    │
    ├─ RMA_BW lane? (would use cuda_ipc PUT_ZCOPY)
    │   Only allocated when native RMA lane exists
    │   No native RMA lane → RMA_BW lanes never created → ❌ SKIPPED
    │
    └─ AM-based RMA fallback (rma_am)?
        Requires: AM_BCOPY on AM lane
        cuda_ipc: no AM ops → ❌ REJECTED
        tcp: has AM_BCOPY → ✅ SELECTED
            │
            ▼
        rma_am(tcp/cilium_host)
            │
            ▼
        GPU VRAM → cuda_copy → Host staging → TCP socket →
          Host staging → cuda_copy → GPU VRAM
            │
            ▼
        NVLink counter delta: 0 KiB
```

---

## What Would Fix This

1. **NIXL AM-based transfer**: Change NIXL to use `ucp_am_send_nbx()` (Active Messages with rendezvous) instead of `ucp_put_nbx()`. The AM rendezvous data path already uses `cuda_ipc`'s `put_zcopy` for bulk intra-node GPU transfers. This would enable NVLink without hardware changes.

2. **RoCE hardware**: RDMA verbs (`rc_mlx5`) provide native RMA lanes, which unlocks RMA_BW lane allocation, which allows `cuda_ipc` to carry bulk data. This is the path that gives LMCache 99 GB/s. DOKS GPU nodes have Ethernet NICs that could support RoCE, but RoCE is not currently configured on the cluster.

3. **UCX transport extension**: A new transport that implements both RMA capabilities (short/bcopy) and CUDA IPC data movement. This would directly qualify for RMA lanes.

4. **Direct CUDA IPC bypass**: The vLLM NixlConnector or NIXL itself could detect intra-node peers and use `cuMemcpyDtoDAsync()` directly, bypassing UCX's RMA path entirely.

5. **Single-pod architecture**: Run both prefill and decode in the same pod, eliminating cross-pod transfer. This loses DGD orchestration flexibility but avoids the transport issue entirely.

6. **Upstream issue filing**: No existing GitHub issue on [ai-dynamo/nixl](https://github.com/ai-dynamo/nixl/issues) or [openucx/ucx](https://github.com/openucx/ucx/issues) tracks the specific problem of `cuda_ipc` being excluded from intra-node RMA lanes in environments without RDMA.

---

## Bare Metal Would Not Help

On bare metal, both processes share the host's network/IPC/PID namespaces naturally — exactly like our `hostNetwork: true` test. UCX would correctly detect intra-node locality. But the wireup algorithm runs identically: NIXL calls `ucp_put_nbx()`, UCP needs `PUT_SHORT` for a native RMA lane, `cuda_ipc` only has `PUT_ZCOPY`, no native RMA lane gets created, everything falls back to `rma_am(tcp)`. The only scenario where bare metal changes the outcome is if the host has **RoCE-capable NICs with RDMA properly configured** (or InfiniBand).

---

## References

### UCX Source Code
- [`cuda_ipc_iface.c`](https://github.com/openucx/ucx/blob/master/src/uct/cuda/cuda_ipc/cuda_ipc_iface.c) — cuda_ipc capability flags and interface operations
- [`cuda_ipc_ep.c`](https://github.com/openucx/ucx/blob/master/src/uct/cuda/cuda_ipc/cuda_ipc_ep.c) — cuda_ipc endpoint operations (cuMemcpyDtoDAsync wrappers)
- [`select.c`](https://github.com/openucx/ucx/blob/master/src/ucp/wireup/select.c) — UCP wireup lane selection algorithm
- [`put_am.c`](https://github.com/openucx/ucx/blob/master/src/ucp/rma/put_am.c) — AM-emulated RMA PUT
- [`get_am.c`](https://github.com/openucx/ucx/blob/master/src/ucp/rma/get_am.c) — AM-emulated RMA GET
- [`proto_common.c`](https://github.com/openucx/ucx/blob/master/src/ucp/proto/proto_common.c) — Protocol v2 lane filtering
- [UCX FAQ (ReadTheDocs)](https://openucx.readthedocs.io/en/master/faq.html) / [FAQ source on GitHub](https://github.com/openucx/ucx/blob/master/docs/source/faq.md)
- [UCX Releases](https://github.com/openucx/ucx/releases) — v1.19 and v1.20 device API changes

### UCX GitHub Issues and Discussions
- [Issue #3123](https://github.com/openucx/ucx/issues/3123) — "Question - using RMA with shared memory transports"
- [Issue #3156](https://github.com/openucx/ucx/issues/3156) — "Question: cannot get cuda_ipc to work"
- [Issue #6124](https://github.com/openucx/ucx/issues/6124) — RMA lane selection error logs
- [Issue #7912](https://github.com/openucx/ucx/issues/7912) — "Can I expect `ucp_{get,put}_nb()` to work on GPU memory?"
- [Discussion #9896](https://github.com/openucx/ucx/discussions/9896) — "How to use nvlink in ucx"

### NIXL
- [`ucx_utils.cpp`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_utils.cpp) — UCX context creation, RMA feature request, memory registration
- [`ucx_backend.cpp`](https://github.com/ai-dynamo/nixl/blob/b6909e19/src/plugins/ucx/ucx_backend.cpp) — KV transfer orchestration, RMA read/write calls
- [NIXL documentation (`nixl.md`)](https://github.com/ai-dynamo/nixl/blob/main/docs/nixl.md)
- [NIXL Backend Guide](https://github.com/ai-dynamo/nixl/blob/main/docs/BackendGuide.md)
- [NIXL Releases](https://github.com/ai-dynamo/nixl/releases)

### vLLM
- [NixlConnector Usage Guide](https://docs.vllm.ai/en/stable/features/nixl_connector_usage/)

### LMCache
- [Disaggregated Prefill Quickstart](https://docs.lmcache.ai/getting_started/quickstart/disaggregated_prefill.html) — includes 98.99 GB/s benchmark

### Related Analysis
- [UCCL: Everything You Want to Know about KV Cache Transfer Engine](https://uccl-project.github.io/posts/kv-transfer-engine/)
- [Mistral AI: Debugging a memory leak in vLLM](https://mistral.ai/news/debugging-memory-leak-in-vllm) — UCX memory hook configuration
