# Phase 0 Baseline Benchmark Report - ShareGPT

## Configuration

| Parameter | Value |
|-----------|-------|
| Engine | vLLM 0.14.1 (V1 engine) |
| GPU | 1x H200 141GB |
| Model | Llama 3.1 70B Instruct FP8 |
| Tensor Parallel | 1 |
| KV Cache Dtype | fp8_e4m3 |
| Chunked Prefill | Enabled (max_num_batched_tokens=8192) |
| Prefix Caching | Enabled |
| Attention Backend | FLASH_ATTN |
| Available KV Cache | 53.15 GiB (348,304 tokens) |
| Model Memory | 67.7 GiB |
| Dataset | ShareGPT |
| Prompts per Rate | 300 |
| Server Startup | 205s |

## Results

All times in milliseconds. Throughput in output tokens/sec.

| Rate | Compl | Fail | MaxConc | TTFT p50 | TTFT p95 | TTFT p99 | TPOT p50 | TPOT p95 | TPOT p99 | ITL p50 | ITL p95 | ITL p99 | Tput tok/s |
|-----:|------:|-----:|--------:|---------:|---------:|---------:|---------:|---------:|---------:|--------:|--------:|--------:|-----------:|
| 0.50 |   300 |    0 |       7 |     66.5 |    151.5 |    180.7 |     20.4 |     21.2 |     23.1 |    20.2 |    20.6 |    22.1 |       98.5 |
| 0.75 |   300 |    0 |       9 |     57.4 |     68.7 |     71.6 |     20.3 |     20.5 |     20.6 |    20.3 |    20.7 |    21.0 |      147.8 |
| 1.00 |   300 |    0 |      11 |     56.5 |     68.8 |     72.9 |     20.4 |     20.6 |     20.8 |    20.3 |    20.8 |    21.3 |      194.4 |
| 1.25 |   300 |    0 |      13 |     58.9 |     69.6 |     72.7 |     20.4 |     20.9 |     21.2 |    20.4 |    21.0 |    21.6 |      242.0 |
| 1.50 |   300 |    0 |      13 |     59.7 |     72.1 |     74.0 |     20.5 |     21.1 |     21.7 |    20.5 |    21.2 |    27.4 |      288.3 |
| 2.00 |   300 |    0 |      19 |     60.2 |     72.8 |     75.0 |     20.8 |     21.4 |     22.0 |    20.7 |    21.5 |    27.7 |      380.8 |
| 2.50 |   300 |    0 |      22 |     63.7 |     75.4 |     78.7 |     21.2 |     25.3 |     27.6 |    21.0 |    27.6 |    28.0 |      463.6 |
| 3.00 |   300 |    0 |      26 |     64.2 |     79.4 |     85.9 |     21.5 |     27.6 |     27.7 |    21.2 |    27.9 |    28.1 |      543.0 |

## SLO Analysis

SLO targets: TTFT p99 < 350ms, TPOT p99 < 60ms.

| Rate | TTFT p99 | TPOT p99 | Status |
|-----:|---------:|---------:|--------|
| 0.50 |    180.7 |     23.1 | PASS   |
| 0.75 |     71.6 |     20.6 | PASS   |
| 1.00 |     72.9 |     20.8 | PASS   |
| 1.25 |     72.7 |     21.2 | PASS   |
| 1.50 |     74.0 |     21.7 | PASS   |
| 2.00 |     75.0 |     22.0 | PASS   |
| 2.50 |     78.7 |     27.6 | PASS   |
| 3.00 |     85.9 |     27.7 | PASS   |

All 8 rates pass both SLOs with significant headroom. The system is not yet saturated at 3.0 RPS.

## Key Observations

- **Decode latency is remarkably flat.** ITL p50 stays at ~20ms across all rates, indicating the H200's memory bandwidth is not yet a bottleneck.
- **TTFT scales gracefully.** TTFT p99 grows from 72ms (rate 1.0) to 86ms (rate 3.0) — a modest 19% increase for 3x the load.
- **Saturation onset at 2.5 RPS.** TPOT p95 jumps from 21ms to 25ms between rate 2.0 and 2.5, and ITL p99 jumps from 28ms at 1.5 RPS. This suggests batching pressure is beginning but is well-managed.
- **Zero failures.** 300/300 requests completed at every rate.
- **Peak throughput: 543 output tok/s (1,114 total tok/s) at 3.0 RPS.**
- **Anomalous TTFT at rate 0.5.** The p95/p99 TTFT at rate 0.5 (152ms/181ms) is higher than at rates 0.75-1.25 (~69-73ms). This is likely a cold-cache artifact from the first benchmark run after warm-up.

## Workload Parameters

| Parameter | Value |
|-----------|-------|
| Tool | `vllm bench serve` (built-in vLLM 0.14.1 benchmarking) |
| Dataset | ShareGPT V3 unfiltered cleaned split |
| Dataset Source | `anon8231489123/ShareGPT_Vicuna_unfiltered` (HuggingFace) |
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
| Total Input Tokens | 62,238 (fixed across all rates — same sample set) |
| Avg Input Tokens/Request | 207 |
| Avg Output Tokens/Request | ~198 (varies slightly by run, range 59,105–59,704 total) |
| Avg Total Tokens/Request | ~405 |
| Input:Output Ratio | ~1.05:1 |

ShareGPT conversations have highly variable lengths — the distribution is heavy-tailed with many short exchanges and occasional long conversations. This makes it a realistic proxy for production chat workloads, though it differs from the multi-turn demo workload which targets longer context windows.

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
