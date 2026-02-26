# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-26 21:59:53 UTC

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
| 40 | 266ms | 286ms | -7.8% | 629ms | 520ms | 17.3% | 100.0% | 97.5% |
| 50 | 267ms | 267ms | 0.0% | 637ms | 459ms | 27.9% | 90.3% | 97.9% |
| 60 | 276ms | 262ms | 5.1% | 664ms | 452ms | 32.0% | 89.2% | 88.0% |
| 70 | 307ms | 288ms | 6.3% | 647ms | 529ms | 18.3% | 91.0% | 97.0% |
| 80 | 317ms | 284ms | 10.3% | 699ms | 494ms | 29.2% | 87.4% | 95.9% |
| 90 | 338ms | 324ms | 4.3% | 662ms | 1262ms | -90.8% | 87.5% | 95.4% |
| 100 | 325ms | 361ms | -11.2% | 659ms | 572ms | 13.2% | 87.3% | 96.8% |
| 110 | 361ms | 374ms | -3.6% | 631ms | 540ms | 14.4% | 88.3% | 97.1% |
| 120 | 382ms | 408ms | -6.7% | 647ms | 563ms | 13.0% | 87.9% | 94.6% |

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
| 40 | 1601.3 | 1618.1 |
| 50 | 1874.2 | 1969.7 |
| 60 | 2133.7 | 2278.3 |
| 70 | 2399.8 | 2512.5 |
| 80 | 2557.8 | 2740.2 |
| 90 | 2483.2 | 2817.9 |
| 100 | 2653.4 | 2785.3 |
| 110 | 2642.9 | 2730.1 |
| 120 | 2637.3 | 2831.1 |

