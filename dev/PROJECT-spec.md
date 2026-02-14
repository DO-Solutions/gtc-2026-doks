# GTC Demo Proposal v2: Optimized LLM Inference on DigitalOcean

## 1. Executive Summary

This demo showcases two complementary inference optimizations running on DigitalOcean GPU infrastructure: **KV cache-aware routing** and **speculative decoding**. Together, they reduce both time-to-first-token (TTFT) and inter-token latency (ITL) for multi-turn LLM conversations — without requiring any changes to the application layer. The system exposes a standard OpenAI-compatible API; the optimizations are entirely infrastructure-side.

Running on a single 8xH100 (or 8xH200) GPU node, the demo serves a 70B-parameter Llama model in FP8 through NVIDIA Dynamo with a TensorRT-LLM backend. Two TP=4 replicas handle requests, with Dynamo's KV-aware router directing multi-turn conversations to the replica that already holds their KV cache, and speculative decoding accelerating token generation within each replica.

Development follows a **risk-ladder approach**: Phase 1 delivers a safe, working demo with KV-aware routing only. Phase 2 adds speculative decoding using Llama 3.1 8B as a draft model — proven path, minimal risk. Phase 3 upgrades to Llama 3.3 70B with EAGLE3 speculative decoding for maximum performance — higher risk, higher reward, and produces a compelling comparison between the two speculative decoding approaches for blog content. Each phase is a viable demo on its own; later phases build on earlier ones without rework.

**Key Message:** DigitalOcean's GPU infrastructure, combined with NVIDIA's inference stack, delivers measurably lower latency through intelligent routing and engine-level optimization — two layers of improvement that work together transparently.

---

## 2. Why These Optimizations Matter

### The Problem with Naive LLM Serving

In a standard multi-replica LLM deployment with round-robin load balancing, every request is treated independently. This creates two sources of waste:

1. **Redundant prefill on multi-turn conversations.** When a user sends a follow-up message, the new request may land on a different replica than the one that served the previous turn. That replica has no context — it must re-process the entire conversation history from scratch. The KV cache computed on the original replica is wasted. For long conversations, this means TTFT grows linearly with conversation length on every turn.

2. **Underutilized GPU compute during decode.** Autoregressive decoding is memory-bandwidth bound, not compute bound. Each forward pass through the model generates a single token, but most of the time is spent loading model weights from HBM — not doing math. The GPU's tensor cores sit largely idle during decode. You're paying for FLOPS you aren't using.

### How KV Cache-Aware Routing Solves Problem 1

KV cache-aware routing operates at the **routing layer** in Dynamo's frontend. When a request arrives, the router checks which worker already holds KV cache entries for that conversation's prefix. If a match is found, the request is routed to that worker, and the existing KV cache is reused — skipping redundant prefill entirely.

The result: on turn 2+ of a multi-turn conversation, TTFT drops dramatically because the system only needs to prefill the new tokens (the latest user message), not the entire conversation history.

This optimization is transparent to the client. The API is unchanged. The router makes the decision based on internal KV cache state tracked across workers via NATS.

### How Speculative Decoding Solves Problem 2

Speculative decoding operates at the **engine layer** inside each TRT-LLM worker, after routing has already occurred. It addresses the decode-phase bottleneck by converting token generation from a sequential process into a draft-and-verify process.

The mechanism works in two stages:

- **Draft phase:** A lightweight prediction model (e.g., EAGLE3 heads appended to the target model, or a separate smaller draft model from the same model family) generates K candidate tokens. Because the draft model is much smaller or simpler, each forward pass is fast.

- **Verification phase:** The target model (Llama 70B) processes all K draft tokens in a single forward pass. This is the key insight — verification is parallelizable in a way that generation is not. The target model evaluates all candidates simultaneously and accepts those that match its own distribution, rejecting the rest.

The acceptance scheme guarantees that the output distribution is **identical** to what the target model would produce on its own. There is no quality degradation — only speed improvement.

In the best case, all K tokens are accepted and the system generates K+1 tokens per forward pass instead of 1. In the worst case, at least 1 token is generated (the standard outcome), so speculative decoding never performs worse than baseline.

