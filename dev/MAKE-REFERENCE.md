# Make Targets & Scripts Reference

## Make Variables

- `ENV` (default: dev) — dev|prod
- `MODEL` (default: nvidia/Llama-3.1-70B-Instruct-FP8) — HuggingFace model ID
- `CONTEXT` (default: do-nyc2-gtc-demo) — kubectl context
- `HOSTNAME` — derived from ENV (dev: gtc-2026-dev.digitalocean.solutions, prod: gtc-2026.digitalocean.solutions)
- `TAG` — YYYYMMDD-<git-short-sha> (auto-generated)

## Make Targets

| Target | What it does |
|--------|-------------|
| `check-env` | Validate required env vars (calls `scripts/check-env.sh`) |
| **Infrastructure (Stack 1)** | |
| `infra-init` | `terraform init` for infra stack |
| `infra-plan` | `terraform plan` for infra stack |
| `infra-up` | Apply infra (VPC, DOKS, NFS) + save kubeconfig |
| `infra-down` | Destroy infra stack |
| **Cluster Config (Stack 2)** | |
| `cluster-config` | Apply Helm releases, namespaces, secrets |
| `cluster-teardown` | Destroy cluster config |
| **Model** | |
| `ensure-pvc` | Create NFS PVC for model storage |
| `model-to-spaces` | K8s job: HuggingFace → Spaces bucket |
| `model-to-nfs` | K8s job: Spaces → NFS share |
| `setup-model` | Full pipeline: HF → Spaces → NFS (calls `scripts/setup-model.sh`) |
| **Container Images** | |
| `build-loadgen` | Build load generator Docker image |
| `build-push-all` | Build + push all images (tagged `YYYYMMDD-<sha>`) |
| **Application Deployment** | |
| `deploy-dynamo` | Apply DGD CR (`k8s/dynamo/<env>-agg.yaml`) with worker replicas auto-discovered from GPU node count (override: `WORKERS=N`), RBAC, wait for pods |
| `deploy-loadgen` | Deploy loadgen (substitutes TAG + MODEL placeholders) |
| `deploy-corpus` | Curate + upload corpus to Spaces |
| `deploy-gateway` | Apply Gateway, HTTPRoutes, ClusterIssuer (substitutes HOSTNAME) |
| `deploy-apps` | All of the above in order |
| **Full Chains** | |
| `deploy` | End-to-end: infra → cluster-config → model → images → apps |
| `teardown` | Reverse: stop demo → destroy Stack 2 → destroy Stack 1 |
| **Demo Control** | |
| `demo-status` | Show nodes, DGDs, pods, PVCs |
| `demo-start` | Start manual mode (RPS=10, concurrency=35) via port-forward + curl |
| `demo-auto` | Start auto mode (cycling load phases) |
| `demo-stop` | Stop workload via API |
| `demo-ui` | Port-forward loadgen to localhost:3000 |
| `demo-dashboard` | Port-forward Grafana to localhost:3001 (prints creds) |
| `grafana-password` | Print Grafana admin password |
| **Validation** | |
| `test-gateway` | Check Gateway, TLS cert, DNS, HTTPS routing |
| `test-inference` | Send test request to Dynamo frontend |
| `capacity-test` | Staircase load test (calls `scripts/capacity-test.sh`) |

## Scripts (`scripts/`)

| Script | Args | What it does |
|--------|------|-------------|
| `check-env.sh` | — | Validates required env vars, exits 1 if missing |
| `wait-for-gpu.sh` | `[count=4] [timeout=900]` | Polls until GPU nodes are Ready (15s interval) |
| `setup-model.sh` | env: `MODEL`, `KUBE_CONTEXT` | Two-stage model pipeline: HF → Spaces → NFS via K8s jobs |
| `wait-for-dynamo.sh` | `[timeout=600]` | Polls until DGD pods are Running. Expected count auto-discovered from DGD CR. On timeout, prints logs from non-Running pods |
| `capacity-test.sh` | `--context NAME --output-dir DIR [--dry-run]` | Staircase load test: L1-L7 increasing concurrency/RPS, measures TTFT/ITL/queue/KV/errors via Prometheus, outputs TSV. Stops on red thresholds (TTFT p95>3s, ITL p95>150ms, errors>5%) |
| `validate-nvlink.sh` | `[--label TEXT]` | Post-deploy validation: pod readiness, co-location, inference test, NVLink counter check, UCX transport log extraction. Reports PASS/PARTIAL/FAIL |
