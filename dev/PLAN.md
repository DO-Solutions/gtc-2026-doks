# GTC Demo Implementation Plan
## Disaggregated LLM Inference on DigitalOcean

**Purpose:** Automated deployment of the GTC booth demo showcasing disaggregated LLM inference using NVIDIA Dynamo + Grove + KAI on DigitalOcean infrastructure.

**Inference backend:** TensorRT-LLM via `tensorrtllm-runtime:0.8.1` (PyTorch backend). The runtime loads HuggingFace checkpoints directly — no offline engine compilation step. Runtime behavior (quantization, batch sizes, memory fractions, prefill vs decode optimization) is controlled via `--extra-engine-args` YAML configs. The Terraform infrastructure patterns are adapted from the vLLM + NFS reference architecture (VPC, DOKS, NFS are backend-agnostic).

**Approach:** Terraform for infrastructure, Helm for platform components, Kubernetes manifests for application workloads, Make for orchestration. All automation designed for use with Claude Code during implementation.

---

## Critical Constraints & Conventions

These rules apply across all phases. Violating any of them will cause failures that are hard to debug.

**DGDSA scaling (not DGD):**
- KEDA and the scenario controller target `DynamoGraphDeploymentScalingAdapter` (DGDSA), never the DGD directly.
- When `scalingAdapter.enabled: true` is set on a DGD service, the operator auto-creates a DGDSA. A validating webhook then **blocks** direct DGD replica edits.
- Always scale via: `kubectl scale dgdsa <name> --replicas=N`
- DGDSA naming convention: `{dgd-name}-{service-name-lowercase}` (e.g., `gtc-demo-trtllmprefillworker`, `gtc-demo-trtllmdecodeworker`)
- DGDSA scaling chain: `KEDA ScaledObject → DGDSA (/scale subresource) → DGDSA controller syncs to DGD service replicas → DGD operator reconciles underlying resource (PodClique or Deployment)`
- On Dynamo 0.8.x, DGDSA is **opt-in** (`scalingAdapter.enabled: true`). On future releases it becomes the default.

**KEDA pause/resume:**
- Pause: set annotation `autoscaling.keda.sh/paused: "true"` on the ScaledObject
- Resume: set annotation `autoscaling.keda.sh/paused: "false"`
- Auto mode pauses KEDA (scenario controller drives scaling deterministically). Manual mode resumes KEDA (organic scaling).

**DOKS GPU prerequisites (must exist before any GPU workloads):**
- **RuntimeClass `nvidia`** — KAI injects `runtimeClassName: nvidia` into GPU pods; DOKS doesn't create this by default. Created as `kubernetes_runtime_class_v1` in cluster-config.
- **GPU tolerations** — All GPU pods must tolerate `nvidia.com/gpu:NoSchedule`.
- **KAI queue label** — Use `kai.scheduler/queue: default-queue` (not `default`).

**Grove:**
- Included in all environments for narrative value ("this same DGD spec scales from one node to hundreds").
- DGD spec is identical with or without Grove; operator produces PodCliques instead of Deployments underneath.
- Fallback: annotation `nvidia.com/enable-grove: "false"` and redeploy falls back to Deployments with zero spec changes.
- Only annotate Dynamo workloads with KAI scheduler name; leave default scheduler for system pods.
- KEDA is unaffected — it talks to DGDSA regardless of whether the underlying resource is a PodClique or Deployment.
- Grove is at v0.1.0-alpha.3 — validate install early in Phase 1.

**Container registry:**
- All application images are pushed to `registry.digitalocean.com/do-solutions-sfo3/` with prefix `gtc-demo-`.
- DOKS cluster is created with `registry_integration = true`, which grants all nodes pull access automatically — no image pull secrets needed.
- Images are tagged with short git SHA (`TAG=$(git rev-parse --short HEAD)`).

**Idempotency:** All Make targets are idempotent. Terraform stacks converge to desired state. Kubernetes manifests use `kubectl apply`. Model Jobs check for sentinel markers before executing.

**Metric labels for filtering:**
- `dynamo_namespace`: `{k8s-namespace}-{dynamoNamespace}` (e.g., `dynamo-workload-gtc-demo`)
- `dynamo_component`: component name (e.g., `TrtllmPrefillWorker`, `TrtllmDecodeWorker`, `Frontend`)
- `dynamo_endpoint`: endpoint name within component
- `model`: model name (on frontend metrics)
- `model_name`: model name (on TRT-LLM pass-through metrics)

---

## Repository Structure

```
gtc-demo/
├── Makefile                          # Top-level orchestration
├── .env.example                      # Required environment variables template
├── README.md                         # Setup and usage instructions
│
├── terraform/
│   ├── infra/                        # Stack 1: VPC + DOKS + NFS (infra patterns from vllm-nfs reference, backend-agnostic)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── versions.tf
│   │
│   ├── cluster-config/               # Stack 2: Helm releases + K8s baseline config
│   │   ├── main.tf                   # helm_release + kubernetes_* resources
│   │   ├── variables.tf              # Sensitive vars (HF_TOKEN, GRADIENT_API_KEY, SPACES keys, etc.)
│   │   ├── outputs.tf
│   │   └── versions.tf              # helm, kubernetes, digitalocean providers
│   │
│   └── environments/
│       ├── dev.tfvars                # 3x H100 1-GPU nodes
│       └── prod.tfvars               # 1x 8xH200 node
│
├── k8s/                              # Kubernetes manifests (workloads only — platform config is in terraform/cluster-config)
│   ├── dynamo/                       # DynamoGraphDeployment CRs
│   │   ├── dev-disagg.yaml           # 8B Instruct, 3 GPU nodes
│   │   ├── prod-disagg.yaml          # Llama 70B, 8xH200
│   │   └── engine-configs/           # TRT-LLM PyTorch backend runtime configs (--extra-engine-args)
│   │       ├── dev/
│   │       │   ├── prefill.yaml      # 8B prefill: batch size, memory fraction, quantization
│   │       │   └── decode.yaml       # 8B decode: batch size, memory fraction, quantization
│   │       └── prod/
│   │           ├── prefill.yaml      # 70B prefill: tuned for H200
│   │           └── decode.yaml       # 70B decode: tuned for H200
│   │
│   ├── keda/                         # KEDA ScaledObject definitions
│   │   ├── prefill-scaler.yaml
│   │   └── decode-scaler.yaml
│   │
│   └── jobs/                         # One-shot K8s Jobs
│       ├── model-upload-spaces.yaml  # HuggingFace → Spaces bucket (idempotent)
│       └── model-download-nfs.yaml   # Spaces bucket → NFS share (idempotent)
│
├── apps/                             # Application source code
│   ├── load-generator/               # Load gen Web UI + backend
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── server/               # Node.js/Express backend
│   │   │   │   ├── index.ts
│   │   │   │   ├── workloads/
│   │   │   │   │   ├── chat.ts           # Workload A: multi-turn via serverless inference
│   │   │   │   │   ├── summarization.ts  # Workload B: long prompt, short output
│   │   │   │   │   └── reasoning.ts      # Workload C: short prompt, long output
│   │   │   │   ├── scenario-controller.ts # Auto mode sequencer + KEDA pause/resume
│   │   │   │   └── k8s-client.ts         # Patch DynamoGraphDeployment replicas
│   │   │   └── ui/                   # React frontend
│   │   │       ├── App.tsx
│   │   │       ├── components/
│   │   │       │   ├── WorkloadSliders.tsx
│   │   │       │   ├── MetricsPanel.tsx
│   │   │       │   ├── ScenarioPresets.tsx
│   │   │       │   └── AutoModeControls.tsx
│   │   │       └── hooks/
│   │   │           └── useMetrics.ts     # Poll Prometheus for live stats
│   │   └── k8s/
│   │       ├── deployment.yaml       # Image: registry.digitalocean.com/do-solutions-sfo3/gtc-demo-loadgen:$(TAG)
│   │       └── service.yaml
│   │
│   └── corpus-curator/               # Document corpus preparation (local script, not containerized)
│       ├── curate.py                 # Fetch, clean, upload to Spaces
│       ├── requirements.txt          # boto3, requests
│       └── prompts/
│           ├── chat_passages.json    # Workload A passage bank (bundled)
│           └── reasoning.json        # Workload C prompt bank
│
├── scripts/                          # Helper scripts called by Make
│   ├── check-env.sh                  # Validate required env vars are set
│   ├── wait-for-gpu.sh               # Poll until GPU nodes are Ready
│   ├── wait-for-dynamo.sh            # Poll until Dynamo operator + workers healthy
│   ├── setup-model.sh                # Submit model-download K8s Job, wait for completion
│   └── record-fallback.sh            # Helper for recording demo video
│
└── docs/                             # Reference documentation
    ├── demo-proposal.md              # Original demo proposal
    ├── grove-validation.md           # DOKS validation plan + results
    └── runbook.md                    # GTC booth operations guide
```

