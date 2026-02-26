# Phase 0 Benchmark Report — Custom Multi-Turn Dataset

## Configuration

| Parameter | Value |
|-----------|-------|
| Engine | vLLM 0.14.1 (V1 engine) |
| GPU | 1x H200 141GB |
| Model | Llama 3.1 70B Instruct FP8 |
| Tensor Parallel | 1 |
| KV Cache Dtype | fp8_e4m3 |
| Chunked Prefill | Enabled (max_num_batched_tokens=8192) |
| Prefix Caching | Enabled (default in v0.14.1) |
| Attention Backend | FLASH_ATTN |
| Available KV Cache | 53.15 GiB (348,304 tokens) |
| Model Memory | 67.7 GiB |
| Dataset | Custom multi-turn conversations collected from load generator |
| Prompts per Rate | 300 |
| Server Startup | ~211s |

## Results

All times in milliseconds. Throughput in output tokens/sec.

| Rate | Compl | Fail | MaxConc | TTFT p50 | TTFT p95 | TTFT p99 | TPOT p50 | TPOT p95 | TPOT p99 | ITL p50 | ITL p95 | ITL p99 | Tput tok/s |
|-----:|------:|-----:|--------:|---------:|---------:|---------:|---------:|---------:|---------:|--------:|--------:|--------:|-----------:|
| 0.50 |   300 |    0 |      16 |     82.7 |    568.0 |    769.6 |     25.1 |     28.3 |     28.8 |    23.7 |    26.0 |    31.0 |      251.6 |
| 0.75 |   300 |    0 |      20 |     89.6 |    470.8 |    646.2 |     27.0 |     32.3 |     33.9 |    25.5 |    34.0 |    35.8 |      371.2 |
| 1.00 |   300 |    0 |      30 |    106.4 |    509.0 |    702.8 |     37.1 |     40.4 |     41.2 |    35.0 |    37.0 |    52.1 |      484.7 |
| 1.25 |   300 |    0 |      35 |    112.7 |    532.7 |    801.5 |     39.2 |     41.8 |     42.5 |    35.7 |    37.2 |   169.4 |      593.9 |
| 1.50 |   300 |    0 |      41 |    113.9 |    537.2 |    981.0 |     39.8 |     42.7 |     43.3 |    35.9 |    38.1 |   197.6 |      695.0 |
| 2.00 |   300 |    0 |      59 |    129.7 |    605.3 |    953.3 |     44.8 |     47.8 |     48.8 |    38.0 |    43.3 |   232.0 |      866.8 |
| 2.50 |   300 |    0 |      89 |    165.1 |    636.0 |    977.7 |     54.9 |     63.8 |     66.6 |    51.1 |    57.9 |   333.1 |     1007.8 |
| 3.00 |   300 |    0 |     112 |    180.4 |    676.4 |   1019.7 |     62.0 |     73.4 |     75.1 |    54.7 |    67.0 |   390.9 |     1109.8 |

## SLO Analysis

SLO targets: TTFT p99 < 350ms, TPOT p99 < 60ms.

| Rate | TTFT p99 | TPOT p99 | Status |
|-----:|---------:|---------:|--------|
| 0.50 |    769.6 |     28.8 | FAIL (TTFT) |
| 0.75 |    646.2 |     33.9 | FAIL (TTFT) |
| 1.00 |    702.8 |     41.2 | FAIL (TTFT) |
| 1.25 |    801.5 |     42.5 | FAIL (TTFT) |
| 1.50 |    981.0 |     43.3 | FAIL (TTFT) |
| 2.00 |    953.3 |     48.8 | FAIL (TTFT) |
| 2.50 |    977.7 |     66.6 | FAIL (both) |
| 3.00 |   1019.7 |     75.1 | FAIL (both) |

No rate passes the TTFT p99 < 350ms SLO with this dataset. TPOT p99 stays under 60ms up to rate 2.0 but exceeds it at 2.5+. This is expected — the SLO targets were calibrated for the short-prompt ShareGPT dataset (~207 tokens avg input). The custom dataset has 28x longer prompts on average, fundamentally changing the TTFT profile.

## Comparison with ShareGPT Baseline

| Metric | ShareGPT (20260224-185458) | Custom Dataset (this run) | Ratio |
|--------|---------------------------|---------------------------|-------|
| Avg Input Tokens/Request | 207 | 5,806 | 28x |
| Avg Output Tokens/Request | ~198 | ~517 | 2.6x |
| TTFT p50 @ rate 1.0 | 56.5ms | 106.4ms | 1.9x |
| TTFT p95 @ rate 1.0 | 68.8ms | 509.0ms | 7.4x |
| ITL p50 @ rate 1.0 | 20.3ms | 35.0ms | 1.7x |
| Output Throughput @ rate 1.0 | 194.4 tok/s | 484.7 tok/s | 2.5x |
| Total Token Throughput @ rate 1.0 | ~400 tok/s | ~2,560 tok/s | 6.4x |
| Max Concurrent @ rate 3.0 | 26 | 112 | 4.3x |

