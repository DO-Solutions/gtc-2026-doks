# GTC Booth Guide: Dynamo on DOKS Demo

## Know Your Audience

Most attendees will fall into one of these buckets:

- **"I used DigitalOcean in college"** — They spun up a Droplet for a side project and haven't thought about DO since. They'll be surprised we have GPUs and managed Kubernetes.
- **"I've never heard of DigitalOcean"** — They live in the AWS/GCP/Azure world. They need the "why would I care" angle.
- **"I'm evaluating GPU clouds"** — They're actively shopping for inference infrastructure. They want specifics.
- **"I'm here for Dynamo/NVIDIA"** — They want the technical details on KV-aware routing and may not care about DO specifically (yet).

Adjust your depth based on who you're talking to, but the elevator pitch works for all of them.

---

## Elevator Pitch (~30 seconds)

*"We're running NVIDIA's newest inference framework — Dynamo — on DigitalOcean, serving Llama 70B across three H200 GPUs. What you're seeing live is Dynamo's KV-aware routing, which is smart enough to send each request to the GPU that already has relevant data cached in memory instead of picking a random one. The result: up to 14% more throughput and consistently faster responses on the exact same hardware.*

*The thing we want to show is that this entire stack — managed Kubernetes, H200 GPUs, shared model storage, serverless inference for the load generator — all runs on DigitalOcean. Production-grade AI infrastructure, without the complexity."*

---

## What the Demo Is Actually Doing

Here's what's happening on screen so you can walk someone through it:

A load generator is running dozens to hundreds of simultaneous multi-turn conversations against Llama 3.1 70B. Each conversation starts with a large Wikipedia excerpt (~3,500 tokens) and runs for 3–5 turns, with the conversation history growing each turn (up to 7,000+ tokens of input by turn 5). A smaller model running on DigitalOcean Serverless Inference plays the role of the "user," generating follow-up questions to keep the conversations going.

The UI shows live metrics (TTFT, throughput, latency) alongside pre-computed benchmark baselines for both KV-aware and round-robin routing. The concurrency slider lets us dial load up and down in real time.

The key comparison: KV-aware routing sends each follow-up turn back to the GPU that already has that conversation's context cached. Round-robin just cycles through GPUs blindly, so each turn may hit a GPU that has to recompute everything from scratch.

---

## The Results in Plain English

When someone asks "so what's the difference?", here are the numbers that matter:

- **Throughput**: KV-aware routing pushes 5–14% more tokens per second at every concurrency level we tested. Peak throughput hit 3,907 tokens/s vs. 3,434 for round-robin.
- **Token generation speed**: Each individual token comes back 5–12% faster (lower inter-token latency) because GPUs aren't wasting cycles on redundant work.
- **End-to-end response time**: Up to 15% faster from request to final token.
- **KV cache hit rate**: 94.3% average under KV routing vs. 87.8% under round-robin — confirming that the router is successfully reusing cached computation.

All of this is on identical hardware. The only difference is how requests get routed.

---

## The DigitalOcean Story

This is the part most attendees won't expect. Make sure it comes through:

**Managed Kubernetes (DOKS)** — The entire deployment runs on DOKS, a CNCF-certified managed Kubernetes service with a free HA control plane (99.95% uptime SLA). Clusters scale up to 1,000 worker nodes. The networking layer is Cilium with eBPF in full kube-proxy replacement mode — important for inference workloads where the router, event plane, and workers are constantly communicating. Gateway API comes pre-installed as a managed service, automatically provisioning a network load balancer. GPU node pools can scale to zero when idle, eliminating GPU charges during inactivity.

**H200 GPUs** — Three NVIDIA H200 GPU Droplets (141 GB HBM3e each) run as worker nodes in the DOKS cluster. DigitalOcean offers GPU Droplets in 1× and 8×GPU configurations across NVIDIA H100, H200, L40S, and RTX 4000/6000 Ada — at competitive pricing with straightforward, per-second billing.

