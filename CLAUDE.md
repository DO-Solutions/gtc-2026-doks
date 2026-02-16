# CLAUDE.md

## Rules

- **Implement ALL plan steps.** When given a plan, read the entire plan before starting. Do not skip steps or assume parts are optional.
- **Validation is mandatory.** Every plan must include numbered validation steps. Executing validation is part of completing the work — not optional. If validation fails, continue fixing until it passes or you are genuinely blocked. After completing the work form the plan and the validation then create a numbered bullet list with each item matching the numbered validation step that describes: (1) what was done, (2) how validation was performed, (3) validation results. 
- **Ensuring Validation.** - Every plan must end with a note that validation is part of the plan and that the plan is only considered complete when validation has been performed and the results have been reported as described above.
- **Live cluster is source of truth.** When checking cluster state (node labels, taints, pod status, resources), use `kubectl` — do not search the codebase for patterns.
- **Go direct when the target is known.** When given a specific file to edit, go to it. Do not explore the codebase first unless asked to investigate.
- **Discussion ≠ planning.** When asked a question or for a discussion, respond conversationally. Do not create plan files or ask clarifying questions when a direct answer is what's needed.
- **Check naming conflicts.** Before creating new files or scripts, check for naming conflicts with existing project files and terminology.
- **Never commit secrets.** Never store or commit secrets in the repo. All should be based on env vars, which can be set by sourcing files outside the repo.

## What We're Building

A booth demo for NVIDIA GTC showcasing **KV cache-aware routing** and **speculative decoding** on DigitalOcean GPU infrastructure. The demo runs two TP=4 replicas of Llama 3.1 70B Instruct FP8 on a single 8-GPU node, served through NVIDIA Dynamo with a TensorRT-LLM backend. KV-aware routing reduces TTFT on multi-turn conversations by directing follow-up requests to the replica already holding cached KV state. Speculative decoding (Phase 2+) reduces ITL by generating multiple tokens per forward pass. The system exposes a standard OpenAI-compatible API; all optimizations are infrastructure-side.

The key message: DigitalOcean's GPU infrastructure, combined with NVIDIA's inference stack, delivers measurably lower latency through intelligent routing and engine-level optimization — two layers of improvement that work together transparently.

## Why These Optimizations Matter

Standard multi-replica LLM deployments with round-robin load balancing treat every request independently, creating two sources of waste:

1. **Redundant prefill on multi-turn conversations.** Follow-up messages may land on a different replica than the one that served previous turns. That replica must re-process the entire conversation history — the KV cache from the original replica is wasted. TTFT grows linearly with conversation length on every turn.

2. **Underutilized GPU compute during decode.** Autoregressive decoding is memory-bandwidth bound. Each forward pass generates a single token, but most time is spent loading model weights from HBM. The GPU's tensor cores sit largely idle during decode.

**KV cache-aware routing** solves problem 1 at the **routing layer**. Dynamo's frontend tracks KV cache state across replicas via NATS and routes multi-turn conversations to the replica holding their cached context. On turn 2+, only the new user message requires prefill — TTFT drops dramatically.

**Speculative decoding** solves problem 2 at the **engine layer**. A lightweight draft model (or EAGLE3 prediction heads) generates candidate tokens that the target model verifies in a single forward pass. Multiple tokens are produced per step, reducing ITL with no quality degradation.

