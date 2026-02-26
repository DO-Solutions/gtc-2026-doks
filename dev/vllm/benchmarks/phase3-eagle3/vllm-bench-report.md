# Phase 1 Parameter Tuning — Benchmark Report

**Generated:** 2026-02-26 00:34:13 UTC

## Configuration

| # | Label | gpu-memory-util | max-num-batched-tokens | max-num-seqs | KV Cache | Description |
|:-:|-------|:-:|:-:|:-:|--------|-------------|
| 0 | phase0 (baseline) | 0.9 | 8192 | 1024 | 53.15 GiB | Phase 0 custom dataset baseline |
| 1 | phase3-eagle3-chat | 0.9 | 16384 | 64 | 50.09 GiB | EAGLE-3 speculative decoding (chat endpoint, num_speculative_tokens=3) |

## SLO Targets

| Metric | Target |
|--------|--------|
| TTFT p99 | < 1000ms |
| TPOT p99 | < 60ms |

## Results — TTFT p99 (ms)

| Rate | phase0 | phase3-eagle3-chat |
|-----:|--------:|--------:|
| 0.50 | 770 | 790 |
| 0.75 | 646 | 711 |
| 1.00 | 703 | 8517 |
| 1.25 | 801 | 47339 |
| 1.50 | 981 | 78756 |
| 2.00 | 953 | 122767 |
| 2.50 | 978 | 147867 |
| 3.00 | 1020 | 169287 |

## Results — TPOT p99 (ms)

| Rate | phase0 | phase3-eagle3-chat |
|-----:|--------:|--------:|
| 0.50 | 29 | 43 |
| 0.75 | 34 | 66 |
| 1.00 | 41 | 76 |
| 1.25 | 42 | 77 |
| 1.50 | 43 | 77 |
| 2.00 | 49 | 78 |
| 2.50 | 67 | 79 |
| 3.00 | 75 | 79 |

## Results — Output Throughput (tok/s)

| Rate | phase0 | phase3-eagle3-chat |
|-----:|--------:|--------:|
| 0.50 | 252 | 402 |
| 0.75 | 371 | 583 |
| 1.00 | 485 | 730 |
| 1.25 | 594 | 759 |
| 1.50 | 695 | 772 |
| 2.00 | 867 | 784 |
| 2.50 | 1008 | 791 |
| 3.00 | 1110 | 792 |

## Results — Max Concurrent Requests

| Rate | phase0 | phase3-eagle3-chat |
|-----:|--------:|--------:|
| 0.50 | 16 | 29 |
| 0.75 | 20 | 54 |
| 1.00 | 30 | 73 |
| 1.25 | 35 | 114 |
| 1.50 | 41 | 146 |
| 2.00 | 59 | 197 |
| 2.50 | 89 | 223 |
| 3.00 | 112 | 233 |

## SLO Compliance Matrix

PASS = TTFT p99 < 1000ms AND TPOT p99 < 60ms

| Rate | phase0 | phase3-eagle3-chat |
|-----:|--------|--------|
| 0.50 | PASS | PASS |
| 0.75 | PASS | FAIL (TPOT) |
| 1.00 | PASS | FAIL (TTFT+TPOT) |
| 1.25 | PASS | FAIL (TTFT+TPOT) |
| 1.50 | PASS | FAIL (TTFT+TPOT) |
| 2.00 | PASS | FAIL (TTFT+TPOT) |
| 2.50 | FAIL (TPOT) | FAIL (TTFT+TPOT) |
| 3.00 | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) |

## Winner Identification

| Label | Max SLO-Compliant Rate | Capacity vs Baseline |
|-------|:----------------------:|:--------------------:|
| phase0 | 2.00 | — |
| phase3-eagle3-chat **WINNER** | 0.50 | -75% |

**No combo improved over baseline.**

## Detailed Comparison at Baseline Max Rate (2.00 RPS)

