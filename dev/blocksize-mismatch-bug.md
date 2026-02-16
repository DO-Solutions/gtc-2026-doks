# TRT-LLM deployment examples missing `DYN_KV_CACHE_BLOCK_SIZE` setting

**Component:** Docs / Examples
**Version:** Dynamo 0.9.0
**Repo:** https://github.com/ai-dynamo/dynamo

## Summary

The TRT-LLM deployment examples and router documentation do not set `DYN_KV_CACHE_BLOCK_SIZE` on the frontend when using the KV-aware router. Since TRT-LLM defaults to `tokens_per_block=32` and the frontend defaults to `DYN_KV_CACHE_BLOCK_SIZE=16`, anyone following the examples gets **silent routing degradation** — the KV-aware router falls back to load-based routing with no error.

The frontend default of 16 is correct (it matches vLLM, the most common backend). The issue is that the TRT-LLM examples don't override it to match TRT-LLM's default.

## Affected Files

### 1. `examples/backends/trtllm/deploy/agg_router.yaml`

The aggregated TRT-LLM example with KV-aware routing sets `DYN_ROUTER_MODE=kv` but does not set `DYN_KV_CACHE_BLOCK_SIZE`:

```yaml
Frontend:
  componentType: frontend
  replicas: 1
  extraPodSpec:
    mainContainer:
      image: my-registry/tensorrtllm-runtime:my-tag
  envs:
    - name: DYN_ROUTER_MODE
      value: kv
```

Should be:

```yaml
  envs:
    - name: DYN_ROUTER_MODE
      value: kv
    - name: DYN_KV_CACHE_BLOCK_SIZE
      value: "32"  # Must match TRT-LLM tokens_per_block (default: 32)
```

### 2. `docs/pages/components/router/router-examples.md`

The router examples doc shows `DYN_KV_CACHE_BLOCK_SIZE: "16"` (line ~140) and `block_size=16` in Python examples (lines ~69, ~236). These values are correct for vLLM but there's no note explaining that TRT-LLM requires `32`. A reader deploying TRT-LLM will copy the example value and get silent degradation.

**Suggested fix:** Add a note after each block size setting:

```
# Must match the backend's tokens_per_block. vLLM default: 16, TRT-LLM default: 32.
```

## Impact

When block sizes mismatch, the radix tree never accumulates state (`tree size: 0` permanently). The KV-aware router silently falls back to load-based routing. There is no error at startup and the only runtime signal is WARN-level messages that don't mention block size:

```
WARN: Failed to find parent block; skipping store operation
WARN: Failed to find block to remove; skipping remove operation
```

This makes the issue very hard to diagnose — the system appears to work correctly, requests complete, but the TTFT benefit of KV-aware routing is entirely lost on multi-turn conversations.

## Root Cause

The frontend and workers hash token sequences into blocks independently using their own block size. With `block_size=16` the frontend produces hashes for `[0..16], [16..32], [32..48], [48..64]`; with `tokens_per_block=32` the worker produces hashes for `[0..32], [32..64]`. These hashes are completely different values. Every radix tree store/remove operation fails the parent block lookup (`lib/kv-router/src/radix_tree.rs:335-348`).

## Workaround

Set `DYN_KV_CACHE_BLOCK_SIZE=32` in the frontend environment when using TRT-LLM:

```yaml
services:
  Frontend:
    envs:
      - name: DYN_KV_CACHE_BLOCK_SIZE
        value: "32"
      - name: DYN_ROUTER_MODE
        value: kv
```

## Related

- [Feature request: validate KV cache block size at startup](blocksize-validation-fr.md)
- [Feature request: auto-discover KV cache block size from workers](blocksize-autodiscovery-fr.md)
