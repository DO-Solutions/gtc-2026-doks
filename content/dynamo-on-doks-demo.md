# NVIDIA Dynamo on DigitalOcean Kubernetes Service (DOKS)

## KV-Aware Routing Demo: Achieving Inference SLOs at Higher Concurrency

---

## Overview

This document captures the architecture, configuration, and results of a demo deployment running NVIDIA Dynamo on DigitalOcean Kubernetes Service (DOKS). The demo demonstrates how KV-aware routing enables meeting strict inference SLOs at significantly higher concurrency levels compared to traditional round-robin load balancing.

### SLO Targets

| Metric | Target | Description |
|--------|--------|-------------|
| TTFT | ≤ 600 ms | Time to First Token |
| TPOT | ≤ 60 ms | Time Per Output Token |

### Key Claim

KV-aware routing, enabled by Dynamo's intelligent request distribution, allows us to sustain these SLOs at higher concurrent request levels than round-robin routing — demonstrating measurable efficiency gains from prefix-aware scheduling on identical infrastructure.

---

## Infrastructure

### DigitalOcean Environment

This demo runs entirely on DigitalOcean's cloud infrastructure, showcasing how DigitalOcean's managed services provide a production-ready platform for GPU inference workloads without requiring teams to manage underlying infrastructure.

**DigitalOcean Kubernetes Service (DOKS)** is a fully managed Kubernetes offering. DigitalOcean manages the control plane — including upgrades, etcd, security patching, and scaling — so teams can focus on deploying workloads rather than operating Kubernetes. The control plane can optionally be configured for high availability. Worker nodes are also managed: DigitalOcean handles OS-level upgrades and configuration.

**Node Groups:** DOKS clusters are organized into node groups — pools of nodes that share the same configuration and can be scaled independently (manually or via autoscaling). This demo uses two node groups:

| Node Group | Purpose | Nodes |
|------------|---------|-------|
| Management | Runs Dynamo Operator, NATS, load generator, controllers, and non-GPU workloads | *TBD* |
| GPU | Runs TRT-LLM inference workers | 3× NVIDIA H200 GPU Droplets |

**Networking:** DOKS comes Cilium-powered out of the box, leveraging eBPF in full kube-proxy replacement mode for high-performance, low-latency in-cluster networking. This is significant for inference workloads where the router, NATS event plane, and workers communicate frequently with latency-sensitive traffic.

External access is provided via the Kubernetes Gateway API. When a Gateway resource is created, DOKS automatically provisions a DigitalOcean Network Load Balancer (Layer 3) that distributes traffic across nodes. This integration is transparent — no manual load balancer configuration is required.

All nodes are connected to a DigitalOcean VPC, providing private networking between the management and GPU node groups with no traffic traversing the public internet for intra-cluster communication.

### Cluster Topology

| Component | Specification |
|-----------|--------------|
| Platform | DigitalOcean Kubernetes Service (DOKS) |
| Worker Nodes | 3× NVIDIA H200 GPU Droplets |
| GPU per Node | 1× NVIDIA H200 (141 GB HBM3e) |
| Total GPUs | 3 |
| Kubernetes Version | 1.34.1 |

### Software Stack

| Layer | Component |
|-------|-----------|
| Inference Engine | TensorRT-LLM (TRT-LLM) |
| Orchestration / Routing | NVIDIA Dynamo (v0.9.0) |
| Routing Strategy | KV-aware routing (via Dynamo Smart Router) |
| Frontend Image | `nvcr.io/nvidia/ai-dynamo/dynamo-frontend:0.9.0` |
| Worker Image | `nvcr.io/nvidia/ai-dynamo/tensorrtllm-runtime:0.9.0` — bundles the Dynamo distributed runtime, KVPublisher integration, and TRT-LLM engine. This is distinct from a standalone TRT-LLM image because it includes the Dynamo hooks required for KV event publishing and service discovery. |
| Model | Meta Llama 3.1 70B Instruct (FP8 quantized) |

---

## About NVIDIA Dynamo

NVIDIA Dynamo (v0.9.0) is a high-throughput, low-latency inference framework designed to serve generative AI and reasoning models in multi-node distributed environments. It is inference-engine agnostic, supporting TensorRT-LLM, vLLM, SGLang, and others. Dynamo is built in Rust for performance and Python for extensibility, and is fully open-source.

### Dynamo's Full Capability Set

While this demo focuses specifically on KV-aware routing, Dynamo provides a broader set of capabilities that address the key challenges of distributed LLM inference:

