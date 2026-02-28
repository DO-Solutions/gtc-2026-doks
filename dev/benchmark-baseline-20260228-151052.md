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
- **Concurrency levels:** 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180
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
| 40 | 266ms | 247ms | 7.1% | 660ms | 446ms | 32.4% | 99.7% | 99.2% |
| 50 | 256ms | 244ms | 4.9% | 646ms | 446ms | 30.9% | 94.2% | 95.7% |
| 60 | 274ms | 249ms | 9.3% | 655ms | 446ms | 32.0% | 90.9% | 91.6% |
| 70 | 292ms | 260ms | 10.9% | 622ms | 494ms | 20.5% | 90.1% | 96.2% |
| 80 | 306ms | 267ms | 12.8% | 637ms | 508ms | 20.2% | 85.3% | 95.7% |
| 90 | 320ms | 289ms | 9.7% | 634ms | 501ms | 20.9% | 87.9% | 95.2% |
| 100 | 342ms | 329ms | 3.9% | 652ms | 547ms | 16.2% | 88.5% | 96.1% |
| 110 | 354ms | 355ms | -0.2% | 642ms | 515ms | 19.7% | 88.3% | 96.3% |
| 120 | 375ms | 382ms | -2.0% | 643ms | 530ms | 17.6% | 87.2% | 95.9% |
| 130 | 387ms | 385ms | 0.4% | 557ms | 521ms | 6.4% | 84.0% | 88.9% |
| 140 | 398ms | 415ms | -4.1% | 643ms | 650ms | -1.1% | 83.9% | 91.2% |
| 150 | 397ms | 423ms | -6.6% | 638ms | 690ms | -8.0% | 85.0% | 93.7% |
| 160 | 422ms | 424ms | -0.5% | 722ms | 704ms | 2.5% | 90.1% | 95.3% |
| 170 | 416ms | 430ms | -3.3% | 708ms | 1256ms | -77.4% | 85.4% | 94.9% |
| 180 | 413ms | 472ms | -14.1% | 732ms | 3143ms | -329.6% | 88.9% | 94.0% |

### Throughput (Output Tokens/s)

| Concurrency | RR TOPS | KV TOPS | Improvement |
|:-----------:|:-------:|:-------:|:-----------:|
| 40 | 1587.8 | 1616.8 | 1.8% |
| 50 | 1894.6 | 1976.1 | 4.3% |
| 60 | 2146.9 | 2262.8 | 5.4% |
| 70 | 2361.7 | 2513.6 | 6.4% |
| 80 | 2543.2 | 2742.3 | 7.8% |
| 90 | 2508.0 | 2836.6 | 13.1% |
| 100 | 2547.5 | 2780.1 | 9.1% |
| 110 | 2620.6 | 2732.2 | 4.3% |
| 120 | 2642.6 | 2805.7 | 6.2% |
| 130 | 2784.4 | 2943.4 | 5.7% |
| 140 | 2816.8 | 3167.8 | 12.5% |
| 150 | 2966.5 | 3341.1 | 12.6% |
| 160 | 3126.8 | 3471.8 | 11.0% |
| 170 | 3207.9 | 3656.5 | 14.0% |
| 180 | 3434.0 | 3907.7 | 13.8% |

### ITL -- Inter-Token Latency

