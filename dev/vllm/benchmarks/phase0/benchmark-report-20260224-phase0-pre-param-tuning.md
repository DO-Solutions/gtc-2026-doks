# Combined Benchmark Sweep: vLLM Single Worker Concurrency Scaling (50–120)

**Generated:** 2026-02-24 UTC (combined from two 3x-averaged sweep sessions)

## Test Methodology

- **Routing mode:** Round-robin
- **Concurrency levels:** 50, 60, 70, 80, 90, 100, 110, 120
- **Target RPS:** 10.0
- **Warmup:** 60s per level (Summary window flush)
- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)
- **Repetitions:** 3 sweeps per session, averaged (rows with >5% error excluded)
- **Workload:** Multi-turn chat (3-5 turns per conversation)
- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)

## Deployment Details

| Parameter | Value |
|:----------|:------|
| Model | Llama 3.1 70B Instruct FP8 |
| GPU | 1x H200 (1 node) |
| Workers | 1x TP=1 |
| Backend | vLLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |

## TPOT — Time Per Output Token (ITL)

| Concurrency | TPOT p50 | TPOT p95 | Error % | Valid Runs |
|:-----------:|:--------:|:--------:|:-------:|:----------:|
| 50 | 44ms | 46ms | 0.0% | 3/3 |
| 60 | 47ms | 49ms | 0.0% | 3/3 |
| 70 | 56ms | 57ms | 0.0% | 3/3 |
| 80 | 59ms | 61ms | 0.0% | 3/3 |
| 90 | 67ms | 83ms | 0.0% | 2/3 |
| 100 | 79ms | 86ms | 0.0% | 3/3 |
| 110 | 83ms | 95ms | 1.7% | 3/3 |
| 120 | 84ms | 95ms | 0.0% | 1/3 |

## TTFT — Time to First Token

| Concurrency | TTFT p50 | TTFT p95 |
|:-----------:|:--------:|:--------:|
| 50 | 174ms | 210ms |
| 60 | 186ms | 221ms |
| 70 | 206ms | 249ms |
| 80 | 222ms | 268ms |
| 90 | 231ms | 5815ms |
| 100 | 258ms | 3021ms |
| 110 | 2214ms | 4967ms |
| 120 | 297ms | 2227ms |

## End-to-End Latency

| Concurrency | Latency p50 | Latency p95 |
|:-----------:|:-----------:|:-----------:|
| 50 | 40.6s | 46.6s |
| 60 | 42.7s | 50.2s |
| 70 | 49.9s | 58.5s |
| 80 | 55.6s | 62.0s |
| 90 | 59.3s | 84.1s |
| 100 | 72.9s | 84.5s |
| 110 | 75.7s | 92.4s |
| 120 | 76.7s | 93.6s |

## Error Rates

| Concurrency | Error % | Notes |
|:-----------:|:-------:|:------|
| 50 | 0.0% | |
| 60 | 0.0% | |
| 70 | 0.0% | |
| 80 | 0.0% | |
| 90 | 0.0% | 1 run excluded (33% err, cold-start) |
| 100 | 0.0% | |
| 110 | 1.7% | |
| 120 | 0.0% | 2 runs excluded (7-8% err); only 1 valid run |

## Actual RPS (Conversation Starts/s)

| Concurrency | Actual RPS |
|:-----------:|:----------:|
| 50 | 1.21 |
| 60 | 1.51 |
| 70 | 1.51 |
| 80 | 1.53 |
| 90 | 1.45 |
| 100 | 1.46 |
| 110 | 1.54 |
| 120 | 1.62 |

> **Note:** Actual RPS measures the conversation start rate (`loadgen_requests_total`), not individual turn rate. Each conversation takes 3–5 turns over 40–90s, so the effective start rate is bounded by concurrency ÷ avg conversation duration (~1.2–1.6 conversations/s). The target RPS of 10.0 is never reached because conversations are long-lived — concurrency, not arrival rate, is the binding constraint.

## Analysis

### TPOT Degradation Curve

The TPOT p95 shows a clear degradation curve as concurrency increases:

```
Conc:  50    60    70    80    90   100   110   120
p95:  46ms  49ms  57ms  61ms  83ms  86ms  95ms  95ms
      ───── clean ─────  ──── degrading ────  ─ saturated ─
```

- **50–60**: Comfortable operating range. TPOT p95 under 50ms.
- **70–80**: SLO boundary zone. TPOT p95 hits 57–61ms. Concurrency 70 was previously identified as the SLO ceiling.
- **90–100**: Clear degradation. TPOT p95 jumps to 83–86ms (+36-41% vs concurrency 70).
- **110–120**: Saturated. TPOT p95 plateaus at 95ms. Errors begin appearing (1.7% at 110, 7-8% at 120 in 2/3 runs). TTFT p95 becomes highly variable (multi-second spikes).

### Key Findings

1. **TPOT p50 nearly doubles** from 44ms (conc 50) to 84ms (conc 120) — a 1.9x increase.
2. **TPOT p95 more than doubles** from 46ms to 95ms — a 2.1x increase.
3. **The sharpest jump** is between concurrency 80 and 90 (61ms → 83ms p95, +36%).
4. **TTFT becomes unstable** above concurrency 90 — p95 spikes to multi-second values while p50 remains ~230-260ms, indicating intermittent queuing.
5. **Error rates** emerge at concurrency 110+ and become persistent at 120, where 2/3 runs exceeded 5% errors.
6. **End-to-end latency p95** roughly doubles from 47s (conc 50) to 94s (conc 120).
7. **Actual RPS is flat at ~1.2–1.6 conversations/s** across all concurrency levels — the system is concurrency-bound, not arrival-rate-bound. Higher concurrency increases queue depth and latency but barely increases throughput.

### Source Data

- **Concurrency 50–80**: `dev/benchmark-report-20260224-141349.md` (3x averaged sweep)
- **Concurrency 90–120**: `dev/benchmark-report-20260224-161901.md` (3x averaged sweep)
