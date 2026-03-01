# GTC Demo Walkthrough: KV Cache-Aware Routing on DigitalOcean

This document describes everything visible in the demo's two displays — the Load Generator UI and the Grafana dashboard — so a booth agent can explain any element to visitors.

---

## What the Demo Shows

The demo runs **Llama 3.3 70B Instruct FP8** on DigitalOcean GPU Droplets (NVIDIA H200 GPUs), served through **NVIDIA Dynamo** with a vLLM backend and EAGLE-3 speculative decoding. Three TP=1 replicas each run on a separate single-GPU node.

The key optimization is **KV cache-aware routing**: Dynamo's frontend tracks which replica holds cached KV state from prior conversation turns and routes follow-up requests to that same replica. This avoids redundant prefill computation, dramatically reducing Time to First Token (TTFT) on turn 2 and beyond.

A synthetic load generator drives multi-turn chat conversations against the system. Each conversation has 3-5 turns. An 8B model (DigitalOcean Serverless Inference) generates realistic follow-up questions that get sent to the 70B model through Dynamo.

---

## Display 1: Load Generator UI

The Load Generator UI is a React web app served at the demo's public URL (e.g., `https://gtc-2026.digitalocean.solutions`). It has five pages accessible via the top navigation bar.

### Header (visible on all pages)

- **Title**: "Serve More Users on the Same GPUs with KV-Aware Routing"
- **Subtitle**: "Powered by NVIDIA Dynamo and DigitalOcean Kubernetes Service"
- **Navigation tabs**: Dashboard, Conversations, Demo Architecture, KV Routing, Dynamo Features
- **Start / Stop buttons** (top-right): Start begins the synthetic workload; Stop halts it. Buttons are disabled when the WebSocket connection to the backend is down. Start is disabled while the workload is already running; Stop is disabled while it is stopped.

---

### Page 1: Dashboard

The main operational view. Contains four sections stacked vertically.

#### Section 1: Live vs Round-Robin Benchmark

This panel is the centerpiece of the demo. It compares **live metrics** (measured right now with KV-aware routing enabled) against **pre-recorded round-robin baseline benchmarks** at the same concurrency level.

**SLO thresholds** are displayed in a subtitle line: TTFT p95 < 600ms, TPOT p95 < 60ms. Values that breach the SLO turn red; values within 90% of the SLO turn yellow.

**Concurrency slider**: A range slider (60 to 180, in steps of 20) that controls how many concurrent conversations the load generator maintains. Adjusting this changes both the live workload intensity and which pre-recorded baseline row is used for comparison. Changes are debounced (300ms) and applied live without stopping the workload.

**Metrics table** (appears once the workload starts producing data):

| Row | What It Measures |
|-----|-----------------|
| TTFT | Time to First Token — latency from request submission to the first token arriving. Displayed in milliseconds. The most important metric for demonstrating KV-aware routing: on multi-turn conversations, TTFT drops significantly on turn 2+ because cached KV state eliminates redundant prefill. |
| TPOT | Time Per Output Token — average time between consecutive output tokens. Displayed in milliseconds. Reflects decode-phase efficiency. |
| ITL | Inter-Token Latency — time between consecutive tokens as observed by the client. Displayed in milliseconds. Similar to TPOT but measured client-side (includes network jitter). |
| Latency | End-to-end request latency from submission to final token. Displayed in seconds. |

Each row shows four columns:
- **Live p50**: Current median from the last 60-second window
- **RR p50**: Pre-recorded median from round-robin baseline at the matching concurrency
- **Live p95**: Current 95th percentile from the last 60-second window
- **RR p95**: Pre-recorded 95th percentile from round-robin baseline at the matching concurrency

The RR (round-robin) columns use a muted visual style to distinguish them from live values.

**How to read it**: When KV-aware routing is working well, the Live columns should show lower values than the RR columns, especially for TTFT. The improvement comes from cache hits on multi-turn conversations — the router sends follow-up turns to the replica that already has the conversation's KV cache, so only the new user message needs prefill instead of the entire conversation history.

#### Section 2: Metrics (KPI Cards)

