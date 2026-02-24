# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-24 02:59:21 UTC

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 10, 20, 30, 40, 50
- **Target RPS:** 10.0
- **Warmup:** per level (Summary window flush)
- **Measurement:** 3 snapshots averaged per level
- **Workload:** Multi-turn chat (3-5 turns per conversation)
- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)

## Deployment Details

| Parameter | Value |
|:----------|:------|
| Model | Llama 3.1 70B Instruct FP8 |
| GPUs | 8x H100 (1 node) |
| Replicas | 4x TP=2 |
| Backend | TensorRT-LLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |
| Max batch size | 64 |
| Free GPU memory fraction | 0.85 |
| KV cache dtype | FP8 |
| Chunked prefill | Enabled |

## Results

| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|
| 10 | 74ms | N/A | N/A | 1380ms | N/A | N/A | 0.0% | N/A |
| 20 | 140ms | N/A | N/A | 167ms | N/A | N/A | 0.0% | N/A |
| 30 | 148ms | N/A | N/A | 185ms | N/A | N/A | 0.0% | N/A |
| 40 | 164ms | N/A | N/A | 193ms | N/A | N/A | 0.0% | N/A |
| 50 | 177ms | N/A | N/A | 210ms | N/A | N/A | 0.0% | N/A |

### Error Rates

| Concurrency | RR Error % | KV Error % |
|:-----------:|:----------:|:----------:|
| 10 | 33.3% | N/A |
| 20 | 0.0% | N/A |
| 30 | 0.0% | N/A |
| 40 | 0.0% | N/A |
| 50 | 0.0% | N/A |

### Throughput (Output Tokens/s)

| Concurrency | RR TOPS | KV TOPS |
|:-----------:|:-------:|:-------:|
| 10 | 0.0 | N/A |
| 20 | 0.0 | N/A |
| 30 | 0.0 | N/A |
| 40 | 0.0 | N/A |
| 50 | 0.0 | N/A |

### TPOT — Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 10 | 26ms | N/A | 27ms | N/A |
| 20 | 37ms | N/A | 38ms | N/A |
| 30 | 39ms | N/A | 39ms | N/A |
| 40 | 41ms | N/A | 41ms | N/A |
| 50 | 44ms | N/A | 44ms | N/A |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 10 | 25582ms | N/A | 27312ms | N/A |
| 20 | 34810ms | N/A | 38612ms | N/A |
| 30 | 35457ms | N/A | 39906ms | N/A |
| 40 | 38184ms | N/A | 42434ms | N/A |
| 50 | 39162ms | N/A | 45388ms | N/A |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-24T02:59:21Z",
  "model": "Llama-3.1-70B-Instruct-FP8",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 10,
      "round_robin": {
        "ttft_p50_ms": 74.4,
        "ttft_p95_ms": 1380.2,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 25.6,
        "tpot_p95_ms": 26.7,
        "latency_p50_ms": 25582.5,
        "latency_p95_ms": 27312.5
      },
      "kv_aware": {
        "ttft_p50_ms": null,
        "ttft_p95_ms": null,
        "kv_hit_rate_pct": 0,
        "tops": null,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": null,
        "latency_p95_ms": null
      }
    },
    {
      "concurrency": 20,
      "round_robin": {
        "ttft_p50_ms": 140.1,
        "ttft_p95_ms": 166.9,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 37.1,
        "tpot_p95_ms": 37.8,
        "latency_p50_ms": 34809.7,
        "latency_p95_ms": 38612.2
      },
      "kv_aware": {
        "ttft_p50_ms": null,
        "ttft_p95_ms": null,
        "kv_hit_rate_pct": 0,
        "tops": null,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": null,
        "latency_p95_ms": null
      }
    },
    {
      "concurrency": 30,
      "round_robin": {
        "ttft_p50_ms": 148.1,
        "ttft_p95_ms": 184.8,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 38.8,
        "tpot_p95_ms": 38.9,
        "latency_p50_ms": 35457.0,
        "latency_p95_ms": 39905.7
      },
      "kv_aware": {
        "ttft_p50_ms": null,
        "ttft_p95_ms": null,
        "kv_hit_rate_pct": 0,
        "tops": null,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": null,
        "latency_p95_ms": null
      }
    },
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 164.3,
        "ttft_p95_ms": 192.8,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 40.9,
        "tpot_p95_ms": 41.4,
        "latency_p50_ms": 38183.9,
        "latency_p95_ms": 42434.0
      },
      "kv_aware": {
        "ttft_p50_ms": null,
        "ttft_p95_ms": null,
        "kv_hit_rate_pct": 0,
        "tops": null,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": null,
        "latency_p95_ms": null
      }
    },
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 177.1,
        "ttft_p95_ms": 210.4,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 43.8,
        "tpot_p95_ms": 44.3,
        "latency_p50_ms": 39161.8,
        "latency_p95_ms": 45387.7
      },
      "kv_aware": {
        "ttft_p50_ms": null,
        "ttft_p95_ms": null,
        "kv_hit_rate_pct": 0,
        "tops": null,
        "tpot_p50_ms": null,
        "tpot_p95_ms": null,
        "latency_p50_ms": null,
        "latency_p95_ms": null
      }
    }
  ]
}
```

## Summary

- **KV cache hit rate (RR mode):** 0.0% (at 10) to 0.0% (at 10), average 0.0%.