- **Disaggregated Prefill & Decode Inference**: Separates the compute-intensive prefill phase from the latency-sensitive decode phase onto dedicated worker pools, maximizing GPU throughput and enabling independent tuning of TTFT vs. ITL. NVIDIA benchmarks show 30% throughput/GPU improvement on single-node and over 2× gains on two-node setups for Llama 70B.
- **KV-Aware Request Routing** *(demonstrated in this demo)*: Routes requests to the worker with the highest KV cache hit rate rather than the least busy node, eliminating redundant KV cache recomputation. NVIDIA benchmarks show 3× improvement in TTFT and 2× reduction in average request latency on 100K real R1 user queries.
- **KV Cache Block Manager (KVBM)**: Enables KV cache offloading across memory hierarchies (GPU HBM → CPU → local SSD → remote storage), allowing more KV blocks to be reused instead of recomputed. Benchmarks show 2.2×–12× TTFT improvement depending on QPS.
- **Dynamic GPU Scheduling via Planner**: Responds to real-time deployment signals to make intelligent, zero-downtime scaling adjustments (e.g., scaling up prefill workers when long-input-sequence traffic increases).
- **NVIDIA Inference Transfer Library (NIXL)**: Accelerates data transfer through reduced synchronization and intelligent batching, critical for disaggregated serving where prefill workers pass KV cache data to decode workers.

### What This Demo Shows

This demo isolates and demonstrates the **KV-aware routing** capability specifically. We are running Dynamo in aggregated mode (not disaggregated), meaning each TRT-LLM worker handles both prefill and decode. The Dynamo Smart Router sits in the request path and uses its knowledge of each worker's KV cache state to make intelligent routing decisions.

---

## Architecture

### Request Flow

The request path in this demo is:

1. **Client** sends an OpenAI-compatible HTTP request to the Dynamo **Frontend** (API server on port 8000).
2. The Frontend preprocesses the request (applies chat template, tokenizes) and passes it to the **Dynamo Smart Router**.
3. The Router evaluates each worker's cost based on KV cache overlap and decode load, then routes the request to the optimal **TRT-LLM worker**.
4. The TRT-LLM worker performs prefill and decode, streaming tokens back through the Frontend to the client.

### Dynamo Internal Planes

Dynamo's distributed runtime consists of three communication planes that work together:

**Discovery Plane** — Lets components find each other at runtime. On Kubernetes (our deployment), this uses native K8s resources (DynamoWorkerMetadata CRD and EndpointSlices) — no external etcd required. Workers register their endpoints when they start, and the frontend discovers them automatically. Pod lifecycle is handled natively: when a pod terminates, its endpoints are automatically cleaned up.

**Request Plane** — The transport layer for RPC communication between services (frontend → router → workers). Dynamo supports TCP (default, lowest latency), HTTP/2, and NATS as request plane transports. The request plane is independent of the event plane — you can mix transports. Configuration is via the `DYN_REQUEST_PLANE` environment variable.

**Event Plane** — A pub/sub layer for near real-time event exchange. This is the critical plane for KV-aware routing: workers publish KV cache state events (block stored, block removed) and load metrics through this plane so the router can make cache-aware scheduling decisions. The event plane supports NATS (default) and ZMQ transports, configured via `DYN_EVENT_PLANE`.

### How KV-Aware Routing Works

Traditional routing strategies (round-robin, random, least-connections) distribute requests without knowledge of each worker's KV cache state. This means that when multiple requests share common prompt prefixes (e.g., a system prompt, shared conversation context, or repeated instructions), different workers redundantly recompute the same KV cache blocks.

Dynamo's KV-aware router solves this by maintaining a **global view of cached blocks** across all workers and routing requests to the worker that can reuse the most cached data.

**The KV Event Loop:**

1. When a TRT-LLM worker computes and stores KV cache blocks, a **KVPublisher** emits a "KV stored" event.
2. When blocks are evicted (due to memory pressure), the KVPublisher emits a "KV removed" event.
3. These events flow through the Event Plane to the router's **KVIndexer**.
4. The KVIndexer maintains a **global radix tree** (prefix tree) with worker IDs on each node, enabling efficient lookup of how many cached blocks each worker has for any given token sequence.

**The Routing Decision:**

When a new request arrives, the router computes a cost for each worker using:

```
cost = overlap_score_weight × prefill_blocks + decode_blocks
```

Where:
- **prefill_blocks** = number of tokens requiring fresh computation / block size. This is reduced when a worker already has matching KV cache blocks (the "overlap").
- **decode_blocks** = estimated active decode load on the worker (blocks currently being used for ongoing generation).
- **overlap_score_weight** (default 1.0) = a tunable parameter that balances cache reuse (lower TTFT) against load distribution (lower ITL).

