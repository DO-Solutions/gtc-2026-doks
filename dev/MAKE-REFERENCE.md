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
| `vllm-benchmark.sh` | env: `RESULT_LABEL`, `VLLM_EXTRA_ARGS`, `BENCHMARK_RATES`, `NUM_PROMPTS`, `MODEL`, `TP_SIZE` | Runs inside benchmark Job: starts vLLM server, sweeps request rates via `vllm bench serve` with ShareGPT, saves JSON results to NFS |

## Benchmarks

### Overview

The vLLM benchmark system (`scripts/vllm-benchmark.sh` + `k8s/benchmarks/vllm-benchmark-job.yaml`) runs a standalone vLLM server inside a K8s Job on a GPU node, sweeps request rates using ShareGPT data via `vllm bench serve`, and saves JSON + log results to NFS. Each benchmark run produces one result file per rate point.

### Prerequisites

- **DGD must be deleted first** — the benchmark Job needs exclusive GPU access. Delete the DGD CR before running: `kubectl delete dgd --all -n dynamo-workload --context do-nyc2-gtc-demo`
- **NFS PVC** (`model-nfs-pvc`) must exist with the model already downloaded
- **CUDA compat DaemonSet** must be running (libs at `/opt/cuda-compat-13.1/`)

### Environment Variables

All configured in the Job YAML (`k8s/benchmarks/vllm-benchmark-job.yaml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `RESULT_LABEL` | `phase0` | Subdirectory name for results (e.g., `phase0`, `prefix-caching`, `spec-decode`) |
| `VLLM_EXTRA_ARGS` | `""` | Additional args passed to `vllm serve` (e.g., `--enable-prefix-caching --enable-chunked-prefill`) |
| `BENCHMARK_RATES` | `0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0` | Space-separated request rates to sweep |
| `NUM_PROMPTS` | `300` | Number of prompts per rate point |
| `MODEL` | `/models/nvidia/Llama-3.1-70B-Instruct-FP8` | Model path on NFS |
| `TP_SIZE` | `1` | Tensor parallel size |

### Running a Benchmark

**1. Edit env vars in the Job YAML** to configure the phase:

```bash
vi k8s/benchmarks/vllm-benchmark-job.yaml
# Change RESULT_LABEL, VLLM_EXTRA_ARGS, etc. as needed
```

**2. Update the ConfigMap and deploy the Job:**

```bash
# Update the benchmark script ConfigMap
kubectl create configmap vllm-benchmark-script \
    --from-file=vllm-benchmark.sh=scripts/vllm-benchmark.sh \
    -n dynamo-workload --context do-nyc2-gtc-demo \
    --dry-run=client -o yaml | kubectl apply -f - --context do-nyc2-gtc-demo

# Delete any previous Job (Job names are immutable)
kubectl delete job vllm-benchmark -n dynamo-workload --context do-nyc2-gtc-demo --ignore-not-found

# Apply the Job
kubectl apply -f k8s/benchmarks/vllm-benchmark-job.yaml --context do-nyc2-gtc-demo
```

**3. Follow progress:**

```bash
kubectl logs -f job/vllm-benchmark -n dynamo-workload --context do-nyc2-gtc-demo
```

### Retrieving Results from NFS

Completed Job pods can't be `kubectl exec`'d. Use a helper pod to access NFS:

```bash
# Launch helper pod
kubectl run nfs-helper --rm -it \
    --image=busybox \
    --overrides='{"spec":{"containers":[{"name":"nfs-helper","image":"busybox","command":["sh"],"stdin":true,"tty":true,"volumeMounts":[{"name":"nfs","mountPath":"/models"}]}],"volumes":[{"name":"nfs","persistentVolumeClaim":{"claimName":"model-nfs-pvc"}}]}}' \
    -n dynamo-workload --context do-nyc2-gtc-demo

# Inside the helper pod:
ls /models/benchmarks/<RESULT_LABEL>/
# Copy results out via kubectl cp from another terminal
```

Or copy directly with `kubectl cp` from a running helper pod:

```bash
kubectl cp dynamo-workload/nfs-helper:/models/benchmarks/phase0/ dev/vllm/benchmarks/phase0/ \
    --context do-nyc2-gtc-demo
```

### Result Location Convention

Results are stored on NFS at `/models/benchmarks/<RESULT_LABEL>/<YYYYMMDD-HHMMSS>/` and copied locally to:

```
dev/vllm/benchmarks/<RESULT_LABEL>/<YYYYMMDD-HHMMSS>/
├── server.log          # vLLM server startup log
├── warmup.log          # 10-prompt warm-up run output
├── rate-0.5.json       # vllm bench serve JSON output per rate
├── rate-0.5.log        # Console output per rate
├── rate-0.75.json
├── rate-0.75.log
├── ...
└── report.md           # Generated analysis report (if created)
```

### Example Phase Configurations

Edit the env vars in `k8s/benchmarks/vllm-benchmark-job.yaml` for each phase:

| Phase | `RESULT_LABEL` | `VLLM_EXTRA_ARGS` | `TP_SIZE` | Notes |
|-------|----------------|-------------------|-----------|-------|
| Phase 0: Vanilla vLLM | `phase0` | `""` | `1` | Baseline — no optimizations |
| Prefix Caching | `prefix-caching` | `--enable-prefix-caching --enable-chunked-prefill` | `1` | APC enabled |
| Speculative Decode | `spec-decode` | `--speculative-model /models/nvidia/Llama-3.1-8B-Instruct-FP8 --num-speculative-tokens 5` | `1` | Draft model on same GPU |
| TP=2 Baseline | `tp2-baseline` | `""` | `2` | GPU limit must also be updated to 2 |

### Estimated Duration

Each benchmark run takes approximately 45–90 minutes depending on the number of rate points and prompts per point. The default config (8 rates × 300 prompts + warm-up + cooldowns) typically runs ~60 minutes.

### After Benchmarking

Redeploy the DGD workers to resume normal serving:

```bash
make deploy-dynamo ENV=dev
```
