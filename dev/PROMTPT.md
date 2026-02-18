# Benchmark: SLA-Based Capacity Testing

## Objective

Determine the maximum concurrent sessions each configuration can sustain while staying within a TTFT p95 SLA target. The goal is to show that KV cache-aware routing allows more users on the same hardware at the same latency SLA.

## Two Phases

For each phase, ramp concurrency and find the point where TTFT p95 crosses the SLA threshold.

**Phase 1 — Baseline (Round-Robin)**
- KV cache routing disabled
- Requests land on random replicas — with 4 replicas, only ~25% of requests hit a cached KV prefix

**Phase 2 — KV Cache-Aware Routing**
- KV cache routing enabled
- Requests are routed to the replica holding the cached KV prefix — ~100% cache hit rate
- Cache hits reduce prefill work, allowing more concurrent sessions before hitting the SLA

## SLA Target

**TTFT p95 ≤ 400ms**

If during testing it becomes clear that 400ms is too tight or too loose (e.g., baseline crosses it immediately, or no phase crosses it within our concurrency range), adjust to 450ms and note the change.

## Concurrency Ramp

Run at these concurrency levels (finer granularity in the range where we expect the SLA breakpoint):

**20, 30, 40, 50, 60, 70, 80, 100, 120**

Run each level for 5 minutes. Record TTFT p50, TTFT p95, and KV cache hit rate at each level.

## Deployment Details

- 4 replicas, 2× H100 per replica, TP=2
- Llama 70B FP8
- FP8 KV cache
- Dynamo TRT-LLM runtime
- max_batch_size: 64
- max_num_tokens: 16384
- max sequence length: 16,384 tokens
- Chat prompts: ~3,100 tokens
- maxTokens (output): 1024
- free-gpu-memory-fraction: 0.85

## Switching Between Phases

Routing is controlled by an environment variable on the DynamoGraphDeployment. Switching requires a redeployment.

1. Deploy Phase 1 config (routing disabled). Run all 9 concurrency levels.
2. Redeploy Phase 2 config (routing enabled). Run all 9 concurrency levels.

After each redeployment, wait for the deployment to be fully ready and stable. Allow a brief warm-up period (a few conversations) before collecting measurements.

Total test time: ~2 phases × 9 levels × 5 minutes = ~90 minutes of test time plus redeployment overhead.

## Metrics to Collect

For each phase at each concurrency level:
- TTFT p50
- TTFT p95
- KV cache hit rate

## Output Format

Results should be in a format that makes it easy to identify the SLA breakpoint for each phase. Ideally a single table:

| Concurrency | Baseline TTFT p95 | KV Routing TTFT p95 |
|---|---|---|
| 20 | ... | ... |
| 30 | ... | ... |
| ... | ... | ... |

Mark the highest concurrency level where each phase stays at or below the SLA target. The difference between those breakpoints is the demo story: "KV cache-aware routing supports X% more concurrent sessions on the same hardware at the same latency SLA."

## What NOT to Change

- Do not change prompt length or maxTokens between phases
- Do not change max_batch_size or max_num_tokens between phases
- Do not change the number of replicas or GPU configuration between phases
- The only variable changing between phases is routing (on/off)

## What to Monitor

- **KV cache hit rate**: Should be near 0% for Phase 1 (random routing hits ~25% by chance), near 100% for Phase 2. If Phase 2 hit rate is low, stop and debug before continuing.
- **GPU KV cache utilization**: Watch for eviction pressure at higher concurrency levels.


I am reviewing https://llm-d.ai/docs/usage/readiness-probes and I see the recommend using /v1/models for startupProbe and readinessProbe. I'd like to confirm how well that works, can you deploy the /home/jjk3/PycharmProjects/work/digitalocean/scale-with-simplicity/reference-architectures/vllm-nfs RA and configure to see if this endpoint works as it shows? 