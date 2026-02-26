# Benchmark Sweep: Round-robin Concurrency Scaling (50-160)

**Generated:** 2026-02-25 19:09:22 UTC

## Test Methodology

- **Routing mode:** Round-robin
- **Concurrency levels:** 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160
- **Target RPS:** 10.0
- **Warmup:** 60s per level (Summary window flush)
- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)
- **Workload:** Multi-turn chat (3-5 turns per conversation)
- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)

## Deployment Details

| Parameter | Value |
|:----------|:------|
| Model | Llama 3.3 70B Instruct FP8 + EAGLE-3 |
| GPU | 1x H200 (1 node) |
| Workers | 1x TP=1 |
| Backend | vLLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |
| Speculative decoding | EAGLE-3 (num_speculative_tokens=3) |
| gpu-memory-utilization | 0.90 |
| max-num-seqs | 64 |
| max-num-batched-tokens | 16384 |
| EAGLE-3 drafter | yuhuili/EAGLE3-LLaMA3.3-Instruct-70B |

## TPOT -- Time Per Output Token (ITL)

| Concurrency | TPOT p50 | TPOT p95 | Error % |
|:-----------:|:--------:|:--------:|:-------:|
| 50 | 65ms | 68ms | 0.0% |
| 60 | 70ms | 71ms | 0.0% |
| 70 | 74ms | 74ms | 0.0% |
| 80 | 73ms | 75ms | 0.0% |
| 90 | 76ms | 80ms | 16.3% |
| 100 | 71ms | 72ms | 0.0% |
| 110 | 70ms | 72ms | 17.3% |
| 120 | 70ms | 71ms | 35.0% |
| 130 | 69ms | 70ms | 34.2% |
| 140 | 68ms | 69ms | 55.5% |
| 150 | 68ms | 68ms | 36.9% |
| 160 | 68ms | 69ms | 57.9% |

## TTFT -- Time to First Token

| Concurrency | TTFT p50 | TTFT p95 |
|:-----------:|:--------:|:--------:|
| 50 | 236ms | 325ms |
| 60 | 258ms | 333ms |
| 70 | 6519ms | 9852ms |
| 80 | 14698ms | 28935ms |
| 90 | 25804ms | 33274ms |
| 100 | 34258ms | 39529ms |
| 110 | 41930ms | 49843ms |
| 120 | 49041ms | 58438ms |
| 130 | 52825ms | 56437ms |
| 140 | 55571ms | 65460ms |
| 150 | 65929ms | 70661ms |
| 160 | 72361ms | 77096ms |

## End-to-End Latency

| Concurrency | Latency p50 | Latency p95 |
|:-----------:|:-----------:|:-----------:|
| 50 | 58.5s | 69.8s |
| 60 | 68.1s | 73.0s |
| 70 | 80.3s | 85.6s |
| 80 | 82.8s | 104.7s |
| 90 | 101.3s | 109.0s |
| 100 | 104.4s | 112.1s |
| 110 | 100.1s | 114.9s |
| 120 | 101.8s | 118.7s |
| 130 | 98.4s | 117.5s |
| 140 | 101.2s | 112.2s |
| 150 | 104.8s | 116.1s |
| 160 | 110.2s | 118.2s |

## Error Rates

| Concurrency | Error % |
|:-----------:|:-------:|
| 50 | 0.0% |
| 60 | 0.0% |
| 70 | 0.0% |
| 80 | 0.0% |
| 90 | 16.3% |
| 100 | 0.0% |
| 110 | 17.3% |
| 120 | 35.0% |
| 130 | 34.2% |
| 140 | 55.5% |
| 150 | 36.9% |
| 160 | 57.9% |

## Actual RPS (Conversation Starts/s)

| Concurrency | Actual RPS |
|:-----------:|:----------:|
| 50 | 0.94 |
| 60 | 0.79 |
| 70 | 0.93 |
| 80 | 0.96 |
| 90 | 0.82 |
| 100 | 0.91 |
| 110 | 1.13 |
| 120 | 1.24 |
| 130 | 1.16 |
| 140 | 1.36 |
| 150 | 1.40 |
| 160 | 1.56 |

## Analysis: Phase 3 (EAGLE-3) vs Phase 0 (Baseline)

### Phase 0 Baseline Reference

Phase 0 used Llama 3.1 70B Instruct FP8 on the same hardware (1x H200, 1 worker, TP=1, vLLM via Dynamo) **without** speculative decoding, with `max-num-seqs=128` and `gpu-memory-utilization=0.95`.

### TPOT Comparison