These optimizations are complementary — KV-aware routing targets prefill (TTFT), speculative decoding targets decode (ITL). Neither requires changes to the application, model, or API contract.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│              8x H100/H200 GPU Node                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │           Dynamo Frontend (Rust)                   │  │
│  │  KV-aware router: routes multi-turn conversations │  │
│  │  to the replica holding their cached KV state     │  │
│  └──────────────┬──────────────┬─────────────────────┘  │
│                 │              │                         │
│                 ▼              ▼                         │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  Replica A       │  │  Replica B       │             │
│  │  TP=4 (GPUs 0-3) │  │  TP=4 (GPUs 4-7) │             │
│  │  Llama 70B FP8   │  │  Llama 70B FP8   │             │
│  └──────────────────┘  └──────────────────┘             │
│                                                          │
│  Infrastructure: etcd, NATS, Prometheus, Grafana         │
└──────────────────────────────────────────────────────────┘
```

**NVIDIA stack:** Dynamo (inference platform with KV-aware routing), TensorRT-LLM (inference backend with speculative decoding), Grove (PodClique orchestration), KAI Scheduler (GPU-aware gang scheduling). Supporting infra: etcd, NATS.

**Config:** 2 aggregated TP=4 replicas (all 8 GPUs). Each replica handles its own prefill and decode — no inter-pod KV transfers.

## The Demo Experience

The demo has two displays running at the booth:

**Display 1 — Load Generator UI (presenter-facing):** A React web app with concurrency controls, RPS slider, preset buttons, and auto mode toggle. Drives synthetic multi-turn chat conversations against the Dynamo frontend.

**Display 2 — Grafana Dashboard (audience-facing):** Real-time metrics showing TTFT, ITL, KV cache hit rate, GPU utilization, and active conversations.

### Workload

| Workload | Pattern | Demonstrates |
|----------|---------|-------------|
| **Multi-turn Chat** | DO Serverless Inference (8B) generates follow-up questions → sends to Dynamo (70B). 3-5 turns per conversation. | KV cache routing — TTFT drops on turn 2+ due to cache hits |

### Demo Flow

1. **Baseline** — round-robin routing under multi-turn chat load, TTFT consistent across all turns, KV cache hit rate near zero
2. **KV-Aware Routing** — switch to KV-aware routing, TTFT drops on turn 2+, KV cache hit rate climbs as conversations progress

### Auto Mode

For unattended periods, a scenario controller cycles load intensity through four phases: ramp up, steady state, high load, cooldown. No scaling events — replicas are fixed at 2.

## Technical Stack & Conventions

### Infrastructure

- **Terraform** (two stacks): Stack 1 = VPC + DOKS + NFS. Stack 2 = Helm releases + K8s baseline (namespaces, RuntimeClass, secrets, Dynamo CRDs + Platform + Grove + KAI, Prometheus, Grafana, KEDA, dcgm-exporter, cert-manager, external-dns).
- **Kubernetes manifests** for application workloads (DGD CRs, load generator).
- **Make** for orchestration of all targets.
- **Container images** published to `registry.digitalocean.com/do-solutions-sfo3/` with `gtc-demo-` prefix, tagged with `YYYYMMDD-<short SHA>`. DOKS has `registry_integration = true` for automatic pull access.

### Critical Rules (Always Follow)

**Phase 1 has fixed replicas.** No KEDA scaling. 2 worker replicas at TP=4 (all 8 GPUs used). Replica count is set in the DGD CR.

**DOKS GPU prerequisites:** RuntimeClass `nvidia` must exist before GPU pods (KAI injects it). All GPU pods tolerate `nvidia.com/gpu:NoSchedule`. KAI queue label: `kai.scheduler/queue: default-queue`.

**Grove:** Included for narrative value. DGD spec is identical with or without it. Fallback: `nvidia.com/enable-grove: "false"` annotation reverts to Deployments.

**Idempotency:** All Make targets, Terraform stacks, and K8s manifests are idempotent.

**Model changes require full redeploy:** When changing the `MODEL` variable (Makefile line 13), you must redeploy both the DGD workers (`make deploy-dynamo`) AND the load generator (`make deploy-loadgen`). The loadgen gets the model name via `MODEL_PLACEHOLDER` substitution at deploy time — it won't pick up Makefile changes until redeployed. Shortcut: `make deploy-apps` redeploys everything.

### Environments

| | Dev | Prod |
|--|-----|------|
| GPU | 1x `gpu-h100x8-640gb` | 1x `gpu-h200x8-1128gb-contracted` |
| Region | `ams3` | `atl1` |
| Model | Llama 3.1 70B Instruct FP8 | Llama 3.1 70B Instruct FP8 |
| Replicas | 2x TP=4 (8 GPUs) | 2x TP=4 (8 GPUs) |
| Hostname | `gtc-2026-dev.digitalocean.solutions` | `gtc-2026.digitalocean.solutions` |
| Load Gen UI | `https://gtc-2026-dev.digitalocean.solutions` | `https://gtc-2026.digitalocean.solutions` |
| Grafana | `https://gtc-2026-dev.digitalocean.solutions/grafana` | `https://gtc-2026.digitalocean.solutions/grafana` |

