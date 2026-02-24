# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-24 16:19:01 UTC

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 90, 100, 110, 120
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
| 90 | 231ms | N/A | N/A | 5815ms | N/A | N/A | 0.0% | N/A |
| 100 | 258ms | N/A | N/A | 3021ms | N/A | N/A | 0.0% | N/A |
| 110 | 2214ms | N/A | N/A | 4967ms | N/A | N/A | 0.0% | N/A |
| 120 | 297ms | N/A | N/A | 2227ms | N/A | N/A | 0.0% | N/A |

### Error Rates

| Concurrency | RR Error % | KV Error % |
|:-----------:|:----------:|:----------:|
| 90 | 0.0% | N/A |
| 100 | 0.0% | N/A |
| 110 | 1.7% | N/A |
| 120 | 0.0% | N/A |

### Throughput (Output Tokens/s)

| Concurrency | RR TOPS | KV TOPS |
|:-----------:|:-------:|:-------:|
| 90 | 0.0 | N/A |
| 100 | 0.0 | N/A |
| 110 | 0.0 | N/A |
| 120 | 0.0 | N/A |

### TPOT — Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 90 | 67ms | N/A | 83ms | N/A |
| 100 | 79ms | N/A | 86ms | N/A |
| 110 | 83ms | N/A | 95ms | N/A |
| 120 | 84ms | N/A | 95ms | N/A |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 90 | 59323ms | N/A | 84092ms | N/A |
| 100 | 72889ms | N/A | 84524ms | N/A |
| 110 | 75744ms | N/A | 92416ms | N/A |
| 120 | 76665ms | N/A | 93628ms | N/A |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-24T16:19:01Z",
  "model": "Llama-3.1-70B-Instruct-FP8",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 90,
      "round_robin": {
        "ttft_p50_ms": 231.1,
        "ttft_p95_ms": 5814.8,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 66.7,
        "tpot_p95_ms": 83.0,
        "latency_p50_ms": 59322.7,
        "latency_p95_ms": 84091.7
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
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 258.0,
        "ttft_p95_ms": 3020.8,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 79.2,
        "tpot_p95_ms": 86.3,
        "latency_p50_ms": 72889.1,
        "latency_p95_ms": 84524.1
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
      "concurrency": 110,
      "round_robin": {
        "ttft_p50_ms": 2213.5,
        "ttft_p95_ms": 4967.2,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 82.7,
        "tpot_p95_ms": 94.6,
        "latency_p50_ms": 75743.5,
        "latency_p95_ms": 92415.9
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
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 297.0,
        "ttft_p95_ms": 2226.6,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 84.3,
        "tpot_p95_ms": 95.0,
        "latency_p50_ms": 76664.8,
        "latency_p95_ms": 93628.0
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

- **KV cache hit rate (RR mode):** 0.0% (at 90) to 0.0% (at 90), average 0.0%.
