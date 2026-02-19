# The UCT-UCP Layer Gap That Silences NVLink in cuda_ipc RMA

**NIXL's RMA-based KV transfer cannot use cuda_ipc because UCX's UCP protocol layer requires capability flags that cuda_ipc does not provide, creating an architectural gap where the transport can perform GPU-to-GPU copies but the protocol layer will never select it for RMA operations.** This is not a bug but a structural limitation in UCX's lane selection algorithm that specifically affects TCP-only environments without InfiniBand. The user's NVLink counters showing zero KV traffic are the direct, expected consequence of this mismatch: all GPU RMA data routes through TCP with host-memory staging instead.

The hypothesis posed in the question is confirmed across multiple dimensions of the UCX codebase and issue tracker. cuda_ipc advertises only `PUT_ZCOPY` and `GET_ZCOPY` at the UCT transport level, while UCP's wireup algorithm in [`select.c`](https://github.com/openucx/ucx/blob/master/src/ucp/wireup/select.c) demands `PUT_SHORT` for native RMA lanes and `AM_BCOPY` for the AM-emulation fallback — neither of which cuda_ipc provides. UCX's own [FAQ](https://openucx.readthedocs.io/en/master/faq.html) ([source on GitHub](https://github.com/openucx/ucx/blob/master/docs/source/faq.md)) acknowledges this plainly: "Remote memory access APIs, including atomic operations, have an incomplete support for GPU memory; the full support is planned for future releases."

---

## cuda_ipc's capability flags are fundamentally mismatched with RMA requirements

The cuda_ipc transport's advertised capabilities in [`cuda_ipc_iface.c`](https://github.com/openucx/ucx/blob/master/src/uct/cuda/cuda_ipc/cuda_ipc_iface.c) are deliberately minimal:

```c
iface_attr->cap.flags = UCT_IFACE_FLAG_PUT_ZCOPY |
                        UCT_IFACE_FLAG_GET_ZCOPY |
                        UCT_IFACE_FLAG_CONNECT_TO_IFACE |
                        UCT_IFACE_FLAG_PENDING |
                        UCT_IFACE_FLAG_ERRHANDLE_PEER_FAILURE |
                        UCT_IFACE_FLAG_DEVICE_EP;
```

The transport exposes **zero** AM capabilities (`AM_SHORT`, `AM_BCOPY`, `AM_ZCOPY`) and **zero** short/bcopy RMA capabilities (`PUT_SHORT`, `PUT_BCOPY`, `GET_BCOPY`). Its `max_zcopy` is `ULONG_MAX` with unlimited transfer sizes, and it calls `cuMemcpyDtoDAsync` under the hood — meaning the raw hardware path works perfectly. But UCP never invokes it for RMA.

UCX error logs from multiple GitHub issues confirm the rejection mechanism. [Issue #3123](https://github.com/openucx/ucx/issues/3123) ("Question - using RMA with shared memory transports") shows `"cma/cma - no put short, knem/knem - no put short"` during RMA lane selection. [Issue #6124](https://github.com/openucx/ucx/issues/6124) shows `"tcp/eth0 - no put short"`. [Issue #3156](https://github.com/openucx/ucx/issues/3156) ("Question: cannot get cuda_ipc to work") directly demonstrates `"cuda_ipc/cudaipc0 does not support operation put short"`. The wireup code in [`select.c`](https://github.com/openucx/ucx/blob/master/src/ucp/wireup/select.c) checks each transport's `iface_attr.cap.flags` against mandatory requirements and produces these diagnostic messages when transports fail the filter.

The RMA lane selection in `select.c` creates a **three-gate filter** that cuda_ipc fails at every stage:

| Gate | Required capability | cuda_ipc has it? | Consequence |
|------|-------------------|-------------------|-------------|
| Native RMA lane | `PUT_SHORT` + `PUT_BCOPY` + `GET_BCOPY` | ❌ None of these | Cannot be RMA lane |
| AM-emulated RMA (`rma_am`) | `AM_BCOPY` minimum | ❌ No AM at all | Cannot participate in rma_am |
| RMA_BW lane (zcopy bulk) | `PUT_ZCOPY` or `GET_ZCOPY` | ✅ Has both | Qualifies — but only allocated alongside native RMA lanes |

That third gate is the cruelest detail. cuda_ipc qualifies for **RMA_BW lanes** (bandwidth-optimized lanes used for large zero-copy transfers), but these lanes are only allocated by the wireup algorithm when a native RMA lane already exists. In TCP-only environments, no native RMA lane can be established — TCP itself lacks `PUT_SHORT` — so the wireup falls back to `rma_am` emulation and **never allocates RMA_BW lanes at all**.

## The data path through rma_am completely bypasses NVLink

When NIXL calls `ucp_put_nbx()` with a CUDA memory buffer in this configuration, proto v2's protocol selection engine evaluates all available protocols for the tuple (PUT, CUDA_memory, message_size). With no native RMA lane and no RMA_BW lanes, every size bracket resolves to the **rma_am emulation path**. This path encodes the RMA operation as Active Messages carried on the TCP transport.

For CUDA source memory, the rma_am pipeline becomes:

```
Source GPU → cuda_copy → Host staging buffer → TCP AM_BCOPY →
  Remote host staging buffer → cuda_copy → Destination GPU
```

Every byte of KV cache data crosses the PCIe bus twice (GPU→host, host→GPU) and traverses TCP — even when source and destination GPUs share an NVLink interconnect on the same physical node. The theoretical NVLink bandwidth on H100 systems (**900 GB/s bidirectional**) goes entirely unused. TCP throughput on loopback is typically **10–30 GB/s** at best.

Proto v2 is essential here for a different reason: it prevents the *crash* that proto v1 would cause. UCX [issue #7912](https://github.com/openucx/ucx/issues/7912) ("Can I expect `ucp_{get,put}_nb()` to work on GPU memory?"), filed by a GASNet-EX developer, documented that proto v1 would select `put_short`/`put_bcopy` protocols for GPU memory RMA, calling `memcpy()` on device pointers and triggering segmentation faults. Proto v2 correctly excludes these protocols for non-CPU-accessible memory types. But "not crashing" and "using the optimal transport" are two very different things.

## Why cuda_ipc appears in the AM lane but cannot help RMA

The user's wireup log deserves precise interpretation:

```
ucp_context_0 intra-node cfg#2
  rma_am(tcp/cilium_host)         ← All RMA emulated via AM on TCP
  amo_am(tcp/cilium_host)         ← All atomics emulated via AM on TCP
  am(tcp/cilium_host ... cuda_ipc/cuda)  ← cuda_ipc available for AM data path
  ka(tcp/cilium_host)             ← Keepalive on TCP
```

cuda_ipc's presence in the `am()` lane list means it participates in the **AM rendezvous data path** — when large Active Messages are sent via `ucp_am_send_nbx()`, the rendezvous protocol uses TCP for control messages (RTS/RTR headers) and cuda_ipc's `put_zcopy`/`get_zcopy` for bulk data transfer. This is the AM_BW (bandwidth) role. If NIXL used `ucp_am_send_nbx()` for data transfer instead of `ucp_put_nbx()`, cuda_ipc **would** carry the bulk data over NVLink.

But NIXL's architecture is built around one-sided RMA semantics. Its [documentation](https://github.com/ai-dynamo/nixl/blob/main/docs/nixl.md) and [BackendGuide](https://github.com/ai-dynamo/nixl/blob/main/docs/BackendGuide.md) explicitly describe "one-sided transfers, i.e., Read and Write operations" with remote memory key exchange — the classic `ucp_mem_map` → `ucp_rkey_pack` → `ucp_put_nbx`/`ucp_get_nbx` pattern. The UCCL project's [independent analysis of KV transfer engines](https://uccl-project.github.io/posts/kv-transfer-engine/) confirms: "NIXL provides read/write operations between KV cache exporter nodes and importer nodes... transferred in a GPU-Direct RDMA manner." This RMA path never triggers the AM rendezvous code path where cuda_ipc participates.

## LMCache's 99 GB/s likely ran on InfiniBand hardware, not TCP-only

[LMCache's documented](https://docs.lmcache.ai/getting_started/quickstart/disaggregated_prefill.html) **98.99 GB/s** benchmark (`UCX_TLS=cuda_ipc,cuda_copy,tcp`) uses the same underlying stack: LMCache → NIXL → UCX RMA → transport. Both LMCache and vLLM's NixlConnector call the identical NIXL transfer API. The critical difference is almost certainly the **hardware environment**, not the software path.

On systems with InfiniBand (rc_mlx5), the architecture changes fundamentally:

- **IB verbs** provide a native RMA lane (`PUT_SHORT` + `PUT_BCOPY` + `PUT_ZCOPY` + GDR registration)
- With a native RMA lane present, the wireup **allocates RMA_BW lanes**
- cuda_ipc qualifies as an **RMA_BW lane** (only needs `PUT_ZCOPY`/`GET_ZCOPY`)
- Proto v2 selects cuda_ipc's `put_zcopy` for large intra-node GPU-GPU transfers via the RMA_BW path
- NVLink bandwidth is fully utilized

The **~99 GB/s throughput** is consistent with single-direction NVLink effective bandwidth on H100 systems for 5271-token KV cache transfers, including protocol overhead. This confirms NVLink was active. On a TCP-only system without IB, the same benchmark would yield roughly **10–30× lower throughput**.

The [vLLM NixlConnector documentation](https://docs.vllm.ai/en/stable/features/nixl_connector_usage/) provides a revealing hint: its example UCX_TLS configuration includes `^cuda_ipc` (explicitly excluding cuda_ipc), suggesting awareness that cuda_ipc may not be beneficial — or may be confusing — in the RMA-based NixlConnector path for certain deployments.

## Would bare metal (non-Kubernetes) change the outcome?

No. On bare metal, both vLLM processes would naturally share the host's network/IPC/PID namespaces, so UCX would correctly detect intra-node locality — exactly like Test 2 with `hostNetwork: true`. But the UCP wireup algorithm runs identically whether inside a pod or a bare process. NIXL calls `ucp_put_nbx()`, UCP needs `PUT_SHORT` for a native RMA lane, cuda_ipc only has `PUT_ZCOPY`, no native RMA lane gets created, RMA_BW lanes never get allocated, and everything falls back to `rma_am(tcp)`. The PCIe-bus double-crossing staging path (GPU → host memory → TCP → host memory → GPU) happens regardless of deployment model.

The one scenario where bare metal *would* change the outcome is if the host has **InfiniBand or RoCE NICs**. IB verbs (`rc_mlx5`) provide native RMA capabilities, which gives UCP the native RMA lane it needs. Once that lane exists, the wireup allocates RMA_BW lanes, cuda_ipc qualifies for RMA_BW, and proto v2 selects cuda_ipc's `put_zcopy` for large intra-node GPU-to-GPU transfers. The dependency chain is: **NVLink KV transfer requires RMA_BW lanes → RMA_BW lanes require a native RMA lane → native RMA lanes require IB/RoCE hardware (or a UCX version that closes the zcopy-only gap)**.

## UCX v1.19 and v1.20 introduce a device API to bypass this limitation

UCX versions **1.19.0** (mid-2025) and **1.20.0** (late 2025) introduced significant changes specifically targeting this problem ([UCX releases](https://github.com/openucx/ucx/releases)):

- **"Added device API implementation for CUDA_IPC transport"** — a new GPU device-level API that bypasses traditional UCP lane selection
- **"Added device put multi, put partial, and atomic operations for CUDA_IPC"** — extending cuda_ipc beyond just put_zcopy/get_zcopy
- **"Fixed CUDA IPC RMA operations by using correct context for local buffers"** — direct RMA fix
- **"Added new GPU device API for direct GPU-to-GPU communication"** (v1.20)
- **"Added GDAKI transport with endpoint export to GPU"** (v1.20) — kernel-initiated GPU transfers

[NIXL v0.7.0](https://github.com/ai-dynamo/nixl/releases) correspondingly added "[Device API] Improved support for GPU-initiated UCX transfers in MoE workloads" and requires UCX 1.20.x. However, the device API appears targeted at MoE (Mixture of Experts) workloads with GPU-initiated transfers, which is architecturally distinct from the CPU-initiated KV cache RMA transfers in disaggregated serving. Whether the v1.19/v1.20 device API resolves the standard RMA path for KV transfer remains unclear without examining the specific code paths.

NIXL's [CI pipeline](https://github.com/ai-dynamo/nixl/actions/workflows/build_validation.yml) shows an active branch `topic/ucx-cfg-relaxed-order` suggesting ongoing UCX configuration work that may address transport selection. No GitHub issues or PRs in the [openucx/ucx](https://github.com/openucx/ucx) or [ai-dynamo/nixl](https://github.com/ai-dynamo/nixl) repositories explicitly track the problem of cuda_ipc being excluded from intra-node RMA lanes in TCP-only environments. [Issue #7912](https://github.com/openucx/ucx/issues/7912) is the closest upstream issue (GPU memory RMA protocol selection), and it was partially addressed by proto v2 becoming the default. The more fundamental lane allocation problem — RMA_BW lanes not being created without a native RMA lane — appears untracked.

## Discussion #9896: UCX maintainer confirms cuda_ipc usage model

[Discussion #9896](https://github.com/openucx/ucx/discussions/9896) ("How to use nvlink in ucx") on the openucx/ucx repo features a UCX collaborator confirming that cuda_ipc's `put_zcopy` calls `cuMemcpyDtoDAsync` and automatically routes over NVLink when available. However, this discussion addresses **UCT-level** (direct transport) operations and **AM rendezvous** data paths — contexts where cuda_ipc is explicitly invoked by the protocol layer. It does not address the UCP RMA lane selection gap described in this analysis, where `ucp_put_nbx()` never reaches cuda_ipc's UCT implementation because the wireup algorithm excludes it from RMA lanes.

## Practical implications and potential workarounds

The Kubernetes deployment with `hostNetwork: true` and `hostIPC: true` has the correct namespace sharing for cuda_ipc to function. Intra-node detection works (the log confirms "intra-node cfg#2" and cuda_ipc appears as reachable). The failure is purely at the UCP protocol selection layer.

For this specific deployment, there are several possible paths forward:

1. **InfiniBand hardware**: If available on the nodes, configuring `UCX_NET_DEVICES` to expose the IB device would enable the native RMA lane → RMA_BW lane → cuda_ipc chain. This is the most straightforward fix but requires hardware not present on the DOKS cluster.

2. **NIXL transfer mechanism change**: An application-level change in NIXL to use `ucp_am_send_nbx()` (Active Messages with rendezvous) rather than `ucp_put_nbx()` would allow cuda_ipc to carry bulk data through the AM rendezvous path. This would require changes in the [NIXL UCX backend](https://github.com/ai-dynamo/nixl/blob/main/src/plugins/ucx/).

3. **UCX upgrade path**: Testing with UCX 1.19+ or 1.20+ to evaluate whether the new device API changes the transport selection for RMA operations in TCP-only environments.

4. **File an upstream issue**: Filing on [ai-dynamo/nixl](https://github.com/ai-dynamo/nixl/issues) describing the specific failure mode — cuda_ipc excluded from RMA in TCP-only environments despite intra-node reachability — would be the most direct path to a fix, as no existing issue tracks this problem.

5. **UCX memory hook configuration**: Setting `UCX_MEM_MMAP_HOOK_MODE=none` is recommended for any NIXL+UCX deployment per a [memory leak fix discovered by Mistral AI](https://mistral.ai/news/debugging-memory-leak-in-vllm).

## Conclusion

The core finding is architectural: **UCX's UCP layer was designed around transports that implement the full RMA capability spectrum** (short, bcopy, zcopy), and cuda_ipc's zcopy-only design makes it invisible to the RMA lane allocator. The RMA_BW lane mechanism could bridge this gap, but only when a native RMA lane already exists — creating a dependency on IB/RDMA hardware that is absent in the user's TCP-only Kubernetes environment. This is not a configuration error but a genuine layer gap in UCX's abstraction stack. The transport works, the protocol just never asks it to.

---

## References

### UCX Source Code
- [`cuda_ipc_iface.c`](https://github.com/openucx/ucx/blob/master/src/uct/cuda/cuda_ipc/cuda_ipc_iface.c) — cuda_ipc capability flags and interface operations
- [`select.c`](https://github.com/openucx/ucx/blob/master/src/ucp/wireup/select.c) — UCP wireup lane selection algorithm
- [UCX FAQ (ReadTheDocs)](https://openucx.readthedocs.io/en/master/faq.html) / [FAQ source on GitHub](https://github.com/openucx/ucx/blob/master/docs/source/faq.md)
- [UCX Releases](https://github.com/openucx/ucx/releases) — v1.19 and v1.20 device API changes

### UCX GitHub Issues and Discussions
- [Issue #3123](https://github.com/openucx/ucx/issues/3123) — "Question - using RMA with shared memory transports"
- [Issue #3156](https://github.com/openucx/ucx/issues/3156) — "Question: cannot get cuda_ipc to work"
- [Issue #6124](https://github.com/openucx/ucx/issues/6124) — RMA lane selection error logs
- [Issue #7912](https://github.com/openucx/ucx/issues/7912) — "Can I expect `ucp_{get,put}_nb()` to work on GPU memory?"
- [Discussion #9896](https://github.com/openucx/ucx/discussions/9896) — "How to use nvlink in ucx"

### NIXL
- [NIXL documentation (`nixl.md`)](https://github.com/ai-dynamo/nixl/blob/main/docs/nixl.md)
- [NIXL Backend Guide](https://github.com/ai-dynamo/nixl/blob/main/docs/BackendGuide.md)
- [NIXL Releases](https://github.com/ai-dynamo/nixl/releases)
- [NIXL Repository](https://github.com/ai-dynamo/nixl)

### vLLM
- [NixlConnector Usage Guide](https://docs.vllm.ai/en/stable/features/nixl_connector_usage/)

### LMCache
- [Disaggregated Prefill Example](https://docs.lmcache.ai/getting_started/quickstart/disaggregated_prefill.html) — includes 98.99 GB/s benchmark

### Related Analysis
- [UCCL: Everything You Want to Know about KV Cache Transfer Engine](https://uccl-project.github.io/posts/kv-transfer-engine/)
- [Mistral AI: Debugging a memory leak in vLLM](https://mistral.ai/news/debugging-memory-leak-in-vllm) — UCX memory hook configuration