---

## Makefile Targets

```makefile
# ============================================================
# Environment
# ============================================================
check-env           # Validate DIGITALOCEAN_ACCESS_TOKEN, HF_TOKEN, GRADIENT_API_KEY, SPACES_ACCESS_KEY_ID, SPACES_SECRET_ACCESS_KEY are set

# ============================================================
# Infrastructure (Terraform Stack 1: terraform/infra)
# ============================================================
infra-init          # terraform -chdir=terraform/infra init
infra-plan          # terraform -chdir=terraform/infra plan -var-file=../environments/$(ENV).tfvars
infra-up            # terraform -chdir=terraform/infra apply — creates VPC, DOKS, NFS
infra-down          # terraform -chdir=terraform/infra destroy

# ============================================================
# Cluster Config (Terraform Stack 2: terraform/cluster-config)
# Manages: namespaces, RuntimeClass, secrets, Helm releases
#          (Dynamo CRDs + Platform + Grove + KAI, Prometheus, KEDA, dashboards)
# Uses data sources to discover cluster from Stack 1
# ============================================================
cluster-config      # terraform -chdir=terraform/cluster-config apply
cluster-teardown    # terraform -chdir=terraform/cluster-config destroy

# ============================================================
# Model Setup (two-step: HuggingFace → Spaces → NFS)
# ============================================================
model-to-spaces     # K8s Job: download model from HuggingFace, upload to Spaces bucket
                    # Idempotent: checks if model already exists in bucket
model-to-nfs        # K8s Job: download model from Spaces bucket to NFS share
                    # Idempotent: checks if model already exists on NFS
setup-model         # Runs model-to-spaces then model-to-nfs

# ============================================================
# Container Images (registry: registry.digitalocean.com/do-solutions-sfo3)
# ============================================================
build-loadgen       # docker build apps/load-generator → registry.digitalocean.com/do-solutions-sfo3/gtc-demo-loadgen:$(TAG)
build-all           # Build all container images
push-loadgen        # docker push gtc-demo-loadgen:$(TAG)
push-all            # Push all container images
build-push-all      # Build + push all images

# ============================================================
# Workload Deployment (kubectl apply — not Terraform)
# ============================================================
deploy-dynamo       # kubectl apply DynamoGraphDeployment CR (dev or prod based on ENV)
deploy-keda         # kubectl apply ScaledObjects (depends on DGDSA names from DGD)
deploy-loadgen      # Build, push, and deploy load generator to cluster (depends on build-push-loadgen)
deploy-corpus       # Run corpus curator locally (pip install + python3), upload to Spaces
deploy-apps         # All of the above

# ============================================================
# Demo Operations
# ============================================================
demo-status         # Show pod status, GPU allocation, active workloads
demo-start          # Start load generator in manual mode
demo-auto           # Start load generator in auto mode
demo-stop           # Stop all workloads
demo-reset          # Scale back to initial P:D ratio, clear queues
demo-dashboard      # Port-forward Grafana (or print external URL)
demo-ui             # Port-forward load gen UI (or print external URL)

# ============================================================
# Validation & Testing
# ============================================================
test-inference      # Send test request to Dynamo frontend
test-disagg         # Verify prefill→decode handoff working
test-kv-cache       # Send multi-turn conversation, verify TTFT drops
test-scaling        # Trigger prefill scale-up, verify recovery
validate-all        # Run all tests in sequence

# ============================================================
# Lifecycle
# ============================================================
deploy              # check-env → infra-up → cluster-config → setup-model → build-push-all → deploy-apps
teardown            # Remove apps → cluster-teardown → infra-down
clean               # Remove local state, kubeconfig, temp files

# ============================================================
# Variables
# ============================================================
# ENV=dev|prod      — selects tfvars + Dynamo CR
# REGION=atl1       — DO region
# GPU_TYPE=gpu-h100x1-80gb  — GPU Droplet size (dev)
# MODEL=meta-llama/Llama-3.1-8B-Instruct    — dev model (overridden in prod)
# REGISTRY=registry.digitalocean.com/do-solutions-sfo3  — container registry
# TAG=$(git rev-parse --short HEAD)  — image tag, defaults to short git SHA
```

---

## Secrets Management

### Required Environment Variables

```bash
# .env.example
DIGITALOCEAN_ACCESS_TOKEN=  # DigitalOcean API token (Terraform DO provider auto-detects this)
SPACES_ACCESS_KEY_ID=       # Spaces access key
SPACES_SECRET_ACCESS_KEY=   # Spaces secret key
HF_TOKEN=                   # HuggingFace token (gated model access)
GRADIENT_API_KEY=            # DO Serverless Inference API token (Workload A)
```

