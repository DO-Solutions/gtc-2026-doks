# vLLM Benchmarking & Tuning Plan — GTC Demo

## Demo Thesis

"Understand how to increase concurrency by X% while still meeting your SLOs through optimization."

Starting from a well-configured vLLM default, demonstrate how workload-specific tuning and architectural improvements progressively increase the number of concurrent users served within defined SLO boundaries.

### Real-World Relevance

The demo workload — multi-turn conversations with large initial context and growing input lengths — is representative of several common enterprise patterns:

- **RAG (Retrieval-Augmented Generation):** The most direct parallel. RAG requests typically stuff 3,000-8,000 tokens of retrieved document context into the prompt, with follow-up turns resending the full conversation history. The prefix caching benefits demonstrated in this demo apply directly to RAG deployments where users ask multiple questions against the same retrieved context.
- **Long system prompts:** Enterprise deployments commonly use 1,000-4,000 token system prompts defining persona, guardrails, response formats, and domain knowledge. The demo's 10 Wikipedia conversation starters (~3,500-4,000 tokens each) model different "agents" with different system prompts, where the shared prefix is reused across all requests.
- **Knowledge assistants:** Educational or enterprise scenarios where users upload documents or receive reference material and have multi-turn conversations to understand it. The output lengths (~800-1,000 tokens of detailed explanation per turn) are realistic for this pattern.

---

## Environment

| Component | Detail |
|---|---|
| **GPU** | 4× NVIDIA H200 (141GB HBM3e each) |
| **Topology** | 4 independent nodes, DP=4, TP=1 per node |
| **Model** | Llama 70B, FP8 (ModelOpt checkpoint, ~70GB weights per GPU) |
| **Runtime** | Dynamo vLLM Runtime 0.9.0 (`nvcr.io/nvidia/ai-dynamo/vllm-runtime:0.9.0`) — vLLM v0.14.1 |
| **Orchestration** | DigitalOcean Kubernetes Service (DOKS) |
| **Model Storage** | NFS share (also hosts benchmark datasets) |
| **Available KV Cache** | ~60GB per node at default 0.9 memory utilization |

## Default Optimizations (Already Enabled in Phase 0)

The Dynamo vLLM runtime ships with several optimizations enabled out of the box:

- Automatic FP8 KV cache quantization (inferred from ModelOpt FP8 checkpoint)
- Chunked prefill (`max_num_batched_tokens=8192`)
- Prefix caching (enabled by default in vLLM V1 — near-zero overhead implementation causes <1% throughput decrease even at 0% hit rate)
- Asynchronous scheduling
- CUDA graph capture (FULL_AND_PIECEWISE mode, 51 batch sizes)
- Flash Attention backend auto-selection

All major inference optimizations are enabled out of the box with no configuration flags required. This means Phase 0 is already a well-optimized baseline rather than a naive configuration. For users upgrading from older vLLM versions (V0, pre-Hopper defaults), simply moving to V1 on modern hardware delivers FP8 KV cache, chunked prefill, prefix caching, and hardware-optimized scheduler settings automatically.

---

## SLO Targets

| Metric | Target | Rationale |
|---|---|---|
| **TTFT p99** | < 1000ms | Appropriate for long-context workloads (RAG, document analysis). Turn-5 prefills at ~7,000 tokens require 400-500ms of pure compute, leaving ~500ms headroom for queuing. A 1-second first-token wait is natural when submitting multi-thousand-token documents for analysis. |
| **TPOT p99** | < 60ms | ~16-20 tokens/sec streaming speed, natural reading pace. This is where responsiveness matters most — once streaming begins, consistent token delivery keeps the experience smooth. |

The primary demo metric is the **maximum request rate sustainable within the TTFT SLO**. Each optimization phase is measured by how much higher that rate goes. TPOT SLO provides a secondary dimension, particularly for speculative decoding.

Note: The original TTFT target of 350ms was found to be unachievable for this workload. Benchmark data shows TTFT p95 of 568ms at rate 0.5 with only 7 max concurrent requests and zero queuing — this is pure prefill compute time for the longer entries. A sub-350ms target would require shorter input sequences, not infrastructure optimization.

---

## Workload Characteristics

| Property | Detail |
|---|---|
| **Type** | Multi-turn technical chat conversations |
| **Turns per conversation** | 5 |
| **Conversation starters** | 10 Wikipedia excerpt-based prompts (~3,500-4,000 tokens each), shared across chats |
| **Follow-up prompts** | Short ("Can you elaborate further on that?"), minimal token addition per turn |
| **System prompt** | None explicitly, but shared starters function similarly |
| **Arrival pattern** | Consistent / automated (not bursty) |
| **Concurrency** | Variable — finding optimal level is part of the benchmarking process |

