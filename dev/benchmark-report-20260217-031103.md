# Benchmark Sweep: KV Cache Routing vs Round-Robin

**Generated:** 2026-02-17 03:11:03 UTC

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
| Replicas | 4x TP=2 |
| Backend | TensorRT-LLM via Dynamo |
| Frontend | Dynamo Frontend (Rust) |
| Max batch size | 64 |
| Free GPU memory fraction | 0.85 |
| KV cache dtype | FP8 |
| Chunked prefill | Enabled |

## Results

| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | KV Hit Rate |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|
| 40 | 244ms | 223ms | 8.4% | 423ms | 345ms | 18.5% | 1.0% |
| 60 | 255ms | 244ms | 4.3% | 456ms | 432ms | 5.1% | 1.0% |
| 80 | 285ms | 270ms | 5.3% | 484ms | 466ms | 3.9% | 1.0% |
| 100 | 315ms | 294ms | 6.6% | 494ms | 487ms | 1.5% | 0.9% |
| 120 | 315ms | 324ms | -3.0% | 486ms | 501ms | -3.0% | 1.0% |

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
  "generated": "2026-02-17T03:11:03Z",
  "model": "Llama-3.1-70B-Instruct-FP8",
  "metric": "loadgen_ttft_all_seconds",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 40,
      "round_robin": {
        "ttft_p50_ms": 243.5,
        "ttft_p95_ms": 423.0
      },
      "kv_aware": {
        "ttft_p50_ms": 223.0,
        "ttft_p95_ms": 344.7,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 60,
      "round_robin": {
        "ttft_p50_ms": 254.9,
        "ttft_p95_ms": 455.6
      },
      "kv_aware": {
        "ttft_p50_ms": 244.0,
        "ttft_p95_ms": 432.3,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 80,
      "round_robin": {
        "ttft_p50_ms": 285.2,
        "ttft_p95_ms": 484.5
      },
      "kv_aware": {
        "ttft_p50_ms": 270.2,
        "ttft_p95_ms": 465.8,
        "kv_hit_rate_pct": 1.0
      }
    },
    {
      "concurrency": 100,
      "round_robin": {
        "ttft_p50_ms": 315.4,
        "ttft_p95_ms": 494.4
      },
      "kv_aware": {
        "ttft_p50_ms": 294.5,
        "ttft_p95_ms": 487.1,
        "kv_hit_rate_pct": 0.9
      }
    },
    {
      "concurrency": 120,
      "round_robin": {
        "ttft_p50_ms": 314.9,
        "ttft_p95_ms": 486.2
      },
      "kv_aware": {
        "ttft_p50_ms": 324.2,
        "ttft_p95_ms": 501.0,
        "kv_hit_rate_pct": 1.0
      }
    }
  ]
}
```

## Summary

- **TTFT p50 improvement at lowest concurrency (40):** 8.4%
- **TTFT p50 improvement at highest concurrency (120):** -3.0%
- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency (8.4% at 40 → -3.0% at 120). This may indicate cache pressure at higher loads.
- **Peak benefit:** Concurrency 40 shows the maximum p50 improvement at 8.4%.
- **KV cache hit rate:** 0.9% (at 100) to 1.0% (at 80), average 1.0%.