Six compact metric cards in a horizontal row, providing at-a-glance system health:

| Card | Description |
|------|------------|
| **RPS** | Requests per second — rate of completed requests over the current window. Indicates actual throughput being achieved. |
| **Requests** | Total count of completed requests since the workload started. |
| **TOPS** | Tokens per second — total output token throughput across all workers. Higher is better. Measures how many tokens the system is generating per second of wall-clock time. |
| **KV Cache Hit** | Percentage of input tokens served from KV cache rather than computed fresh. This is the key metric for KV-aware routing — a high hit rate (e.g., 60-80%) means most follow-up turns are benefiting from cached state. Near 0% means routing is not effectively reusing cache (typical of round-robin). Sourced from Prometheus via the loadgen backend. |
| **Queued** | Number of requests currently queued at the Dynamo frontend waiting for a worker slot. A sustained high value indicates the system is overloaded at the current concurrency. |
| **Errors** | Number of failed requests. Should be 0 during healthy operation. Non-zero values turn red to signal a problem (e.g., timeouts, OOM, worker crashes). |

Each card shows a dash ("—") when no data is available (workload not running or metric source unavailable).

#### Section 3: Static Benchmark Comparison

A table showing **pre-recorded p95 latency benchmarks** at every tested concurrency level (60, 80, 100, 120, 140, 160, 180). This is static data — it does not change with the live workload. It lets visitors see the full performance curve at a glance.

**Columns**:
- Concurrency level
- TTFT p95 (ms): Round-Robin value, KV-aware value, Improvement percentage
- TPOT p95 (ms): Round-Robin value, KV-aware value, Improvement percentage

**Color coding**: Green = within SLO, yellow = within 90% of SLO, red = exceeds SLO. SLO thresholds: TTFT p95 < 600ms, TPOT p95 < 60ms.

**Improvement column**: Shows the percentage reduction from round-robin to KV-aware (e.g., "+32.0%" means KV-aware is 32% faster). Positive values mean KV-aware routing is better.

**Key talking points from the data**:
- At concurrency 60: TTFT p95 improves from 655ms (RR, breaching SLO) to 446ms (KV, well within SLO) — a 31.9% improvement
- TPOT improvements are more modest (5-14%) since TPOT is primarily decode-bound
- At concurrency 140: TOPS increases from 2817 (RR) to 3168 (KV) — KV-aware routing actually improves throughput because less GPU time is spent on redundant prefill
- At very high concurrency (180), TTFT p95 with KV spikes to 3143ms — this shows the system is saturated and queueing dominates

#### Section 4: Infrastructure (Per-Worker GPU View)

Shows real-time GPU metrics for each Dynamo worker pod, sourced from DCGM (Data Center GPU Manager) via Prometheus.

**Header metadata**: Displays the GPU type (e.g., "H200") and model name (e.g., "nvidia/Llama-3.3-70B-Instruct-FP8").

**Per-worker cards**: One card per worker pod (typically 3 workers). Each card shows:
- Worker name (shortened pod name)
- One GPU box per GPU assigned to that worker (1 GPU per worker in TP=1 config), showing:
  - **GPU utilization %**: Compute utilization. Color-coded: green (<30%), amber (30-70%), red (>70%)
  - **Memory %**: GPU framebuffer memory used as a percentage of total. Shows how much VRAM is consumed by model weights + KV cache + activations.

A "Prometheus unavailable" warning appears if the metrics backend is unreachable.

---

### Page 2: Conversations

A list view of all multi-turn conversations generated by the load generator. Auto-refreshes every 5 seconds.

**Table columns**:
| Column | Description |
|--------|------------|
| Status | Badge showing "active" (green, conversation in progress), "completed" (gray, all turns finished), or "error" (red, a turn failed) |
| Topic | The conversation topic, randomly generated at the start of each conversation |
| Turns | Number of completed turns (out of the 3-5 planned) |
| Duration | Total wall-clock time from first request to last response |
| Started | Timestamp when the conversation began |

Clicking a row opens the **Conversation Detail** view.

#### Conversation Detail

