# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-17 01:16:58 UTC

## Test Methodology

- **Routing modes:** Round-robin (baseline) vs KV cache-aware
- **Concurrency levels:** 40, 60, 80, 100, 120
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
| Replicas | 2x TP=4 |
| Backend | TensorRT-LLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |
| Max batch size | 64 |
| Free GPU memory fraction | 0.85 |
| KV cache dtype | FP8 |
| Chunked prefill | Enabled |

## Results

| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | KV Hit Rate |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|
| 40 | 238ms | 229ms | 3.7% | 410ms | 406ms | 1.0% | 1.0% |
| 60 | 236ms | 257ms | -9.1% | 422ms | 460ms | -8.9% | 1.0% |
| 80 | 255ms | 269ms | -5.3% | 432ms | 450ms | -4.0% | 0.9% |
| 100 | 296ms | 296ms | -0.2% | 432ms | 465ms | -7.5% | 1.0% |
| 120 | 275ms | 378ms | -37.5% | 438ms | 615ms | -40.4% | 1.0% |

### Error Rates

| Concurrency | RR Error % | KV Error % |
|:-----------:|:----------:|:----------:|
| 40 | 0.0% | 0.0% |
| 60 | 0.0% | 0.0% |
| 80 | 0.0% | 0.0% |
| 100 | 0.0% | 0.0% |
| 120 | 0.0% | 0.0% |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-17T01:16:58Z",
  "model": "Llama-3.1-70B-Instruct-FP8",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 238.0,
        "ttft_p95_ms": 410.1
      },
      "kv_aware": {
        "ttft_p50_ms": 229.3,
        "ttft_p95_ms": 406.2,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 235.8,
        "ttft_p95_ms": 422.1
      },
      "kv_aware": {
        "ttft_p50_ms": 257.2,
        "ttft_p95_ms": 459.6,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 255.3,
        "ttft_p95_ms": 432.4
      },
      "kv_aware": {
        "ttft_p50_ms": 268.8,
        "ttft_p95_ms": 449.9,
        "kv_hit_rate_pct": 0.9
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 295.6,
        "ttft_p95_ms": 432.4
      },
      "kv_aware": {
        "ttft_p50_ms": 296.2,
        "ttft_p95_ms": 464.8,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 275.0,
        "ttft_p95_ms": 437.9
      },
      "kv_aware": {
        "ttft_p50_ms": 378.0,
        "ttft_p95_ms": 614.9,
        "kv_hit_rate_pct": 1.0
      }
    }
  ]
}
```

## Summary

- **TTFT p50 improvement at lowest concurrency (40):** 3.7%
- **TTFT p50 improvement at highest concurrency (120):** -37.5%
- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency (3.7% at 40 → -37.5% at 120). This may indicate cache pressure at higher loads.
- **Peak benefit:** Concurrency 40 shows the maximum p50 improvement at 3.7%.
- **KV cache hit rate:** 0.9% (at 80) to 1.0% (at 120), average 1.0%.
