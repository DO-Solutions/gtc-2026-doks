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