| Concurrency | RR ITL p50 | KV ITL p50 | RR ITL p95 | KV ITL p95 |
|:-----------:|:----------:|:----------:|:----------:|:----------:|
| 40 | 25ms | 25ms | 28ms | 26ms |
| 50 | 26ms | 25ms | 28ms | 26ms |
| 60 | 28ms | 26ms | 30ms | 27ms |
| 70 | 30ms | 27ms | 31ms | 28ms |
| 80 | 31ms | 28ms | 33ms | 33ms |
| 90 | 31ms | 33ms | 47ms | 42ms |
| 100 | 38ms | 36ms | 48ms | 43ms |
| 110 | 45ms | 40ms | 50ms | 45ms |
| 120 | 45ms | 43ms | 50ms | 46ms |
| 130 | 46ms | 44ms | 50ms | 46ms |
| 140 | 49ms | 44ms | 52ms | 46ms |
| 150 | 50ms | 45ms | 52ms | 46ms |
| 160 | 51ms | 46ms | 54ms | 48ms |
| 170 | 53ms | 46ms | 55ms | 48ms |
| 180 | 52ms | 45ms | 54ms | 48ms |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 40 | 21968ms | 21439ms | 28173ms | 26666ms |
| 50 | 22865ms | 22492ms | 28394ms | 26604ms |
| 60 | 24636ms | 24326ms | 30114ms | 27674ms |
| 70 | 26598ms | 25168ms | 32032ms | 29003ms |
| 80 | 29269ms | 26575ms | 33357ms | 32526ms |
| 90 | 30511ms | 30040ms | 48130ms | 41123ms |
| 100 | 32060ms | 31812ms | 48957ms | 43614ms |
| 110 | 34578ms | 35614ms | 50520ms | 45466ms |
| 120 | 41154ms | 38095ms | 50363ms | 47221ms |
| 130 | 41965ms | 40142ms | 50325ms | 46959ms |
| 140 | 45682ms | 38712ms | 52955ms | 46715ms |
| 150 | 45330ms | 40235ms | 52942ms | 47202ms |
| 160 | 45178ms | 40771ms | 55427ms | 48144ms |
| 170 | 48366ms | 42294ms | 56119ms | 48821ms |
| 180 | 46065ms | 41433ms | 54570ms | 48657ms |

## Summary

- **Average TTFT p50 improvement across all concurrency levels:** 1.9%
- **Peak TTFT p50 improvement:** 12.8% at concurrency 80
- **TTFT p50 improvement range:** -14.1% to 12.8%
- **KV cache hit rate (KV mode):** 88.9% to 99.2%, average 94.7%
- **KV cache hit rate (RR mode):** 83.9% to 99.7%, average 88.6%
- **Peak throughput (KV):** 3907.7 tokens/s at concurrency 180
- **Peak throughput (RR):** 3434.0 tokens/s at concurrency 180

## Reference Data (JSON)

