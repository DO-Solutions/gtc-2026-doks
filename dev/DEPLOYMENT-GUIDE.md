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
