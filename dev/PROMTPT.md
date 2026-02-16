# Investigate Dynamo KV Cache-Aware Routing Failure

## Context

I'm running a Dynamo + TRT-LLM inference setup on Kubernetes with 2 worker pods, each using TP=4 (4 GPUs per worker, 8x H100 GPUs total). KV cache-aware routing is enabled but effectively non-functional. I am currently running load gen with a concurrency of 10 to see how the system is acting under reasonable load  load.

The Dynamo frontend router maintains an internal tree/trie index of KV cache block locations across workers. This index is currently empty at routing time, meaning every request does a full prefill regardless of whether it's a follow-up in a conversation. Follow-up TTFT is roughly equal to (or sometimes worse than) initial TTFT.

The purpose here is to troubleshoot and identify potential issues and then we will work together to resolve them.

## Symptoms

The frontend logs show two categories of warnings in rapid succession:

1. **"Failed to find block to remove; skipping remove operation"** — The engine reports block evictions for blocks the router doesn't track. The router's index is out of sync with the engine's actual KV cache state.

2. **"Failed to find parent block; skipping store operation"** — New blocks can't be inserted into the router's tree because their parent blocks are missing (already evicted or never stored). This causes a cascading failure where entire sequences become untrackable.

The scheduler INFO lines confirm the result:

gtc-2026-doks$ k logs gtc-demo-0-frontend-rmjwp | grep "Selected worker" | tail
2026-02-16T14:38:53.950961Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=7702713015953616 dp_rank=0, logit: 138.656, cached blocks: 0, tree size: 0
2026-02-16T14:38:54.992643Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=7702713015953616 dp_rank=0, logit: 124.031, cached blocks: 0, tree size: 0
2026-02-16T14:38:55.106408Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=4467334888485367 dp_rank=0, logit: 48.781, cached blocks: 0, tree size: 0
2026-02-16T14:38:55.244408Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=4467334888485367 dp_rank=0, logit: 104.562, cached blocks: 0, tree size: 0
2026-02-16T14:38:56.212562Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=4467334888485367 dp_rank=0, logit: 155.844, cached blocks: 0, tree size: 0
2026-02-16T14:38:58.107927Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=7702713015953616 dp_rank=0, logit: 85.094, cached blocks: 0, tree size: 0
2026-02-16T14:38:58.294618Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=7702713015953616 dp_rank=0, logit: 113.344, cached blocks: 0, tree size: 0
2026-02-16T14:38:59.632506Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=7702713015953616 dp_rank=0, logit: 167.312, cached blocks: 0, tree size: 0
2026-02-16T14:39:00.157269Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=4467334888485367 dp_rank=0, logit: 201.594, cached blocks: 0, tree size: 0
2026-02-16T14:39:01.315568Z  INFO dynamo_llm::kv_router::scheduler: Selected worker: worker_id=4467334888485367 dp_rank=0, logit: 146.219, cached blocks: 0, tree size: 0

The router falls back to pure load-based scheduling with zero cache affinity.

## Investigation Tasks

Work through these systematically. Use `kubectl`, log inspection, config file review, and any Dynamo CLI/API tools available in the environment.

### 1. Understand the Current Configuration

- Find and review the Dynamo deployment configuration (YAML, TOML, or however it's configured). Identify settings related to:
  - KV cache block size / token block size on the engine side
  - KV cache memory allocation (`kv_cache_free_gpu_mem_fraction` or equivalent TRT-LLM setting)
  - Router-side settings for the KV indexer (cache TTL, max tree size, block size assumptions, sync intervals)
  - Any prefix caching or KV cache reuse flags on the TRT-LLM engine
- Identify the model being served and its memory footprint relative to available GPU memory per worker
- Check GPU memory utilization on each worker: `nvidia-smi` or DCGM metrics

### 2. Diagnose the Sync Failure

- Examine how the router receives block store/evict notifications from workers (push-based via NATS/etcd/gRPC, or polling?)
- Check if there's a communication backlog or latency between engine eviction events and router index updates
- Look at the rate of eviction warnings vs. store warnings — if evictions vastly outnumber stores, the cache is churning too fast for the tree to stabilize
- Check if there's a block size or hash mismatch between what TRT-LLM reports and what the Dynamo router expects

### 3. Assess Memory Pressure

- Determine the effective KV cache budget per GPU after model weights are loaded
- Calculate approximate KV cache capacity in blocks/tokens for the running model
- Check concurrent request volume and average sequence length — are active sequences consuming most of the available cache, leaving no room for retained entries?
- Review if `max_num_seqs` or batch size settings are too aggressive for the available KV cache memory

### 4. Identify Potential Fixes

Based on findings, evaluate these remediation paths:

- **Reduce memory pressure**: Lower `max_num_seqs` / max batch size to leave more KV cache headroom for retention
- **Increase KV cache allocation**: Adjust `kv_cache_free_gpu_mem_fraction` upward if model weights leave room
- **Block size alignment**: Ensure the router's expected block size matches the engine's actual block size
- **Eviction policy tuning**: Check if TRT-LLM or Dynamo has configurable eviction policies (LRU vs. size-based) or minimum retention guarantees
- **Reduce concurrent load during testing**: Test with very low concurrency (1-2 requests) to confirm the tree can stabilize when there's no memory pressure

## Constraints

- Don't restart or redeploy anything without showing me the proposed changes first
- Prefer diagnostic/read-only operations before making any modifications