### Development Phases (High Level)

| Phase | Focus | Risk |
|-------|-------|------|
| **1: KV-Aware Routing** | Aggregated TP=4 serving, KV-aware routing, multi-turn workload, baseline comparison | Low |
| **2: Draft-Model Spec Decode** | Add Llama 8B as draft model for speculative decoding, show ITL improvement | Low-moderate |
| **3: EAGLE3 Spec Decode** | Switch to Llama 3.3 70B + EAGLE3 heads, higher acceptance rates | Moderate-high (stretch) |

### Key File Locations

- `terraform/infra/` — Stack 1 (VPC, DOKS, NFS)
- `terraform/cluster-config/` — Stack 2 (Helm releases, K8s baseline)
- `terraform/environments/` — `dev.tfvars`, `prod.tfvars`
- `k8s/dynamo/` — DGD CRs for aggregated TP=4 serving
- `apps/load-generator/` — Load gen UI + backend (Node.js/Express + React)
- `apps/corpus-curator/` — Document corpus preparation
- `k8s/gateway/` — Gateway API resources (Gateway, HTTPRoutes, ClusterIssuer)
- `scripts/` — Helper scripts called by Make
- `dev/MAKE-REFERENCE.md` — Make targets & scripts quick reference

## Local Environment

### Secrets & Auth

- **Env file:** `source /home/jjk3/env/gtc.env` before any make/terraform/doctl commands. Contains: `DIGITALOCEAN_ACCESS_TOKEN`, `DIGITALOCEAN_TOKEN`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `HF_TOKEN`, `GRADIENT_API_KEY`. All are populated.
- **doctl context:** Always use `--context solutions` (Solutions team account).
- **Docker registry auth:** Run `doctl registry login --context solutions` before pushing images.

### Tools (All Installed — Do Not Check or Install)

`doctl`, `kubectl`, `helm`, `terraform`, `docker`, `node`/`npm`, `python3`, `make`, `git`

### Pre-existing Resources (Do Not Create)

| Resource | Name | Region | Notes |
|----------|------|--------|-------|
| Spaces bucket | `do-gtc2026-doks-demo` | `atl1` | Already exists. Model cache + corpus storage. |
| Container registry | `do-solutions-sfo3` | `sfo3` | Already exists. `registry_integration = true` on DOKS handles pull access. |

## Workflow

- **Terraform state:** Local (terraform.tfstate in each stack directory).
- **Env sourcing:** Manual — run `source /home/jjk3/env/gtc.env` before make/terraform. Makefile's `check-env` target validates required vars are set.
- **Kubeconfig:** After cluster creation, save via `doctl kubernetes cluster kubeconfig save gtc-demo --context solutions`. kubectl context: `do-ams3-gtc-demo`.
- **GPU node readiness:** After `make infra-up`, GPU nodes take time to become Ready. Run `scripts/wait-for-gpu.sh [count] [timeout]` to poll (defaults: 3 nodes, 900s).
- **Image tagging:** `TAG=$(date +%Y%m%d)-$(git rev-parse --short HEAD)` — date prefix + short git SHA (e.g., `20260210-a1b2c3d`).
- **Public URLs:** After `deploy-gateway`, services are available at `https://<hostname>/` and `https://<hostname>/grafana`. DNS and TLS are fully automated via external-dns and cert-manager.

## Deploying a New Environment

Step-by-step guide for standing up a new environment (e.g., prod) or re-deploying from scratch.

### Prerequisites