### Flow

1. Developer sets env vars locally (or in CI).
2. `make check-env` validates all required vars are set; errors with specific message if any are missing.
3. Stack 1 (`terraform/infra`) — the DO provider auto-detects `DIGITALOCEAN_ACCESS_TOKEN` from environment.
4. Stack 2 (`terraform/cluster-config`) creates Kubernetes Secrets via `kubernetes_secret` resources:
   - `hf-token` in `dynamo-workload` namespace
   - `gradient-api-key` in `dynamo-workload` namespace
   - `spaces-credentials` in `dynamo-workload` namespace
   Secret values are passed as Terraform variables marked `sensitive = true`, sourced from `TF_VAR_*` env vars.

No secrets are ever stored in the repo (outside of Terraform state). All secrets are provided via environment variables that will be set and available to Claude Code.

**Docker registry auth:** Run `doctl registry login` before `make build-push-all`. This authenticates Docker to push to `registry.digitalocean.com/do-solutions-sfo3` using the `DIGITALOCEAN_ACCESS_TOKEN`.

---

## Infrastructure Specifications

Infrastructure is split into two Terraform stacks. Stack 1 creates the cloud resources. Stack 2 configures the cluster — it cannot run in the same apply because the DOKS cluster must exist before the `helm` and `kubernetes` providers can connect to it.

### Stack 1: `terraform/infra` (VPC + DOKS + NFS)

Based on the infrastructure patterns from the vLLM + NFS reference architecture at `/home/jjk3/PycharmProjects/work/digitalocean/scale-with-simplicity/reference-architectures/vllm-nfs` (VPC, DOKS, NFS provisioning — backend-agnostic). Providers: `digitalocean`.

#### Delta from Reference Architecture

| Parameter | Reference Default | GTC Demo Override |
|-----------|------------------|-------------------|
| Cluster name | (varies) | `gtc-demo` |
| Management pool | (varies) | `s-2vcpu-4gb`, auto-scale 2–5 nodes |
| GPU pool (dev) | (varies) | `gpu-h100x1-80gb`, count 3 |
| GPU pool (prod) | (varies) | `gpu-h200x8-1128gb-contracted`, count 1 |
| NFS volume size | (varies) | 16000 GB (max throughput tier) |
| Region | (varies) | `atl1` |
| Registry integration | (varies) | `registry_integration = true` (grants node pull access to `do-solutions-sfo3`) |

Dev vs prod differences are captured in `terraform/environments/dev.tfvars` and `prod.tfvars`.

### Stack 2: `terraform/cluster-config` (Helm + K8s Baseline)

Providers: `digitalocean` (data source only), `helm`, `kubernetes`. Discovers the DOKS cluster via `data "digitalocean_kubernetes_cluster"` using cluster name or ID. Configures the `helm` and `kubernetes` providers from the cluster's endpoint, token, and CA certificate.

**Manages via `kubernetes_*` resources:**
- Namespaces: `dynamo-workload`, `dynamo-system`, `monitoring`, `keda`
- RuntimeClass `nvidia` (required for KAI on DOKS)
- Secrets: `hf-token`, `spaces-credentials`, `gradient-api-key` in `dynamo-workload` namespace (values from `sensitive` Terraform variables)
- NFS PersistentVolume + PersistentVolumeClaim (`model-nfs-pvc`)
- Grafana dashboard ConfigMaps (NVIDIA Dynamo + KVBM + custom demo, labeled `grafana_dashboard: "1"` for sidecar auto-discovery)

**Manages via `helm_release` resources:**

| Resource Name | Chart | Key `set` Values |
|--------------|-------|-----------------|
| `dynamo_crds` | `dynamo-crds-0.8.1.tgz` | — |
| `dynamo_platform` | `dynamo-platform-0.8.1.tgz` | `grove.enabled=true`, `kai-scheduler.enabled=true`, `prometheusEndpoint` (constructed from Prometheus service name) |
| `kube_prometheus_stack` | `prometheus-community/kube-prometheus-stack` | `podMonitorSelectorNilUsesHelmValues=false`, `podMonitorNamespaceSelector={}`, `probeNamespaceSelector={}` |
| `dcgm_exporter` | `gpu-helm-charts/dcgm-exporter` | — (DOKS does not pre-install dcgm-exporter; required for GPU utilization metrics) |
| `keda` | `kedacore/keda` | — |

Helm values are inline `set` blocks — no external YAML files. This allows dynamic references (e.g., Prometheus endpoint constructed from the `kubernetes_namespace` resource name rather than hardcoded).

**Dependency ordering** is handled by Terraform's implicit dependency graph: `kubernetes_namespace` → `helm_release.dynamo_crds` → `helm_release.dynamo_platform` → `helm_release.kube_prometheus_stack` → dashboard ConfigMaps → `helm_release.dcgm_exporter` → `helm_release.keda`.

### Helm Chart Sources & Versions

| Component | Chart Source | Version | Namespace |
|-----------|-------------|---------|-----------|
| Dynamo CRDs | `https://helm.ngc.nvidia.com/nvidia/ai-dynamo/charts/dynamo-crds-0.8.1.tgz` | 0.8.1 | `default` |
| Dynamo Platform | `https://helm.ngc.nvidia.com/nvidia/ai-dynamo/charts/dynamo-platform-0.8.1.tgz` | 0.8.1 | `dynamo-system` |
| ↳ KAI Scheduler (sub-chart) | Bundled — `kai-scheduler.enabled=true` | v0.12.10 | `kai-scheduler` |
| ↳ Grove (sub-chart) | Bundled — `grove.enabled=true` | v0.1.0-alpha.3 | `grove-system` |
| kube-prometheus-stack | `prometheus-community/kube-prometheus-stack` | latest | `monitoring` |
| dcgm-exporter | `gpu-helm-charts/dcgm-exporter` | latest | `gpu-operator` (or `monitoring`) |
| KEDA | `kedacore/keda` | latest | `keda` |

All charts are managed as `helm_release` resources in `terraform/cluster-config`. Values are inline `set` blocks (see Stack 2 section above).

### Pre-existing Resources (Not Managed by Terraform)

| Resource | Name | Region | Purpose |
|----------|------|--------|---------|
| Spaces Bucket | `do-gtc2026-doks-demo` | `atl1` | Model file cache + corpus storage |
| Container Registry | `do-solutions-sfo3` | — | Container images for load generator and corpus curator |

The DOKS cluster is created with `registry_integration = true` in Stack 1, which grants all cluster nodes pull access to the `do-solutions-sfo3` registry automatically. No image pull secrets needed.

### Deployment Order