```json
{
  "generated": "2026-02-28T15:10:52Z",
  "type": "averaged_baseline",
  "num_sweeps": 6,
  "source_files": [
    "benchmark-reference-20260226-214226.json",
    "benchmark-reference-20260227-011550.json",
    "benchmark-reference-20260227-031723.json",
    "benchmark-reference-20260227-225527.json",
    "benchmark-reference-20260227-225529.json",
    "benchmark-reference-20260227-225531.json"
  ],
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 266.2,
        "ttft_p95_ms": 660.3,
        "kv_hit_rate_pct": 99.7,
        "tops": 1587.8,
        "itl_p50_ms": 25.2,
        "itl_p95_ms": 27.8,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 21967.6,
        "latency_p95_ms": 28173.2
      },
      "kv_aware": {
        "ttft_p50_ms": 247.2,
        "ttft_p95_ms": 446.5,
        "kv_hit_rate_pct": 99.2,
        "tops": 1616.8,
        "itl_p50_ms": 24.9,
        "itl_p95_ms": 26.2,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 21438.7,
        "latency_p95_ms": 26665.7
      }
    },
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 256.1,
        "ttft_p95_ms": 646.3,
        "kv_hit_rate_pct": 94.2,
        "tops": 1894.6,
        "itl_p50_ms": 26.3,
        "itl_p95_ms": 28.0,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 22865.1,
        "latency_p95_ms": 28393.7
      },
      "kv_aware": {
        "ttft_p50_ms": 243.5,
        "ttft_p95_ms": 446.4,
        "kv_hit_rate_pct": 95.7,
        "tops": 1976.1,
        "itl_p50_ms": 25.2,
        "itl_p95_ms": 26.2,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 22492.4,
        "latency_p95_ms": 26603.9
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 274.1,
        "ttft_p95_ms": 655.4,
        "kv_hit_rate_pct": 90.9,
        "tops": 2146.9,
        "itl_p50_ms": 27.7,
        "itl_p95_ms": 29.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 24636.1,
        "latency_p95_ms": 30113.7
      },
      "kv_aware": {
        "ttft_p50_ms": 248.7,
        "ttft_p95_ms": 445.8,
        "kv_hit_rate_pct": 91.6,
        "tops": 2262.8,
        "itl_p50_ms": 26.2,
        "itl_p95_ms": 27.1,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 24326.0,
        "latency_p95_ms": 27674.4
      }
    },
    {
      "concurrency": 70,
      "round_robin": {
        "ttft_p50_ms": 291.7,
        "ttft_p95_ms": 622.1,
        "kv_hit_rate_pct": 90.1,
        "tops": 2361.7,
        "itl_p50_ms": 29.5,
        "itl_p95_ms": 31.4,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 26598.4,
        "latency_p95_ms": 32032.0
      },
      "kv_aware": {
        "ttft_p50_ms": 260.0,
        "ttft_p95_ms": 494.4,
        "kv_hit_rate_pct": 96.2,
        "tops": 2513.6,
        "itl_p50_ms": 27.4,
        "itl_p95_ms": 28.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 25168.5,
        "latency_p95_ms": 29003.0
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 305.6,
        "ttft_p95_ms": 637.0,
        "kv_hit_rate_pct": 85.3,
        "tops": 2543.2,
        "itl_p50_ms": 30.8,
        "itl_p95_ms": 32.7,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 29269.3,
        "latency_p95_ms": 33357.1
      },
      "kv_aware": {
        "ttft_p50_ms": 266.6,
        "ttft_p95_ms": 508.5,
        "kv_hit_rate_pct": 95.7,
        "tops": 2742.3,
        "itl_p50_ms": 28.5,
        "itl_p95_ms": 33.0,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 26574.9,
        "latency_p95_ms": 32525.8
      }
    },
    {
      "concurrency": 90,
      "round_robin": {
        "ttft_p50_ms": 320.5,
        "ttft_p95_ms": 633.7,
        "kv_hit_rate_pct": 87.9,
        "tops": 2508.0,
        "itl_p50_ms": 30.9,
        "itl_p95_ms": 47.3,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 30510.6,
        "latency_p95_ms": 48130.3
      },
      "kv_aware": {
        "ttft_p50_ms": 289.4,
        "ttft_p95_ms": 501.3,
        "kv_hit_rate_pct": 95.2,
        "tops": 2836.6,
        "itl_p50_ms": 32.7,
        "itl_p95_ms": 42.0,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 30039.7,
        "latency_p95_ms": 41123.0
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 342.5,
        "ttft_p95_ms": 652.5,
        "kv_hit_rate_pct": 88.5,
        "tops": 2547.5,
        "itl_p50_ms": 38.2,
        "itl_p95_ms": 48.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 32060.1,
        "latency_p95_ms": 48956.6
      },
      "kv_aware": {
        "ttft_p50_ms": 329.2,
        "ttft_p95_ms": 546.6,
        "kv_hit_rate_pct": 96.1,
        "tops": 2780.1,
        "itl_p50_ms": 36.2,
        "itl_p95_ms": 43.3,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 31811.5,
        "latency_p95_ms": 43614.5
      }
    },
    {
      "concurrency": 110,
      "round_robin": {
        "ttft_p50_ms": 354.0,
        "ttft_p95_ms": 641.7,
        "kv_hit_rate_pct": 88.3,
        "tops": 2620.6,
        "itl_p50_ms": 45.1,
        "itl_p95_ms": 49.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 34577.9,
        "latency_p95_ms": 50519.6
      },
      "kv_aware": {
        "ttft_p50_ms": 354.6,
        "ttft_p95_ms": 515.4,
        "kv_hit_rate_pct": 96.3,
        "tops": 2732.2,
        "itl_p50_ms": 40.1,
        "itl_p95_ms": 44.8,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 35613.8,
        "latency_p95_ms": 45466.0
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 374.7,
        "ttft_p95_ms": 643.0,
        "kv_hit_rate_pct": 87.2,
        "tops": 2642.6,
        "itl_p50_ms": 45.1,
        "itl_p95_ms": 49.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 41153.7,
        "latency_p95_ms": 50362.7
      },
      "kv_aware": {
        "ttft_p50_ms": 382.3,
        "ttft_p95_ms": 530.1,
        "kv_hit_rate_pct": 95.9,
        "tops": 2805.7,
        "itl_p50_ms": 42.6,
        "itl_p95_ms": 46.3,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 38095.0,
        "latency_p95_ms": 47220.9
      }
    },
    {
      "concurrency": 130,
      "round_robin": {
        "ttft_p50_ms": 386.7,
        "ttft_p95_ms": 557.3,
        "kv_hit_rate_pct": 84.0,
        "tops": 2784.4,
        "itl_p50_ms": 45.5,
        "itl_p95_ms": 49.6,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 41965.0,
        "latency_p95_ms": 50324.9
      },
      "kv_aware": {
        "ttft_p50_ms": 385.0,
        "ttft_p95_ms": 521.4,
        "kv_hit_rate_pct": 88.9,
        "tops": 2943.4,
        "itl_p50_ms": 44.1,
        "itl_p95_ms": 46.1,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 40142.1,
        "latency_p95_ms": 46958.7
      }
    },
    {
      "concurrency": 140,
      "round_robin": {
        "ttft_p50_ms": 398.4,
        "ttft_p95_ms": 643.2,
        "kv_hit_rate_pct": 83.9,
        "tops": 2816.8,
        "itl_p50_ms": 49.2,
        "itl_p95_ms": 52.1,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 45681.7,
        "latency_p95_ms": 52955.3
      },
      "kv_aware": {
        "ttft_p50_ms": 414.8,
        "ttft_p95_ms": 650.3,
        "kv_hit_rate_pct": 91.2,
        "tops": 3167.8,
        "itl_p50_ms": 43.9,
        "itl_p95_ms": 46.1,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 38711.7,
        "latency_p95_ms": 46714.8
      }
    },
    {
      "concurrency": 150,
      "round_robin": {
        "ttft_p50_ms": 397.3,
        "ttft_p95_ms": 638.5,
        "kv_hit_rate_pct": 85.0,
        "tops": 2966.5,
        "itl_p50_ms": 49.9,
        "itl_p95_ms": 52.2,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 45330.0,
        "latency_p95_ms": 52942.0
      },
      "kv_aware": {
        "ttft_p50_ms": 423.4,
        "ttft_p95_ms": 689.6,
        "kv_hit_rate_pct": 93.7,
        "tops": 3341.1,
        "itl_p50_ms": 44.7,
        "itl_p95_ms": 46.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 40234.8,
        "latency_p95_ms": 47201.9
      }
    },
    {
      "concurrency": 160,
      "round_robin": {
        "ttft_p50_ms": 421.5,
        "ttft_p95_ms": 722.1,
        "kv_hit_rate_pct": 90.1,
        "tops": 3126.8,
        "itl_p50_ms": 51.1,
        "itl_p95_ms": 54.3,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 45178.3,
        "latency_p95_ms": 55426.9
      },
      "kv_aware": {
        "ttft_p50_ms": 423.8,
        "ttft_p95_ms": 704.3,
        "kv_hit_rate_pct": 95.3,
        "tops": 3471.8,
        "itl_p50_ms": 45.5,
        "itl_p95_ms": 47.5,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 40770.6,
        "latency_p95_ms": 48144.2
      }
    },
    {
      "concurrency": 170,
      "round_robin": {
        "ttft_p50_ms": 416.3,
        "ttft_p95_ms": 707.7,
        "kv_hit_rate_pct": 85.4,
        "tops": 3207.9,
        "itl_p50_ms": 52.6,
        "itl_p95_ms": 55.1,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 48366.5,
        "latency_p95_ms": 56118.6
      },
      "kv_aware": {
        "ttft_p50_ms": 430.0,
        "ttft_p95_ms": 1255.5,
        "kv_hit_rate_pct": 94.9,
        "tops": 3656.5,
        "itl_p50_ms": 45.6,
        "itl_p95_ms": 47.9,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 42293.8,
        "latency_p95_ms": 48821.0
      }
    },
    {
      "concurrency": 180,
      "round_robin": {
        "ttft_p50_ms": 413.4,
        "ttft_p95_ms": 731.6,
        "kv_hit_rate_pct": 88.9,
        "tops": 3434.0,
        "itl_p50_ms": 51.6,
        "itl_p95_ms": 53.7,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 46064.9,
        "latency_p95_ms": 54569.7
      },
      "kv_aware": {
        "ttft_p50_ms": 471.7,
        "ttft_p95_ms": 3143.0,
        "kv_hit_rate_pct": 94.0,
        "tops": 3907.7,
        "itl_p50_ms": 45.4,
        "itl_p95_ms": 47.7,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": 41432.8,
        "latency_p95_ms": 48657.4
      }
    }
  ]
}
```