**Managed NFS** — Model weights (Llama 70B FP8) are stored on a single Managed NFS share mounted by all workers. It's a fully managed, POSIX-compliant shared file storage service supporting NFSv4.1 with ReadWriteMany access. One copy of the model, accessible to every GPU node simultaneously. When a new worker joins (scaling up, pod restart, whatever), it loads the model immediately from NFS — no downloading from S3 or HuggingFace. GPU Droplets support jumbo frames (9000 MTU) for higher NFS throughput. This is the "Download Once, Infer Everywhere" pattern.

**Serverless Inference** — The load generator uses DigitalOcean's Serverless Inference (part of the Gradient AI Platform) to play the role of the end user. It provides OpenAI-compatible API access to models from OpenAI, Anthropic, Meta, Mistral, DeepSeek, and others — no GPU provisioning, per-token billing, auto-scaling. In this demo it's running Llama 3.1 8B. So even the test harness is running on DO infrastructure.

**VPC Networking** — All intra-cluster communication stays on a private VPC. Nothing traverses the public internet between nodes.

The message: this isn't a toy or a proof of concept. It's the full NVIDIA inference stack (Dynamo, Grove, KAI Scheduler, TRT-LLM) running in production configuration on DigitalOcean managed services.

---

## FAQs

### About the Demo

**"Why is the requests-per-second so low?"**
It's the nature of the workload, not a limitation. Each request involves 3,500–7,000+ input tokens and generates ~830 output tokens, keeping a GPU busy for 25–90 seconds. The meaningful throughput metric here is tokens per second, not requests per second. We peak at 3,907 tokens/s across 3 GPUs. If you ran a chatbot workload with short prompts and short responses, you'd see dramatically higher RPS on the same hardware.

**"Why does round-robin beat KV routing on TTFT at the highest concurrency?"**
Great catch — this is a known and well-understood behavior. At concurrency 170+, conversation-sticky routing creates correlated bursts where two GPUs get hit at the same time while the third is idle. With only 3 workers, there isn't much room to absorb that burst. One GPU temporarily exceeds its batch capacity, requests queue, and TTFT (which is very sensitive to queue time) spikes. Throughput, token latency, and end-to-end latency all remain better under KV routing even at that level. At production scale with 10+ workers, the burst distributes across more targets and this crossover shifts much higher.

**"Is this disaggregated inference?"**
No. This demo runs in aggregated mode — each worker handles both prefill and decode. We're isolating the KV-aware routing benefit specifically. Dynamo does support disaggregated serving (separate prefill and decode worker pools), and the infrastructure is set up to demonstrate that as a next step. Grove and KAI Scheduler are deployed here specifically to support that path.

**"What model is this running?"**
Meta Llama 3.1 70B Instruct, quantized to FP8. Running on TensorRT-LLM with one GPU per worker (no tensor parallelism). The FP8 quantization cuts KV cache memory footprint roughly in half compared to FP16, allowing more concurrent sequences per GPU.

**"What are the SLO targets?"**
TTFT ≤ 600ms and TPOT ≤ 60ms. KV-aware routing sustains these SLOs at higher concurrency than round-robin. All ITL measurements stay well within the 60ms TPOT target across both routing modes.

**"How were the benchmarks run?"**
Six independent sweeps across concurrency levels 60–180. Each level runs for 300 seconds (three 100-second snapshots, averaged) after a 60-second warmup. Results are averaged across all six sweeps. Both routing modes were tested with identical configuration — the only difference is the routing strategy.

### About DigitalOcean's AI Infrastructure

**"Since when does DigitalOcean have GPUs?"**
GPU Droplets launched in October 2024 with NVIDIA H100s, and the portfolio has expanded fast. Today we offer NVIDIA H100, H200, L40S, RTX 4000 Ada, and RTX 6000 Ada — available in both single-GPU and 8-GPU configurations. NVIDIA HGX B300 (Blackwell Ultra) is also listed on the platform (contact sales). Bare Metal GPUs (dedicated, single-tenant H100 and H200 servers) are available for customers who need full hardware control. All GPU Droplets are HIPAA-eligible and SOC 2 compliant with a 99.5% uptime SLA. This is a core investment area for DigitalOcean — the Atlanta (ATL1) data center opened in 2025 specifically as a purpose-built, high-density GPU facility.