### Observed Token Distributions (from real load generator data)

**Per-turn profile from a representative conversation:**

| Turn | Approx Input Tokens | Output Tokens | E2E Latency |
|------|---------------------|---------------|-------------|
| 1 | ~3,500 | 555 | 37.1s |
| 2 | ~4,100 | 818 | 58.5s |
| 3 | ~5,000 | 1,008 | 97.6s |
| 4 | ~6,100 | 875 | 92.1s |
| 5 | ~7,000 | 888 | 64.0s |

**Aggregate from Grafana dashboard (under load, past saturation):**

| Metric | p50 | p95 |
|---|---|---|
| Input Sequence Length | 5,900 | 12,700 |
| Output Sequence Length | 978 | 1,720 |
| Cached Tokens | 5,620 | 8,610 |

**Key workload characteristics for benchmarking:**
- Average output tokens per turn: ~830
- Input length grows significantly each turn as full conversation history is resent
- The Wikipedia excerpt dominates the initial input (~3,500-4,000 tokens)
- Late turns (4-5) have input lengths of 6,000-7,000+ tokens per conversation
- Across all concurrent conversations, p95 input length reaches ~12,700 tokens

### Prefix Caching Opportunity

The workload has strong prefix reuse patterns:
- 10 shared Wikipedia conversation starters (~3,500-4,000 tokens each) are reused across many conversations
- Within each conversation, each turn resends the full prior history as a growing prefix
- Both patterns create significant KV cache reuse opportunity with prefix caching enabled

---

## Benchmarking Tooling

### Primary Tool: `benchmark_serving.py` (via `vllm bench serve`)

Benchmarks against a running vLLM server via the OpenAI-compatible API. Measures TTFT, TPOT, ITL, end-to-end latency, and throughput.

### Auto-Tuner: `benchmarks/auto_tune/auto_tune.sh`

Automatically searches for optimal `max-num-seqs` and `max-num-batched-tokens` given a workload profile and latency constraint. For each parameter combination, spins up a vLLM server, benchmarks at infinite request rate, and if latency exceeds the constraint, iteratively reduces request rate to find maximum sustainable throughput. Also searches for the highest viable `gpu-memory-utilization`.

**How it works internally:** The script manages the full vLLM server lifecycle — it starts a `vllm serve` process, runs `benchmark_serving.py` against it, kills the server with `pkill -f vllm`, changes parameters, and repeats. This is fundamentally different from normal Kubernetes serving where the server is a long-running Deployment.

**Running in Kubernetes:** The auto-tuner runs as a Kubernetes Job on a GPU node. The Job pod gets exclusive access to the GPU and runs the entire auto-tune loop internally as subprocess management within a single pod. The existing vLLM Deployment must be scaled down first to free the GPU, then scaled back up with the optimized config once tuning completes.

**Container prerequisites — verify before running:**

The Dynamo vLLM runtime container (`nvcr.io/nvidia/ai-dynamo/vllm-runtime:0.9.0`) is optimized for serving and may not include the `benchmarks/` directory from the vLLM source tree. Check with:

```bash
kubectl exec -it your-vllm-pod -- find / -name auto_tune.sh 2>/dev/null
```

If not present, options are:
- Copy the vLLM v0.14.1 `benchmarks/` directory onto the NFS share and mount it into the Job pod
- Build a thin image layered on top of the Dynamo runtime that adds the benchmarks directory

**Gotchas:**
- The script uses `pkill -f vllm` to kill the server between iterations. The README warns that if the execution path contains the word "vllm", the pkill will kill the auto-tuner script itself. Ensure the working directory and script path avoid this.
- Set `$BASE` to a path on the NFS mount so results persist after the Job pod terminates. Results land in a timestamped directory under `$BASE/auto-benchmark/` with a `result.txt` summarizing the winning parameters and detailed logs for each iteration.
- Set `DOWNLOAD_DIR` to the NFS model path so the auto-tuner finds the model without attempting a HuggingFace download.

### Benchmark Dataset

ShareGPT dataset stored on the NFS share alongside model files. Loaded into memory at benchmark startup so NFS read speed only affects initialization, not benchmark results.

### Execution Environment

**Load sweep benchmarks** (`benchmark_serving.py` / `vllm bench serve`): Run as pods within the DOKS cluster, hitting the vLLM service via ClusterIP for a clean network path. Development iteration via a long-lived benchmark pod (`kubectl exec`), final comparison runs codified as Kubernetes Jobs for reproducibility.