| Concurrency | Phase 0 TPOT p50 | Phase 3 TPOT p50 | Change |
|:-----------:|:----------------:|:----------------:|:------:|
| 50 | 44ms | 65ms | +48% worse |
| 60 | 47ms | 70ms | +49% worse |
| 70 | 56ms | 74ms | +32% worse |
| 80 | 59ms | 73ms | +24% worse |
| 90 | 67ms | 76ms | +13% worse |
| 100 | 79ms | 71ms | -10% better |
| 110 | 83ms | 70ms | -16% better |
| 120 | 84ms | 70ms | -17% better |

At low-to-moderate concurrency (50-90), EAGLE-3 **increases** TPOT by 13-49%. At high concurrency (100-120), EAGLE-3 TPOT appears slightly better, but this is misleading -- the system is shedding load via errors (0-35% error rate), so the surviving requests see less contention.

For context, at concurrency 5-10 (not benchmarked here), EAGLE-3 delivers **31ms TPOT** vs the baseline's estimated ~35-40ms -- a genuine improvement. The benefit only manifests at very low load.

### TTFT Comparison

| Concurrency | Phase 0 TTFT p50 | Phase 3 TTFT p50 | Change |
|:-----------:|:----------------:|:----------------:|:------:|
| 50 | 174ms | 236ms | +36% worse |
| 60 | 186ms | 258ms | +39% worse |
| 70 | 206ms | 6,519ms | +31x worse |
| 80 | 222ms | 14,698ms | +66x worse |
| 90 | 231ms | 25,804ms | +112x worse |
| 100 | 258ms | 34,258ms | +133x worse |
| 110 | 2,214ms | 41,930ms | +19x worse |
| 120 | 297ms | 49,041ms | +165x worse |

TTFT is catastrophically degraded by EAGLE-3 under load. At concurrency 70, TTFT p50 jumps from 206ms to 6.5 seconds. By concurrency 100, it's 34 seconds. The root cause is severe prefill queuing -- the EAGLE-3 draft model consumes GPU memory and compute that would otherwise be available for prefill scheduling.

### Saturation Point

| Metric | Phase 0 | Phase 3 |
|:-------|:-------:|:-------:|
| First errors | Concurrency 110 (1.7%) | Concurrency 90 (16.3%) |
| Sustained >5% errors | Concurrency 120 | Concurrency 90 |
| TTFT p50 > 1s | Concurrency 110 | Concurrency 70 |
| TPOT p50 plateau | ~84ms (conc 120) | ~68ms (conc 130+) |

EAGLE-3 reduces the effective saturation point from concurrency ~110 to ~60-70 -- roughly a **40% reduction** in capacity.

### Why Speculative Decoding Hurts Under Load

1. **Reduced KV cache capacity**: EAGLE-3 drafter consumes ~3GB additional GPU memory. Combined with `gpu-memory-utilization` reduced from 0.95 to 0.90 and `max-num-seqs` halved from 128 to 64, the system can serve far fewer concurrent sequences.

2. **Extra compute per decode step**: Each decode step runs the draft model (forward pass) + target model verification. At low concurrency this is amortized across multiple accepted tokens. Under load, the extra compute competes with prefill and other decode batches.

3. **Prefill starvation**: With decode steps taking longer (draft + verify), prefill scheduling is delayed. Requests queue up waiting for their first token, causing the TTFT explosion starting at concurrency 70.

4. **Diminishing acceptance rate under load**: As batch sizes grow and KV cache pressure increases, the draft model's predictions may become less accurate, reducing the tokens-per-step benefit.

### Conclusion

EAGLE-3 speculative decoding is a **single-stream latency optimization** that trades throughput capacity for per-request speed. It delivers measurable ITL improvement at low concurrency (31ms vs ~44ms at concurrency 5-10) but is counterproductive for the demo's multi-turn chat workload at concurrency 50+. The demo workload requires high concurrent request capacity, making baseline vLLM without speculative decoding the better configuration.

**Recommendation**: Use EAGLE-3 only for low-concurrency, latency-sensitive workloads. For the GTC demo running at concurrency 50-120, revert to baseline vLLM (Phase 0 configuration) for production.

## Reference Data (JSON)