Shows the full chat transcript for a single conversation with per-turn performance metrics. Auto-refreshes every 3 seconds for active conversations.

**Header**: Conversation topic, status badge, turn count, and total duration.

**Per-turn display**: Each turn shows:

| Metric | What It Shows |
|--------|--------------|
| **TTFT** | Time to First Token for this specific turn, in milliseconds. On turn 1 there is no cached state so TTFT reflects full prefill. On turns 2+ with KV-aware routing, TTFT should drop because the router sent the request to the worker that already has this conversation's KV cache — only the new user message needs prefill. |
| **ITL** | Inter-Token Latency for this turn, in milliseconds. Should be relatively stable across turns since decode speed is not affected by cache hits. |
| **Tokens** | Number of output tokens generated in this turn's response. |
| **Latency** | Total end-to-end latency for this turn, in seconds. |

Below the metrics, the actual **User** message and **Assistant** response are displayed in a chat-bubble format.

**Why this page matters for the demo**: It gives visitors a concrete, tangible view of KV-aware routing in action. You can point to a specific conversation and show that Turn 1 had a TTFT of, say, 400ms, while Turn 3 had a TTFT of 80ms — because the router sent turns 2 and 3 to the same worker that already had the conversation's KV cache loaded.

---

### Page 3: Demo Architecture

Displays a static infographic image (`do-demo-arch.png`) showing the overall system architecture — DigitalOcean infrastructure, DOKS cluster, Dynamo components, and how they connect.

### Page 4: KV Routing

Displays a static infographic image (`kv-cache-arch.png`) illustrating how KV cache-aware routing works — the Dynamo frontend, the radix tree that tracks cached token blocks, NATS event bus for KV state propagation, and the routing decision flow.

### Page 5: Dynamo Features

Displays a static infographic image (`dynamo-features.png`) highlighting key features of NVIDIA Dynamo as an inference serving platform.

---

## Display 2: Grafana Dashboard

The Grafana dashboard is titled **"GTC Demo: Optimized LLM Inference"** and is accessible at the `/grafana` path (e.g., `https://gtc-2026.digitalocean.solutions/grafana`). Dashboard UID: `gtc-demo`. Default time range: last 30 minutes.

All panels query Prometheus. Metrics are scoped to `namespace="dynamo-workload"` (the Kubernetes namespace where Dynamo workers run).

### Top Row: Summary Stats (4 stat panels)

Four single-value stat panels across the top providing instant system health:

| Panel | Prometheus Query | What It Shows |
|-------|-----------------|---------------|
| **Request Rate** | `sum(rate(dynamo_frontend_requests_total{namespace="dynamo-workload"}[1m]))` | Requests per second flowing through the Dynamo frontend. Rate is computed over a 1-minute window. Shows a small sparkline area chart of recent values. |
| **Inflight** | `sum(dynamo_frontend_inflight_requests{namespace="dynamo-workload"})` | Total number of requests currently being processed across all workers. This is the instantaneous concurrency the system is handling. |
| **Queued** | `sum(dynamo_frontend_queued_requests{namespace="dynamo-workload"})` | Requests waiting in the Dynamo frontend queue for a free worker slot. A sustained non-zero value means the system cannot keep up with incoming requests at the current concurrency. |
| **Output Tokens/s** | `sum(rate(dynamo_frontend_output_tokens_total{namespace="dynamo-workload"}[1m]))` | Total output token throughput across all workers, measured over a 1-minute window. The primary throughput metric. |

### Row 2: SLO Panels (2 time-series panels)

Two large time-series charts that are the most important panels on the dashboard. They show the SLO-tracked latency metrics with threshold visualization.

#### TTFT p95 (SLO: 600ms)