- Environment file sourced: `source ~/env/gtc.env`
- Docker registry auth: `doctl registry login --context solutions`
- Environment tfvars file exists at `terraform/environments/<env>.tfvars` with: `name_prefix`, `region`, `vpc_cidr`, `doks_cluster_subnet`, `doks_service_subnet`, `gpu_droplet_size`, `gpu_node_count`, `hostname`
- DNS domain (`digitalocean.solutions`) is managed in the DO account

### Deployment Steps

| Step | Command | What it does | Time |
|------|---------|--------------|------|
| 1 | `make infra-up ENV=<env>` | Creates VPC, DOKS cluster, NFS share. Saves kubeconfig. | ~10 min |
| 2 | `scripts/wait-for-gpu.sh 1 900` | Waits for GPU node(s) to reach Ready state. | ~5-10 min |
| 3 | `make cluster-config ENV=<env>` | Stack 2: namespaces, secrets, Helm releases (Dynamo platform, Prometheus, Grafana, KEDA, dcgm-exporter, cert-manager, external-dns). | ~5 min |
| 4 | `make ensure-pvc` | Creates NFS PVC for model storage. | seconds |
| 5 | `make setup-model` | Downloads model HF → Spaces → NFS (two K8s jobs). | ~30-45 min |
| 6 | `make build-push-all` | Builds and pushes container images. | ~2 min |
| 7 | `make deploy-apps ENV=<env>` | Deploys DGD, load generator, corpus, Gateway API resources. | ~5 min |
| 8 | `make test-gateway ENV=<env>` | Validates Gateway, TLS cert, DNS, HTTPS routing. | seconds |
| 9 | `make test-inference` | Sends test request through Dynamo frontend. | seconds |

Or run the full chain: `make deploy ENV=<env>`

### What `make deploy` does (full chain)

`check-env` → `infra-up` → `cluster-config` → `ensure-pvc` → `setup-model` → `build-push-all` → `deploy-apps`

Where `deploy-apps` = `deploy-dynamo` → `deploy-loadgen` → `deploy-corpus` → `deploy-gateway`

### Gateway / DNS / TLS

Handled automatically by `make cluster-config` + `make deploy-gateway` (part of `deploy-apps`):

1. **cert-manager** (Helm, Stack 2) — watches Gateway resources, provisions Let's Encrypt TLS certs via DNS-01 challenge using DO DNS API
2. **external-dns** (Helm, Stack 2) — watches HTTPRoutes, creates/syncs A records in DO DNS pointing hostname → LB IP
3. **Gateway** (`k8s/gateway/`) — Cilium Gateway with HTTPS (443) + HTTP→HTTPS redirect (80), routes for `/` (load gen) and `/grafana` (Grafana)

After `deploy-gateway`, allow ~2-3 min for LB provisioning, DNS propagation, and TLS cert issuance. Validate with `make test-gateway`.

### Accessing the Demo

| Method | Command / URL |
|--------|---------------|
| Public (after gateway) | `https://<hostname>/` (Load Gen), `https://<hostname>/grafana` (Grafana) |
| Conversation viewer | `https://<hostname>/#/conversations` (list), `https://<hostname>/#/conversations/<id>` (detail) |
| Port-forward (fallback) | `make demo-ui` (localhost:3000), `make demo-dashboard` (localhost:3001) |

### Teardown

`make teardown` — stops demo, destroys Stack 2, destroys Stack 1 (reverse order, errors suppressed).

## NVIDIA Stack Documentation Reference

When answering questions or making plans about the NVIDIA inference stack (Dynamo, Grove, KAI), search the documentation in these repos. Always prefer these docs over general knowledge — they reflect the latest APIs and behavior.

### Dynamo — `/home/jjk3/PycharmProjects/work/ai-dynamo/dynamo`

High-throughput disaggregated LLM inference framework. Core of the serving stack.

**Docs** (under `docs/pages/`):