```
Stack 1: terraform/infra apply
  → VPC, DOKS cluster, GPU node pool, NFS volume
      ↓
Stack 2: terraform/cluster-config apply
  → Namespaces, RuntimeClass, Secrets
  → Dynamo CRDs → Dynamo Platform (with Grove + KAI)
  → kube-prometheus-stack → Grafana dashboard ConfigMaps
  → KEDA
  → dcgm-exporter
  → NFS PV/PVC
      ↓
make setup-model
  → Job 1: HuggingFace → Spaces (if not cached)
  → Job 2: Spaces → NFS
      ↓
make build-push-all
  → Build + push load generator image to do-solutions-sfo3
      ↓
make deploy-apps
  → DynamoGraphDeployment CR
  → KEDA ScaledObjects
  → Load generator
```

---

## Environment Configurations

### Dev Environment (Phase 1–2)

| Parameter | Value |
|-----------|-------|
| GPU Droplet Size | `gpu-h100x1-80gb` |
| GPU Node Count | 3 |
| Model | `meta-llama/Llama-3.1-8B-Instruct` |
| Initial P:D Ratio | 1P : 1D (2 GPUs), 1 GPU available for scaling |
| NFS | Mount for model weights (HuggingFace checkpoints loaded directly via TRT-LLM PyTorch backend) |
| KEDA | Installed but thresholds tuned for 8B model |
| Focus | Functional correctness, UI development, auto mode logic |

### Prod Environment (Phase 3+)

| Parameter | Value |
|-----------|-------|
| GPU Droplet Size | `gpu-h200x8-1128gb-contracted` |
| GPU Node Count | 1 |
| Model | `meta-llama/Llama-3.1-70B-Instruct` |
| Initial P:D Ratio | 2P : 3D (5 GPUs), 3 GPUs available for scaling |
| NFS | Mount for model weights; quantization and runtime tuning controlled via `--extra-engine-args` YAML |
| KEDA | Thresholds tuned for 70B inference latencies |
| Focus | NVLink validation, performance tuning, SLO calibration, recording |

### Switching Environments

```bash
# Dev
make deploy ENV=dev REGION=atl1 GPU_TYPE=gpu-h100x1-80gb MODEL=meta-llama/Llama-3.1-8B-Instruct

# Prod
make deploy ENV=prod REGION=atl1 GPU_TYPE=gpu-h200x8-1128gb-contracted MODEL=meta-llama/Llama-3.1-70B-Instruct
```

The `ENV` variable selects:
- `terraform/environments/{ENV}.tfvars` for infrastructure sizing
- `k8s/dynamo/{ENV}-disagg.yaml` for the DynamoGraphDeployment CR
- Model name and KEDA thresholds passed as Helm/manifest values

---

## Model Storage Pipeline

Model files follow a two-step path: HuggingFace → Spaces (durable cache) → NFS (runtime mount). This separates the slow external download from the fast internal transfer, and means the HuggingFace download only happens once regardless of how many times the cluster is rebuilt.

```
HuggingFace Hub ──(Job 1)──→ Spaces bucket ──(Job 2)──→ NFS share ──→ Dynamo workers
                              do-gtc2026-doks-demo        /models/
                              (atl1, persistent)           (ephemeral with cluster)
```

Both Jobs run inside the DOKS cluster. The system running `make` only needs `kubectl` access.

### Job 1: model-upload-spaces (HuggingFace → Spaces)

- K8s Job in `dynamo-workload` namespace, image `python:3.11-slim`
- Downloads model from HuggingFace via `huggingface-cli download`, uploads to Spaces via `aws s3 sync`
- Target path: `s3://do-gtc2026-doks-demo/models/${MODEL}/`
- Idempotency: checks for `.upload-complete` sentinel object in bucket before downloading
- Secrets required: `hf-token` (HuggingFace), `spaces-credentials` (SPACES_ACCESS_KEY_ID + SPACES_SECRET_ACCESS_KEY)
- Spaces endpoint: `https://atl1.digitaloceanspaces.com`
- `backoffLimit: 3`, `ttlSecondsAfterFinished: 3600`

### Job 2: model-download-nfs (Spaces → NFS)

- K8s Job in `dynamo-workload` namespace, image `python:3.11-slim`
- Downloads from Spaces via `aws s3 sync` to NFS mount at `/models/${MODEL}/`
- Mounts the same `model-nfs-pvc` PersistentVolumeClaim that Dynamo workers use
- Idempotency: checks for `.download-complete` sentinel file on NFS before downloading
- Secrets required: `spaces-credentials`
- No HuggingFace token needed (pulling from Spaces, not HF)

### setup-model.sh (Orchestrates Both Jobs)

- Runs Job 1 then Job 2 sequentially
- Must delete any previous Job with the same name before submitting (K8s Job names are immutable)
- Uses `envsubst` to template `${MODEL}` and `${MODEL_SLUG}` into manifests
- `kubectl wait --for=condition=complete` with 30-minute timeout per Job

---

## DynamoGraphDeployment Configuration

DGD name: `gtc-demo`, namespace: `dynamo-workload`, annotation: `nvidia.com/kai-scheduler-queue: "default-queue"`.

### Dev (3x single-GPU nodes)

| Service | componentType | Replicas | scalingAdapter | Image | Key Args | GPU |
|---------|--------------|----------|---------------|-------|----------|-----|
| Frontend | frontend | 1 | — | `dynamo-frontend:0.8.1` | — | — |
| TrtllmPrefillWorker | worker | 1 | enabled (→ DGDSA `gtc-demo-trtllmprefillworker`) | `tensorrtllm-runtime:0.8.1` | `--model-path ${MODEL} --disaggregation-mode prefill --extra-engine-args configs/prefill.yaml --publish-events-and-metrics` | 1 |
| TrtllmDecodeWorker | worker | 1 | enabled (→ DGDSA `gtc-demo-trtllmdecodeworker`) | `tensorrtllm-runtime:0.8.1` | `--model-path ${MODEL} --disaggregation-mode decode --extra-engine-args configs/decode.yaml --publish-events-and-metrics` | 1 |

All worker pods:
- Mount `model-nfs-pvc` at `/models`
- Tolerate `nvidia.com/gpu:NoSchedule`
- Reference `hf-token` secret via `envFromSecret`
- Images from `nvcr.io/nvidia/ai-dynamo/`

### Prod (1x 8xH200 node)

Same structure as dev with these differences:

| Parameter | Dev | Prod |
|-----------|-----|------|
| Prefill replicas | 1 | 2 |
| Decode replicas | 1 | 3 |
| Initial ratio | 1P:1D (2 GPUs used, 1 available) | 2P:3D (5 GPUs used, 3 available for scaling) |
| Model | `meta-llama/Llama-3.1-8B-Instruct` | `meta-llama/Llama-3.1-70B-Instruct` |
| Additional flags | — | Prod-specific `--extra-engine-args` YAMLs for 70B tuning, potential `--kv-transfer-config` for NVLink optimization |
| GPU per worker | 1 | 1 (70B fits on single H200 with appropriate quantization via engine args) |

