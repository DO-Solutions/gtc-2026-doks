# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-27 01:15:50 UTC

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
| 40 | 262ms | 232ms | 11.2% | 674ms | 448ms | 33.5% | 99.5% | 100.0% |
| 50 | 245ms | 231ms | 6.0% | 639ms | 410ms | 35.8% | 97.4% | 96.2% |
| 60 | 266ms | 238ms | 10.5% | 645ms | 447ms | 30.6% | 91.5% | 93.7% |
| 70 | 284ms | 240ms | 15.3% | 608ms | 475ms | 22.0% | 90.1% | 94.3% |
| 80 | 290ms | 247ms | 14.9% | 599ms | 459ms | 23.4% | 86.2% | 94.9% |
| 90 | 303ms | 262ms | 13.4% | 626ms | 492ms | 21.4% | 87.3% | 94.2% |
| 100 | 349ms | 288ms | 17.5% | 640ms | 537ms | 16.1% | 90.4% | 96.9% |
| 110 | 353ms | 298ms | 15.7% | 648ms | 500ms | 23.0% | 88.0% | 95.7% |
| 120 | 363ms | 364ms | -0.4% | 636ms | 495ms | 22.2% | 88.1% | 98.1% |

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
| 40 | 1571.1 | 1616.4 |
| 50 | 1907.1 | 1974.1 |
| 60 | 2159.2 | 2249.5 |
| 70 | 2375.7 | 2524.2 |
| 80 | 2564.0 | 2729.6 |
| 90 | 2518.2 | 2781.7 |
| 100 | 2468.0 | 2782.0 |
| 110 | 2619.2 | 2746.6 |
| 120 | 2642.3 | 2770.0 |