The custom dataset reveals a very different system profile:
- **TTFT is dominated by long prefills**, not just scheduling overhead. The p95 TTFT (509-676ms) reflects actual compute time to process 4K-10K input tokens.
- **Output throughput is higher** because each request generates more tokens (avg ~517 vs ~198), keeping the GPU more utilized during decode.
- **Total token throughput is 6x higher** because the GPU is processing far more input tokens per request.
- **Concurrency is much higher** (112 vs 26 at rate 3.0) because each request takes longer end-to-end, causing more overlap.

## Key Observations

- **Prefix caching is highly effective.** TTFT p50 stays at 83-180ms despite 4K-10K token inputs. Without prefix caching, TTFT would be proportional to input length (~200-500ms per 1K tokens at this model size). The low p50 indicates most requests hit cached prefixes — expected since the 500-entry dataset resamples the same 100 conversation bases.
- **TTFT tail latency reveals cold-cache misses.** TTFT p95 is 470-676ms and p99 is 650-1020ms — these are the cache misses where full prefill is required. The gap between p50 and p95 (5-6x) shows the bimodal distribution: cache hit vs cache miss.
- **ITL p99 spikes at higher rates.** ITL p99 jumps from 31ms (rate 0.5) to 391ms (rate 3.0). This is likely caused by long prefill operations interrupting decode batches — a known interaction between chunked prefill and decode scheduling.
- **TPOT remains well-controlled.** TPOT p50 grows from 25ms to 62ms across the rate sweep — a 2.5x increase for 6x the load. The decode pipeline handles the longer KV caches gracefully.
- **Zero failures.** 300/300 requests completed at every rate, even at 3.0 RPS with 112 concurrent requests.
- **Effective throughput caps at ~2.15 RPS.** At configured rate 3.0, actual throughput is 2.15 RPS — the system is fully saturated. The gap between configured and effective rate starts at 1.25 RPS (effective 1.14).

## Workload Parameters

| Parameter | Value |
|-----------|-------|
| Tool | `vllm bench serve` (built-in vLLM 0.14.1 benchmarking) |
| Dataset | Custom: 500 ShareGPT entries from 100 multi-turn conversations |
| Dataset Source | Collected via `scripts/collect-conversations.py` from load generator API |
| Collection Method | 100 completed 5-turn conversations, each turn flattened with accumulated message history |
| Prompts per Rate | 300 |
| Request Rates Swept | 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0 RPS |
| Arrival Distribution | Poisson process (burstiness=1.0) |
| Max Concurrency | Unlimited (no cap) |
| Endpoint | `/v1/completions` (OpenAI-compatible) |
| Warm-up | 10 prompts at 0.5 RPS (discarded), 15s cooldown |
| Cooldown Between Rates | 30s |
| Sampling | Default (greedy, temperature=0) |

### Token Statistics (per run of 300 prompts)

| Metric | Value |
|--------|-------|
| Total Input Tokens | 1,741,762 (fixed across all rates — same sample set) |
| Avg Input Tokens/Request | 5,806 |
| Avg Output Tokens/Request | ~517 (varies slightly by run, range 154,668–156,804 total) |
| Avg Total Tokens/Request | ~6,323 |
| Input:Output Ratio | ~11.2:1 |

The custom dataset has a heavily input-skewed token distribution (11:1 input:output ratio vs ~1:1 for ShareGPT), which is representative of the actual demo workload where long Wikipedia passages are provided as context and the model generates relatively short analytical responses.

### Server Configuration

The vLLM server ran as a standalone process (`vllm.entrypoints.openai.api_server`) with no Dynamo, etcd, or NATS — isolating pure single-node inference performance. All Hopper-optimized defaults were applied automatically by vLLM:

| Server Parameter | Value |
|-----------------|-------|
| Max Model Length | 131,072 tokens |
| Max Num Batched Tokens | 8,192 (chunked prefill) |
| KV Cache Dtype | fp8_e4m3 |
| Quantization | ModelOpt FP8 |
| CUDA Graphs | Full + Piecewise (51 capture sizes, 1–512) |
| Torch Compile | Enabled (inductor backend) |
| Async Scheduling | Enabled |
| Block Reuse | Enabled (prefix caching) |

### Dataset Filter Patch

vLLM's `vllm bench serve` has hardcoded dataset filters (`max_prompt_len=1024`, `max_total_len=2048`) in `is_valid_sequence()` that silently reject long prompts. These defaults were patched at runtime via `sed` to `max_prompt_len=16384, max_total_len=32768` to accommodate the custom dataset's 4K-10K token prompts. This patch is applied automatically by `scripts/vllm-benchmark.sh` when `DATASET_PATH` differs from the default ShareGPT path.