---

## KEDA Scaling Configuration

KEDA targets the DGDSA for each worker pool, not the DGD directly. Each scaler has a single Prometheus trigger — KEDA runs the PromQL query every `pollingInterval`, compares the result to the `threshold`, and scales the DGDSA accordingly.

### Scaling Triggers

| Scaler | Metric | Why This Metric |
|--------|--------|-----------------|
| Prefill pool | `dynamo_frontend_time_to_first_token_seconds` (Histogram, p95) | TTFT is dominated by prefill compute. When TTFT degrades, prefill workers are saturated — adding replicas gives the router more capacity to distribute prefill work. |
| Decode pool | `dynamo_frontend_inter_token_latency_seconds` (Histogram, p95) | ITL is dominated by decode compute. When ITL degrades, decode workers have too many concurrent sequences — adding replicas spreads the load. |

Both metrics are filtered by `dynamo_namespace="dynamo-workload-gtc-demo"` to scope queries to the demo deployment.

### ScaledObject Specs

Each worker pool gets one `keda.sh/v1alpha1/ScaledObject` in `dynamo-workload` namespace.

**Prefill pool scaler (`gtc-demo-prefill-scaler`):**
- Target: DGDSA `gtc-demo-trtllmprefillworker` (apiVersion `nvidia.com/v1alpha1`)
- Replicas: min 1, max 4
- Trigger: Prometheus query — `histogram_quantile(0.95, ...)` over `dynamo_frontend_time_to_first_token_seconds_bucket` with 5m rate window
- Threshold: 0.5 (500ms), activation threshold: 0.1 (100ms)
- Scenario controller toggles `autoscaling.keda.sh/paused` annotation

**Decode pool scaler (`gtc-demo-decode-scaler`):**
- Target: DGDSA `gtc-demo-trtllmdecodeworker`
- Replicas: min 1, max 5
- Trigger: Prometheus query — `histogram_quantile(0.95, ...)` over `dynamo_frontend_inter_token_latency_seconds_bucket` with 5m rate window
- Threshold: 0.05 (50ms), activation threshold: 0.01 (10ms)

**Shared settings:** `pollingInterval: 15`, `cooldownPeriod: 60`. All PromQL queries filter on `dynamo_namespace="dynamo-workload-gtc-demo"`.

**Fallback trigger:** If the histogram-based triggers prove too slow to react during demo scenario transitions (the `rate()` window introduces inherent lag), we can switch to `dynamo_frontend_queued_requests` (a gauge) as the trigger instead. Queue depth responds instantly to load changes but doesn't map as cleanly to the SLO narrative. Evaluate during Phase 3 tuning.

---

## Scenario Controller Design

The scenario controller runs as part of the load generator backend and manages auto mode transitions.

### State Machine

```
IDLE → BALANCED → KV_CACHE_DEMO → PREFILL_STRESS → 
  PREFILL_RECOVERY → DECODE_STRESS → DECODE_RECOVERY → 
  FULL_LOAD → COOLDOWN → BALANCED (loop)
```

### Transition Actions

| State | Duration | Workload Mix | Scaling Action |
|-------|----------|-------------|----------------|
| BALANCED | 2 min | A:40% B:30% C:30% | Set initial P:D ratio |
| KV_CACHE_DEMO | 2 min | A:100% | None (observe TTFT drops) |
| PREFILL_STRESS | 1.5 min | B:80% C:20% | None (let metrics degrade) |
| PREFILL_RECOVERY | 1.5 min | B:80% C:20% | Add prefill worker(s), show recovery |
| DECODE_STRESS | 1.5 min | B:20% C:80% | None (let metrics degrade) |
| DECODE_RECOVERY | 1.5 min | B:20% C:80% | Add decode worker(s), show recovery |
| FULL_LOAD | 2 min | A:30% B:35% C:35% | All GPUs active |
| COOLDOWN | 1 min | Ramp down to 0 | Reset to initial P:D ratio |

**Total cycle time: ~13 minutes** — comfortable for passersby to see at least one full transition.

### Implementation Details

```
Scenario Controller (TypeScript)
├── K8s client (kubectl scale dgdsa gtc-demo-trtllmprefillworker --replicas=N)
├── K8s client (kubectl scale dgdsa gtc-demo-trtllmdecodeworker --replicas=N)
├── KEDA client (toggle autoscaling.keda.sh/paused annotation on ScaledObjects)
├── Load generator client (set workload mix + RPS)
├── State machine with configurable durations
└── WebSocket events → UI shows current phase + countdown
```

### Manual vs Auto Mode

| Aspect | Manual Mode | Auto Mode |
|--------|------------|-----------|
| Workload control | Presenter via sliders | Scenario controller |
| Scaling | KEDA (organic, via DGDSA) | Scenario controller (`kubectl scale dgdsa`, deterministic) |
| KEDA state | Active (`paused: "false"`) | Paused (`paused: "true"`) |
| Best for | Guided presentations | Unattended booth |

---

## Load Generator Architecture

### Backend (Node.js/Express)

```
Endpoints:
  POST /api/workload/start     — Start workload(s) with mix + RPS
  POST /api/workload/stop      — Stop all workloads
  POST /api/workload/config    — Update mix/RPS in real-time
  POST /api/scenario/auto      — Start auto mode
  POST /api/scenario/stop      — Stop auto mode, resume KEDA
  POST /api/scenario/manual    — Switch to manual, resume KEDA
  GET  /api/status             — Current state, workload stats
  WS   /ws                     — Real-time metrics + scenario state

Workload Runners (goroutine-style async workers):
  - Chat runner: manages conversation state, calls Serverless Inference
    for follow-up generation, sends to Dynamo frontend
  - Summarization runner: pulls random doc from Spaces, sends to Dynamo
  - Reasoning runner: pulls random prompt from bank, sends to Dynamo
  
  All runners:
  - Send requests to Dynamo frontend's OpenAI-compatible API
  - Track per-request TTFT, ITL, total latency
  - Report stats via WebSocket to UI
```

### Frontend (React)

Designed for **multiple booth displays**:

**Display 1 — Control + Metrics (presenter-facing or interactive):**
- Workload sliders (A/B/C mix, total RPS)
- Preset buttons (Balanced, Prefill Stress, Decode Stress)
- Auto mode toggle with phase indicator + countdown
- Live request metrics (RPS, in-flight, conversation turns)
- Start / Stop / Reset controls

**Display 2 — Grafana Dashboard (audience-facing):**
- NVIDIA Dynamo dashboard (from ConfigMap): TTFT p50/p95, ITL p50/p95, RPS, GPU utilization, request duration
- NVIDIA KVBM dashboard (from ConfigMap): KV cache hit rate, cache usage
- Custom demo dashboard: worker pool replica counts, scaling events timeline, scenario phase indicator