**"What GPUs are available and how much do they cost?"**
The full lineup includes NVIDIA H100, H200, L40S, RTX 4000 Ada, and RTX 6000 Ada — in 1× and 8×GPU configurations. On-demand and reserved (12-month commitment) pricing tiers are available, with significant discounts on reserved. DigitalOcean claims up to 75% savings vs. AWS for on-demand H100 and H200 8-GPU configurations. All billing is per-second with a 5-minute minimum. Direct people to digitalocean.com/pricing/gpu-droplets for current numbers.

**"Where are the GPUs located?"**
GPU Droplets are currently available in NYC2, TOR1, ATL1, and AMS3, with more regions planned. ATL1 is DigitalOcean's newest and largest data center, purpose-built for high-density GPU infrastructure. Bare Metal GPUs are available in NYC and AMS.

**"How does DOKS compare to EKS/GKE/AKS?"**
DOKS is a fully managed, CNCF-certified Kubernetes service with a free HA control plane. The control plane is included in the price of your worker nodes — no separate charges. Some concrete differentiators: Cilium with eBPF in full kube-proxy replacement mode is the default networking layer, which means faster packet processing and lower latency than traditional kube-proxy — important for inference workloads where the router, event plane, and workers communicate constantly. Gateway API comes pre-installed as a managed service at no additional cost (no manual Ingress controller setup). Clusters scale up to 1,000 worker nodes. Node pool scale-to-zero lets GPU node pools automatically scale down to zero when idle, eliminating GPU charges during inactivity. DOKS supports NVIDIA GPU Droplets as worker nodes, with managed GPU drivers and device plugins handled for you. VPC-native networking assigns pod IPs directly from your VPC, simplifying communication with other DigitalOcean resources. There's also a Priority Expander for the cluster autoscaler that lets workloads automatically scale across node pools in a defined priority order. The uptime SLA for HA control planes is 99.95%. Customers like NoBid (processing 200 billion ad auctions monthly, 300K concurrent requests/second) and Character.ai run production workloads on DOKS.

**"What's Managed NFS and why does it matter for inference?"**
Managed NFS (Network File Storage) is a fully managed, POSIX-compliant shared file storage service that supports NFSv3 and NFSv4.1. It mounts as a PersistentVolume in Kubernetes. For inference, this means you store model weights once on a single NFS share and every GPU worker pod mounts them directly — the "Download Once, Infer Everywhere" pattern. When a new worker joins (scaling up, pod restart, node replacement), it loads the model immediately from NFS instead of downloading from HuggingFace or S3. This eliminates cold-start model download times and removes runtime dependencies on external services. NFS provides ReadWriteMany access (multiple pods read simultaneously), which is essential for horizontal scaling — Block Storage only supports ReadWriteOnce. GPU Droplets support jumbo frames (9000 MTU) on their VPC interface, which improves NFS throughput for large model transfers. Pricing is allocation-based with discounts for GPU-committed customers. Available in ATL1 and NYC2, with more regions planned. Character.ai used Managed NFS in their production deployment on DigitalOcean to cache model weights mounted by pods during vLLM startup.

**"Does DigitalOcean have multi-GPU nodes / NVLink?"**
Yes. GPU Droplets are available in 1× and 8×GPU configurations. The 8-GPU H100 and H200 Droplets use NVIDIA HGX boards with NVSwitch connectivity for high-bandwidth GPU-to-GPU communication. This demo specifically uses single-GPU H200 Droplets to showcase distributed inference across nodes — which is the more common pattern for production inference at scale and doesn't require NVLink between nodes. But 8-GPU configurations with NVLink are available for workloads that need tensor parallelism (e.g., very large models that don't fit on a single GPU).