- **Primary series (orange, "p95")**: `loadgen_ttft_all_seconds{quantile="0.95"}` — the 95th percentile Time to First Token as measured by the load generator client. This is a client-side metric that includes network latency. Units are seconds on the Y-axis.
- **Secondary series (light blue dashed, "Inflight")**: `sum(dynamo_frontend_inflight_requests{namespace="dynamo-workload"})` — plotted on the right Y-axis to show how TTFT correlates with load. This is the same inflight count from the stat panel above.
- **SLO threshold**: A red horizontal line + shaded area at 0.6 seconds (600ms). When the p95 line enters the red zone, the SLO is breached.
- **How to interpret**: Under round-robin routing, TTFT p95 tends to hover near or above the 600ms SLO line because every multi-turn request requires full prefill. With KV-aware routing, TTFT p95 drops well below the line because cache hits eliminate most prefill work on follow-up turns.

#### TPOT p95 (SLO: 60ms)

- **Primary series (orange, "p95")**: `loadgen_tpot_all_seconds{quantile="0.95"}` — the 95th percentile Time Per Output Token from the load generator client. Units are seconds.
- **Secondary series (light blue dashed, "Inflight")**: Same inflight count on the right Y-axis.
- **SLO threshold**: Red line + area at 0.06 seconds (60ms).
- **How to interpret**: TPOT is primarily determined by decode speed and batch size, so it is less affected by routing strategy than TTFT. It degrades mainly under heavy load when batching causes contention. KV-aware routing provides modest TPOT improvements because less prefill work means the engine spends more time on decode, improving overall scheduling.

### Row 3: Detailed Latency Charts (2 time-series panels)

#### TTFT (p50 and p95)

- **p50 (green)**: `loadgen_ttft_all_seconds{quantile="0.5"}` — median TTFT
- **p95 (orange)**: `loadgen_ttft_all_seconds{quantile="0.95"}` — 95th percentile TTFT
- Shows the full distribution shape. A large gap between p50 and p95 suggests tail latency issues (some requests hitting uncached workers or experiencing queue delays).

#### TPOT (p50 and p95)

- **p50 (green)**: `loadgen_tpot_all_seconds{quantile="0.5"}` — median TPOT
- **p95 (orange)**: `loadgen_tpot_all_seconds{quantile="0.95"}` — 95th percentile TPOT
- A tight p50/p95 spread indicates consistent decode performance. A wide spread suggests batching contention or resource pressure.

### Row 4: Latency and Cache (2 time-series panels)

#### Latency

- **Series ("avg")**: `sum(rate(dynamo_frontend_request_duration_seconds_sum{namespace="dynamo-workload"}[1m])) / sum(rate(dynamo_frontend_request_duration_seconds_count{namespace="dynamo-workload"}[1m]))` — average end-to-end request duration computed from the Dynamo frontend histogram.
- This is the full request lifecycle: queue wait + prefill + decode + all tokens generated. Unlike TTFT which measures only time-to-first-token, this captures the complete response generation time.
- Units are seconds. A typical value for multi-turn chat responses (500-900 output tokens) is 15-45 seconds depending on concurrency.

#### KV Cache

- **Series ("Cache Hit Rate")**: `rate(dynamo_frontend_cached_tokens_sum{namespace="dynamo-workload"}[1m]) / rate(dynamo_frontend_input_sequence_tokens_sum{namespace="dynamo-workload"}[1m])` — the ratio of input tokens served from KV cache to total input tokens, computed as a rolling 1-minute rate.
- Y-axis: 0% to 100%.
- **How to interpret**: This is the single most direct indicator of whether KV-aware routing is working.
  - **Near 0%**: No cache reuse. Either routing is round-robin, the workload is all first-turn requests, or cache blocks are being evicted before reuse.
  - **30-50%**: Moderate reuse. Multi-turn conversations are landing on the correct workers but some cache has been evicted due to memory pressure or the conversation mix includes many new conversations.
  - **60-80%**: Strong reuse. Most follow-up turns are hitting cached state. This is the target range during the KV-aware portion of the demo.
  - **>80%**: Excellent reuse. Most of the workload is follow-up turns on long conversations with full cache retention.

### Per Worker Metrics Section

A collapsible row header labeled "Per Worker Metrics" separates the per-worker panels from the aggregate panels above.

#### Inflight Requests (per worker)