Both displays served from the load gen service on the management node pool. Grafana exposed separately.

---

## Document Corpus

Curated from public domain / CC-licensed sources, organized by token length for workload targeting.

| Workload | Source | Why | Count |
|----------|--------|-----|-------|
| **Workload A (Chat)** | Bundled technology/science passages (GPU architecture, LLMs, Kubernetes, disaggregated inference, etc.) | Diverse topics that generate natural follow-up questions from the 8B broker model | 10 passages (dev), 50-100 passages (prod), each 250-500 tokens |
| **Workload B (Summarization)** | arXiv paper abstracts + intros (CS, physics), Project Gutenberg chapter excerpts, SEC 10-K filing excerpts (public) | Long-form content with clear summarizable structure | 30-50 documents across `/short/`, `/medium/`, `/long/` buckets |
| **Workload C (Reasoning)** | Prompt bank (no documents needed) — "Explain X step by step", "Write a detailed implementation of Y", "Compare A and B" | Short prompts that elicit long decode sequences | 50-100 prompts stored as JSON |

**Storage structure in Spaces:**

```
s3://do-gtc2026-doks-demo/
├── models/                          # Model files (from setup-model)
└── corpus/                          # Demo corpus (from deploy-corpus)
    ├── .curator-complete            # Sentinel for idempotency
    ├── chat/
    │   └── passages.jsonl           # {id, text, topic, token_count}
    ├── summarization/
    │   ├── short/docs.jsonl         # ~4k tokens each
    │   ├── medium/docs.jsonl        # ~10k tokens each
    │   └── long/docs.jsonl          # ~18k tokens each
    └── reasoning/
        └── prompts.jsonl            # {id, prompt, category, expected_output_length, prompt_token_count}
```

For Phase 1–2 dev, a smaller subset (10 chat passages, 10 docs, 20 prompts) is sufficient. Full corpus curation happens in parallel.

---

## Observability Stack

### Prometheus

**Installation:** `helm_release.kube_prometheus_stack` in `terraform/cluster-config`.

Required `set` values on `kube_prometheus_stack`:
- `prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false` — allow Prometheus to discover PodMonitors created by Dynamo operator, not just those from the Helm release
- `prometheus.prometheusSpec.podMonitorNamespaceSelector="{}"` — scrape PodMonitors across all namespaces (Dynamo workloads run in `dynamo-workload`, not `monitoring`)
- `prometheus.prometheusSpec.probeNamespaceSelector="{}"` — same for Probes

Required `set` values on `dynamo_platform`:
- `prometheusEndpoint` — constructed dynamically from the Prometheus service name and monitoring namespace
- `grove.enabled=true`
- `kai-scheduler.enabled=true`

**Metric discovery is automatic.** The Dynamo operator creates PodMonitor resources and adds labels (`nvidia.com/metrics-enabled: "true"`, `nvidia.com/dynamo-component-type: "frontend|worker"`) to all pods for Prometheus auto-discovery. No manual scrape config needed.

Scrape targets (auto-discovered):
- Dynamo frontend pods (`:8000/metrics`) — `dynamo_frontend_*` metrics
- Dynamo worker pods (`:8081/metrics`) — `dynamo_component_*` + TensorRT-LLM pass-through metrics
- node-exporter (bundled with kube-prometheus-stack) — CPU, memory, system load
- dcgm-exporter — GPU utilization, memory, temperature (installed via `helm_release.dcgm_exporter` in cluster-config)
- KEDA metrics server — scaled object status, trigger values

### Grafana Dashboards

#### NVIDIA-Provided Dashboards (Confirmed)

NVIDIA provides pre-built Grafana dashboards at two levels:

**Repo-bundled JSON files** (in `grafana_dashboards/` directory):
| Dashboard | File | Contents |
|-----------|------|----------|
| Dynamo Overview | `grafana-dynamo-dashboard.json` | SW + HW metrics: request rates, TTFT, ITL, request duration, sequence lengths, GPU utilization, node CPU/memory |
| DCGM GPU Metrics | `grafana-dcgm-metrics.json` | GPU-specific metrics from dcgm-exporter |
| KVBM Metrics | `grafana-kvbm-dashboard.json` | KV Block Manager metrics: cache usage, prefix cache hit rate, active/total blocks |

**Kubernetes ConfigMap** (managed by `kubernetes_config_map` in `terraform/cluster-config`):
The dashboard JSON is embedded in a ConfigMap and labeled with `grafana_dashboard: "1"`. The Grafana sidecar auto-discovers and imports it. No manual import needed.

**K8s dashboard panels include:** frontend request rates, time to first token, inter-token latency, request duration, input/output sequence lengths, GPU utilization via DCGM, node CPU utilization and system load, container CPU usage per pod, memory usage per pod.

#### Dashboard Strategy for GTC Demo

**Layer 1 — NVIDIA K8s ConfigMap dashboard** (base):
Apply `grafana-dynamo-dashboard-configmap.yaml` as-is. This gives us the core inference metrics panels (TTFT, ITL, request rates, GPU utilization) with zero customization effort.

**Layer 2 — KVBM dashboard** (KV cache narrative):
Import `grafana-kvbm-dashboard.json` as a second ConfigMap. This adds prefix cache hit rate and cache usage panels, which are critical for demonstrating the KV cache reuse story in Workload A (multi-turn chat).

**Layer 3 — Demo-specific custom dashboard** (scaling narrative):
Fork the NVIDIA dashboard JSON and add:
- Worker pool replica counts (prefill vs decode) — sourced from `kube_deployment_spec_replicas` or DGDSA status
- Scaling events timeline with annotation markers — fed from scenario controller via Grafana annotation API
- Scenario phase indicator panel — current auto mode phase + countdown
- Prefill vs decode queue depth split — using `dynamo_frontend_queued_requests` with component label filtering

All three dashboards provisioned as ConfigMaps in `k8s/observability/dashboards/`.

### Dashboard Layout (Display 2)

```
┌─────────────────────────────────────────────────────┐
│  GTC Demo: Disaggregated LLM Inference on DO        │
├──────────────────────┬──────────────────────────────┤
│  TTFT (p50/p95)      │  ITL (p50/p95)              │
│  [line chart]        │  [line chart]                │
├──────────────────────┼──────────────────────────────┤
│  Worker Pools        │  KV Cache                    │
│  Prefill: ██░░ 2/4   │  Hit Rate: 73%              │
│  Decode:  ███░ 3/5   │  Prefix Cache: 0.85         │
├──────────────────────┼──────────────────────────────┤
│  Prefill Queue Depth │  GPU Utilization per Worker  │
│  [area chart]        │  [bar chart via DCGM]        │
├──────────────────────┴──────────────────────────────┤
│  Scaling Events Timeline + Scenario Phase           │
│  [annotation chart with scenario phases]             │
└─────────────────────────────────────────────────────┘
```