**Auto-tuner** (`auto_tune.sh`): Runs as a standalone Kubernetes Job on a GPU node with the vLLM Deployment scaled down. Manages its own vLLM server processes internally. Requires the GPU, model files (NFS), dataset (NFS), and benchmark scripts to all be accessible within the pod.

---

## Phasing

### Phase 0 — Baseline (Vanilla vLLM)

**Goal:** Establish baseline capacity at SLO targets with default configuration.

**vLLM Configuration:**
- All runtime defaults (FP8 KV cache, chunked prefill, prefix caching, async scheduling already enabled)
- `gpu-memory-utilization`: 0.9 (default)
- `max-num-batched-tokens`: 8192 (H200 Hopper-specific default, generic default is 2048)
- `max-num-seqs`: 1024 (H200 Hopper-specific default, generic default is 256)

Note: vLLM auto-detects Hopper+ hardware and sets significantly more aggressive scheduler defaults than the generic values. These are confirmed from startup logs:
```
INFO main.get_engine_cache_info: Scheduler config values: {'max_num_seqs': 1024, 'max_num_batched_tokens': 8192}
```

**Benchmark Procedure:**

1. Deploy vLLM with default config on one node
2. Run load sweep across increasing request rates:
   ```bash
   for rate in 0.25 0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0; do
     vllm bench serve \
       --backend vllm \
       --base-url http://vllm-service:8000 \
       --model your-model \
       --dataset-name sharegpt \
       --dataset-path /data/ShareGPT_V3_unfiltered_cleaned_split.json \
       --num-prompts 300 \
       --request-rate $rate \
       --save-result \
       --result-dir /results/phase0/
     sleep 30  # cooldown between runs
   done
   ```
   Note: Real workload saturates below 1.5 req/s with 110 inflight requests (observed from Grafana). The sweep range is calibrated accordingly — the saturation knee is expected well below 3.0 req/s for this workload.
3. Identify the maximum request rate where TTFT p99 < 1000ms — this is the **baseline capacity**
4. Record all metrics (TTFT, TPOT, throughput) at that rate

**Expected Outcome:** A well-performing baseline due to the runtime's built-in optimizations, but with room for improvement through workload-specific tuning.

### Phase 1 — Optimized vLLM

**Goal:** Maximize per-node capacity through parameter tuning against the specific workload.

Since all major features (FP8 KV cache, chunked prefill, prefix caching) are already enabled by default, Phase 1 focuses purely on tuning scheduler parameters and memory allocation:

- **`gpu-memory-utilization` 0.9 → 0.95:** Frees ~7GB additional KV cache. With long sequences consuming heavy cache, every extra GB directly translates to more concurrent requests before hitting the saturation cliff observed at ~90 concurrency in load generator tests.
- **`max-num-batched-tokens` — likely higher than 8192:** This is the most impactful tuning lever for this workload. At 8192, a single turn-5 prefill (~7,000 tokens) nearly exhausts the budget, meaning no other new requests can begin prefill in the same scheduler iteration. Increasing to 16384 or 32768 lets the scheduler process multiple prefills concurrently, directly improving TTFT for shorter entries stuck behind long ones.
- **`max-num-seqs` — likely lower than 1024:** The Hopper default of 1024 assumes shorter sequences. This workload's sequences are much longer, consuming far more KV cache per sequence. Load generator data shows a cliff at concurrency ~90, suggesting KV cache fills up well below 1024 concurrent sequences. Lowering `max-num-seqs` to match actual cache capacity avoids preemption and protects prefix cache entries.

**Parameter Tuning via Auto-Tuner:**

Operational sequence in Kubernetes:
1. Scale down the vLLM Deployment to free the GPU on the target node
2. Deploy the auto-tuner Job on the same GPU node
3. Job runs the full parameter sweep internally
4. Retrieve optimal parameters from `$BASE/auto-benchmark/<timestamp>/result.txt` on NFS
5. Delete the auto-tuner Job
6. Update the vLLM Deployment with the optimized config and scale back up

Auto-tuner configuration:

```bash
# Key auto_tune.sh configuration
INPUT_LEN=6000                  # matches p50 from real workload (~5,900)
OUTPUT_LEN=850                  # matches average output tokens per turn
MAX_MODEL_LEN=16384             # must accommodate p95 input (~12,700) + output (~1,700)
MIN_CACHE_HIT_PCT=50            # reflects shared conversation starters
MAX_LATENCY_ALLOWED_MS=25000    # constrains E2E latency (not TTFT); set based on
                                # observed E2E p50 of 13-20s at moderate load

# Suggested sweep ranges informed by benchmark data
num_seqs_list="64 128 256 512 1024"          # bias lower than Hopper default (1024);
                                              # load generator saturates at ~90 concurrent
num_batched_tokens_list="8192 16384 32768"   # bias higher than Hopper default (8192);
                                              # turn-5 prefills of ~7,000 tokens nearly
                                              # fill the 8192 budget alone
```

The script ships with defaults "set for medium-sized inputs/outputs" which may not account for the Hopper-specific values vLLM already applies. Customizing these ranges ensures the sweep brackets around the actual runtime defaults rather than the generic ones. Inspect the default lists in the script before running and adjust if needed.

The auto-tuner will:
1. Find the highest viable `gpu-memory-utilization`
2. Sweep combinations of `max-num-seqs` and `max-num-batched-tokens`
3. For each combination, find the maximum throughput within the latency constraint
4. Report the optimal parameter set

**Actual Approach — Manual Parameter Sweep:**

The auto-tuner was not used. Instead, a manual structured sweep of 6 parameter combinations was run (`make phase1-sweep`), each performing a 12-rate load sweep (0.5 to 5.0 RPS, 300 prompts per rate). This provided clearer isolation of individual parameter effects.

**Phase 1 Results (2026-02-25):**

Full report: `dev/vllm/benchmarks/phase1/report.md`

| Config | gpu-mem-util | max-batched-tokens | max-num-seqs | KV Cache | Max SLO Rate |
|--------|:-:|:-:|:-:|--------|:-:|
| phase0 (baseline) | 0.9 | 8192 | 1024 | 53.15 GiB | 2.00 RPS |
| phase1-baseline-rerun | 0.9 | 8192 | 1024 | 53.15 GiB | 1.50 RPS |
| phase1-mem095 | 0.95 | 8192 | 1024 | 60.14 GiB | 2.00 RPS |
| phase1-batch16k | 0.9 | 16384 | 1024 | 53.02 GiB | 2.00 RPS |
| phase1-seqs128 | 0.9 | 8192 | 128 | 56.39 GiB | 2.00 RPS |
| **phase1-moderate** | **0.95** | **16384** | **128** | **61.79 GiB** | **2.00 RPS** |
| phase1-aggressive | 0.95 | 32768 | 256 | 56.85 GiB | 2.00 RPS |

**Key Findings:**

1. **No config pushed max SLO rate above 2.0 RPS.** The TPOT p99 < 60ms SLO is the binding constraint — all configs fail at 2.5 RPS. This is fundamental: decode is memory-bandwidth bound on a single H200, and parameter tuning cannot speed up the autoregressive decode pipeline.

2. **`phase1-moderate` delivers best latency within SLO range.** At 2.0 RPS: TTFT p99 drops 11% (953→849ms), TPOT p99 drops 10% (49→44ms), ITL p99 drops 22% (232→181ms). More headroom means more resilience to traffic bursts.

3. **KV cache sizes:** 0.95 mem util adds ~7 GiB (53→60 GiB). Combined with max-num-seqs 128, moderate config reaches 61.8 GiB — the largest cache. Lowering max-num-seqs frees internal scheduler overhead, slightly increasing available KV cache.

4. **`max-num-batched-tokens 16384` alone has minimal impact** — batch16k tracks very close to baseline at every rate. The prefill budget increase doesn't help because our long prompts already fit within the 8192 default.

5. **`max-num-seqs` caps create queuing at overload.** At 3.5+ RPS, seqs128 and moderate show TTFT p99 of 3-25 seconds (requests queue waiting for slots), but TPOT stays lower (82-85ms vs 88-109ms) because fewer concurrent requests reduce decode contention.

