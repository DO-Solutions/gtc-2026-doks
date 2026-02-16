# Batch Size Reasoning: H100 TP=4, Llama 70B FP8, TRT-LLM

## Context

This document explains how to estimate an appropriate `max_batch_size` for TensorRT-LLM when serving Llama 70B with FP8 quantization (both model weights and KV cache) on 4× NVIDIA H100 80GB GPUs with tensor parallelism (TP=4). The max sequence length (`max_seq_len`) is 16,384 tokens. The target workload is an interactive chat application.

A batch size of 8 or 12 is dramatically underutilizing this hardware configuration. The analysis below shows why, and provides a defensible starting point.

## Hardware Budget

Each H100 SXM has 80 GB HBM3 memory. With TP=4, both model weights and KV cache are sharded across all 4 GPUs. The memory analysis is done **per GPU** since each GPU must independently hold its shard.

```
Per GPU Memory Budget:
  Total HBM:                        80.0 GB
  Model weights (70 GB FP8 / 4):   -17.5 GB
  CUDA context + activations:       -5.0 GB  (conservative estimate)
  ─────────────────────────────────────────
  Available for KV cache:           ~57.5 GB
```

## KV Cache Per Token Calculation

The KV cache size per token is derived from the model architecture. These values come from the Llama 70B `config.json`:

```
num_hidden_layers:    80
num_key_value_heads:   8   (GQA — 8 KV heads, not the full 64 query heads)
hidden_size:        8192
head_dim:            128   (= hidden_size / num_attention_heads = 8192 / 64)
```

With TP=4, each GPU handles `8 / 4 = 2` KV heads.

Per-token KV cache per GPU:

```
= 2 (K and V matrices)
× 2 (KV heads per GPU)
× 128 (head dimension)
× 80 (layers)
× 1 byte (FP8 dtype)

= 40,960 bytes
= 40 KB per token per GPU
```

Note: If BF16 KV cache were used instead of FP8, this would double to 80 KB per token per GPU. FP8 KV cache is a significant concurrency multiplier with minimal quality impact for chat workloads.

## Theoretical Token Capacity

```
57.5 GB / 40 KB per token = ~1,437,500 total tokens in KV cache per GPU
```

Since all GPUs are sharded symmetrically, the system-wide token capacity equals the per-GPU capacity.

## Converting Tokens to Concurrent Sequences

Not every sequence occupies the full `max_seq_len` at any given moment. For an interactive chat workload, the average KV cache occupancy per sequence is typically 20–30% of max_seq_len. This is because:

- Most chat turns involve relatively short prompts (500–2,000 tokens) and short outputs (200–500 tokens)
- Sequences arrive and complete at different times, so the mix includes sequences at various stages
- Few sequences ever approach the 16K ceiling in normal chat usage

Using a utilization factor of 0.25 (middle estimate for chat):

```
Average KV occupancy per sequence = 16,384 × 0.25 = 4,096 tokens

Theoretical max concurrent sequences = 1,437,500 / 4,096 ≈ 351
```

## Applying a Latency Constraint

For interactive chat (where users are waiting for responses), you cannot run at the theoretical memory ceiling. Higher batch sizes increase per-token decode latency because each forward pass processes more sequences. A practical rule of thumb for interactive workloads is to operate at 50–70% of the memory ceiling.

```
Latency-adjusted estimate = 351 × 0.60 ≈ 210
```

Even with very conservative assumptions (higher utilization factor of 0.35, aggressive latency haircut of 0.50):

```
Conservative floor = 1,437,500 / (16,384 × 0.35) × 0.50 ≈ 125
```

## Recommended Starting Point

| Scenario | Estimated Max Batch Size |
|---|---|
| Theoretical memory ceiling (0.85 fraction) | ~275 |
| Practical for interactive chat | ~100–170 |
| Conservative starting point | ~64–96 |
| Current setting (8–12) | **~3–5% utilization of available capacity** |