### TPOT -- Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 40 | 26ms | 25ms | 28ms | 26ms |
| 50 | 26ms | 25ms | 28ms | 26ms |
| 60 | 28ms | 26ms | 30ms | 27ms |
| 70 | 29ms | 27ms | 30ms | 28ms |
| 80 | 31ms | 28ms | 32ms | 34ms |
| 90 | 31ms | 31ms | 47ms | 39ms |
| 100 | 42ms | 36ms | 47ms | 44ms |
| 110 | 46ms | 40ms | 48ms | 44ms |
| 120 | 46ms | 43ms | 48ms | 46ms |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 40 | 23026ms | 20504ms | 28472ms | 26341ms |
| 50 | 22821ms | 21900ms | 28434ms | 26569ms |
| 60 | 24716ms | 24204ms | 30114ms | 27842ms |
| 70 | 26435ms | 24812ms | 31154ms | 28861ms |
| 80 | 28940ms | 26840ms | 32982ms | 34197ms |
| 90 | 30698ms | 28208ms | 47400ms | 38608ms |
| 100 | 32585ms | 32336ms | 48009ms | 43592ms |
| 110 | 34472ms | 35518ms | 49104ms | 45120ms |
| 120 | 40343ms | 37989ms | 49217ms | 46262ms |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-27T01:15:50Z",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 261.5,
        "ttft_p95_ms": 674.2,
        "kv_hit_rate_pct": 99.5,
        "tops": 1571.148148,
        "tpot_p50_ms": 25.6,
        "tpot_p95_ms": 28.2,
        "latency_p50_ms": 23025.8,
        "latency_p95_ms": 28472.4
      },
      "kv_aware": {
        "ttft_p50_ms": 232.3,
        "ttft_p95_ms": 448.3,
        "kv_hit_rate_pct": 100.0,
        "tops": 1616.427862,
        "tpot_p50_ms": 24.7,
        "tpot_p95_ms": 25.9,
        "latency_p50_ms": 20503.9,
        "latency_p95_ms": 26341.2
      }
    },
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 245.3,
        "ttft_p95_ms": 639.2,
        "kv_hit_rate_pct": 97.4,
        "tops": 1907.096296,
        "tpot_p50_ms": 26.4,
        "tpot_p95_ms": 28.4,
        "latency_p50_ms": 22820.6,
        "latency_p95_ms": 28434.0
      },
      "kv_aware": {
        "ttft_p50_ms": 230.7,
        "ttft_p95_ms": 410.3,
        "kv_hit_rate_pct": 96.2,
        "tops": 1974.125926,
        "tpot_p50_ms": 25.3,
        "tpot_p95_ms": 26.2,
        "latency_p50_ms": 21899.5,
        "latency_p95_ms": 26569.0
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 265.8,
        "ttft_p95_ms": 644.8,
        "kv_hit_rate_pct": 91.5,
        "tops": 2159.162963,
        "tpot_p50_ms": 27.7,
        "tpot_p95_ms": 29.6,
        "latency_p50_ms": 24716.3,
        "latency_p95_ms": 30113.7
      },
      "kv_aware": {
        "ttft_p50_ms": 237.8,
        "ttft_p95_ms": 447.2,
        "kv_hit_rate_pct": 93.7,
        "tops": 2249.466749,
        "tpot_p50_ms": 26.4,
        "tpot_p95_ms": 27.3,
        "latency_p50_ms": 24204.4,
        "latency_p95_ms": 27842.5
      }
    },
    {
      "concurrency": 70,
      "round_robin": {
        "ttft_p50_ms": 283.7,
        "ttft_p95_ms": 608.4,
        "kv_hit_rate_pct": 90.1,
        "tops": 2375.651852,
        "tpot_p50_ms": 29.3,
        "tpot_p95_ms": 30.5,
        "latency_p50_ms": 26434.7,
        "latency_p95_ms": 31154.2
      },
      "kv_aware": {
        "ttft_p50_ms": 240.3,
        "ttft_p95_ms": 474.8,
        "kv_hit_rate_pct": 94.3,
        "tops": 2524.241137,
        "tpot_p50_ms": 27.3,
        "tpot_p95_ms": 28.5,
        "latency_p50_ms": 24812.2,
        "latency_p95_ms": 28860.7
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 290.0,
        "ttft_p95_ms": 598.9,
        "kv_hit_rate_pct": 86.2,
        "tops": 2563.955555,
        "tpot_p50_ms": 30.8,
        "tpot_p95_ms": 32.2,
        "latency_p50_ms": 28939.6,
        "latency_p95_ms": 32982.3
      },
      "kv_aware": {
        "ttft_p50_ms": 246.9,
        "ttft_p95_ms": 458.7,
        "kv_hit_rate_pct": 94.9,
        "tops": 2729.555613,
        "tpot_p50_ms": 28.3,
        "tpot_p95_ms": 34.3,
        "latency_p50_ms": 26839.5,
        "latency_p95_ms": 34196.6
      }
    },
    {
      "concurrency": 90,
      "round_robin": {
        "ttft_p50_ms": 302.9,
        "ttft_p95_ms": 625.8,
        "kv_hit_rate_pct": 87.3,
        "tops": 2518.155555,
        "tpot_p50_ms": 30.9,
        "tpot_p95_ms": 46.6,
        "latency_p50_ms": 30698.1,
        "latency_p95_ms": 47399.5
      },
      "kv_aware": {
        "ttft_p50_ms": 262.4,
        "ttft_p95_ms": 491.9,
        "kv_hit_rate_pct": 94.2,
        "tops": 2781.683516,
        "tpot_p50_ms": 31.1,
        "tpot_p95_ms": 38.8,
        "latency_p50_ms": 28208.1,
        "latency_p95_ms": 38607.5
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 349.0,
        "ttft_p95_ms": 639.9,
        "kv_hit_rate_pct": 90.4,
        "tops": 2467.979771,
        "tpot_p50_ms": 42.4,
        "tpot_p95_ms": 47.3,
        "latency_p50_ms": 32585.3,
        "latency_p95_ms": 48009.3
      },
      "kv_aware": {
        "ttft_p50_ms": 288.0,
        "ttft_p95_ms": 536.8,
        "kv_hit_rate_pct": 96.9,
        "tops": 2782.03278,
        "tpot_p50_ms": 36.3,
        "tpot_p95_ms": 43.6,
        "latency_p50_ms": 32335.8,
        "latency_p95_ms": 43591.9
      }
    },
    {
      "concurrency": 110,
      "round_robin": {
        "ttft_p50_ms": 353.3,
        "ttft_p95_ms": 648.5,
        "kv_hit_rate_pct": 88.0,
        "tops": 2619.2,
        "tpot_p50_ms": 46.0,
        "tpot_p95_ms": 48.2,
        "latency_p50_ms": 34472.0,
        "latency_p95_ms": 49103.6
      },
      "kv_aware": {
        "ttft_p50_ms": 298.0,
        "ttft_p95_ms": 499.5,
        "kv_hit_rate_pct": 95.7,
        "tops": 2746.644445,
        "tpot_p50_ms": 39.9,
        "tpot_p95_ms": 44.2,
        "latency_p50_ms": 35518.0,
        "latency_p95_ms": 45119.8
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 362.6,
        "ttft_p95_ms": 636.0,
        "kv_hit_rate_pct": 88.1,
        "tops": 2642.256346,
        "tpot_p50_ms": 46.0,
        "tpot_p95_ms": 48.4,
        "latency_p50_ms": 40343.1,
        "latency_p95_ms": 49217.2
      },
      "kv_aware": {
        "ttft_p50_ms": 364.1,
        "ttft_p95_ms": 495.1,
        "kv_hit_rate_pct": 98.1,
        "tops": 2770.041148,
        "tpot_p50_ms": 42.9,
        "tpot_p95_ms": 45.6,
        "latency_p50_ms": 37988.6,
        "latency_p95_ms": 46262.1
      }
    }
  ]
}
```

## Summary

- **TTFT p50 improvement at lowest concurrency (40):** 11.2%
- **TTFT p50 improvement at highest concurrency (120):** -0.4%
- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency (11.2% at 40 -> -0.4% at 120). This may indicate cache pressure at higher loads.
- **Peak benefit:** Concurrency 100 shows the maximum p50 improvement at 17.5%.
- **KV cache hit rate (KV mode):** 93.7% (at 60) to 100.0% (at 40), average 96.0%.
- **KV cache hit rate (RR mode):** 86.2% (at 80) to 99.5% (at 40), average 90.9%.