**"What about Serverless Inference?"**
Serverless Inference is part of the DigitalOcean Gradient AI Platform (GA). It gives you API access to models from OpenAI, Anthropic, Meta, Mistral, DeepSeek, and other providers through a single endpoint — no GPU provisioning, no server configuration, no scaling logic. The API is OpenAI-compatible, so if you're already using the OpenAI Python SDK, LangChain, or LlamaIndex, you can swap the base URL and it works. Billing is per-token with no idle costs. In this demo, Serverless Inference is running Llama 3.1 8B to play the role of the "end user" generating follow-up questions in the load test. It's a separate product from what the demo is benchmarking, but it shows how multiple DO AI services compose together in a real architecture.

**"Is this production-ready or just a demo?"**
The infrastructure is production-grade — every component here is a GA DigitalOcean product. DOKS is running production workloads for customers handling billions of requests monthly. The GPU Droplets are backed by a 99.5% uptime SLA. Managed NFS is GA and was used in Character.ai's production deployment where they achieved 2× inference throughput improvement with DigitalOcean. The NVIDIA stack (Dynamo, Grove, KAI Scheduler) is deployed in its recommended production configuration. The "demo" part is the load generator and the specific workload — the underlying platform is what you'd actually use.

**"Why would I choose DigitalOcean over AWS/GCP for inference?"**
We're not going to tell you to rip out your entire cloud. But here's the honest pitch: the same H100 and H200 GPUs are available on DigitalOcean at up to 75% less on 8-GPU on-demand configurations vs. AWS. DOKS gives you managed Kubernetes with Cilium/eBPF networking, Gateway API, and GPU node support without the operational complexity of configuring EKS networking, installing GPU operators, or managing Ingress controllers. The setup is a few clicks — no multi-step security, storage, and network configuration required. You get transparent per-second billing without the maze of instance types, commitment tiers, and hidden egress charges that come with other major clouds. If your workload is inference-focused and you need GPUs, Kubernetes, storage, and networking that works, DigitalOcean gives you that with less overhead and lower cost. Companies like Character.ai and NoBid have migrated to or chosen DigitalOcean for exactly these reasons.

**"What about training workloads?"**
DigitalOcean supports training — GPU Droplets including 8×H100 and 8×H200 configurations are used for LLM training, fine-tuning, and HPC workloads. Bare Metal GPUs (dedicated, unshared hardware) are available for customers who need full control for large-scale training or custom setups. WindBorne Systems, which operates the largest balloon constellation in the world, trains their deep learning weather models on DigitalOcean H100s and found it faster and more cost-effective than other cloud options. That said, our strongest differentiation is in inference infrastructure — managed Kubernetes with GPU nodes, shared model storage, serverless inference, and the full stack you see in this demo. For very large distributed training (hundreds of GPUs with InfiniBand interconnects), there are providers that specialize in that space. But for training that fits within a single 8-GPU node or a small cluster, DigitalOcean is very competitive.

### Technical Deep Dives (For the Curious)

**"How does the KV-aware router actually decide where to send a request?"**
Every worker publishes events when it stores or evicts KV cache blocks. The router maintains a global radix tree — a prefix tree that tracks which blocks are cached on which worker. When a request comes in, the router computes a cost for each worker based on how many tokens it would need to freshly compute (fewer = better) plus its current decode load. Lowest cost wins.

**"What's Grove doing in this deployment?"**
Grove is NVIDIA's Kubernetes API for orchestrating AI inference. It manages the deployment through PodCliques (groups of pods with specific roles) and handles startup ordering, scaling, and gang scheduling. In this demo it's deployed to validate the full production stack. It becomes essential for disaggregated serving, where prefill and decode pods need to be gang-scheduled to avoid resource deadlocks.

**"What networking is under this?"**
Cilium with eBPF in full kube-proxy replacement mode. All intra-cluster traffic runs on a private VPC. External traffic comes through Gateway API, which auto-provisions a Layer 3 network load balancer. The low-latency networking matters because the Dynamo router, NATS event plane, and workers are constantly exchanging messages for KV cache state, metrics, and request routing.