**Recommended `--max-batch-size`: start at 64, tune upward based on load testing.**
**`--max-num-tokens` is being set to 16384, which pairs well with batch sizes up to ~64.**

## Why 8 or 12 Is Too Low

A batch size of 8 on this hardware means:

- Maximum of 8 × 16,384 = 131,072 tokens in KV cache (if every sequence were at max length)
- But realistically ~8 × 4,096 = 32,768 tokens in KV cache at any moment
- That consumes roughly 32,768 × 40 KB = **1.3 GB** of the **57.5 GB** available for KV cache per GPU
- GPU memory utilization during decode: **~2%** of KV cache capacity
- GPU compute utilization during decode: extremely low — the GPU is mostly idle between tokens

At batch_size=8, the GPUs are spending the vast majority of their time waiting. The memory bandwidth and compute available on 4× H100 can service 10–15× more concurrent sequences before becoming the bottleneck.

## TRT-LLM Specific Notes (Dynamo Runtime)

The deployment uses the Dynamo TRT-LLM runtime (`dynamo.trtllm`), which handles engine compilation internally. Key parameters are set as CLI flags at container startup and can be changed without a manual engine rebuild:

- `--max-batch-size` is a **runtime CLI flag**, not a compile-time constant. Changing it requires a pod restart, not a lengthy engine recompilation.
- `--max-num-tokens` caps the total tokens processed per scheduler iteration (across all sequences in the batch, including both prefill and decode tokens). This is being increased from 8192 to 16384, which is appropriate for higher batch sizes — at batch_size=64 with mixed prefill/decode, 16384 tokens per iteration provides reasonable headroom. If batch size is pushed significantly higher (96+), this may need to increase further to avoid prefill stalls.
- `--free-gpu-memory-fraction 0.85` limits TRT-LLM to 85% of each GPU's 80 GB (= 68 GB usable). This affects the KV cache budget calculation (see adjusted numbers below).
- `kv_cache_config.dtype: fp8` is correctly set, which halves KV cache memory per token compared to BF16.
- `enable_chunked_prefill: true` allows long prompts to be chunked across iterations, which works well with continuous batching but interacts with `max-num-tokens` as the per-iteration token budget.

## Adjusted Memory Budget (Accounting for free-gpu-memory-fraction=0.85)

```
Per GPU Memory Budget:
  Usable HBM (80 GB × 0.85):       68.0 GB
  Model weights (70 GB FP8 / 4):   -17.5 GB
  CUDA context + activations:       -5.0 GB
  ─────────────────────────────────────────
  Available for KV cache:           ~45.5 GB
```

Revised token capacity:

```
45.5 GB / 40 KB per token = ~1,137,500 total tokens in KV cache per GPU
```

Revised concurrent sequences (chat, utilization factor 0.25, latency haircut 0.60):

```
1,137,500 / (16,384 × 0.25) × 0.60 ≈ 167
```

Conservative floor: ~96–128. The hardware can comfortably support this range even with the 0.85 memory fraction.

## Validation Approach

After adjusting the batch size:

1. Run a load test with realistic chat traffic patterns (varied prompt lengths, typical output lengths)
2. Monitor TTFT (time to first token) — should be <500ms for interactive chat
3. Monitor ITL (inter-token latency) — should be <50ms for smooth streaming
4. Monitor GPU KV cache utilization — should be 40–70% at steady-state peak load
5. Increase batch size until latency SLAs are breached, then back off 20–30%

## Summary

The current batch size of 8–12 leaves >90% of the KV cache capacity unused on 4× H100 with Llama 70B FP8 (even accounting for the 0.85 GPU memory fraction). A starting point of 64–96 is well-supported by the memory math. `--max-num-tokens` is being increased to 16384, which is well-suited for batch sizes in the 64 range. Since the Dynamo runtime accepts `--max-batch-size` as a CLI flag, changes require only a pod restart — there is no lengthy engine recompilation step.