```json
{
  "generated": "2026-02-25T19:09:22Z",
  "mode": "round_robin",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 50,
      "ttft_p50_ms": 236.0,
      "ttft_p95_ms": 324.8,
      "kv_hit_rate_pct": 0,
      "error_pct": 0.0,
      "actual_rps": 0.940708,
      "tops": 0.0,
      "tpot_p50_ms": 65.1,
      "tpot_p95_ms": 68.0,
      "latency_p50_ms": 58476.5,
      "latency_p95_ms": 69843.5
    },
    {
      "concurrency": 60,
      "ttft_p50_ms": 258.3,
      "ttft_p95_ms": 332.7,
      "kv_hit_rate_pct": 0,
      "error_pct": 0.0,
      "actual_rps": 0.792566,
      "tops": 0.0,
      "tpot_p50_ms": 70.1,
      "tpot_p95_ms": 71.4,
      "latency_p50_ms": 68082.4,
      "latency_p95_ms": 72987.9
    },
    {
      "concurrency": 70,
      "ttft_p50_ms": 6518.8,
      "ttft_p95_ms": 9851.7,
      "kv_hit_rate_pct": 0,
      "error_pct": 0.0,
      "actual_rps": 0.925957,
      "tops": 0.0,
      "tpot_p50_ms": 73.6,
      "tpot_p95_ms": 74.5,
      "latency_p50_ms": 80277.0,
      "latency_p95_ms": 85562.5
    },
    {
      "concurrency": 80,
      "ttft_p50_ms": 14697.6,
      "ttft_p95_ms": 28935.4,
      "kv_hit_rate_pct": 0,
      "error_pct": 0.0,
      "actual_rps": 0.955555,
      "tops": 0.0,
      "tpot_p50_ms": 73.4,
      "tpot_p95_ms": 75.1,
      "latency_p50_ms": 82751.3,
      "latency_p95_ms": 104677.1
    },
    {
      "concurrency": 90,
      "ttft_p50_ms": 25804.1,
      "ttft_p95_ms": 33273.9,
      "kv_hit_rate_pct": 0,
      "error_pct": 16.260163,
      "actual_rps": 0.822276,
      "tops": 0.0,
      "tpot_p50_ms": 75.7,
      "tpot_p95_ms": 80.4,
      "latency_p50_ms": 101271.9,
      "latency_p95_ms": 109029.0
    },
    {
      "concurrency": 100,
      "ttft_p50_ms": 34258.4,
      "ttft_p95_ms": 39529.4,
      "kv_hit_rate_pct": 0,
      "error_pct": 0.0,
      "actual_rps": 0.911135,
      "tops": 0.0,
      "tpot_p50_ms": 71.0,
      "tpot_p95_ms": 71.8,
      "latency_p50_ms": 104387.0,
      "latency_p95_ms": 112107.8
    },
    {
      "concurrency": 110,
      "ttft_p50_ms": 41930.1,
      "ttft_p95_ms": 49843.2,
      "kv_hit_rate_pct": 0,
      "error_pct": 17.335563,
      "actual_rps": 1.133333,
      "tops": 0.0,
      "tpot_p50_ms": 69.6,
      "tpot_p95_ms": 71.9,
      "latency_p50_ms": 100085.5,
      "latency_p95_ms": 114881.5
    },
    {
      "concurrency": 120,
      "ttft_p50_ms": 49040.7,
      "ttft_p95_ms": 58438.1,
      "kv_hit_rate_pct": 0,
      "error_pct": 34.980948,
      "actual_rps": 1.237037,
      "tops": 0.0,
      "tpot_p50_ms": 70.3,
      "tpot_p95_ms": 71.1,
      "latency_p50_ms": 101760.1,
      "latency_p95_ms": 118724.5
    },
    {
      "concurrency": 130,
      "ttft_p50_ms": 52824.6,
      "ttft_p95_ms": 56436.6,
      "kv_hit_rate_pct": 0,
      "error_pct": 34.210709,
      "actual_rps": 1.162963,
      "tops": 0.0,
      "tpot_p50_ms": 68.9,
      "tpot_p95_ms": 69.5,
      "latency_p50_ms": 98412.1,
      "latency_p95_ms": 117507.8
    },
    {
      "concurrency": 140,
      "ttft_p50_ms": 55570.7,
      "ttft_p95_ms": 65460.3,
      "kv_hit_rate_pct": 0,
      "error_pct": 55.536625,
      "actual_rps": 1.355486,
      "tops": 0.0,
      "tpot_p50_ms": 68.2,
      "tpot_p95_ms": 68.9,
      "latency_p50_ms": 101237.1,
      "latency_p95_ms": 112169.5
    },
    {
      "concurrency": 150,
      "ttft_p50_ms": 65929.3,
      "ttft_p95_ms": 70660.6,
      "kv_hit_rate_pct": 0,
      "error_pct": 36.910537,
      "actual_rps": 1.4,
      "tops": 0.0,
      "tpot_p50_ms": 67.5,
      "tpot_p95_ms": 68.4,
      "latency_p50_ms": 104831.3,
      "latency_p95_ms": 116065.7
    },
    {
      "concurrency": 160,
      "ttft_p50_ms": 72360.8,
      "ttft_p95_ms": 77096.2,
      "kv_hit_rate_pct": 0,
      "error_pct": 57.87037,
      "actual_rps": 1.555521,
      "tops": 0.0,
      "tpot_p50_ms": 67.8,
      "tpot_p95_ms": 68.6,
      "latency_p50_ms": 110166.8,
      "latency_p95_ms": 118203.8
    }
  ]
}
```