| Metric | phase0 | phase3-eagle3-chat |
|--------|--------:|--------:|
| TTFT p50 (ms) | 130 | 58868 |
| TTFT p95 (ms) | 605 | 118941 |
| TTFT p99 (ms) | 953 | 122767 |
| TPOT p50 (ms) | 45 | 74 |
| TPOT p95 (ms) | 48 | 76 |
| TPOT p99 (ms) | 49 | 78 |
| ITL p50 (ms) | 38 | 65 |
| ITL p99 (ms) | 232 | 315 |
| Max Concurrent | 59 | 197 |
| Output tok/s | 867 | 784 |
| Completed | 300 | 300 |
| Failed | 0 | 0 |

## Key Observations

### EAGLE-3 Acceptance Rate: Still Near-Zero (0.01%)

The chat endpoint (`/v1/chat/completions`) did **not** fix the EAGLE-3 acceptance rate. Warmup shows 0.01% acceptance (2 accepted tokens out of 25,182 drafted) — essentially identical to the previous run with `/v1/completions` (0.009%). The hypothesis that the completions endpoint bypassed the chat template, causing hidden-state mismatch, is **disproven**.

### Root Cause Remains Unknown

Possible explanations for the near-zero acceptance rate:

1. **Model mismatch**: The EAGLE-3 drafter (`yuhuili/EAGLE3-LLaMA3.3-Instruct-70B`) was trained on Llama 3.3 70B weights, but the target is `nvidia/Llama-3.3-70B-Instruct-FP8` (FP8-quantized). FP8 quantization changes weight values, producing different hidden states than the BF16 weights the drafter was trained on. This is the most likely explanation.
2. **vLLM EAGLE-3 implementation bug**: The `eagle3` method in vLLM may have issues with the verification loop or d2t projection for this model combination.
3. **Token alignment**: The drafter's `draft_vocab_size: 32000` vs target's full vocabulary could cause misalignment.

### Performance Impact: Severe Degradation

EAGLE-3 with near-zero acceptance acts as **pure overhead** — the draft model runs on every decode step, generating 3 candidate tokens that are all rejected. This manifests as:

- **TPOT p50**: 34.8ms → 74.3ms at 0.5 RPS (+113% vs baseline's 25ms). Each decode step runs both draft and verify for no benefit.
- **TTFT**: Comparable at low rates (119ms vs 130ms at 0.5 RPS), but explodes at ≥1.0 RPS due to queuing from the slower decode throughput.
- **Throughput ceiling**: Saturates at ~792 tok/s (vs baseline scaling to 1,110 tok/s at 3.0 RPS). The draft model consumes GPU compute without producing extra tokens.
- **Max SLO rate**: 0.50 RPS vs 2.00 RPS baseline (**-75% capacity**). Identical to the previous completions-endpoint run.
- **Concurrency**: 2-4x higher concurrent requests at every rate, indicating requests are backing up due to slower processing.

### KV Cache Impact

KV cache reduced from 53.15 GiB (baseline) to 50.09 GiB with the EAGLE-3 drafter loaded — a 3.06 GiB reduction for the drafter's parameters. This is a minor factor; the performance degradation is dominated by the wasted draft compute.

### Conclusion

EAGLE-3 speculative decoding with `yuhuili/EAGLE3-LLaMA3.3-Instruct-70B` on `nvidia/Llama-3.3-70B-Instruct-FP8` is **not viable** in its current form. The near-zero acceptance rate makes it strictly worse than no speculation. Potential next steps:

1. **Test with BF16 target model** to confirm FP8 quantization is the root cause (requires 2x GPU memory).
2. **Try a different EAGLE drafter** trained on FP8 weights or a quantization-aware drafter.
3. **Fall back to draft-model speculative decoding** (Llama 8B draft → 70B target) which showed ~198ms ITL p50 in Phase 2 TRT-LLM benchmarks.
4. **Abandon EAGLE-3 for this deployment** and focus on KV-aware routing as the primary latency optimization.

## Workload Parameters

| Parameter | Value |
|-----------|-------|
| Tool | `vllm bench serve` (vLLM 0.14.1) |
| Dataset | Custom multi-turn conversations (avg ~5,806 input tokens) |
| Prompts per Rate | 300 |
| Request Rates | 0.50, 0.75, 1.00, 1.25, 1.50, 2.00, 2.50, 3.00 RPS |
| Arrival Distribution | Poisson (burstiness=1.0) |
| Warm-up | 10 prompts at 0.5 RPS, 15s cooldown |
| Cooldown Between Rates | 30s |

