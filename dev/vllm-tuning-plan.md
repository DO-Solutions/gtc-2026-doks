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
- Asynchronous scheduling
- CUDA graph capture (FULL_AND_PIECEWISE mode, 51 batch sizes)
- Flash Attention backend auto-selection

This means Phase 0 is already a reasonably optimized baseline rather than a naive configuration.

---

## SLO Targets

| Metric | Target | Rationale |
|---|---|---|
| **TTFT p99** | < 350ms | Responsive first-token delivery, under the ~500ms perceptible delay threshold |
| **TPOT p99** | < 60ms | ~16-20 tokens/sec streaming speed, natural reading pace |

The primary demo metric is the **maximum request rate sustainable within the TTFT SLO**. Each optimization phase is measured by how much higher that rate goes. TPOT SLO provides a secondary dimension, particularly for speculative decoding.

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

| Turn | Approx Input Tokens | Output Tokens |
|------|---------------------|---------------|
| 1 | ~3,500 | 555 |
| 2 | ~4,100 | 818 |
| 3 | ~5,000 | 1,008 |
| 4 | ~6,100 | 875 |
| 5 | ~7,000 | 888 |

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
- All runtime defaults (FP8 KV cache, chunked prefill, async scheduling already enabled)
- `gpu-memory-utilization`: 0.9 (default)
- `max-num-batched-tokens`: 8192 (H200 Hopper-specific default, generic default is 2048)
- `max-num-seqs`: 1024 (H200 Hopper-specific default, generic default is 256)
- No prefix caching

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
3. Identify the maximum request rate where TTFT p99 < 350ms — this is the **baseline capacity**
4. Record all metrics (TTFT, TPOT, throughput) at that rate

**Expected Outcome:** A well-performing baseline due to the runtime's built-in optimizations, but with room for improvement through workload-specific tuning.

### Phase 1 — Optimized vLLM

**Goal:** Maximize per-node capacity through feature enablement and parameter tuning.

**Additional Features to Enable:**
- Prefix caching (`--enable-prefix-caching`) — exploits the 10 shared conversation starters
- `gpu-memory-utilization` pushed to 0.95 (auto-tuner handles this)

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
MAX_LATENCY_ALLOWED_MS=350      # SLO target (note: constrains E2E, not TTFT specifically)

# Suggested sweep ranges, bracketing around the Hopper defaults
num_seqs_list="256 512 1024 1536 2048"       # Hopper default is 1024
num_batched_tokens_list="8192 16384 32768"   # Hopper default is 8192; real workload
                                             # has turn-5 prefills of ~7,000 tokens which
                                             # nearly fill the 8192 budget alone
```

The script ships with defaults "set for medium-sized inputs/outputs" which may not account for the Hopper-specific values vLLM already applies. Customizing these ranges ensures the sweep brackets around the actual runtime defaults rather than the generic ones. Inspect the default lists in the script before running and adjust if needed.

The auto-tuner will:
1. Find the highest viable `gpu-memory-utilization`
2. Sweep combinations of `max-num-seqs` and `max-num-batched-tokens`
3. For each combination, find the maximum throughput within the latency constraint
4. Report the optimal parameter set

**Post Auto-Tuner Benchmark:**

1. Deploy vLLM with the optimized config (features + auto-tuned parameters)
2. Run the same load sweep as Phase 0
3. Identify the new maximum request rate at TTFT p99 < 350ms
4. Calculate the capacity improvement: `(Phase1_rate - Phase0_rate) / Phase0_rate × 100%`

### Phase 2 — Speculative Decoding

*To be planned.* Primary impact on TPOT rather than TTFT. Adds to per-node optimization before moving to multi-node routing.

### Phase 3 — KV Cache-Aware Routing

*To be planned.* Distributes traffic intelligently across the 4 nodes based on KV cache state. Expected to be the largest single improvement due to prefix-aware load balancing across DP=4.

---

## Key Considerations

**Auto-tuner runs after feature enablement, not before.** Features like prefix caching and FP8 KV cache fundamentally change the performance envelope. Optimal scheduler parameters with features off will differ from optimal parameters with features on. Tuning is only meaningful against the final feature set.

**Auto-tuner constrains on E2E latency, not TTFT.** The `MAX_LATENCY_ALLOWED_MS` parameter in the auto-tuner applies to end-to-end request latency. Post-processing of detailed results is needed to verify the TTFT p99 < 350ms and TPOT p99 < 60ms SLOs are independently met.

**Cooldown between benchmark runs.** Allow 30 seconds between sweep runs for the scheduler to drain and KV cache to clear. Without this, tail requests from one run bleed into the next.

**Warm-up before benchmarking.** First few requests after vLLM startup may have inflated latency from CUDA compilation or lazy initialization. Run a small throwaway benchmark or discard the first run.

**Phase 0 baseline is already strong.** The Dynamo runtime's built-in optimizations (FP8 KV cache, chunked prefill) mean the Phase 0 → Phase 1 delta may be moderate. The compelling story may be the cumulative improvement across all phases through to KV-aware routing.