**Acceptance rate** is the metric that determines speedup. For same-family model pairs (Llama 8B drafting for Llama 70B, or EAGLE3 heads trained on Llama 70B), acceptance rates of 60-80% are typical, with higher rates on predictable content (code, factual responses) and lower rates on creative or reasoning-heavy generation.

### How They Work Together

These optimizations are complementary because they target different phases and different layers of the inference pipeline:

| Optimization | Layer | Phase Targeted | Metric Improved |
|---|---|---|---|
| KV-aware routing | Routing (Dynamo frontend) | Prefill | TTFT |
| Speculative decoding | Engine (TRT-LLM worker) | Decode | ITL |

For a multi-turn conversation, the combined effect on turn 2+ is:

1. KV-aware routing eliminates redundant prefill → **TTFT drops**
2. Speculative decoding accelerates token generation → **ITL drops**

Neither optimization requires changes to the application, the model, or the API contract. They are purely infrastructure-side improvements.

---

## 3. Demo Environment

### Hardware

- **1x 8xH100 GPU node** (80GB HBM3 per GPU, NVLink interconnect)
  - Development and recording environment
  - H200 variant (141GB HBM3e) may be available for GTC booth; architecture is identical
- CPU capacity for Dynamo frontend, etcd, NATS, monitoring stack, and load generator

### Model

The target model progresses across development phases:

| Dev Phase | Target Model | Spec Decode | Checkpoint |
|---|---|---|---|
| Phase 1 | Llama 3.1 70B Instruct FP8 | None | `nvidia/Llama-3.1-70B-Instruct-FP8` |
| Phase 2 | Llama 3.1 70B Instruct FP8 | Llama 3.1 8B Instruct FP8 (draft model) | `nvidia/Llama-3.1-8B-Instruct-FP8` |
| Phase 3 | Llama 3.3 70B Instruct FP8 | EAGLE3 heads | `nvidia/Llama-3.3-70B-Instruct-FP8` + EAGLE3 checkpoint (see below) |

All configurations run at **TP=4** with two replicas across the 8 GPUs. At TP=4, each GPU holds ~17.5GB of target model weights, leaving ample headroom for KV cache, draft model weights (Phase 2: ~2GB per GPU), or EAGLE3 heads (Phase 3: minimal overhead), and activations.

Llama 3.3 70B Instruct is architecturally identical to Llama 3.1 70B (same parameter count, tokenizer, and GQA configuration) with improved training. Switching from 3.1 to 3.3 in Phase 3 does not require any infrastructure changes — only the model checkpoint and EAGLE3 heads change.

### Speculative Decoding Approaches

**Phase 2: Draft-target model (Llama 8B → Llama 70B).** The draft model is a separate, smaller model from the same family that generates candidate tokens independently. Because the 8B model has its own weights and learned distributions, it doesn't have direct visibility into the 70B model's internal state — it's predicting based on its own (smaller) understanding of the context. This limits acceptance rates to roughly 55-70% depending on the task. However, the path is well-documented, requires no special checkpoints, and is proven on TRT-LLM (see [TRT-LLM speculative decoding docs](https://nvidia.github.io/TensorRT-LLM/advanced/speculative-decoding.html)).

**Phase 3: EAGLE3 (Llama 3.3 70B).** EAGLE3 appends a lightweight single-transformer-layer prediction head directly to the target model. Unlike the draft-target approach, EAGLE3 operates on the target model's own hidden states — it reads the 70B model's internal representations and extrapolates forward, rather than predicting independently. This results in higher acceptance rates (typically 70-85%) and lower memory overhead (no separate model to load). The tradeoff is a dependency on finding a compatible pre-trained EAGLE3 checkpoint.

Available EAGLE3 checkpoints for Llama 3.3 70B Instruct:

