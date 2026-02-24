# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-24 14:13:49 UTC

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 50, 60, 70, 80
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
| 50 | 174ms | N/A | N/A | 210ms | N/A | N/A | 0.0% | N/A |
| 60 | 186ms | N/A | N/A | 221ms | N/A | N/A | 0.0% | N/A |
| 70 | 206ms | N/A | N/A | 249ms | N/A | N/A | 0.0% | N/A |
| 80 | 222ms | N/A | N/A | 268ms | N/A | N/A | 0.0% | N/A |

### Error Rates

| Concurrency | RR Error % | KV Error % |
|:-----------:|:----------:|:----------:|
| 50 | 0.0% | N/A |
| 60 | 0.0% | N/A |
| 70 | 0.0% | N/A |
| 80 | 0.0% | N/A |

### Throughput (Output Tokens/s)

| Concurrency | RR TOPS | KV TOPS |
|:-----------:|:-------:|:-------:|
| 50 | 0.0 | N/A |
| 60 | 0.0 | N/A |
| 70 | 0.0 | N/A |
| 80 | 0.0 | N/A |

### TPOT — Time Per Output Token (ITL)

| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |
|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| 50 | 44ms | N/A | 46ms | N/A |
| 60 | 47ms | N/A | 49ms | N/A |
| 70 | 56ms | N/A | 57ms | N/A |
| 80 | 59ms | N/A | 61ms | N/A |

### End-to-End Latency

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 50 | 40641ms | N/A | 46643ms | N/A |
| 60 | 42721ms | N/A | 50205ms | N/A |
| 70 | 49891ms | N/A | 58511ms | N/A |
| 80 | 55632ms | N/A | 62023ms | N/A |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-24T14:13:49Z",
  "model": "Llama-3.1-70B-Instruct-FP8",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 50,
      "round_robin": {
        "ttft_p50_ms": 173.8,
        "ttft_p95_ms": 209.7,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 43.9,
        "tpot_p95_ms": 45.7,
        "latency_p50_ms": 40640.6,
        "latency_p95_ms": 46643.3
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
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 186.0,
        "ttft_p95_ms": 221.3,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 47.0,
        "tpot_p95_ms": 49.3,
        "latency_p50_ms": 42720.6,
        "latency_p95_ms": 50205.0
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
      "concurrency": 70,
      "round_robin": {
        "ttft_p50_ms": 206.0,
        "ttft_p95_ms": 249.3,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 55.9,
        "tpot_p95_ms": 57.4,
        "latency_p50_ms": 49891.0,
        "latency_p95_ms": 58511.4
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
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 222.1,
        "ttft_p95_ms": 268.0,
        "kv_hit_rate_pct": 0,
        "tops": 0.0,
        "tpot_p50_ms": 59.2,
        "tpot_p95_ms": 60.8,
        "latency_p50_ms": 55632.0,
        "latency_p95_ms": 62023.2
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

- **KV cache hit rate (RR mode):** 0.0% (at 50) to 0.0% (at 50), average 0.0%.
