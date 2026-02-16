# [FEATURE]: Auto-discover KV cache block size from backend workers

## Feature request

The frontend should auto-discover the KV cache block size from connected workers at startup, making `DYN_KV_CACHE_BLOCK_SIZE` / `--kv-cache-block-size` optional:

1. **Query workers:** When the frontend connects to workers (or on the first KV cache event from each worker), read the worker's `tokens_per_block` from the event metadata or a capability handshake.

2. **All workers agree → use that value:** If all connected workers report the same `tokens_per_block`, use it as the frontend's block size. Log an INFO message: `"Auto-configured KV block size to 32 (from worker reports)"`.

3. **Workers disagree → refuse to start:** If workers report different block sizes, log an ERROR and refuse to start. Mixed block sizes in the same graph would produce inconsistent hashing.

4. **Explicit override → warn on mismatch:** If the user explicitly set `DYN_KV_CACHE_BLOCK_SIZE`, use that value. But if it doesn't match what workers report, log a WARN so the user knows about the discrepancy.

This would eliminate the class of block-size-mismatch bugs entirely — no manual configuration needed, and the frontend adapts to whatever backend is deployed.

Implementation considerations:
- This likely requires a small addition to the worker→frontend capability exchange or KV event metadata to include `tokens_per_block`.
- The auto-discovery should happen early enough that the radix tree is initialized with the correct block size before any routing decisions are made.
- If workers connect at different times, the frontend may need to defer routing decisions until at least one worker has reported its block size.

## Describe the problem you're encountering

Users must manually keep `DYN_KV_CACHE_BLOCK_SIZE` in sync with the backend's `tokens_per_block`. Different backends have different defaults:

| Backend | Default `tokens_per_block` |
|---------|---------------------------|
| vLLM    | 16                        |
| TRT-LLM | 32                       |

The frontend defaults to 16 (matching vLLM). When deploying with TRT-LLM, users must know to override this — and if they don't, the KV-aware router silently degrades to load-based routing with no error. The system appears to work (requests complete, responses are correct) but the TTFT benefit of KV-aware routing is entirely lost on multi-turn conversations.

This is error-prone because:
- There's no startup check or health probe that validates the configuration
- The only runtime signal is WARN-level messages that don't mention block size
- Different backends have different defaults, so the correct value depends on which backend is deployed

**Environment:** Dynamo 0.9.0, TRT-LLM backend, Kubernetes (DOKS)

## Describe alternatives you've tried

1. **Manual configuration** — Setting `DYN_KV_CACHE_BLOCK_SIZE=32` in the frontend environment. Works but requires knowing the backend's default and which env var to set.

2. **Documentation fix** — We filed a docs fix to add `DYN_KV_CACHE_BLOCK_SIZE` to the TRT-LLM examples (see [blocksize-mismatch-bug.md](blocksize-mismatch-bug.md)). This helps users following examples but doesn't protect against custom deployments or future backends with different defaults.

3. **Startup validation** — A lighter-weight alternative would be logging an ERROR on first block size mismatch detection (see [blocksize-validation-fr.md](blocksize-validation-fr.md)). This catches the problem but still requires manual configuration to fix it. Auto-discovery is preferred because it eliminates the configuration step entirely.