The router selects the worker with the **lowest cost**. A `router_temperature` parameter can optionally introduce softmax-based randomness for additional load distribution.

**Example:** Consider 3 workers receiving a request with 100 input token blocks:

| Worker | Cached Blocks Matching Request | Prefill Blocks Needed | Active Decode Blocks | Cost (weight=1.0) |
|--------|-------------------------------|----------------------|---------------------|--------------------|
| Worker 1 | 20 | 80 | 10 | 90 |
| Worker 2 | 75 | 25 | 5 | **30** ← selected |
| Worker 3 | 10 | 90 | 9 | 99 |

Worker 2 already has 75 of the 100 blocks cached, so it only needs to compute 25 new blocks. Despite Worker 2 having some decode load, the massive prefill savings make it the best choice.

### KV-Aware Routing vs. Round-Robin

| Behavior | Round-Robin | KV-Aware (Dynamo) |
|----------|-------------|-------------------|
| Routing decision basis | Cycle through workers in order | KV cache overlap + decode load |
| Awareness of cached KV blocks | None | Full global view via radix tree |
| Prefix cache reuse | Accidental (only if request happens to hit the same worker) | Intentional and optimized |
| TTFT under shared-prefix workloads | Degrades as concurrency increases (redundant prefill) | Remains low (prefill work avoided via cache hits) |
| Load balancing | Even distribution by definition | Weighted by actual computational cost |
| Best for | Stateless, uniform workloads | Workloads with shared prefixes, multi-turn conversations, system prompts |

---

## Deployment

### Prerequisites

- DOKS cluster (K8s 1.34.1) with 3× H200 GPU Droplet worker nodes
- NVIDIA Dynamo Kubernetes Operator installed (handles service discovery via native K8s CRDs)
- Grove enabled for multi-node orchestration
- NATS server deployed in-cluster (required for KV event plane)
- Llama 3.1 70B Instruct FP8 model weights available via NFS PVC

### Deployment Topology

The deployment is defined as a DynamoGraphDeployment custom resource (backend framework: `trtllm`) with two services:

| Service | Image | Replicas | Role |
|---------|-------|----------|------|
| Frontend | `dynamo-frontend:0.9.0` | 1 | API server + Dynamo Smart Router |
| TrtllmWorker | `tensorrtllm-runtime:0.9.0` | 3 | TRT-LLM inference workers (1× H200 GPU each) |

### NVIDIA Deployment Stack

This demo runs the full NVIDIA inference deployment stack on DOKS, from the Kubernetes orchestration layer through to the inference engine:

**DynamoGraphDeployment (DGD)** → **Grove** → **PodCliques** → **TRT-LLM Workers**

**DynamoGraphDeployment** is Dynamo's Kubernetes Custom Resource for defining an inference pipeline declaratively. A single DGD resource describes all the services in the deployment (frontend, workers), their images, replica counts, environment variables, resource requirements, and relationships. The Dynamo Operator watches for DGD resources and translates them into the underlying Kubernetes objects.

**Grove** is NVIDIA's open-source Kubernetes API purpose-built for orchestrating complex AI inference workloads. It sits between the Dynamo Operator and the actual pod scheduling, providing capabilities that standard Kubernetes primitives don't natively support. In this demo, Grove is enabled via the `nvidia.com/enable-grove: "true"` annotation on the DGD resource.

Grove manages workloads through a hierarchy of custom resources:

- **Grove** (top-level): Defines a group of components that are managed and colocated together.
- **PodCliques**: Groups of pods with a specific role (e.g., leader, worker, frontend). Each PodClique manages replicas, resource requirements, and pod-level configuration for that role.
- **PodCliqueScalingGroups**: Sets of PodCliques that scale and are scheduled together — ideal for tightly coupled roles that require coordinated scaling behavior.

**Why Grove matters — even for this demo:**

While this demo uses aggregated serving (each worker handles both prefill and decode independently) and does not strictly require PodCliques for co-scheduling, Grove is deployed for several reasons:

- **Full-stack validation**: The environment demonstrates the complete NVIDIA inference stack as it would be deployed in production — DGD → Grove → PodCliques → TRT-LLM. This validates the entire deployment pathway on DOKS.
- **Future-ready for disaggregated serving**: Grove's PodCliques and PodCliqueScalingGroups become essential when running disaggregated prefill/decode architectures, where prefill leader and worker pods must be gang-scheduled together to prevent resource deadlocks. The infrastructure is already in place to demonstrate this capability.
- **Hierarchical gang scheduling**: For workloads that require multiple pods to start together (e.g., tensor-parallel inference across multiple GPUs/nodes, or prefill + decode worker pools), Grove integrates with the KAI Scheduler to ensure all required pods are co-scheduled atomically. Without gang scheduling, partial scheduling can lead to GPU resource deadlocks where some pods hold GPUs while waiting for others that can never be scheduled.
- **Multi-level autoscaling**: Grove supports scaling at the PodClique level, the PodCliqueScalingGroup level, and the Grove level, enabling fine-grained scaling policies — for example, scaling prefill workers independently from decode workers based on real-time demand signals from Dynamo's Planner.
- **Startup ordering**: Grove enforces explicit startup ordering between components, ensuring dependencies (like NATS or the frontend) are ready before workers attempt to register.

### Frontend Configuration

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `DYN_ROUTER_MODE` | `kv` | Enables KV cache-aware routing |
| `DYN_KV_CACHE_BLOCK_SIZE` | `32` | Matches the TRT-LLM engine's KV cache block size |

For the **round-robin baseline**, the only change is `DYN_ROUTER_MODE=round_robin`.

### TRT-LLM Worker Configuration

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `--model-path` | `Llama-3.1-70B-Instruct-FP8` | FP8 quantized model for efficient H200 utilization |
| `--tensor-parallel-size` | `1` | Single GPU per worker (no tensor parallelism) |
| `--max-num-tokens` | `16384` | Maximum tokens in-flight per worker |
| `--max-batch-size` | `64` | Maximum concurrent sequences per worker |
| `--publish-events-and-metrics` | enabled | Activates the KVPublisher, which emits KV cache block stored/removed events to the Dynamo event plane. Required for KV-aware routing. |

**TRT-LLM Engine Overrides:**

| Engine Parameter | Value | Purpose |
|-----------------|-------|---------|
| `enable_chunked_prefill` | `true` | Allows prefill to be broken into chunks, enabling decode requests to be interleaved during long prefills. Reduces head-of-line blocking. |
| `disable_overlap_scheduler` | `false` | Enables the overlap scheduler so compute and communication can overlap. |
| `kv_cache_config.dtype` | `fp8` | Stores KV cache in FP8, reducing memory footprint by ~50% vs FP16, allowing more sequences/blocks to fit in GPU memory. |
| `kv_cache_config.free_gpu_memory_fraction` | `0.90` | Allocates 90% of available GPU memory to KV cache. |

### Model Storage

Model weights are stored on a **DigitalOcean Managed NFS** share — a high-performance network file system that is mounted as a Persistent Volume Claim (`model-nfs-pvc`) at `/models` across all worker pods. This design serves several purposes:

- **Fast cold starts**: When a worker pod starts (or restarts due to replacement or upgrade), it loads the model directly from the NFS share rather than downloading from an external source. This minimizes pod startup time and gets workers serving traffic quickly.
- **Shared storage, single copy**: The Llama 3.1 70B FP8 model weights exist as a single copy on the NFS share, accessible to all 3 worker nodes simultaneously. There is no need to pre-stage weights on local disk per node.
- **Operational simplicity**: Model updates or swaps only need to happen in one place. New workers joining the cluster (e.g., via autoscaling) automatically have access to the model without additional provisioning steps.

### Observability

A Prometheus and Grafana monitoring stack runs on the management node pool, providing real-time visibility into the health, performance, and utilization of the entire Dynamo deployment. All Dynamo components (frontend, router, TRT-LLM workers) export metrics to Prometheus, which Grafana visualizes in dashboards.

Key metrics monitored:

| Category | Metrics |
|----------|---------|
| Latency | Time to First Token (TTFT), Inter-Token Latency (ITL), End-to-End Latency |
| Throughput | Requests per second, tokens generated per second |
| Load | In-flight requests, queue depth per worker |
| Reliability | Error rate, request timeouts |
| Utilization | GPU utilization, KV cache occupancy |

This gives operators a real-time understanding of how the system behaves as concurrency increases — complementing the load generator's own UI with deeper, component-level visibility.

---

## Benchmarking Methodology

### Load Generator

The load generator is a custom JavaScript application purpose-built to simulate realistic multi-turn LLM conversations. It is designed to create workloads that exercise prefix caching — the exact scenario where KV-aware routing provides measurable benefit over round-robin.

**Conversation Flow:**