**Source mapping for custom panels:**
- Worker Pools: DGDSA replica counts or `kube_deployment_spec_replicas`
- KV Cache Hit Rate: `dynamo_component_kvstats_gpu_prefix_cache_hit_rate`
- Prefill Queue: `dynamo_frontend_queued_requests`
- GPU Utilization: `DCGM_FI_DEV_GPU_UTIL` from dcgm-exporter
- Scaling Events: Grafana annotation API, pushed by scenario controller

### Available Metrics Reference

**Frontend metrics** (from Dynamo HTTP frontend pods at `:8000/metrics`):
- `dynamo_frontend_time_to_first_token_seconds` — Histogram, TTFT
- `dynamo_frontend_inter_token_latency_seconds` — Histogram, ITL
- `dynamo_frontend_request_duration_seconds` — Histogram, E2E latency
- `dynamo_frontend_requests_total` — Counter, total requests
- `dynamo_frontend_inflight_requests` — Gauge, currently processing
- `dynamo_frontend_queued_requests` — Gauge, in HTTP queue (includes prefill time)
- `dynamo_frontend_input_sequence_tokens` — Histogram, input lengths
- `dynamo_frontend_output_sequence_tokens` — Histogram, output lengths

**KV Router stats** (from worker pods):
- `dynamo_component_kvstats_gpu_cache_usage_percent` — Gauge, 0-1
- `dynamo_component_kvstats_gpu_prefix_cache_hit_rate` — Gauge, 0-1
- `dynamo_component_kvstats_active_blocks` — Gauge
- `dynamo_component_kvstats_total_blocks` — Gauge

**Backend component metrics** (from worker pods at `:8081/metrics`):
- `dynamo_component_requests_total` — Counter
- `dynamo_component_request_duration_seconds` — Histogram
- `dynamo_component_inflight_requests` — Gauge
- `dynamo_component_system_uptime_seconds` — Gauge

**TensorRT-LLM pass-through metrics** (same `:8081/metrics` endpoint, `trtllm:` prefix):
Requires `--publish-events-and-metrics` flag on worker launch. TRT-LLM metrics are automatically prefixed with `trtllm:` by Dynamo. As of TRT-LLM 1.1.0rc5, 5 basic Prometheus metrics are exposed via `MetricsCollector`. Metric labels use `model_name` (not `model`). Metrics may change between TRT-LLM versions — inspect the `/metrics` endpoint to confirm available metrics for dashboards.

---

## Development Phases

Work is structured in sequential phases. Each phase ends with a review checkpoint — inspect outcomes, commit changes, and make adjustments before moving to the next phase.

### Phase 1: Infrastructure & Platform — ENV=dev, 3x single-GPU nodes

Stand up the cluster, install the platform stack, and validate the core inference pipeline works end-to-end with the dev model.

#### Phase 1a: Project Scaffolding

**Deliverable:** Repo structure, Makefile skeleton, Terraform config for both stacks (infra + cluster-config).

**Build from these specs:**
- Repository Structure (for directory layout)
- Makefile Targets (for target signatures and comments)
- Secrets Management (`check-env` logic)
- Infrastructure Specifications → Stack 1 and Stack 2 (for Terraform files)
- Environment Configurations (for `dev.tfvars` and `prod.tfvars`)

**Notes:** At this step, Terraform files should be complete and plannable but not yet applied. Helm release resources in cluster-config should reference the exact chart URLs and `set` values from the Helm Chart Sources table. The Makefile should have all target signatures stubbed even if some just `echo "TODO"`.

#### Phase 1b: Infrastructure Automation

**Deliverable:** `make infra-up` working: VPC, DOKS cluster, GPU nodes, NFS provisioned.

**Build from these specs:**
- Infrastructure Specifications → Stack 1 (for Terraform resources)
- Infrastructure Specifications → Delta from Reference Architecture (for sizing overrides)
- Environment Configurations → Dev Environment (for `dev.tfvars` values)

**Notes:** Reference architecture source is at `/home/jjk3/PycharmProjects/work/digitalocean/scale-with-simplicity/reference-architectures/vllm-nfs`. After apply, validate: `kubectl get nodes` shows 3 GPU nodes with `nvidia.com/gpu` capacity, NFS volume is attached.

#### Phase 1c: Platform Stack

**Deliverable:** `make cluster-config` working: namespaces, RuntimeClass, secrets, Dynamo (CRDs + Platform + Grove + KAI), Prometheus, Grafana, KEDA, dcgm-exporter all deployed and healthy.

**Build from these specs:**
- Infrastructure Specifications → Stack 2 (for all `kubernetes_*` and `helm_release` resources)
- Infrastructure Specifications → Helm Chart Sources & Versions (for chart URLs and versions)
- Infrastructure Specifications → Deployment Order (for dependency chain)
- Critical Constraints → DOKS GPU prerequisites (for RuntimeClass and tolerations)
- Observability Stack → Prometheus (for required `set` values on both kube-prometheus-stack and dynamo-platform)

**Notes:** Validate Grove is healthy: `kubectl get pods -n grove-system`. Validate KAI: `kubectl get pods -n kai-scheduler`. Validate Prometheus is scraping: check targets page. This is where Grove v0.1.0-alpha.3 risk surfaces — if it fails, see fallback in Critical Constraints → Grove.

#### Phase 1d: Dynamo Deployment

**Deliverable:** `make deploy-dynamo` working: disaggregated serving with 8B model on TensorRT-LLM, test-inference passing, DGDSA resources visible via `kubectl get dgdsa`.

**Build from these specs:**
- DynamoGraphDeployment Configuration → Dev (for the DGD CR spec)
- Model Storage Pipeline (for the two-step model download jobs)
- Critical Constraints → DGDSA scaling (for DGDSA naming and verification)

**Notes:** After deploying, verify: `kubectl get dgdsa -n dynamo-workload` shows `gtc-demo-trtllmprefillworker` and `gtc-demo-trtllmdecodeworker`. Run `test-inference` to confirm end-to-end request flow. Check that metrics appear in Prometheus (`dynamo_frontend_*` metrics).

**Phase 1 Checkpoint:** Cluster healthy, disaggregated inference responding, model loaded from NFS, metrics flowing to Prometheus.

---

### Phase 2: Application — ENV=dev, 3x single-GPU nodes

Build the load generator, workload runners, and demo UI on top of the validated platform.

#### Phase 2a: Dev Corpus

**Deliverable:** Corpus curator tool built, minimal dev corpus (10 chat passages, 10 summarization docs, 20 reasoning prompts) curated and uploaded to Spaces bucket.