| Doc Path | Topics |
|------|--------|
| `backends/trtllm/` | TRT-LLM backend setup, KV cache transfer, profiling, Prometheus metrics, model examples |
| `components/frontend/` | Frontend (request routing, KV-aware dispatch) |
| `components/router/` | Router configuration, routing strategies, examples |
| `components/planner/` | Planner (scaling decisions), examples |
| `components/kvbm/` | KV Buffer Manager (cache management) |
| `features/disaggregated-serving/` | Disaggregated prefill/decode architecture and optimization |
| `features/lora/`, `features/multimodal/`, `features/speculative-decoding/` | LoRA, multimodal, speculative decoding support |
| `api/nixl-connect/` | NIXL API reference (device, connector, RDMA, descriptors) |
| `kubernetes/` | Kubernetes deployment guides |
| `observability/` | Metrics, monitoring, dashboards |
| `fault-tolerance/` | Fault tolerance mechanisms |
| `design-docs/` | Architecture and disaggregation design docs |
| `benchmarks/` | Benchmarking guides, KV-router A/B testing |
| `reference/` | Support matrix, feature matrix, release artifacts |
| `agents/` | Tool calling for agentic inference |

**Helm chart** — `deploy/helm/charts/platform/README.md`: Complete Helm values reference for the Dynamo platform chart (operator, NATS, etcd, Grove toggle, KAI toggle, webhooks, namespace scoping, checkpoint/restore). This is the definitive reference for all Helm configuration.

**Examples** (under `examples/`):

| Path | Topics |
|------|--------|
| `basics/quickstart/` | Simple aggregated serving with vLLM |
| `basics/disaggregated_serving/` | Prefill/decode separation setup |
| `basics/multinode/` | Distributed multi-node inference |
| `basics/kubernetes/` | K8s distributed inference, shared frontend |
| `backends/trtllm/` | TRT-LLM deployment configs, engine configs, performance sweeps |
| `deployments/EKS/`, `deployments/AKS/`, `deployments/ECS/`, `deployments/GKE/` | Cloud provider deployment guides (AWS, Azure, GCP) |
| `custom_backend/` | Custom backend hello world, cancellation patterns |
| `hierarchical_planner/` | Hierarchical planner setup |

### Grove — `/home/jjk3/PycharmProjects/work/ai-dynamo/grove`

Kubernetes API for multi-pod inference orchestration. Manages PodCliques, gang scheduling, and scaling.

| Doc Path (under `docs/`) | Topics |
|------|--------|
| `user-guide/01_core-concepts/` | PodClique (PCS), PodCliqueSet (PCSG), core abstractions |
| `user-guide/02_pod-and-resource-naming-conventions/` | Pod naming conventions, examples |
| `user-guide/03_environment-variables-for-pod-discovery/` | Pod discovery env vars, patterns |
| `api-reference/` | Scheduler API, Operator API |
| `quickstart.md`, `installation.md` | Getting started, Kind cluster setup |
| `designs/` | Multi-node NVLink (MNNVL) design docs |
| `proposals/` | Enhancement proposals (topology-aware scheduling, etc.) |

### KAI-Scheduler — `/home/jjk3/PycharmProjects/work/NVIDIA/KAI-Scheduler`

GPU-aware Kubernetes batch scheduler. Handles queues, fairness, GPU sharing, and topology placement.

| Doc Path (under `docs/`) | Topics |
|------|--------|
| `quickstart/` | Getting started |
| `queues/` | Hierarchical queue configuration |
| `fairness/` | DRF and resource fairness |
| `priority/` | Workload prioritization |
| `batch/` | Batch and gang scheduling |
| `elastic/` | Elastic workload scaling |
| `gpu-sharing/` | GPU sharing (MPS, autoscaling) |
| `topology/` | Topology-aware scheduling (multi-level) |
| `dra/` | Dynamic Resource Allocation |
| `operator/` | Operator deployment, scheduling shards |
| `metrics/` | Metrics and monitoring |
| `developer/` | Developer guides, plugin framework, action framework, design proposals |
| `time-based-fairshare/` | Time-based fairness policies |

### GTC 2026 Doks — `/home/jjk3/PycharmProjects/work/DO-Solutions/gtc-2026-doks`

The demo project itself. Docs are in this CLAUDE.md (above) and component READMEs in `apps/`, `k8s/`, `terraform/`.