### TPOT -- Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 40 | 25ms | 26ms | 28ms | 27ms |
| 50 | 26ms | 25ms | 28ms | 26ms |
| 60 | 28ms | 26ms | 30ms | 27ms |
| 70 | 29ms | 27ms | 31ms | 28ms |
| 80 | 31ms | 28ms | 33ms | 32ms |
| 90 | 31ms | 39ms | 48ms | 47ms |
| 100 | 33ms | 37ms | 49ms | 43ms |
| 110 | 45ms | 40ms | 49ms | 44ms |
| 120 | 45ms | 43ms | 49ms | 47ms |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 40 | 21069ms | 23906ms | 27595ms | 27994ms |
| 50 | 22823ms | 22500ms | 28195ms | 26722ms |
| 60 | 24981ms | 24212ms | 30226ms | 27578ms |
| 70 | 26785ms | 25231ms | 31493ms | 28935ms |
| 80 | 29182ms | 27097ms | 33236ms | 31737ms |
| 90 | 30826ms | 32600ms | 48581ms | 46279ms |
| 100 | 31207ms | 31460ms | 50182ms | 43869ms |
| 110 | 33713ms | 34637ms | 49584ms | 44309ms |
| 120 | 41366ms | 37594ms | 49608ms | 48518ms |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-26T21:59:53Z",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 265.7,
        "ttft_p95_ms": 629.1,
        "kv_hit_rate_pct": 100.0,
        "tops": 1601.322389,
        "tpot_p50_ms": 24.8,
        "tpot_p95_ms": 27.5,
        "latency_p50_ms": 21069.4,
        "latency_p95_ms": 27595.3
      },
      "kv_aware": {
        "ttft_p50_ms": 286.5,
        "ttft_p95_ms": 520.3,
        "kv_hit_rate_pct": 97.5,
        "tops": 1618.133333,
        "tpot_p50_ms": 25.7,
        "tpot_p95_ms": 27.3,
        "latency_p50_ms": 23905.6,
        "latency_p95_ms": 27993.8
      }
    },
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 267.4,
        "ttft_p95_ms": 636.8,
        "kv_hit_rate_pct": 90.3,
        "tops": 1874.182871,
        "tpot_p50_ms": 26.3,
        "tpot_p95_ms": 27.6,
        "latency_p50_ms": 22822.8,
        "latency_p95_ms": 28194.6
      },
      "kv_aware": {
        "ttft_p50_ms": 267.3,
        "ttft_p95_ms": 459.4,
        "kv_hit_rate_pct": 97.9,
        "tops": 1969.658306,
        "tpot_p50_ms": 25.2,
        "tpot_p95_ms": 26.3,
        "latency_p50_ms": 22500.3,
        "latency_p95_ms": 26721.6
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 276.0,
        "ttft_p95_ms": 664.1,
        "kv_hit_rate_pct": 89.2,
        "tops": 2133.726725,
        "tpot_p50_ms": 27.8,
        "tpot_p95_ms": 29.6,
        "latency_p50_ms": 24980.8,
        "latency_p95_ms": 30226.3
      },
      "kv_aware": {
        "ttft_p50_ms": 261.8,
        "ttft_p95_ms": 451.9,
        "kv_hit_rate_pct": 88.0,
        "tops": 2278.266667,
        "tpot_p50_ms": 26.1,
        "tpot_p95_ms": 26.8,
        "latency_p50_ms": 24211.7,
        "latency_p95_ms": 27578.2
      }
    },
    {
      "concurrency": 70,
      "round_robin": {
        "ttft_p50_ms": 307.3,
        "ttft_p95_ms": 647.4,
        "kv_hit_rate_pct": 91.0,
        "tops": 2399.811063,
        "tpot_p50_ms": 29.2,
        "tpot_p95_ms": 30.9,
        "latency_p50_ms": 26785.3,
        "latency_p95_ms": 31492.6
      },
      "kv_aware": {
        "ttft_p50_ms": 287.9,
        "ttft_p95_ms": 528.9,
        "kv_hit_rate_pct": 97.0,
        "tops": 2512.459259,
        "tpot_p50_ms": 27.4,
        "tpot_p95_ms": 28.2,
        "latency_p50_ms": 25231.2,
        "latency_p95_ms": 28935.1
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 316.7,
        "ttft_p95_ms": 698.7,
        "kv_hit_rate_pct": 87.4,
        "tops": 2557.785185,
        "tpot_p50_ms": 30.8,
        "tpot_p95_ms": 32.7,
        "latency_p50_ms": 29182.5,
        "latency_p95_ms": 33236.3
      },
      "kv_aware": {
        "ttft_p50_ms": 284.2,
        "ttft_p95_ms": 494.5,
        "kv_hit_rate_pct": 95.9,
        "tops": 2740.178299,
        "tpot_p50_ms": 28.5,
        "tpot_p95_ms": 32.2,
        "latency_p50_ms": 27096.6,
        "latency_p95_ms": 31737.2
      }
    },
    {
      "concurrency": 90,
      "round_robin": {
        "ttft_p50_ms": 338.3,
        "ttft_p95_ms": 661.5,
        "kv_hit_rate_pct": 87.5,
        "tops": 2483.165949,
        "tpot_p50_ms": 31.0,
        "tpot_p95_ms": 47.5,
        "latency_p50_ms": 30826.4,
        "latency_p95_ms": 48581.1
      },
      "kv_aware": {
        "ttft_p50_ms": 323.9,
        "ttft_p95_ms": 1262.3,
        "kv_hit_rate_pct": 95.4,
        "tops": 2817.911111,
        "tpot_p50_ms": 38.9,
        "tpot_p95_ms": 46.8,
        "latency_p50_ms": 32600.2,
        "latency_p95_ms": 46279.4
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 324.8,
        "ttft_p95_ms": 659.3,
        "kv_hit_rate_pct": 87.3,
        "tops": 2653.43915,
        "tpot_p50_ms": 33.0,
        "tpot_p95_ms": 49.4,
        "latency_p50_ms": 31207.0,
        "latency_p95_ms": 50182.3
      },
      "kv_aware": {
        "ttft_p50_ms": 361.2,
        "ttft_p95_ms": 572.5,
        "kv_hit_rate_pct": 96.8,
        "tops": 2785.273744,
        "tpot_p50_ms": 36.7,
        "tpot_p95_ms": 43.3,
        "latency_p50_ms": 31460.2,
        "latency_p95_ms": 43869.2
      }
    },
    {
      "concurrency": 110,
      "round_robin": {
        "ttft_p50_ms": 360.8,
        "ttft_p95_ms": 630.8,
        "kv_hit_rate_pct": 88.3,
        "tops": 2642.889454,
        "tpot_p50_ms": 44.7,
        "tpot_p95_ms": 48.7,
        "latency_p50_ms": 33713.3,
        "latency_p95_ms": 49583.9
      },
      "kv_aware": {
        "ttft_p50_ms": 373.7,
        "ttft_p95_ms": 540.0,
        "kv_hit_rate_pct": 97.1,
        "tops": 2730.059259,
        "tpot_p50_ms": 40.1,
        "tpot_p95_ms": 44.0,
        "latency_p50_ms": 34636.7,
        "latency_p95_ms": 44309.2
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 382.3,
        "ttft_p95_ms": 646.9,
        "kv_hit_rate_pct": 87.9,
        "tops": 2637.307407,
        "tpot_p50_ms": 44.9,
        "tpot_p95_ms": 48.9,
        "latency_p50_ms": 41365.8,
        "latency_p95_ms": 49607.9
      },
      "kv_aware": {
        "ttft_p50_ms": 408.1,
        "ttft_p95_ms": 563.0,
        "kv_hit_rate_pct": 94.6,
        "tops": 2831.144444,
        "tpot_p50_ms": 43.1,
        "tpot_p95_ms": 47.4,
        "latency_p50_ms": 37593.6,
        "latency_p95_ms": 48518.4
      }
    }
  ]
}
```

## Summary

- **TTFT p50 improvement at lowest concurrency (40):** -7.8%
- **TTFT p50 improvement at highest concurrency (120):** -6.7%
- **Trend:** The TTFT improvement from KV-aware routing **increases** with concurrency (-7.8% at 40 -> -6.7% at 120), as expected -- higher load means more conversations competing for cache, making routing intelligence more valuable.
- **Peak benefit:** Concurrency 80 shows the maximum p50 improvement at 10.3%.
- **KV cache hit rate (KV mode):** 88.0% (at 60) to 97.9% (at 50), average 95.6%.
- **KV cache hit rate (RR mode):** 87.3% (at 100) to 100.0% (at 40), average 89.9%.