1. **Conversation Start**: The load generator selects from a pool of conversation starters — large technical excerpts sourced from Wikipedia. It sends an initial request to the Dynamo frontend asking the inference engine to explain or elaborate on the technical content.
2. **Response from Dynamo**: The request is routed (via round-robin or KV-aware routing, depending on test scenario) to a TRT-LLM worker, which performs inference and streams a response back to the load generator.
3. **Brokered Multi-Turn Conversation**: The load generator then brokers an ongoing conversation by forwarding the response to DigitalOcean's Serverless Inference endpoint, which runs a smaller model (Meta Llama 3.1 8B). This smaller model acts as the "end user," generating follow-up questions and continuing the conversation with the Dynamo-managed inference system.
4. **3–5 Turn Conversations**: Each conversation runs for 3 to 5 turns. With each turn, the shared conversation history (prefix) grows, making KV cache reuse increasingly valuable.
5. **Conversation Reset**: After 3–5 turns, the conversation is considered complete. The load generator starts a new conversation from the pool of conversation starters.

**Why This Design Matters for the Demo:**

Multi-turn conversations are the ideal workload pattern for demonstrating KV-aware routing. Each subsequent turn includes the full conversation history as context, meaning the prompt prefix grows with every turn. With KV-aware routing, Dynamo routes each turn back to the worker that already has the conversation's KV cache blocks, avoiding redundant prefill computation. With round-robin, each turn may land on a different worker that has no cached context, requiring full recomputation of the entire conversation history.

### Real-Time Observability

The load generator includes a UI with a concurrency slider that allows the operator to increase or decrease the number of simultaneous conversations in real time. The UI displays real-time metrics computed over a rolling window (last minute) across all active conversations:

- **TTFT** (Time to First Token)
- **TPOT** (Time Per Output Token)
- **ITL** (Inter-Token Latency)
- **End-to-End Latency**
- **Error Rate**

These real-time metrics are displayed alongside pre-computed benchmark baselines for both routing strategies, enabling a live visual comparison.

### Benchmark Baselines

Benchmark baselines were established by running **6 independent sweeps** across concurrency levels 60–180. Each concurrency level was measured over a 300-second window (3 snapshots at 100 seconds, averaged), with a 60-second warmup to flush the summary window. Results across all 6 sweeps were averaged. This was done for both routing strategies:

- **Round-Robin baseline**: Dynamo frontend with `DYN_ROUTER_MODE=round_robin`
- **KV-Aware Routing baseline**: Dynamo frontend with `DYN_ROUTER_MODE=kv`

This gives the demo three layers of comparison at any concurrency level:
1. **Live metrics** — what the system is producing right now
2. **KV-aware routing benchmark** — the pre-computed average for this concurrency level
3. **Round-robin benchmark** — the pre-computed average for this concurrency level

### Test Scenarios

| Scenario | Routing Strategy | Concurrency | Conversation Pattern |
|----------|------------------|-------------|----------------------|
| Baseline | Round-Robin | 60–180 (variable via slider) | 3–5 turn multi-turn conversations with large technical prompts |
| Dynamo | KV-Aware | 60–180 (variable via slider) | Same conversation pattern, same prompts |

### Metrics Collected

| Metric | Description |
|--------|-------------|
| TTFT | Time to First Token — measures prefill efficiency. This is where KV-aware routing has the most impact. |
| TPOT | Time Per Output Token — measures decode efficiency. |
| ITL | Inter-Token Latency — time between consecutive output tokens. |
| End-to-End Latency | Total time from request submission to final token received. |
| Error Rate | Percentage of requests that fail or timeout. |

*TBD — specific concurrency levels tested, prompt token counts per turn, output token counts per turn.*

### Real-World Relevance

The demo workload — multi-turn conversations with large initial context and growing input lengths — is representative of several common enterprise patterns:

- **RAG (Retrieval-Augmented Generation):** The most direct parallel. RAG requests typically stuff 3,000-8,000 tokens of retrieved document context into the prompt, with follow-up turns resending the full conversation history. The prefix caching benefits demonstrated in this demo apply directly to RAG deployments where users ask multiple questions against the same retrieved context.
- **Long system prompts:** Enterprise deployments commonly use 1,000-4,000 token system prompts defining persona, guardrails, response formats, and domain knowledge. The demo's 10 Wikipedia conversation starters (~3,500-4,000 tokens each) model different "agents" with different system prompts, where the shared prefix is reused across all requests.
- **Knowledge assistants:** Educational or enterprise scenarios where users upload documents or receive reference material and have multi-turn conversations to understand it. The output lengths (~800-1,000 tokens of detailed explanation per turn) are realistic for this pattern.

