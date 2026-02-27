# Benchmark Sweep: KV-aware Concurrency Scaling (160-200)

**Generated:** 2026-02-27 18:38:23 UTC

## Test Methodology

- **Routing mode:** KV-aware
- **Concurrency levels:** 160, 180, 200
- **Target RPS:** 10.0
- **Warmup:** 60s per level (Summary window flush)
- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)
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

## TPOT -- Time Per Output Token (ITL)

| Concurrency | TPOT p50 | TPOT p95 | Error % |
|:-----------:|:--------:|:--------:|:-------:|
| 160 | 46ms | 47ms | 0.0% |
| 180 | 46ms | 49ms | 0.0% |
| 200 | 42ms | 47ms | 0.0% |

## TTFT -- Time to First Token

| Concurrency | TTFT p50 | TTFT p95 |
|:-----------:|:--------:|:--------:|
| 160 | 432ms | 805ms |
| 180 | 499ms | 4874ms |
| 200 | 1712ms | 5567ms |

## End-to-End Latency

| Concurrency | Latency p50 | Latency p95 |
|:-----------:|:-----------:|:-----------:|
| 160 | 40.9s | 48.2s |
| 180 | 41.4s | 49.3s |
| 200 | 41.2s | 48.6s |

## Error Rates

| Concurrency | Error % |
|:-----------:|:-------:|
| 160 | 0.0% |
| 180 | 0.0% |
| 200 | 0.0% |

## Actual RPS (Conversation Starts/s)

| Concurrency | Actual RPS |
|:-----------:|:----------:|
| 160 | 4.11 |
| 180 | 4.62 |
| 200 | 5.12 |

## Throughput (Output Tokens/s)

| Concurrency | TOPS |
|:-----------:|:----:|
| 160 | 3448.8 |
| 180 | 3851.6 |
| 200 | 4438.4 |

## Reference Data (JSON)

```json
{
  "generated": "2026-02-27T18:38:23Z",
  "mode": "kv",
  "target_rps": 10.0,
  "levels": [
    {
      "concurrency": 160,
      "ttft_p50_ms": 432.5,
      "ttft_p95_ms": 804.7,
      "kv_hit_rate_pct": 90.5,
      "error_pct": 0.0,
      "actual_rps": 4.110672,
      "tops": 3448.800354,
      "tpot_p50_ms": 45.8,
      "tpot_p95_ms": 47.1,
      "latency_p50_ms": 40945.5,
      "latency_p95_ms": 48241.8
    },
    {
      "concurrency": 180,
      "ttft_p50_ms": 498.6,
      "ttft_p95_ms": 4874.2,
      "kv_hit_rate_pct": 96.6,
      "error_pct": 0.0,
      "actual_rps": 4.622327,
      "tops": 3851.640526,
      "tpot_p50_ms": 45.7,
      "tpot_p95_ms": 48.6,
      "latency_p50_ms": 41383.4,
      "latency_p95_ms": 49250.7
    },
    {
      "concurrency": 200,
      "ttft_p50_ms": 1712.2,
      "ttft_p95_ms": 5567.0,
      "kv_hit_rate_pct": 96.8,
      "error_pct": 0.0,
      "actual_rps": 5.118407,
      "tops": 4438.375362,
      "tpot_p50_ms": 41.7,
      "tpot_p95_ms": 46.7,
      "latency_p50_ms": 41244.3,
      "latency_p95_ms": 48647.7
    }
  ]
}
```