6. **Baseline rerun scored 1.50 RPS** (vs Phase 0's 2.00), confirming run-to-run variance near the SLO boundary.

**Applied Config (moderate):**
```yaml
args:
  - --gpu-memory-utilization
  - "0.95"
  - --max-num-batched-tokens
  - "16384"
  - --max-num-seqs
  - "128"
```

**Conclusion:** Phase 1 parameter tuning provides a quality-of-service improvement (better latency at the same rate) rather than a capacity improvement. The Phase 0 baseline was already well-optimized. Breaking through the 2.0 RPS ceiling requires changes to the decode pipeline itself — either TP>1 (more decode bandwidth) or speculative decoding (more tokens per forward pass).


### Phase 2 — Speculative Decoding

**Goal:** Reduce per-request decode latency (TPOT) using EAGLE-3 speculative decoding.

**Model Upgrade:** This phase requires switching from Llama 3.1 70B to Llama 3.3 70B to access the EAGLE-3 speculator. Llama 3.3 shares the same architecture and tokenizer as 3.1 (it's essentially a better-trained version), so no infrastructure changes are required — just a model swap. This is a realistic trade-off that customers would face: upgrading the base model to unlock speculative decoding support.

**Models:**
- Base model: `nvidia/Llama-3.3-70B-Instruct-FP8` (ModelOpt checkpoint, same quantization approach as 3.1)
- EAGLE-3 speculator: `yuhuili/EAGLE3-LLaMA3.3-Instruct-70B`

**How EAGLE-3 works:** Unlike traditional draft-model speculative decoding (e.g., using Llama 8B to draft for Llama 70B), EAGLE-3 trains a lightweight draft head (1-2 transformer layers) that plugs directly into the target model's hidden states. This means minimal memory overhead compared to loading a full separate draft model, which preserves KV cache capacity for concurrent requests.

**vLLM Configuration:**
```bash
vllm serve nvidia/Llama-3.3-70B-Instruct-FP8 \
  --speculative-config '{"model": "yuhuili/EAGLE3-LLaMA3.3-Instruct-70B",
    "num_speculative_tokens": 3, "method": "eagle3",
    "draft_tensor_parallel_size": 1}'
```

The draft head runs at TP=1, matching the existing single-GPU-per-node architecture. No changes to the cluster topology.

**Benchmark Procedure:**

1. Swap model to Llama 3.3 70B FP8 **without** speculative decoding
2. Re-run the load sweep to confirm comparable baseline performance to Llama 3.1
3. Enable EAGLE-3 speculative decoding
4. Re-run the load sweep
5. Compare TPOT improvement — expect 1.5-2x reduction at moderate concurrency

**Expected Impact:**
- **TPOT:** Significant improvement. With baseline TPOT p50 of ~35-55ms, speculative decoding could bring this to ~20-30ms at moderate load. This is where the bulk of per-request time is spent — decode dominates E2E by roughly 85:1 over prefill.
- **TTFT:** Minimal impact. Speculative decoding affects the decode phase, not prefill.
- **Throughput at high concurrency:** Benefit diminishes as GPU becomes compute-saturated. The extra forward passes for draft verification add overhead when the GPU is already fully utilized. This is expected and well-documented behavior.

**Demo Narrative:** The diminishing benefit at high concurrency naturally leads into Phase 3 (KV-aware routing). By distributing load across 4 nodes so each stays in the moderate-concurrency sweet spot, speculative decoding remains effective across the cluster. The two optimizations are complementary — speculative decode improves per-request latency, KV-aware routing keeps each node in the zone where that improvement holds.

### Phase 3 — KV Cache-Aware Routing

*To be planned.* Distributes traffic intelligently across the 4 nodes based on KV cache state. Expected to be the largest single improvement due to prefix-aware load balancing across DP=4.

---

## Key Considerations

**All major features are enabled by default.** FP8 KV cache, chunked prefill, and prefix caching are all active in vLLM V1 on Hopper hardware without any explicit configuration. Phase 1 parameter tuning runs against this already-optimized feature set. For users upgrading from older vLLM versions, simply moving to V1 delivers all of these optimizations automatically.

**Auto-tuner constrains on E2E latency, not TTFT.** The `MAX_LATENCY_ALLOWED_MS` parameter in the auto-tuner applies to end-to-end request latency (set to 25000ms based on observed E2E distributions). Post-processing of detailed results is needed to verify the TTFT p99 < 1000ms and TPOT p99 < 60ms SLOs are independently met.

**Cooldown between benchmark runs.** Allow 30 seconds between sweep runs for the scheduler to drain and KV cache to clear. Without this, tail requests from one run bleed into the next.

**Warm-up before benchmarking.** First few requests after vLLM startup may have inflated latency from CUDA compilation or lazy initialization. Run a small throwaway benchmark or discard the first run.

**Phase 0 baseline is already strong.** The Dynamo runtime's built-in optimizations (FP8 KV cache, chunked prefill, prefix caching, Hopper-tuned scheduler defaults) mean the Phase 0 → Phase 1 delta may be modest since Phase 1 is limited to parameter tuning. The compelling demo narrative is twofold: (1) upgrading to vLLM V1 on modern hardware gives you a well-optimized baseline for free, and (2) the real capacity gains come from architectural decisions like speculative decoding and KV-aware routing across the cluster.