**Per-turn profile from a representative conversation:**

| Turn | Approx Input Tokens | Output Tokens | E2E Latency |
|------|---------------------|---------------|-------------|
| 1 | ~3,500 | 555 | 37.1s |
| 2 | ~4,100 | 818 | 58.5s |
| 3 | ~5,000 | 1,008 | 97.6s |
| 4 | ~6,100 | 875 | 92.1s |
| 5 | ~7,000 | 888 | 64.0s |

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

## Results

### Test Parameters

| Parameter | Value |
|-----------|-------|
| Concurrency levels tested | 60, 80, 100, 120, 140, 160, 180 |
| Warmup | 60s per level (summary window flush) |
| Measurement window | 300s per level (3 snapshots @ 100s, averaged) |
| Independent sweeps | 6 runs, results averaged |
| Metric source | `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT) |

### TTFT — Time to First Token

| Concurrency | RR p50 | KV p50 | p50 Δ | RR p95 | KV p95 | p95 Δ | RR Hit Rate | KV Hit Rate |
|:-----------:|:------:|:------:|:-----:|:------:|:------:|:-----:|:-----------:|:-----------:|
| 60 | 274ms | 249ms | **+9.3%** | 655ms | 446ms | **+32.0%** | 90.9% | 91.6% |
| 80 | 306ms | 267ms | **+12.8%** | 637ms | 508ms | **+20.2%** | 85.3% | 95.7% |
| 100 | 342ms | 329ms | **+3.9%** | 652ms | 547ms | **+16.2%** | 88.5% | 96.1% |
| 120 | 375ms | 382ms | -2.0% | 643ms | 530ms | **+17.6%** | 87.2% | 95.9% |
| 140 | 398ms | 415ms | -4.1% | 643ms | 650ms | -1.1% | 83.9% | 91.2% |
| 160 | 422ms | 424ms | -0.5% | 722ms | 704ms | +2.5% | 90.1% | 95.3% |
| 180 | 413ms | 472ms | -14.1% | 732ms | 3143ms | -329.6% | 88.9% | 94.0% |

### Throughput and Actual RPS

| Concurrency | RR TOPS | KV TOPS | Improvement | RR RPS | KV RPS |
|:-----------:|:-------:|:-------:|:-----------:|:------:|:------:|
| 60 | 2146.9 | 2262.8 | **+5.4%** | 2.60 | 2.57 |
| 80 | 2543.2 | 2742.3 | **+7.8%** | 2.93 | 3.17 |
| 100 | 2547.5 | 2780.1 | **+9.1%** | 2.96 | 3.19 |
| 120 | 2642.6 | 2805.7 | **+6.2%** | 3.05 | 3.53 |
| 140 | 2816.8 | 3167.8 | **+12.5%** | 3.29 | 3.68 |
| 160 | 3126.8 | 3471.8 | **+11.0%** | 3.66 | 4.06 |
| 180 | 3434.0 | 3907.7 | **+13.8%** | 4.10 | 4.61 |

### ITL — Inter-Token Latency

| Concurrency | RR p50 | KV p50 | RR p95 | KV p95 |
|:-----------:|:------:|:------:|:------:|:------:|
| 60 | 28ms | 26ms | 30ms | 27ms |
| 80 | 31ms | 28ms | 33ms | 33ms |
| 100 | 38ms | 36ms | 48ms | 43ms |
| 120 | 45ms | 43ms | 50ms | 46ms |
| 140 | 49ms | 44ms | 52ms | 46ms |
| 160 | 51ms | 46ms | 54ms | 48ms |
| 180 | 52ms | 45ms | 54ms | 48ms |

### End-to-End Latency

| Concurrency | RR p50 | KV p50 | RR p95 | KV p95 |
|:-----------:|:------:|:------:|:------:|:------:|
| 60 | 24.6s | 24.3s | 30.1s | 27.7s |
| 80 | 29.3s | 26.6s | 33.4s | 32.5s |
| 100 | 32.1s | 31.8s | 49.0s | 43.6s |
| 120 | 41.2s | 38.1s | 50.4s | 47.2s |
| 140 | 45.7s | 38.7s | 53.0s | 46.7s |
| 160 | 45.2s | 40.8s | 55.4s | 48.1s |
| 180 | 46.1s | 41.4s | 54.6s | 48.7s |

### Results Summary

| Metric | Value |
|--------|-------|
| Average TTFT p50 improvement (60–180) | 0.8% |
| Peak TTFT p50 improvement | 12.8% at concurrency 80 |
| Average TTFT p95 improvement (60–160) | 14.7% (before queueing onset) |
| Peak TTFT p95 improvement | 32.0% at concurrency 60 |
| KV cache hit rate (KV mode) | 91.2%–96.1%, avg 94.3% |
| KV cache hit rate (RR mode) | 83.9%–90.9%, avg 87.8% |
| Throughput advantage (KV) | 5.4%–13.8%, avg 9.4% |
| ITL advantage (KV, p50) | 5–12% lower across all levels |
| Peak throughput (KV) | 3,907.7 tokens/s at concurrency 180 |
| Peak throughput (RR) | 3,434.0 tokens/s at concurrency 180 |

### A Note on Observed RPS

Actual measured RPS across concurrency levels ranges from 2.57 to 4.61 (see the Throughput table above). This is expected given the workload profile and is not indicative of a bottleneck or misconfiguration.

Each request in this workload involves substantial compute: input sequences range from ~3,500 tokens (turn 1) to ~7,000+ tokens (turn 5), and each response generates ~830 output tokens on average. A single request can occupy a GPU for 25–90+ seconds of end-to-end processing time. With only 3 GPUs and a `max_batch_size` of 64, the system is throughput-bound by the sheer volume of tokens being processed per request, not by the number of requests it can accept.

This is characteristic of long-context, high-output workloads like RAG and multi-turn knowledge assistants — the same real-world patterns this demo mirrors. The meaningful throughput metric for these workloads is **tokens per second** (which peaks at 3,907 tokens/s under KV routing), not requests per second. A workload with shorter sequences (e.g., single-turn chatbot queries with 200-token inputs and 50-token outputs) would show dramatically higher RPS on the same hardware.

---

## Analysis: The TTFT Crossover at High Concurrency

KV-aware routing delivers clear TTFT wins at lower concurrency (up to +12.8% p50, +32% p95 at 60–80), but the advantage erodes and inverts at higher concurrency. By 180, KV p50 TTFT is 14% worse than round-robin, and p95 TTFT degrades to 3,143ms (vs 732ms for RR). Meanwhile, throughput, ITL, and end-to-end latency remain consistently better under KV routing at every concurrency level tested.

### Root Cause: Correlated Burst Variance

KV-aware routing does **not** cause sustained load imbalance. Mean request distribution across workers is near-perfect (1.01× skew under KV vs 1.11× under RR — round-robin is actually worse on average). Instead, KV routing creates higher **momentary inflight variance** because conversation stickiness produces correlated request bursts.

At concurrency 170 with 3 workers, mean inflight is ~57 requests per worker. The queueing threshold is approximately 65 inflight (close to the `max_batch_size` of 64). KV routing's momentary peaks — an inflight spread of 28–32 requests across workers vs 12–14 under RR — push individual workers past this threshold, triggering cascading queue time spikes:

1. A worker briefly hits ~71 inflight → queue time spikes from 0.03s to 1.36s
2. The spike cascades to a second worker (peaking at 1.48s)
3. The third worker stays cool the entire time
4. After 60–90 seconds, the system self-corrects

| Metric | KV @ 170 | RR @ 170 |
|--------|:--------:|:--------:|
| Max queue time spike | 1.48s | 0.04s |
| Queue time skew | 2.55× | 1.17× |
| Engine TTFT max | 1.59s | 0.26s |
| Momentary inflight spread | 28–32 | 12–14 |
| Mean inflight skew | 1.02× | 1.11× (RR worse) |

### Why Throughput, ITL, and E2E Latency Stay Better

TTFT is uniquely sensitive to queue depth because it measures time-to-first-token — any queueing delay adds directly. Once a request begins processing, the decode phase is unaffected by how long it waited. KV routing's global compute savings (less redundant prefill) flow directly into higher decode throughput and lower ITL:

- **Throughput** improves 5–14% under KV at every level — less wasted prefill compute
- **ITL** is 5–12% better — more GPU cycles available for decode
- **E2E latency** improves up to 15% — reduced prefill plus faster decode outweigh occasional TTFT spikes

### The 3-Worker Amplification Factor

This behavior is amplified by the small worker pool. With only 3 workers and 10 shared prefixes, conversation stickiness has limited room to distribute. At larger scale (e.g., 10+ workers), burst variance would distribute across more targets, pushing the crossover point significantly higher while the throughput and latency benefits remain.

---

## Key Takeaways

KV-aware routing delivers a consistently better inference experience across the metrics that matter most for end users: **throughput (+9.4% average)**, **token generation speed (5–12% faster ITL)**, and **end-to-end response time (up to 15% faster)**. The KV cache hit rate advantage is clear — 94.3% average under KV routing vs 87.8% under round-robin — confirming that intelligent routing successfully reduces redundant prefill computation.

The TTFT crossover at high concurrency is a known artifact of conversation-sticky routing in a small (3-worker) pool. The correlated burst variance exceeds the queue headroom near `max_batch_size`. At production scale with more workers, this crossover shifts to much higher concurrency while the throughput and latency benefits remain.

**Within the SLO envelope** (TTFT ≤ 600ms, TPOT ≤ 60ms), KV-aware routing sustains compliant performance at higher concurrency than round-robin, validating the core demo claim. All ITL measurements remain well within the 60ms TPOT target across both routing modes, with KV routing consistently outperforming.

---

## Appendix

### Relevant Links

- [NVIDIA Dynamo — Overall Architecture](https://docs.nvidia.com/dynamo/latest/design-docs/overall-architecture)
- [NVIDIA Dynamo — Architecture Flow](https://docs.nvidia.com/dynamo/latest/design-docs/architecture-flow)
- [NVIDIA Dynamo — Router Design](https://docs.nvidia.com/dynamo/latest/design-docs/router-design)
- [NVIDIA Dynamo — KV Cache Aware Routing User Guide](https://docs.nvidia.com/dynamo/latest/user-guides/kv-cache-aware-routing)
- [NVIDIA Dynamo — KVBM Design](https://docs.nvidia.com/dynamo/latest/design-docs/kvbm-design)
- [NVIDIA Dynamo — Discovery Plane](https://docs.nvidia.com/dynamo/latest/design-docs/discovery-plane)
- [NVIDIA Dynamo — Request Plane](https://docs.nvidia.com/dynamo/latest/design-docs/request-plane)
- [NVIDIA Dynamo — Event Plane](https://docs.nvidia.com/dynamo/latest/design-docs/event-plane)
- [NVIDIA Dynamo GitHub](https://github.com/ai-dynamo/dynamo)
- [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM)
- [DigitalOcean Kubernetes](https://www.digitalocean.com/products/kubernetes)

### Glossary

| Term | Definition |
|------|-----------|
| TTFT | Time to First Token — latency from request submission to receiving the first generated token |
| TPOT | Time Per Output Token — average latency between successive generated tokens |
| TOPS | Tokens Per Second — total output token throughput across all workers, measuring how many tokens the system generates per second of wall-clock time |
| ITL | Inter-Token Latency — latency between consecutive output tokens (synonymous with TPOT in this context) |
| KV-Cache | Key-Value cache storing attention computations from previously processed tokens, avoiding redundant recomputation |
| Prefix Caching | Reusing KV-cache entries when multiple requests share common prompt prefixes |
| KVPublisher | Dynamo component embedded in the inference engine that emits KV cache stored/removed events to the event plane |
| KVIndexer | Dynamo component in the router that maintains a global radix tree of cached blocks across all workers |
| Radix Tree | A prefix tree data structure used by Dynamo to efficiently track and match KV cache blocks across workers. Each node stores worker IDs, enabling O(n) lookup of cache overlap for any token sequence |
| Event Plane | Dynamo's pub/sub layer (NATS or ZMQ) for distributing KV cache events and worker metrics between components |
| Request Plane | Dynamo's transport layer for RPC communication between frontend and workers (TCP, HTTP/2, or NATS) |
| Discovery Plane | Dynamo's service discovery layer; on Kubernetes uses native CRDs and EndpointSlices |
| Overlap Score Weight | Router parameter (`kv_overlap_score_weight`) that balances prefix cache reuse (improving TTFT) against even load distribution (improving ITL). Default 1.0 |
| Router Temperature | Router parameter that controls worker selection randomness via softmax sampling. 0.0 = deterministic (default) |
| KVBM | KV Block Manager — Dynamo component that manages KV cache offloading across memory hierarchies (GPU → CPU → SSD → remote storage) |
| NIXL | NVIDIA Inference Transfer Library — optimized data transfer engine for low-latency cross-node KV cache transfers |
| Disaggregated Serving | Architecture where prefill and decode phases are handled by separate worker pools (not used in this demo) |
| Aggregated Serving | Architecture where each worker handles both prefill and decode (used in this demo) |
| DOKS | DigitalOcean Kubernetes Service |
| TRT-LLM | TensorRT-LLM — NVIDIA's high-performance inference engine for LLMs |
