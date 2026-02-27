# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-27 03:17:23 UTC

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 40, 50, 60, 70, 80, 90, 100, 110, 120
- **Target RPS:** 10.0
- **Warmup:** per level (Summary window flush)
- **Measurement:** 3 snapshots averaged per level
- **Workload:** Multi-turn chat (3-5 turns per conversation)
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
| 40 | 271ms | 223ms | 17.9% | 678ms | 371ms | 45.3% | 99.7% | 100.0% |
| 50 | 256ms | 232ms | 9.0% | 663ms | 469ms | 29.2% | 94.9% | 93.1% |
| 60 | 280ms | 246ms | 12.2% | 657ms | 438ms | 33.3% | 92.0% | 93.2% |
| 70 | 284ms | 252ms | 11.4% | 611ms | 479ms | 21.5% | 89.2% | 97.4% |
| 80 | 310ms | 269ms | 13.3% | 614ms | 572ms | 6.7% | 82.2% | 96.4% |
| 90 | 320ms | 274ms | 14.4% | 614ms | 470ms | 23.5% | 89.0% | 96.7% |
| 100 | 354ms | 338ms | 4.4% | 658ms | 530ms | 19.4% | 87.9% | 94.6% |
| 110 | 348ms | 392ms | -12.7% | 646ms | 507ms | 21.6% | 88.7% | 96.2% |
| 120 | 379ms | 375ms | 1.2% | 646ms | 532ms | 17.6% | 85.5% | 94.9% |

### Error Rates

| Concurrency | RR Error % | KV Error % |
|:-----------:|:----------:|:----------:|
| 40 | 0.0% | 0.0% |
| 50 | 0.0% | 0.0% |
| 60 | 0.0% | 0.0% |
| 70 | 0.0% | 0.0% |
| 80 | 0.0% | 0.0% |
| 90 | 0.0% | 0.0% |
| 100 | 0.0% | 0.0% |
| 110 | 0.0% | 0.0% |
| 120 | 0.0% | 0.0% |

### Throughput (Output Tokens/s)

| Concurrency | RR TOPS | KV TOPS |
|:-----------:|:-------:|:-------:|
| 40 | 1591.1 | 1615.8 |
| 50 | 1902.4 | 1984.6 |
| 60 | 2147.9 | 2260.6 |
| 70 | 2309.5 | 2504.0 |
| 80 | 2508.0 | 2757.1 |
| 90 | 2522.8 | 2783.6 |
| 100 | 2521.0 | 2773.1 |
| 110 | 2599.6 | 2719.8 |
| 120 | 2648.4 | 2816.0 |

