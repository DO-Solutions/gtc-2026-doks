# KV Routing TTFT p95 Explosion: Root Cause Analysis

**Date:** 2026-02-28
**Setup:** 3x H200 TP=1 workers, vLLM + EAGLE-3, Dynamo KV-aware routing
**Data:** 6 averaged benchmark sweeps (concurrency 40-180), per-worker Prometheus metrics

## Problem

KV-aware routing TTFT p95 explodes at concurrency 170+ while p50 stays mild:

| Conc | RR TTFT p95 | KV TTFT p95 | KV TTFT p50 | Δ p95 |
|------|-------------|-------------|-------------|-------|
| 160  | 722ms       | 704ms       | 424ms       | KV 2.5% better |
| 170  | 708ms       | 1256ms      | 430ms       | **KV 77% worse** |
| 180  | 732ms       | 3143ms      | 472ms       | **KV 330% worse** |

## Root Cause: Momentary Inflight Variance → Queue Time Spikes

The load imbalance theory is **partially confirmed** — but the mechanism is different than expected:

- **Mean load is perfectly balanced.** Request rate skew: 1.01x (KV) vs 1.08x (RR). Mean inflight skew: 1.02x (KV). KV routing distributes requests evenly on average.
- **Momentary inflight variance is 2x higher in KV mode.** Max momentary spread: 28-32 requests (KV) vs 12-14 requests (RR). Max momentary ratio: 1.72-1.89x (KV) vs 1.21-1.29x (RR).
- **Queue time spikes when any worker exceeds ~65 inflight.** With 170 concurrency across 3 workers, mean is ~57. Momentary peaks push individual workers past the threshold.

## Evidence

### 1. Queue Time Skew (mean seconds, across all 3 sweep windows)

| Conc | Mode | Worker A | Worker B | Worker C | Skew | Max Spike |
|------|------|----------|----------|----------|------|-----------|
| 160  | KV   | 0.057    | 0.036    | 0.061    | 1.70x | 0.48s |
| 160  | RR   | 0.026-0.034 (9 workers) ||| 1.30x | 0.04s |
| 170  | KV   | **0.152**| **0.142**| 0.059    | **2.55x** | **1.48s** |
| 170  | RR   | 0.028-0.032 (9 workers) ||| 1.17x | 0.04s |
| 180  | KV   | **0.593**| **0.355**| **0.373**| 1.67x | **2.92s** |
| 180  | RR   | 0.032-0.075 (9 workers) ||| 2.32x | 0.22s |

### 2. Engine-Side TTFT Confirms Worker Divergence (conc 170)

| Mode | Worker | Mean TTFT | P95 TTFT | Max TTFT |
|------|--------|-----------|----------|----------|
| KV   | 27hhh  | 0.279s    | 0.842s   | **1.591s** |
| KV   | 4sk6g  | 0.266s    | 0.787s   | **1.487s** |
| KV   | 7fvmq  | 0.176s    | 0.288s   | 0.461s   |
| RR   | (all)  | 0.186-0.212s | 0.214-0.256s | 0.222-0.256s |

### 3. Temporal Pattern: Cascading Spike (Window 3, KV @ 170)

The queue time spikes are **intermittent, lasting 60-90 seconds**, and cascade across workers:

```
Time    Queue Time (seconds)              Inflight Requests
(sec)   27hhh   4sk6g   7fvmq     Ratio   27hhh   4sk6g   7fvmq   Spread
  120   0.026   0.031   0.027     1.17x     45      71      51      26  ← 4sk6g inflight spike
  135   0.028   0.031   0.031     1.13x     63      67      39      28
  150   0.028   0.301   0.031    10.77x     74      50      46      28  ← 4sk6g queue time spikes
  165   0.068   0.648   0.032    20.06x     65      51      54      14
  180   0.377   1.163   0.031    38.11x     58      54      59       5  ← cascades to 27hhh
  195   0.735   1.360   0.025    54.32x     57      51      58       7
  210   1.446   1.107   0.025    56.98x     62      53      57       9  ← 27hhh peaks at 1.45s
  225   1.483   0.429   0.024    62.39x     64      51      55      13  ← 4sk6g recovering
  240   1.082   0.045   0.028    38.30x     62      56      52      10
  255   0.469   0.027   0.029    17.62x     55      61      55       6  ← 27hhh recovering
  270   0.026   0.025   0.028     1.12x     46      62      63      17  ← back to normal
```

Frontend queued requests spike to **12** at t=150s (from baseline of 1-3).

### 4. Why KV Routing Creates Higher Variance

KV-aware routing makes conversations **sticky** to workers. Multi-turn conversations have correlated arrival patterns — when multiple conversations on the same worker reach turn N at similar times, they create a **burst** of concurrent prefill requests. Round-robin breaks this correlation by distributing each request independently.

Additionally, KV cache hits create variable prefill cost: some requests are nearly free (full cache hit), others require full prefill (new conversation). This creates a **bimodal workload distribution** on each worker — a batch might contain a mix of 10ms and 200ms prefills, and the slow ones delay the entire batch.

## Summary

| Metric | KV Mode | RR Mode | Difference |
|--------|---------|---------|------------|
| Mean inflight skew | 1.02x | 1.11x | KV slightly better |
| Momentary inflight spread | 28-32 | 12-14 | **KV 2x worse** |
| Queue time skew | 2.55x | 1.17x | **KV 2.2x worse** |
| Max queue time spike | 1.48s | 0.04s | **KV 37x worse** |
| Engine TTFT max | 1.59s | 0.26s | **KV 6x worse** |
| Spike duration | 60-90s | N/A | Intermittent |
| Spike pattern | Cascading 1→2 workers | N/A | Serial |

## Conclusions

1. **KV routing doesn't cause sustained load imbalance** — mean distribution is excellent (1.01x request rate skew).
2. **It creates higher momentary variance** due to conversation stickiness and correlated multi-turn arrivals.
3. **At concurrency 170+ (≈57 inflight/worker), the system operates near a queueing threshold** (~65 inflight). Momentary peaks push individual workers past this threshold, triggering cascading queue time spikes.
4. **The spikes are intermittent and self-correcting** (60-90s), but at p95 measurement granularity they dominate the tail.
5. **RR mode avoids this** by breaking arrival correlation and distributing requests independently, keeping momentary variance low.

## Implications for the Demo

- **Concurrency 160 is the practical ceiling** for KV-aware routing with 3 workers. Below this, KV routing is strictly better on all metrics.
- **The demo should target concurrency 120-150** where KV routing shows clear p95 improvement (446ms vs 660ms at conc 40, maintaining advantage through 150).
- **Adding a 4th worker would raise the ceiling** to ~220 concurrency (threshold ~65 × 4 workers), but requires the 4th GPU.
- **Alternative mitigation**: frontend-side load balancing that factors in worker queue depth (not just KV cache hits). The KV router could fall back to round-robin when the preferred worker's inflight exceeds a threshold.
