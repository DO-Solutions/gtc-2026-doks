# Phase 1d-ii: DGD Deployment

## Context

Phase 1d-i is complete. Model files for `meta-llama/Llama-3.1-8B-Instruct` are on NFS (mounted via `model-nfs-pvc` in `dynamo-workload` namespace). The platform stack is running: Dynamo CRDs + Platform (Grove + KAI, operator disabled), Prometheus, Grafana, KEDA, dcgm-exporter.

This phase deploys the DynamoGraphDeployment CR for disaggregated TensorRT-LLM inference with 1 prefill + 1 decode worker on separate H100 GPUs.

**Cluster:** kubectl context `do-nyc2-gtc-demo`
**Namespace:** `dynamo-workload`
**GPU nodes:** 3x `gpu-h100x1-80gb`, label `doks.digitalocean.com/gpu-brand=nvidia`, taint `nvidia.com/gpu:NoSchedule`
**Mgmt nodes:** 2x `s-2vcpu-4gb`
**RuntimeClass:** `nvidia` (exists)
**Model path on NFS:** `/models/meta-llama/Llama-3.1-8B-Instruct`
**DGD CRD:** `nvidia.com/v1alpha1` DynamoGraphDeployment (installed via dynamo-crds helm chart)

### DGD CRD Key Schema (from extracted CRD)
- `spec.backendFramework`: string (`trtllm`)
- `spec.pvcs`: array of `{name: pvc-name}` — registered PVCs
- `spec.envs`: array of `{name, value}` — global env vars
- `spec.services`: map of service-name -> service-spec:
  - `dynamoNamespace`, `componentType`, `subComponentType`, `replicas`
  - `scalingAdapter.enabled` — auto-creates DGDSA
  - `envFromSecret` — K8s secret name for env vars
  - `volumeMounts[].{name, mountPoint}` — DGD-level PVC mounts
  - `resources.limits.gpu` — GPU count
  - `labels`, `annotations`
  - `envs` — service-level env vars
  - `extraPodSpec.tolerations`, `extraPodSpec.volumes`
  - `extraPodSpec.mainContainer.{image, args, command, volumeMounts, resources}`

## Files to Create/Modify

| File | Action |
|------|--------|
| `k8s/dynamo/engine-configs/dev/prefill.yaml` | Create — TRT-LLM engine config |
| `k8s/dynamo/engine-configs/dev/decode.yaml` | Create — TRT-LLM engine config |
| `k8s/dynamo/engine-configmap-dev.yaml` | Create — ConfigMap wrapping both configs |
| `k8s/dynamo/dev-disagg.yaml` | Create — DGD CR |
| `scripts/wait-for-dynamo.sh` | Create — Polls until pods ready |
| `Makefile` | Edit — Implement deploy-dynamo, test-inference, demo-status |

## Step 1: Create Engine Configs

### `k8s/dynamo/engine-configs/dev/prefill.yaml`
TRT-LLM PyTorch backend config for 8B prefill on H100:
```yaml
tensor_parallel_size: 1
moe_expert_parallel_size: 1
enable_attention_dp: false
max_num_tokens: 8192
max_batch_size: 16
trust_remote_code: true
backend: pytorch
enable_chunked_prefill: true
disable_overlap_scheduler: true
kv_cache_config:
  free_gpu_memory_fraction: 0.85
cuda_graph_config:
  max_batch_size: 16
cache_transceiver_config:
  backend: DEFAULT
```

### `k8s/dynamo/engine-configs/dev/decode.yaml`
Same as prefill except:
- `max_batch_size: 64` (decode handles many concurrent sequences)
- `disable_overlap_scheduler: false` (overlap scheduling benefits decode)
- `cuda_graph_config.max_batch_size: 64`

### `k8s/dynamo/engine-configmap-dev.yaml`
ConfigMap `trtllm-engine-configs` in namespace `dynamo-workload`. Data keys: `prefill.yaml` and `decode.yaml` containing the above configs inline. Mounted into worker pods at `/engine-configs/`.

## Step 2: Create DGD CR `k8s/dynamo/dev-disagg.yaml`