- **Series**: `dynamo_component_inflight_requests{namespace="dynamo-workload"}` — one line per worker pod, labeled by pod name.
- **Stacking**: Normal (stacked area chart). The total height equals the aggregate inflight count.
- **How to interpret**: Shows how work is distributed across workers.
  - Under round-robin routing, all workers should have roughly equal inflight counts.
  - Under KV-aware routing, distribution may be uneven because the router favors the worker with the best cache match. Temporary imbalances are expected and healthy — they mean the router is doing its job. The router also considers load when making decisions, so extreme imbalance is avoided.

#### GPU Utilization (per GPU)

- **Series**: `DCGM_FI_DEV_GPU_UTIL{exported_namespace="dynamo-workload"}` — one line per GPU, labeled by hostname and GPU index.
- Y-axis: 0% to 100%.
- **How to interpret**: Shows compute utilization for each GPU running a Dynamo worker. During active inference, utilization typically runs 40-80%. Low utilization (<20%) may indicate the worker is idle or the workload is not saturating the GPU. Very high sustained utilization (>90%) may indicate the GPU is a bottleneck.

#### Engine Queue Wait Time (per worker)

- **Series**: `rate(trtllm_request_queue_time_seconds_sum{namespace="dynamo-workload"}[1m]) / rate(trtllm_request_queue_time_seconds_count{namespace="dynamo-workload"}[1m])` — average time requests spend waiting in the inference engine's internal queue before processing begins, per worker pod.
- Units: seconds.
- **How to interpret**: Low values (< 0.1s) mean the engine is processing requests promptly. Rising queue wait times indicate the engine's batch is full and new requests are waiting for a slot. This metric helps distinguish between frontend-level queueing (Dynamo's queued requests metric) and engine-level queueing (requests that were dispatched to a worker but are waiting for the engine's batch scheduler).

---

## Key Metrics Glossary

### Latency Metrics

**TTFT (Time to First Token)**: The time from when a request is submitted to when the first output token is generated. This measures the "prefill" phase — the model processing all input tokens before generating the first output. TTFT is the metric most impacted by KV cache-aware routing. On turn 1 of a conversation, the full input must be prefilled. On subsequent turns with KV-aware routing, only the new tokens since the last turn need prefilling because the previous context is already in the worker's KV cache. Config flag: `DYN_ROUTER_MODE=kv` enables KV-aware routing on the Dynamo frontend. The loadgen reports this as `loadgen_ttft_all_seconds` (a Prometheus summary with quantile labels).

**TPOT (Time Per Output Token)**: The average time to generate each output token after the first. Computed as (total generation time - TTFT) / (output tokens - 1). This measures the "decode" phase efficiency. TPOT is primarily bounded by GPU memory bandwidth (loading model weights for each forward pass) and batch size. KV-aware routing has a modest positive effect on TPOT because avoiding redundant prefill frees up engine scheduling capacity for decode. The loadgen reports this as `loadgen_tpot_all_seconds`.

**ITL (Inter-Token Latency)**: The time between consecutive tokens as observed by the streaming client. Similar to TPOT but measured at the client side, so it includes any network jitter or buffering. ITL and TPOT are typically very close in this demo since the load generator runs inside the same cluster.

**Latency (End-to-End)**: Total wall-clock time from request submission to the final token being received. Equals TTFT plus the time to generate all output tokens. A function of input length (affects prefill/TTFT), output length (affects decode time), and system load (affects queue wait).

### Throughput Metrics

**RPS (Requests Per Second)**: The rate of completed requests. One "request" is a single LLM inference call (one turn of a conversation). The Dynamo frontend tracks this as `dynamo_frontend_requests_total`.

**TOPS (Tokens Per Second)**: Total output token throughput — how many tokens the system produces per second across all workers. Higher is better. Tracked by the Dynamo frontend as `dynamo_frontend_output_tokens_total`. KV-aware routing can improve TOPS because workers spend less time on redundant prefill and more time on productive decode.

### Cache and Routing Metrics

**KV Cache Hit Rate**: The proportion of input tokens that were served from the worker's existing KV cache rather than being computed fresh. Calculated as cached_tokens / total_input_tokens. Reported by the Dynamo frontend as `dynamo_frontend_cached_tokens_sum` divided by `dynamo_frontend_input_sequence_tokens_sum`. A high hit rate (60-80%) is the goal of KV-aware routing. The underlying mechanism is a radix tree in the Dynamo frontend that tracks which token-block hashes are cached on which worker. Workers publish KV cache events via NATS (config: `--publish-events-and-metrics` on workers, `DYN_KV_CACHE_BLOCK_SIZE=32` on the frontend to match the engine's block size).

