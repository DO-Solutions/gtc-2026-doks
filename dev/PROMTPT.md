# Benchmark Sweep: KV Cache Routing vs No Routing

## Objective

We need to benchmark our inference deployment at 5 concurrency levels to measure the impact of KV cache-aware routing on TTFT. The results will be used as a baseline reference in our live demo dashboard.

## Architecture Change

We are moving from 2 replicas (TP=4) to 4 replicas (TP=2) using the same 8× H100 GPU allocation. This change:
- Enables speculative decoding with Llama 8B as the draft model (now fits in memory alongside Llama 70B at TP=2 with FP8)
- Improves KV cache routing effectiveness — round-robin now has a 25% chance of a cache hit vs 50% with 2 replicas, making the routing benefit much more visible

## What We're Measuring

The key metric is **TTFT** (time to first token) — comparing:
- **Without KV cache routing**: requests land on random replicas (cache miss, full recompute)
- **With KV cache routing**: requests are routed to the replica holding the cached KV prefix (cache hit, skip projection recompute)

The load generator reports a single generic TTFT metric for all requests. The comparison is TTFT with routing vs TTFT without routing, at each concurrency level.

## Concurrency Levels

Run the sweep at these 5 total concurrency levels:
- 40 (10 per replica)
- 60 (15 per replica)
- 80 (20 per replica)
- 100 (25 per replica)
- 120 (30 per replica)

We have 4 replicas. Each replica supports approximately 53 concurrent sequences based on available KV cache memory. All concurrency levels are well within this capacity.

## Deployment Details

- 2× H100 per replica, TP=2
- Llama 70B FP8 (target model) + Llama 8B FP8 (draft model for speculative decoding)
- FP8 KV cache for both models
- Dynamo TRT-LLM runtime
- max_batch_size: 64
- max_num_tokens: 16384
- max sequence length: 16,384 tokens
- Chat prompts: ~3,100 tokens
- maxTokens (output): 1024
- 4 replicas
- free-gpu-memory-fraction: 0.85

### Memory Budget Per GPU (for reference)

```
Usable HBM (80 GB × 0.85):         68.0 GB
Llama 70B weights (70 GB FP8 / 2): -35.0 GB
Llama 8B weights (8 GB FP8 / 2):    -4.0 GB
CUDA context + activations:          -5.0 GB
────────────────────────────────────────────
Available for KV cache:              ~24.0 GB
```

Note: Activation memory may be higher than estimated with two models loaded. If OOM occurs, reduce free-gpu-memory-fraction to 0.80 as a first step.

## What Needs to Change

1. **Deployment**: Reconfigure from 2 replicas (TP=4) to 4 replicas (TP=2). Add the Llama 8B FP8 draft model for speculative decoding. Update the DynamoGraphDeployment accordingly.
2. **Load generator / benchmark tooling**:
   a. Run each concurrency level for 5 minutes to get stable p50 and p95 numbers.
   b. At each concurrency level, run two modes:
      - **Routing disabled**: KV cache-aware routing turned off (requests land on random replicas, full recompute)
      - **Routing enabled**: KV cache-aware routing turned on (requests routed to replica with cached KV)
   c. Routing is controlled by an environment variable on the DynamoGraphDeployment. Switching between modes requires a redeployment. Plan the test order to minimize redeployments — run all 5 concurrency levels with routing disabled first, then redeploy with routing enabled and run all 5 levels again (2 total deployments rather than 10).
   d. After each redeployment, wait for the deployment to be fully ready and stable before starting the benchmark. Allow a brief warm-up period (a few conversations) before collecting measurements to avoid cold-start noise.
   e. For each mode at each concurrency level, collect:
      - TTFT p50
      - TTFT p95
      - KV cache hit rate (for the routing-enabled runs, to confirm hits are actually occurring)
   f. Output results in a format suitable for the demo dashboard — we want to show a baseline reference line (without routing) against live metrics (with routing)

## What NOT to Change

- Do not change prompt length or maxTokens
- Do not change max_num_tokens (16384)

## Things to Monitor

- **GPU KV cache utilization**: With less headroom per replica (~24 GB vs ~45.5 GB previously), monitor that cache utilization stays healthy and doesn't cause evictions at higher concurrency levels
- **OOM errors**: Two models loaded simultaneously may push activation memory higher than expected. If OOM occurs, reduce free-gpu-memory-fraction to 0.80
- **Speculative decoding acceptance rate**: Track if available — low acceptance rates may indicate the draft model isn't well-matched for the workload, which would affect throughput but not TTFT directly

## Expected Outcome

With 4 replicas, round-robin routing only achieves a ~25% cache hit rate vs ~100% with KV-aware routing. This should produce a clear and growing TTFT gap as concurrency increases. The without-routing TTFT should climb faster because 75% of requests require full recompute, competing for GPU resources. The with-routing TTFT should stay flatter because cache hits skip that recompute work.