```yaml
apiVersion: nvidia.com/v1alpha1
kind: DynamoGraphDeployment
metadata:
  name: gtc-demo
  namespace: dynamo-workload
spec:
  backendFramework: trtllm
  pvcs:
    - name: model-nfs-pvc
  envs:
    - name: HF_HOME
      value: "/models"
  services:
    Frontend:
      dynamoNamespace: gtc-demo
      componentType: frontend
      replicas: 1
      volumeMounts:
        - name: model-nfs-pvc
          mountPoint: /models
      extraPodSpec:
        mainContainer:
          image: nvcr.io/nvidia/ai-dynamo/dynamo-frontend:0.8.1
      envs:
        - name: DYN_ROUTER_MODE
          value: kv

    TrtllmPrefillWorker:
      dynamoNamespace: gtc-demo
      componentType: worker
      subComponentType: prefill
      replicas: 1
      scalingAdapter:
        enabled: true          # creates DGDSA: gtc-demo-trtllmprefillworker
      envFromSecret: hf-token
      volumeMounts:
        - name: model-nfs-pvc
          mountPoint: /models
      resources:
        limits:
          gpu: "1"
      labels:
        kai.scheduler/queue: default-queue
      extraPodSpec:
        tolerations:
          - key: nvidia.com/gpu
            operator: Exists
            effect: NoSchedule
        volumes:
          - name: engine-configs
            configMap:
              name: trtllm-engine-configs
        mainContainer:
          image: nvcr.io/nvidia/ai-dynamo/tensorrtllm-runtime:0.8.1
          args:
            - --model-path
            - /models/meta-llama/Llama-3.1-8B-Instruct
            - --served-model-name
            - meta-llama/Llama-3.1-8B-Instruct
            - --extra-engine-args
            - /engine-configs/prefill.yaml
            - --disaggregation-mode
            - prefill
            - --publish-events-and-metrics
          volumeMounts:
            - name: engine-configs
              mountPath: /engine-configs
              readOnly: true

    TrtllmDecodeWorker:
      dynamoNamespace: gtc-demo
      componentType: worker
      subComponentType: decode
      replicas: 1
      scalingAdapter:
        enabled: true          # creates DGDSA: gtc-demo-trtllmdecodeworker
      envFromSecret: hf-token
      volumeMounts:
        - name: model-nfs-pvc
          mountPoint: /models
      resources:
        limits:
          gpu: "1"
      labels:
        kai.scheduler/queue: default-queue
      extraPodSpec:
        tolerations:
          - key: nvidia.com/gpu
            operator: Exists
            effect: NoSchedule
        volumes:
          - name: engine-configs
            configMap:
              name: trtllm-engine-configs
        mainContainer:
          image: nvcr.io/nvidia/ai-dynamo/tensorrtllm-runtime:0.8.1
          args:
            - --model-path
            - /models/meta-llama/Llama-3.1-8B-Instruct
            - --served-model-name
            - meta-llama/Llama-3.1-8B-Instruct
            - --extra-engine-args
            - /engine-configs/decode.yaml
            - --disaggregation-mode
            - decode
            - --publish-events-and-metrics
          volumeMounts:
            - name: engine-configs
              mountPath: /engine-configs
              readOnly: true
```

**Key design points:**
- `pvcs` + `volumeMounts[].mountPoint` = DGD-level PVC mounting (NFS for all services)
- `extraPodSpec.volumes` + `extraPodSpec.mainContainer.volumeMounts` = ConfigMap mount for engine configs
- `scalingAdapter.enabled: true` on workers auto-creates DGDSA resources
- GPU tolerations on workers only; Frontend runs on mgmt nodes
- `DYN_ROUTER_MODE: kv` enables KV-aware routing for cache hit demos
- `dynamoNamespace: gtc-demo` -> metric label `dynamo_namespace=dynamo-workload-gtc-demo`

## Step 3: Create `scripts/wait-for-dynamo.sh`

- Polls `kubectl get pods -l nvidia.com/dynamo-graph-deployment=gtc-demo -n dynamo-workload`
- Counts pods in `Running` state
- Waits until 3 pods Running (frontend + prefill + decode)
- Default timeout: 600s (configurable via first arg), poll interval 15s
- On success: print DGDSA status
- On timeout: print pod status (-o wide) + last 20 lines of logs per pod
- Make executable: `chmod +x scripts/wait-for-dynamo.sh`

## Step 4: Update Makefile

Replace TODO stubs for these targets:

**`deploy-dynamo`:**
```
kubectl apply -f k8s/storage/model-nfs-pvc.yaml
kubectl apply -f k8s/dynamo/engine-configmap-$(ENV).yaml
kubectl apply -f k8s/dynamo/$(ENV)-disagg.yaml
scripts/wait-for-dynamo.sh
```

**`test-inference`:**
- Port-forward to Dynamo frontend service/deployment on port 8000
- curl `localhost:8000/v1/chat/completions` with a simple test message
- Note: frontend deployment name is generated by Dynamo operator — check `kubectl get deploy -n dynamo-workload` to find actual name

**`demo-status`:**
- `kubectl get nodes -o wide`
- `kubectl get dgd,dgdsa,pods,pvc -n dynamo-workload`

## Step 5: Execute & Validate

1. `make deploy-dynamo` (~5-10 min for TRT-LLM model loading from NFS)
2. `make demo-status` — verify 3 pods Running, 2 DGDSAs present
3. `make test-inference` — expect valid JSON chat completion response
4. Check Prometheus: `kubectl port-forward svc/kube-prometheus-stack-prometheus 9090:9090 -n monitoring`, then query `dynamo_frontend_requests_total`

**Validation checklist:**
- [ ] `kubectl get dgd gtc-demo -n dynamo-workload` exists
- [ ] `kubectl get dgdsa -n dynamo-workload` shows `gtc-demo-trtllmprefillworker` and `gtc-demo-trtllmdecodeworker`
- [ ] 3 pods Running in dynamo-workload (frontend + prefill + decode)
- [ ] `test-inference` returns valid chat completion JSON
- [ ] `dynamo_frontend_requests_total` metric visible in Prometheus

**Potential issues:**
- Frontend Deployment name from operator may differ from expected -> check `kubectl get deploy -n dynamo-workload` and adjust port-forward target
- Engine config values are starting points for 8B on H100 -> may need tuning if workers OOM
- TRT-LLM model loading from NFS is slow on first start (~5min) -> wait-for-dynamo.sh timeout should be generous
- If DGDSA resources don't appear, check that `scalingAdapter.enabled: true` is set and the Dynamo operator pod is healthy in `dynamo-system`