### TPOT -- Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 40 | 25ms | 24ms | 28ms | 26ms |
| 50 | 26ms | 25ms | 28ms | 26ms |
| 60 | 28ms | 26ms | 29ms | 27ms |
| 70 | 30ms | 28ms | 33ms | 29ms |
| 80 | 31ms | 29ms | 33ms | 32ms |
| 90 | 31ms | 30ms | 48ms | 41ms |
| 100 | 39ms | 36ms | 49ms | 43ms |
| 110 | 45ms | 40ms | 52ms | 46ms |
| 120 | 44ms | 42ms | 51ms | 46ms |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 40 | 21808ms | 19906ms | 28452ms | 25662ms |
| 50 | 22952ms | 23078ms | 28553ms | 26521ms |
| 60 | 24211ms | 24562ms | 30001ms | 27603ms |
| 70 | 26575ms | 25462ms | 33449ms | 29213ms |
| 80 | 29686ms | 25789ms | 33853ms | 31644ms |
| 90 | 30007ms | 28896ms | 48410ms | 39880ms |
| 100 | 32388ms | 31639ms | 48678ms | 43382ms |
| 110 | 35548ms | 36687ms | 52871ms | 46969ms |
| 120 | 41752ms | 38703ms | 52263ms | 46882ms |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-27T03:17:23Z",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 271.4,
        "ttft_p95_ms": 677.7,
        "kv_hit_rate_pct": 99.7,
        "tops": 1591.052529,
        "tpot_p50_ms": 25.3,
        "tpot_p95_ms": 27.6,
        "latency_p50_ms": 21807.7,
        "latency_p95_ms": 28451.8
      },
      "kv_aware": {
        "ttft_p50_ms": 222.7,
        "ttft_p95_ms": 370.9,
        "kv_hit_rate_pct": 100.0,
        "tops": 1615.820497,
        "tpot_p50_ms": 24.4,
        "tpot_p95_ms": 25.5,
        "latency_p50_ms": 19906.5,
        "latency_p95_ms": 25662.1
      }
    },
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 255.5,
        "ttft_p95_ms": 662.9,
        "kv_hit_rate_pct": 94.9,
        "tops": 1902.448428,
        "tpot_p50_ms": 26.1,
        "tpot_p95_ms": 28.0,
        "latency_p50_ms": 22951.8,
        "latency_p95_ms": 28552.6
      },
      "kv_aware": {
        "ttft_p50_ms": 232.5,
        "ttft_p95_ms": 469.4,
        "kv_hit_rate_pct": 93.1,
        "tops": 1984.644292,
        "tpot_p50_ms": 25.1,
        "tpot_p95_ms": 26.2,
        "latency_p50_ms": 23077.5,
        "latency_p95_ms": 26521.1
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 280.5,
        "ttft_p95_ms": 657.4,
        "kv_hit_rate_pct": 92.0,
        "tops": 2147.948148,
        "tpot_p50_ms": 27.7,
        "tpot_p95_ms": 29.4,
        "latency_p50_ms": 24211.2,
        "latency_p95_ms": 30001.0
      },
      "kv_aware": {
        "ttft_p50_ms": 246.4,
        "ttft_p95_ms": 438.2,
        "kv_hit_rate_pct": 93.2,
        "tops": 2260.557917,
        "tpot_p50_ms": 26.2,
        "tpot_p95_ms": 27.1,
        "latency_p50_ms": 24561.8,
        "latency_p95_ms": 27602.6
      }
    },
    {
      "concurrency": 70,
      "round_robin": {
        "ttft_p50_ms": 284.2,
        "ttft_p95_ms": 610.6,
        "kv_hit_rate_pct": 89.2,
        "tops": 2309.542729,
        "tpot_p50_ms": 30.1,
        "tpot_p95_ms": 32.9,
        "latency_p50_ms": 26575.2,
        "latency_p95_ms": 33449.2
      },
      "kv_aware": {
        "ttft_p50_ms": 251.7,
        "ttft_p95_ms": 479.4,
        "kv_hit_rate_pct": 97.4,
        "tops": 2503.985078,
        "tpot_p50_ms": 27.6,
        "tpot_p95_ms": 28.8,
        "latency_p50_ms": 25462.0,
        "latency_p95_ms": 29213.3
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 310.2,
        "ttft_p95_ms": 613.5,
        "kv_hit_rate_pct": 82.2,
        "tops": 2507.962963,
        "tpot_p50_ms": 30.7,
        "tpot_p95_ms": 33.2,
        "latency_p50_ms": 29685.9,
        "latency_p95_ms": 33852.6
      },
      "kv_aware": {
        "ttft_p50_ms": 268.8,
        "ttft_p95_ms": 572.4,
        "kv_hit_rate_pct": 96.4,
        "tops": 2757.148148,
        "tpot_p50_ms": 28.6,
        "tpot_p95_ms": 32.4,
        "latency_p50_ms": 25788.6,
        "latency_p95_ms": 31643.6
      }
    },
    {
      "concurrency": 90,
      "round_robin": {
        "ttft_p50_ms": 320.2,
        "ttft_p95_ms": 613.7,
        "kv_hit_rate_pct": 89.0,
        "tops": 2522.803245,
        "tpot_p50_ms": 30.7,
        "tpot_p95_ms": 47.8,
        "latency_p50_ms": 30007.4,
        "latency_p95_ms": 48410.3
      },
      "kv_aware": {
        "ttft_p50_ms": 274.0,
        "ttft_p95_ms": 469.6,
        "kv_hit_rate_pct": 96.7,
        "tops": 2783.602245,
        "tpot_p50_ms": 30.1,
        "tpot_p95_ms": 41.2,
        "latency_p50_ms": 28896.1,
        "latency_p95_ms": 39880.2
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 353.8,
        "ttft_p95_ms": 658.4,
        "kv_hit_rate_pct": 87.9,
        "tops": 2521.007408,
        "tpot_p50_ms": 39.2,
        "tpot_p95_ms": 48.7,
        "latency_p50_ms": 32388.0,
        "latency_p95_ms": 48678.3
      },
      "kv_aware": {
        "ttft_p50_ms": 338.3,
        "ttft_p95_ms": 530.5,
        "kv_hit_rate_pct": 94.6,
        "tops": 2773.080264,
        "tpot_p50_ms": 35.5,
        "tpot_p95_ms": 43.1,
        "latency_p50_ms": 31638.6,
        "latency_p95_ms": 43382.4
      }
    },
    {
      "concurrency": 110,
      "round_robin": {
        "ttft_p50_ms": 348.0,
        "ttft_p95_ms": 645.9,
        "kv_hit_rate_pct": 88.7,
        "tops": 2599.640072,
        "tpot_p50_ms": 44.7,
        "tpot_p95_ms": 51.7,
        "latency_p50_ms": 35548.5,
        "latency_p95_ms": 52871.4
      },
      "kv_aware": {
        "ttft_p50_ms": 392.1,
        "ttft_p95_ms": 506.6,
        "kv_hit_rate_pct": 96.2,
        "tops": 2719.842627,
        "tpot_p50_ms": 40.4,
        "tpot_p95_ms": 46.1,
        "latency_p50_ms": 36686.6,
        "latency_p95_ms": 46968.9
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 379.3,
        "ttft_p95_ms": 646.1,
        "kv_hit_rate_pct": 85.5,
        "tops": 2648.377778,
        "tpot_p50_ms": 44.3,
        "tpot_p95_ms": 51.2,
        "latency_p50_ms": 41752.1,
        "latency_p95_ms": 52262.9
      },
      "kv_aware": {
        "ttft_p50_ms": 374.8,
        "ttft_p95_ms": 532.3,
        "kv_hit_rate_pct": 94.9,
        "tops": 2815.964199,
        "tpot_p50_ms": 41.8,
        "tpot_p95_ms": 45.9,
        "latency_p50_ms": 38702.9,
        "latency_p95_ms": 46882.2
      }
    }
  ]
}
```

## Summary

- **TTFT p50 improvement at lowest concurrency (40):** 17.9%
- **TTFT p50 improvement at highest concurrency (120):** 1.2%
- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency (17.9% at 40 -> 1.2% at 120). This may indicate cache pressure at higher loads.
- **Peak benefit:** Concurrency 40 shows the maximum p50 improvement at 17.9%.
- **KV cache hit rate (KV mode):** 93.1% (at 50) to 100.0% (at 40), average 95.8%.
- **KV cache hit rate (RR mode):** 82.2% (at 80) to 99.7% (at 40), average 89.9%.
