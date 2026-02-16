# [FEATURE]: Validate KV cache block size matches backend at startup

## Feature request

On the first KV cache event received from a worker, the frontend should compare the block size in the event metadata against its own configured `kv_cache_block_size`. If they don't match, log an ERROR with actionable information:

```
ERROR: Frontend KV block size (16) does not match worker block size (32).
Set DYN_KV_CACHE_BLOCK_SIZE=32 on the frontend or configure tokens_per_block=16 on workers.
KV-aware routing will not function until block sizes match.
```

This check only needs to happen once (on the first event). The cost is negligible and the diagnostic value is high — it turns a silent degradation into an immediately obvious misconfiguration.

Implementation notes:
- The check should run in the KV event processing path, likely near `lib/kv-router/src/radix_tree.rs:335-348` where the parent block lookup already occurs.
- KV cache events from workers presumably include metadata about the block size used to produce the hashes. If this metadata isn't currently included, it would need to be added to the event schema.
- The frontend's configured block size is available from `lib/llm/src/local_model.rs:32` (`DEFAULT_KV_CACHE_BLOCK_SIZE`) or the runtime config.
- Consider also emitting a Prometheus metric (e.g., `kv_router_block_size_mismatch_total`) so monitoring can catch it.

## Describe the problem you're encountering

When the frontend's `DYN_KV_CACHE_BLOCK_SIZE` does not match the backend's `tokens_per_block`, the KV-aware router silently degrades to load-based routing. The only runtime signal is WARN-level messages that don't mention block size:

```
WARN: Failed to find parent block; skipping store operation
WARN: Failed to find block to remove; skipping remove operation
```

These warnings appear thousands of times per minute under load, but they blend into normal log noise and don't tell the operator what's wrong or how to fix it. A user can run for days with KV-aware routing configured but not functioning, with no indication of the problem.

The mismatch between frontend default (16, matching vLLM) and TRT-LLM default (32) is a common deployment pitfall. While fixing the docs/examples addresses the immediate gap, a runtime validation check would prevent this class of issue regardless of how the deployment was configured.

**Environment:** Dynamo 0.9.0, TRT-LLM backend, Kubernetes (DOKS)

## Describe alternatives you've tried

Our current workaround is manually setting `DYN_KV_CACHE_BLOCK_SIZE=32` in the frontend environment to match TRT-LLM's `tokens_per_block`. This works but requires knowing that:

1. The frontend and backend have different default block sizes
2. Which env var to set and what value to use
3. That the WARN-level log messages are caused by a block size mismatch (they don't mention block size)

We also filed a docs fix to add `DYN_KV_CACHE_BLOCK_SIZE` to the TRT-LLM examples, which helps future users following examples but doesn't protect against custom deployments.

A related but more comprehensive approach would be auto-discovering the block size from workers at startup (see [blocksize-autodiscovery-fr.md](blocksize-autodiscovery-fr.md)), which would eliminate the need for manual configuration entirely.