**Inflight Requests**: The number of requests currently being processed (past the queue, actively generating tokens). Reported per-worker as `dynamo_component_inflight_requests` and aggregated at the frontend as `dynamo_frontend_inflight_requests`.

**Queued Requests**: Requests waiting in the Dynamo frontend queue for a worker to become available. Reported as `dynamo_frontend_queued_requests`. Sustained queueing indicates the system is at capacity for the current concurrency level.

### GPU Metrics

**GPU Utilization (DCGM_FI_DEV_GPU_UTIL)**: Percentage of time the GPU's compute engines are active, reported by NVIDIA's DCGM exporter. During LLM inference this is typically 40-80%. The decode phase is memory-bandwidth-bound rather than compute-bound, so utilization rarely reaches 100% even under full load.

**GPU Memory**: VRAM usage broken into model weights (fixed after loading), KV cache (grows with active conversations and retained cache), and activations (transient during forward pass). On H200 (141 GiB), the 70B FP8 model + EAGLE-3 drafter use approximately 71 GiB, with the remainder available for KV cache.

---

## Demo Flow

The demo is designed to show the difference between standard round-robin routing and KV cache-aware routing through a live A/B comparison.

### Phase 1: Baseline (Round-Robin Routing)

In this configuration, `DYN_ROUTER_MODE=round_robin` on the Dynamo frontend. Every incoming request is assigned to the next worker in rotation, regardless of whether that worker has any cached KV state for the conversation.

**What to observe**:
- TTFT is consistent across all turns of a conversation — turn 1, turn 3, and turn 5 all have similar TTFT because every turn requires full prefill of the entire conversation history
- KV Cache Hit Rate on the Grafana dashboard sits near 0%
- As conversations progress and context grows, TTFT increases linearly with conversation length
- TTFT p95 hovers near or above the 600ms SLO line on the Grafana dashboard
- Inflight requests are evenly distributed across workers (visible in the per-worker inflight chart)

### Phase 2: KV-Aware Routing

Switch to `DYN_ROUTER_MODE=kv`. This requires restarting the frontend and all worker pods to reset cache state and ensure consistency between the frontend's radix tree and the workers' actual cache contents.

**What to observe**:
- TTFT drops significantly on turn 2+ of conversations — the router sends follow-up turns to the worker that already has the conversation's KV cache
- KV Cache Hit Rate climbs to 60-80% as multi-turn conversations accumulate cache hits
- TTFT p95 drops well below the 600ms SLO threshold on the Grafana dashboard
- On the Conversations page, you can open individual conversations and see TTFT decreasing from turn to turn (e.g., Turn 1: 400ms, Turn 2: 120ms, Turn 3: 80ms)
- Inflight requests may become slightly uneven across workers — this is expected because the router favors cache-hit workers
- TOPS (tokens per second) increases because workers spend less time on redundant prefill

### What to Tell Visitors

The core message: **same GPUs, same model, same workload — just smarter routing.** KV-aware routing is an infrastructure-level optimization that requires no application changes. The application sends standard OpenAI-compatible API requests. All the optimization happens in the Dynamo routing layer.

Visitors should take away:
1. Multi-turn LLM conversations waste GPU compute under naive load balancing because every turn re-processes the full conversation history
2. KV cache-aware routing eliminates this waste by directing follow-up turns to the replica that already has the cached context
3. The result is lower latency (especially TTFT), higher throughput (TOPS), and the ability to serve more concurrent users on the same GPU infrastructure
4. DigitalOcean's GPU infrastructure with NVIDIA Dynamo makes this available as a managed experience
