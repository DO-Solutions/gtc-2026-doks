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

A booth demo for NVIDIA GTC showcasing **KV cache-aware routing** and **speculative decoding** on DigitalOcean GPU infrastructure. The demo runs four TP=2 replicas of Llama 3.1 70B Instruct FP8 on a single 8-GPU node, served through NVIDIA Dynamo with a TensorRT-LLM backend. KV-aware routing reduces TTFT on multi-turn conversations by directing follow-up requests to the replica already holding cached KV state. Speculative decoding (Phase 2+) reduces ITL by generating multiple tokens per forward pass. The system exposes a standard OpenAI-compatible API; all optimizations are infrastructure-side.

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
┌──────────────────────────────────────────────────────────────┐
│                 8x H100/H200 GPU Node                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Dynamo Frontend (Rust)                     │  │
│  │  KV-aware router: routes multi-turn conversations      │  │
│  │  to the replica holding their cached KV state          │  │
│  └─────┬──────────┬──────────┬──────────┬─────────────────┘  │
│        │          │          │          │                     │
│        ▼          ▼          ▼          ▼                     │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐           │
│  │Replica A ││Replica B ││Replica C ││Replica D │           │
│  │TP=2      ││TP=2      ││TP=2      ││TP=2      │           │
│  │GPUs 0-1  ││GPUs 2-3  ││GPUs 4-5  ││GPUs 6-7  │           │
│  │Llama 70B ││Llama 70B ││Llama 70B ││Llama 70B │           │
│  │FP8       ││FP8       ││FP8       ││FP8       │           │
│  └──────────┘└──────────┘└──────────┘└──────────┘           │
│                                                              │
│  Infrastructure: etcd, NATS, Prometheus, Grafana             │
└──────────────────────────────────────────────────────────────┘
```

**NVIDIA stack:** Dynamo (inference platform with KV-aware routing), TensorRT-LLM (inference backend with speculative decoding), Grove (PodClique orchestration), KAI Scheduler (GPU-aware gang scheduling). Supporting infra: etcd, NATS.

**Config:** 4 aggregated TP=2 replicas (all 8 GPUs). Each replica handles its own prefill and decode — no inter-pod KV transfers.

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

For unattended periods, a scenario controller cycles load intensity through four phases: ramp up, steady state, high load, cooldown. No scaling events — replicas are fixed at 4.

## Technical Stack & Conventions

### Infrastructure

- **Terraform** (two stacks): Stack 1 = VPC + DOKS + NFS. Stack 2 = Helm releases + K8s baseline (namespaces, RuntimeClass, secrets, Dynamo CRDs + Platform + Grove + KAI, Prometheus, Grafana, KEDA, dcgm-exporter, cert-manager, external-dns).
- **Kubernetes manifests** for application workloads (DGD CRs, load generator).
- **Make** for orchestration of all targets.
- **Container images** published to `registry.digitalocean.com/do-solutions-sfo3/` with `gtc-demo-` prefix, tagged with `YYYYMMDD-<short SHA>`. DOKS has `registry_integration = true` for automatic pull access.

### Critical Rules (Always Follow)

**Phase 1 has fixed replicas.** No KEDA scaling. 4 worker replicas at TP=2 (all 8 GPUs used). Replica count is set in the DGD CR.

**DOKS GPU prerequisites:** RuntimeClass `nvidia` must exist before GPU pods (KAI injects it). All GPU pods tolerate `nvidia.com/gpu:NoSchedule`. KAI queue label: `kai.scheduler/queue: default-queue`.

**Grove:** Included for narrative value. DGD spec is identical with or without it. Fallback: `nvidia.com/enable-grove: "false"` annotation reverts to Deployments.

**Idempotency:** All Make targets, Terraform stacks, and K8s manifests are idempotent.

**Model changes require full redeploy:** When changing the `MODEL` variable (Makefile line 13), you must redeploy both the DGD workers (`make deploy-dynamo`) AND the load generator (`make deploy-loadgen`). The loadgen gets the model name via `MODEL_PLACEHOLDER` substitution at deploy time — it won't pick up Makefile changes until redeployed. Shortcut: `make deploy-apps` redeploys everything.

**DYN_ROUTER_MODE changes**: When changing from round robin to KV Aware Routing we must restart all the worker pods as well otherwise the cache's get out of sync. 

### Environments

| | Dev | Prod |
|--|-----|------|
| GPU | 1x `gpu-h100x8-640gb` | 1x `gpu-h200x8-1128gb-contracted` |
| Region | `ams3` | `atl1` |
| Model | Llama 3.1 70B Instruct FP8 | Llama 3.1 70B Instruct FP8 |
| Replicas | 4x TP=2 (8 GPUs) | 4x TP=2 (8 GPUs) |
| Hostname | `gtc-2026-dev.digitalocean.solutions` | `gtc-2026.digitalocean.solutions` |
| Load Gen UI | `https://gtc-2026-dev.digitalocean.solutions` | `https://gtc-2026.digitalocean.solutions` |
| Grafana | `https://gtc-2026-dev.digitalocean.solutions/grafana` | `https://gtc-2026.digitalocean.solutions/grafana` |

### Development Phases (High Level)

| Phase | Focus | Risk |
|-------|-------|------|
| **1: KV-Aware Routing** | Aggregated TP=2 serving, KV-aware routing, multi-turn workload, baseline comparison | Low |
| **2: Draft-Model Spec Decode** | Add Llama 8B as draft model for speculative decoding, show ITL improvement | Low-moderate |
| **3: EAGLE3 Spec Decode** | Switch to Llama 3.3 70B + EAGLE3 heads, higher acceptance rates | Moderate-high (stretch) |

### Key File Locations

- `terraform/infra/` — Stack 1 (VPC, DOKS, NFS)
- `terraform/cluster-config/` — Stack 2 (Helm releases, K8s baseline)
- `terraform/environments/` — `dev.tfvars`, `prod.tfvars`
- `k8s/dynamo/` — DGD CRs for aggregated TP=2 serving
- `apps/load-generator/` — Load gen UI + backend (Node.js/Express + React)
- `apps/corpus-curator/` — Document corpus preparation
- `k8s/gateway/` — Gateway API resources (Gateway, HTTPRoutes, ClusterIssuer)
- `scripts/` — Helper scripts called by Make
- `dev/MAKE-REFERENCE.md` — Refer to this when you need to understand what scripts and make targets exist and can be used as part of your plans.
- `dev/DEPLOYMENT-GUIDE.md` — Refer to this when you need ot know how to Deploy, access, and tear down environments. 
- `dev/NVIDIA-STACK-REFERENCE.md` — Refer to this when you need to know how to located the latest NVIDIA documentation for Dynamo, Grove, and KAI-Scheduler repos

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