**Build from these specs:**
- Document Corpus (for Spaces bucket structure, data formats, and source material)
- Repository Structure → `apps/corpus-curator/` (for file layout)
- Makefile Targets → `deploy-corpus`

**Notes:** The corpus curator is a local Python script (`apps/corpus-curator/curate.py`), not a containerized K8s Job. It loads bundled chat passages and reasoning prompts from `prompts/`, fetches summarization docs from Project Gutenberg, and uploads everything to the `do-gtc2026-doks-demo` Spaces bucket under the `corpus/` prefix (chat/passages.jsonl, summarization/short|medium|long/docs.jsonl, reasoning/prompts.jsonl). Idempotent via a `.curator-complete` sentinel object; `--force` flag bypasses. `make deploy-corpus` installs deps and runs the script locally. Validate by checking the Spaces bucket contains the expected files.

#### Phase 2b: Load Gen Backend

**Deliverable:** Workload B (summarization) + C (reasoning) runners sending traffic to Dynamo, basic metrics collection.

**Build from these specs:**
- Load Generator Architecture → Backend (for Express endpoints and runner design)
- Repository Structure → `apps/load-generator/` (for file layout)
- Document Corpus → Workload B and C (for request format and data sources)

**Notes:** Start with B and C because they don't require the Serverless Inference integration. Runners pull corpus data from the Spaces bucket populated in Phase 2a. Runners should send to Dynamo frontend's OpenAI-compatible API and track TTFT/ITL/total latency per request.

#### Phase 2c: Workload A (Chat Broker)

**Deliverable:** Chat broker (Serverless Inference ↔ Dynamo), conversation state management.

**Build from these specs:**
- Load Generator Architecture → Backend → Chat runner (for conversation state management)
- Document Corpus → Workload A (for chat passage format and seed prompts)
- Secrets Management (for `GRADIENT_API_KEY` usage)

**Notes:** Workload A is the most complex runner — it calls DO Serverless Inference to generate follow-up questions, then sends them to Dynamo. This requires the `gradient-api-key` secret. Chat passages from the Spaces bucket (uploaded in Phase 2a) provide seed context for conversations.

#### Phase 2d: Load Gen UI

**Deliverable:** React frontend: workload sliders, RPS control, start/stop, live metrics display.

**Build from these specs:**
- Load Generator Architecture → Frontend (for Display 1 layout and controls)
- Repository Structure → `apps/load-generator/src/ui/` (for component layout)

**Notes:** The UI connects to the backend via REST + WebSocket. Focus on Display 1 (control panel) — Display 2 (Grafana) is handled in Phase 2g.

#### Phase 2e: Scenario Controller

**Deliverable:** Auto mode state machine, KEDA pause/resume, K8s replica patching via DGDSA.

**Build from these specs:**
- Scenario Controller Design (for the full state machine, transition actions, and implementation details)
- Critical Constraints → DGDSA scaling (for `kubectl scale dgdsa` commands)
- Critical Constraints → KEDA pause/resume (for annotation toggling)

**Notes:** The scenario controller is a TypeScript module inside the load gen backend. It needs a K8s client with permissions to scale DGDSAs and patch ScaledObject annotations. The RBAC for this should be part of the load gen's ServiceAccount.

#### Phase 2f: KEDA Integration

**Deliverable:** Deploy ScaledObjects targeting DGDSAs, validate Prometheus triggers fire, tune dev thresholds.

**Build from these specs:**
- KEDA Scaling Configuration (for complete ScaledObject specs, triggers, and thresholds)
- Repository Structure → `k8s/keda/` (for manifest locations)

**Notes:** Thresholds (TTFT 500ms, ITL 50ms) are starting points for dev — they will need full recalibration in Phase 3. Test both manual mode (KEDA active, verify it scales on load) and auto mode (KEDA paused, verify scenario controller drives scaling).

#### Phase 2g: Grafana Dashboards

**Deliverable:** Apply NVIDIA K8s dashboard + KVBM ConfigMaps, verify panels populate. Build custom demo dashboard (scaling events, worker pool counts, scenario phase).

**Build from these specs:**
- Observability Stack → Grafana Dashboards (for dashboard strategy, layers 1-3)
- Observability Stack → Dashboard Layout (for Display 2 wireframe)
- Observability Stack → Available Metrics Reference (for panel data sources)

**Notes:** Layers 1 and 2 (NVIDIA dashboards) should just work once ConfigMaps are applied — verify panels populate with real data from the running dev workload. Layer 3 (custom dashboard) requires building the JSON and adding panels for worker pools, scaling events, and scenario phase.

**Phase 2 Checkpoint:** Full demo flow working in dev — manual mode + auto mode cycling, all three workloads, scaling up/down, dashboards populating.

---

### Phase 3: Prod Validation & Tuning — ENV=prod, 1x 8xH200

Switch to production hardware. Tune performance, calibrate SLO thresholds, and record fallback content.

**Expect a full retune of auto mode timing and KEDA thresholds.** Dev (3x single-GPU H100 nodes) and prod (1x 8xH200 node) have fundamentally different performance characteristics. KV cache transfers move over the network in dev but over NVLink in prod — much faster. The 70B model on H200 will have different saturation points, queue buildup patterns, and cache hit rates than the 8B model on H100. Pod scale-up is also faster in prod since new workers land on the same node with GPUs already available, rather than scheduling across nodes. Treat Phase 2 auto mode tuning as functional validation only — the timings (phase durations, stress thresholds, recovery windows) will all need to be recalibrated here.

| Step | Focus | Deliverable |
|------|-------|-------------|
| 3a | Infra switch | `make deploy ENV=prod`, validate 8xH200 node, NVLink visible, model download |
| 3b | Performance validation | Verify NVLink KV transfer speed, disaggregated vs aggregated TTFT comparison |
| 3c | SLO tuning | Determine actual TTFT/ITL p95 values under load, set KEDA thresholds, tune auto mode timing |
| 3d | Dry run | Full demo rehearsal (manual + auto), identify and fix issues |
| 3e | Record + harden | Record fallback video, prepare pre-scaled fallback state, final fixes |

**Relevant specs:** Environment Configurations → Prod Environment, DynamoGraphDeployment Configuration → Prod, KEDA Scaling Configuration (for threshold recalibration).

**Phase 3 Checkpoint:** Demo runs reliably on prod hardware with tuned thresholds. Fallback video recorded.

---

### Phase 4: Buffer

Available for fixes and polish. No 8xH200 needed unless rework required.

### Phase 5: GTC

`make deploy ENV=prod` → live booth demo.

---

## References

- Dynamo autoscaling docs: https://docs.nvidia.com/dynamo/latest/kubernetes/autoscaling.html
- KEDA ScaledObject spec: https://keda.sh/docs/2.18/reference/scaledobject-spec/
