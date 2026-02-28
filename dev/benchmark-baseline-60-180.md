# Baseline Benchmark: KV Cache Routing vs Round-Robin (Averaged)

**Generated:** 2026-02-28 15:10:52 UTC

**Averaged across 6 sweeps** for statistical confidence.

Source sweeps:
- `benchmark-reference-20260226-214226.json`
- `benchmark-reference-20260227-011550.json`
- `benchmark-reference-20260227-031723.json`
- `benchmark-reference-20260227-225527.json`
- `benchmark-reference-20260227-225529.json`
- `benchmark-reference-20260227-225531.json`

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 60, 80, 100, 120, 140, 160, 180
- **Target RPS:** 10.0
- **Warmup:** 60s per level (Summary window flush)
- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)
- **Workload:** Multi-turn chat (3-5 turns per conversation)
- **Sweeps:** 6 independent runs, results averaged
- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)

## Deployment Details

| Parameter | Value |
|:----------|:------|
| Model | Llama 3.1 70B Instruct FP8 |
| GPU | 3x H200 (3 nodes) |
| Workers | 3x TP=1 |
| Backend | TensorRT-LLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |
| Max batch size | 64 |
| Free GPU memory fraction | 0.90 |
| KV cache dtype | FP8 |
| Chunked prefill | Enabled |

## Results

| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|
| 60 | 274ms | 249ms | 9.3% | 655ms | 446ms | 32.0% | 90.9% | 91.6% |
| 80 | 306ms | 267ms | 12.8% | 637ms | 508ms | 20.2% | 85.3% | 95.7% |
| 100 | 342ms | 329ms | 3.9% | 652ms | 547ms | 16.2% | 88.5% | 96.1% |
| 120 | 375ms | 382ms | -2.0% | 643ms | 530ms | 17.6% | 87.2% | 95.9% |
| 140 | 398ms | 415ms | -4.1% | 643ms | 650ms | -1.1% | 83.9% | 91.2% |
| 160 | 422ms | 424ms | -0.5% | 722ms | 704ms | 2.5% | 90.1% | 95.3% |
| 180 | 413ms | 472ms | -14.1% | 732ms | 3143ms | -329.6% | 88.9% | 94.0% |

### TPOT — Time Per Output Token

Derived as `(Latency - TTFT) / (TOPS / RPS)` — decode time divided by average output tokens per request.

| Concurrency | RR TPOT p50 | KV TPOT p50 | p50 Improvement | RR TPOT p95 | KV TPOT p95 | p95 Improvement |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|
| 60 | 29ms | 27ms | 6.9% | 36ms | 31ms | 13.9% |
| 80 | 33ms | 30ms | 9.1% | 38ms | 37ms | 2.6% |
| 100 | 37ms | 36ms | 2.7% | 56ms | 49ms | 12.5% |
| 120 | 47ms | 47ms | 0.0% | 57ms | 59ms | -3.5% |
| 140 | 53ms | 44ms | 17.0% | 61ms | 54ms | 11.5% |
| 160 | 52ms | 47ms | 9.6% | 64ms | 55ms | 14.1% |
| 180 | 55ms | 48ms | 12.7% | 64ms | 54ms | 15.6% |

### Throughput and Actual RPS

| Concurrency | RR TOPS | KV TOPS | Improvement | RR RPS | KV RPS |
|:-----------:|:-------:|:-------:|:-----------:|:------:|:------:|
| 60 | 2146.9 | 2262.8 | 5.4% | 2.60 | 2.57 |
| 80 | 2543.2 | 2742.3 | 7.8% | 2.93 | 3.17 |
| 100 | 2547.5 | 2780.1 | 9.1% | 2.96 | 3.19 |
| 120 | 2642.6 | 2805.7 | 6.2% | 3.05 | 3.53 |
| 140 | 2816.8 | 3167.8 | 12.5% | 3.29 | 3.68 |
| 160 | 3126.8 | 3471.8 | 11.0% | 3.66 | 4.06 |
| 180 | 3434.0 | 3907.7 | 13.8% | 4.10 | 4.61 |

### ITL -- Inter-Token Latency

| Concurrency | RR ITL p50 | KV ITL p50 | RR ITL p95 | KV ITL p95 |
|:-----------:|:----------:|:----------:|:----------:|:----------:|
| 60 | 28ms | 26ms | 30ms | 27ms |
| 80 | 31ms | 28ms | 33ms | 33ms |
| 100 | 38ms | 36ms | 48ms | 43ms |
| 120 | 45ms | 43ms | 50ms | 46ms |
| 140 | 49ms | 44ms | 52ms | 46ms |
| 160 | 51ms | 46ms | 54ms | 48ms |
| 180 | 52ms | 45ms | 54ms | 48ms |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 60 | 24636ms | 24326ms | 30114ms | 27674ms |
| 80 | 29269ms | 26575ms | 33357ms | 32526ms |
| 100 | 32060ms | 31812ms | 48957ms | 43614ms |
| 120 | 41154ms | 38095ms | 50363ms | 47221ms |
| 140 | 45682ms | 38712ms | 52955ms | 46715ms |
| 160 | 45178ms | 40771ms | 55427ms | 48144ms |
| 180 | 46065ms | 41433ms | 54570ms | 48657ms |

## Summary

- **Average TTFT p50 improvement (60-180):** 0.8%
- **Peak TTFT p50 improvement:** 12.8% at concurrency 80
- **Average TTFT p95 improvement (60-160):** 14.7% (excluding 180 outlier)
- **Peak TTFT p95 improvement:** 32.0% at concurrency 60
- **KV cache hit rate (KV mode):** 91.2% to 96.1%, average 94.3%
- **KV cache hit rate (RR mode):** 83.9% to 90.9%, average 87.8%
- **KV throughput advantage:** 5.4% to 13.8%, average 9.4%
- **KV ITL advantage (p50):** 5-12% lower across all levels
- **Peak throughput (KV):** 3907.7 tokens/s at concurrency 180
- **Peak throughput (RR):** 3434.0 tokens/s at concurrency 180