| Checkpoint | Publisher | Notes |
|---|---|---|
| [`yuhuili/EAGLE3-LLaMA3.3-Instruct-70B`](https://huggingface.co/yuhuili/EAGLE3-LLaMA3.3-Instruct-70B) | EAGLE paper authors | Framework-agnostic; best candidate for TRT-LLM |
| [`lmsys/SGLang-EAGLE3-Llama-3.3-70B-Instruct-SpecForge`](https://huggingface.co/lmsys/SGLang-EAGLE3-Llama-3.3-70B-Instruct-SpecForge) | SGLang/LMSYS | Validated at TP=4; designed for SGLang |
| [`RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3`](https://huggingface.co/RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3) | Red Hat | Designed for vLLM |

**Note:** No EAGLE3 checkpoint exists for Llama 3.1 70B — this is why Phase 3 requires the model switch to Llama 3.3. The `yuhuili` checkpoint is the most likely to work with TRT-LLM's EAGLE3 one-model mode, but compatibility must be validated. Dynamo's existing EAGLE3 + TRT-LLM example uses Llama 4 Maverick (see [Dynamo Llama 4 + EAGLE example](https://docs.nvidia.com/dynamo/latest/backends/trtllm/llama4_plus_eagle.html)), so checkpoint format conversion may be required.

### Software Stack

| Component | Role |
|---|---|
| **Dynamo** | Inference serving framework: KV cache-aware routing, OpenAI-compatible API, worker discovery via etcd |
| **TensorRT-LLM** | Inference backend: FP8 quantized execution, speculative decoding engine, paged KV caching |
| **NATS** | Messaging for KV cache state coordination (required for KV-aware routing) |
| **etcd** | Worker discovery and service registry |
| **Prometheus + Grafana** | Metrics collection and visualization |

### Architecture

```
                      ┌──────────────────────────────────────────────────────────┐
                      │              8x H100 GPU Node                            │
                      │                                                          │
┌──────────┐          │  ┌────────────────────────────────────────────────────┐  │
│  Client   │          │  │           Dynamo Frontend (Rust)                   │  │
│ Requests  │─────────▶│  │  KV-aware router: routes multi-turn conversations │  │
│ (OpenAI   │          │  │  to the replica holding their cached KV state     │  │
│  compat)  │          │  └──────────────┬──────────────┬─────────────────────┘  │
└──────────┘          │                 │              │                         │
                      │                 ▼              ▼                         │
                      │  ┌──────────────────┐  ┌──────────────────┐             │
                      │  │  Replica A       │  │  Replica B       │             │
                      │  │  TP=4 (GPUs 0-3) │  │  TP=4 (GPUs 4-7) │             │
                      │  │                  │  │                  │             │
                      │  │  Llama 70B FP8   │  │  Llama 70B FP8   │             │
                      │  │  + Speculative   │  │  + Speculative   │             │
                      │  │    Decoding *    │  │    Decoding *    │             │
                      │  │                  │  │                  │             │
                      │  └──────────────────┘  └──────────────────┘             │
                      │                                                          │
                      │  ┌────────────────────────────────────────────────────┐  │
                      │  │  Infrastructure: etcd, NATS, Prometheus, Grafana   │  │
                      │  └────────────────────────────────────────────────────┘  │
                      └──────────────────────────────────────────────────────────┘
```

*\* Speculative decoding configuration varies by dev phase: none (Phase 1), Llama 8B draft model (Phase 2), or EAGLE3 heads (Phase 3).*

---

## 4. Demo Narrative and Phases

The demo is structured as a progressive optimization story: start with a baseline, add one optimization at a time, and show the measurable impact of each. This structure works for both the recorded video (with cuts between phases) and the blog post (with screenshots/charts at each phase).

At the GTC booth, the fully-optimized system runs live with Grafana reference lines showing baseline and single-optimization performance levels for comparison.

### Workload: Multi-Turn Chat

All phases use the same workload: synthetic multi-turn chat conversations driven by a load generator.

- **Conversation structure:** 3-5 turns per conversation, with each turn building on previous context
- **Turn generation:** A broker application uses DigitalOcean Serverless Inference (Llama 3.1 8B Instruct) to generate contextual follow-up questions based on randomly selected passages from a document corpus stored in a Spaces bucket
- **Why this workload:** Multi-turn chat is the workload that benefits from *both* optimizations visibly. Turn 1 benefits from speculative decoding only. Turn 2+ benefits from both KV-aware routing (TTFT improvement) and speculative decoding (ITL improvement).

### Metrics Dashboard (Grafana)

The Grafana dashboard is the visual centerpiece of the demo, showing key metrics in real time:

| Metric | What It Shows | Source |
|---|---|---|
| **TTFT (p50/p95)** | Time to first token; drops on turn 2+ with KV routing | Dynamo frontend metrics |
| **ITL (p50/p95)** | Inter-token latency; drops with speculative decoding | Dynamo frontend metrics |
| **KV Cache Hit Rate** | Percentage of requests reusing cached KV | Dynamo router metrics |
| **Acceptance Rate** | Draft token acceptance rate for speculative decoding | TRT-LLM engine metrics |
| **Tokens per Step** | Average tokens generated per forward pass (1.0 = no spec decode) | TRT-LLM engine metrics |
| **Active Conversations** | Current concurrent multi-turn conversations | Load generator |

For the booth display, horizontal threshold lines on the TTFT and ITL panels mark baseline (no optimization) and single-optimization performance levels, so attendees can immediately see the improvement.

### Phase 1: Baseline — No Optimizations

**Configuration:** Llama 70B FP8 on 2x TP=4 replicas, round-robin routing, no speculative decoding.

**Purpose:** Establish baseline TTFT and ITL under multi-turn chat load. This is the "standard deployment" that most teams would set up.

**What to observe:**
- TTFT is consistent across all turns — no benefit from prior context
- TTFT grows with conversation length as the full history is re-prefilled every turn
- ITL is the standard autoregressive decode rate
- KV cache hit rate is at or near zero (round-robin distributes requests randomly)

**Key takeaway:** "This is what a typical multi-replica LLM deployment looks like. It works, but it's leaving performance on the table."

### Phase 2: KV Cache-Aware Routing Enabled

**Configuration:** Same replicas, switch from round-robin to KV-aware routing via Dynamo. No speculative decoding yet.

**What changes:**
- Dynamo frontend now tracks KV cache state across replicas via NATS
- Multi-turn conversations are routed to the replica holding their existing KV cache
- Only the new user message requires prefill; cached context is reused

**What to observe:**
- **TTFT drops significantly on turn 2+** — the system skips redundant prefill
- TTFT on turn 1 is unchanged (no cache to hit yet)
- ITL is unchanged (decode path is the same)
- KV cache hit rate climbs as conversations progress

**Key takeaway:** "Same model, same hardware, same API — just smarter routing. Multi-turn TTFT drops because we stop re-computing context the system already has."

### Phase 3a: Speculative Decoding — Draft Model (Llama 8B)

**Configuration:** KV-aware routing remains active. TRT-LLM workers now run with speculative decoding using Llama 3.1 8B Instruct FP8 as the draft model, co-located on the same TP=4 GPU group.

**What changes:**
- TRT-LLM engine generates multiple candidate tokens per forward pass using the 8B draft model
- Acceptance rate and tokens-per-step metrics appear on the dashboard

**What to observe:**
- **ITL drops** — tokens are generated faster due to multi-token verification
- TTFT on turn 2+ remains low (KV routing still active)
- Acceptance rate visible on the dashboard (expected: 55-70% depending on task)
- Tokens per step shows improvement over baseline

**Key takeaway:** "Now we're optimizing both phases. KV-aware routing handles the prefill side — no wasted re-computation. Speculative decoding handles the decode side — no wasted GPU cycles. The result: lower TTFT *and* lower ITL, running on the same hardware."

### Phase 3b: Speculative Decoding — EAGLE3 (Llama 3.3 70B)

**Configuration:** Same architecture, but the target model switches to Llama 3.3 70B Instruct FP8 with EAGLE3 prediction heads replacing the separate 8B draft model.

**What changes:**
- EAGLE3 heads are fused into the TRT-LLM engine (one-model mode) — no separate draft model
- EAGLE3 predicts from the target model's hidden states rather than independently

**What to observe:**
- **Acceptance rate climbs** compared to Phase 3a (expected: 70-85% vs. 55-70%)
- **ITL drops further** due to higher acceptance rate and lower draft overhead
- Memory footprint per GPU decreases (EAGLE3 heads are much smaller than an 8B model)

**Key takeaway:** "EAGLE3 gets higher acceptance rates because it's not guessing independently — it's reading the target model's internal state and predicting where it's headed. Same concept as draft-model speculative decoding, but more efficient."

**Blog opportunity:** Phase 3a vs. 3b produces a direct comparison of the two speculative decoding approaches on identical hardware and workload. Acceptance rate, ITL, and tokens-per-step side by side — this is the kind of practical data that engineers bookmark.

### Phase Summary

| Phase | Model | Routing | Spec Decode | TTFT Impact | ITL Impact |
|---|---|---|---|---|---|
| 1: Baseline | Llama 3.1 70B | Round-robin | Off | — | — |
| 2: + KV Routing | Llama 3.1 70B | KV-aware | Off | ↓ on turn 2+ | — |
| 3a: + Draft Model | Llama 3.1 70B | KV-aware | 8B draft model | ↓ on turn 2+ | ↓ all turns |
| 3b: + EAGLE3 | Llama 3.3 70B | KV-aware | EAGLE3 heads | ↓ on turn 2+ | ↓↓ all turns |

---

## 5. Development Plan

Development follows a risk-ladder approach: each phase produces a viable, demoable system. Later phases build on earlier ones without rework. If a later phase hits blockers, the previous phase is the fallback.

### What Exists Today

- Dynamo + TRT-LLM deployment serving Llama 70B FP8 (validated on H200 Droplets)
- KV cache-aware routing configuration
- Load generator Web UI (built with Claude Code)
- Grafana + Prometheus observability stack
- Document corpus in Spaces bucket
- Multi-turn chat workload broker (Serverless Inference integration)

### Dev Phase 1: KV-Aware Routing Demo (Safe Fallback)

**Goal:** Complete, working demo with KV-aware routing on Llama 3.1 70B FP8. This is the guaranteed floor — if nothing else works, this is the demo.

**Risk:** Low. All components exist; this phase is integration, refinement, and measurement.

1. **TP=4, 2-replica deployment**
   - Configure Dynamo to run 2 independent TP=4 worker groups on the 8xH100 node
   - Validate KV-aware routing correctly directs multi-turn conversations to the right replica
   - Validate round-robin mode works for baseline comparison

2. **Load generator updates**
   - Simplify UI to focus on multi-turn chat workload (remove Workload B/C sliders from original proposal)
   - Controls needed: concurrent conversation count, turns per conversation, request rate
   - Ensure conversation IDs are passed through correctly for KV routing to work

3. **Grafana dashboard**
   - Panels: TTFT (p50/p95), ITL (p50/p95), KV cache hit rate, active conversations
   - Tune layout for booth readability (large fonts, clear colors, minimal clutter)

4. **Baseline measurements**
   - Run with round-robin routing under controlled load, record TTFT/ITL metrics
   - Switch to KV-aware routing, same load, record metrics
   - Capture these as reference line values for the dashboard

5. **Recording**
   - Record Phase 1 (baseline) and Phase 2 (KV routing) demo segments under identical load
   - Capture Grafana dashboard and load generator UI side by side

**Exit criteria:** Demo shows measurable TTFT improvement on turn 2+ with KV-aware routing vs. round-robin baseline. Grafana dashboard clearly tells the story. Load generator runs reliably.

### Dev Phase 2: Speculative Decoding — Draft Model (Low Risk)

**Goal:** Add speculative decoding using Llama 3.1 8B Instruct FP8 as a draft model. Show ITL improvement on top of the KV routing demo from Phase 1.

**Risk:** Low-moderate. Draft-target speculative decoding is well-documented in TRT-LLM. The main risk is configuration and tuning, not feasibility.

1. **TRT-LLM engine configuration**
   - Configure Llama 3.1 8B Instruct FP8 as draft model co-located with the 70B target on TP=4
   - Tune draft length (K) — start with K=5, adjust based on acceptance rate
   - Validate on H100 at TP=4 with KV-aware routing still active

2. **Grafana dashboard updates**
   - Add speculative decoding panels: acceptance rate, tokens per step
   - Add horizontal reference lines from Phase 1 baselines (round-robin TTFT/ITL and KV-routing-only TTFT/ITL)

3. **Load generator adjustments (if needed)**
   - Likely minimal — same workload, same controls
   - May want to add acceptance rate display to load gen UI for booth visibility

4. **Measurements and recording**
   - Run same workload as Phase 1, record metrics with speculative decoding active
   - Record demo segment showing Phase 3a (KV routing + draft model spec decode)
   - Capture comparison: baseline → KV routing → KV routing + spec decode

**Exit criteria:** Demo shows measurable ITL improvement with speculative decoding. Acceptance rate is visible and reasonable (>55%). System is stable under sustained multi-turn load.

### Dev Phase 3: EAGLE3 on Llama 3.3 70B (Higher Risk, Stretch Goal)

**Goal:** Switch to Llama 3.3 70B Instruct FP8 with EAGLE3 speculative decoding. Demonstrate higher acceptance rates and lower ITL compared to the draft-model approach.

**Risk:** Moderate-high. Depends on EAGLE3 checkpoint compatibility with TRT-LLM's one-model mode. The Dynamo EAGLE3 examples target Llama 4 Maverick, not Llama 3.x. Checkpoint format conversion may be required.

1. **EAGLE3 checkpoint validation**
   - Download `yuhuili/EAGLE3-LLaMA3.3-Instruct-70B` (most likely TRT-LLM compatible)
   - Attempt to configure TRT-LLM engine in EAGLE3 one-model mode
   - If checkpoint format is incompatible, try SGLang or RedHat checkpoints with conversion
   - If none work within time-box, stop here — Phase 2 is the demo

2. **Model swap**
   - Switch target model to `nvidia/Llama-3.3-70B-Instruct-FP8`
   - Validate TP=4 deployment with EAGLE3 heads
   - Validate KV-aware routing still works correctly (should be transparent)

3. **Comparison measurements**
   - Run identical workload as Phase 2
   - Record acceptance rate, ITL, tokens-per-step side by side with Phase 2 numbers
   - This comparison is the primary blog content from Phase 3

4. **Dashboard and recording**
   - Update Grafana with Phase 2 reference lines (now three levels: baseline, KV routing, draft model)
   - Record demo segment showing EAGLE3 performance
   - Record or screenshot direct Phase 3a vs. 3b comparison

**Exit criteria:** EAGLE3 shows measurably higher acceptance rate and lower ITL than the draft-model approach. If not, Phase 2 is the demo and the EAGLE3 attempt becomes a "lessons learned" section in the blog.

### Development Summary

| Dev Phase | Deliverable | Risk | Fallback |
|---|---|---|---|
| Phase 1 | KV-aware routing demo, complete with dashboards and recording | Low | This IS the fallback |
| Phase 2 | + Draft-model speculative decoding | Low-moderate | Phase 1 |
| Phase 3 | + EAGLE3 speculative decoding on Llama 3.3 | Moderate-high (time-boxed) | Phase 2 |

---

## 6. References

**NVIDIA Dynamo & TRT-LLM:**
- [NVIDIA Dynamo — GitHub](https://github.com/ai-dynamo/dynamo)
- [Dynamo TRT-LLM Backend Documentation](https://docs.nvidia.com/dynamo/latest/backends/trtllm/README.html)
- [TRT-LLM Speculative Decoding Documentation](https://nvidia.github.io/TensorRT-LLM/advanced/speculative-decoding.html)
- [Dynamo Llama 4 + EAGLE Speculative Decoding Example](https://docs.nvidia.com/dynamo/latest/backends/trtllm/llama4_plus_eagle.html)
- [TRT-LLM Speculative Decoding Blog — 3x Throughput with Llama 70B](https://developer.nvidia.com/blog/tensorrt-llm-speculative-decoding-boosts-inference-throughput-by-up-to-3-6x/)
- [Dynamo Prometheus Metrics for TRT-LLM (includes speculative decoding metrics)](https://docs.nvidia.com/dynamo/dev/backends/trtllm/prometheus.html)

**EAGLE3 Checkpoints (Phase 3):**
- [`yuhuili/EAGLE3-LLaMA3.3-Instruct-70B`](https://huggingface.co/yuhuili/EAGLE3-LLaMA3.3-Instruct-70B) — EAGLE paper authors, best candidate for TRT-LLM
- [`lmsys/SGLang-EAGLE3-Llama-3.3-70B-Instruct-SpecForge`](https://huggingface.co/lmsys/SGLang-EAGLE3-Llama-3.3-70B-Instruct-SpecForge) — SGLang team, validated at TP=4
- [`RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3`](https://huggingface.co/RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3) — Red Hat, designed for vLLM

**Other:**
- [Baseten — Production Speculative Decoding with TRT-LLM (practical lessons)](https://www.baseten.co/blog/how-we-built-production-ready-speculative-decoding-with-tensorrt-llm/)

