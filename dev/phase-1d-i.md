# Phase 1d-i: Model Storage Pipeline

## Context

Phases 1a-1c are complete. DOKS cluster running in nyc2 with 3x H100 GPU nodes + 2 mgmt nodes. Platform stack deployed (Dynamo CRDs + Platform with Grove + KAI, Prometheus, Grafana, KEDA, dcgm-exporter). Namespaces, secrets, NFS PV all exist.

This phase builds the model download pipeline: HuggingFace -> DO Spaces -> NFS. The model must be on NFS before Phase 1d-ii can deploy the DGD.

**Cluster:** kubectl context `do-nyc2-gtc-demo`, namespace `dynamo-workload`
**Model:** `meta-llama/Llama-3.1-8B-Instruct` (dev)
**Spaces bucket:** `do-gtc2026-doks-demo` in `atl1`
**Existing secrets in dynamo-workload:** `hf-token` (key: HF_TOKEN), `spaces-credentials` (keys: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
**NFS PV:** `model-nfs-pv` (terraform-managed, storageClass `nfs-static`)
**NFS PVC manifest:** `k8s/storage/model-nfs-pvc.yaml` (exists, may need applying)

## Files to Create/Modify

| File | Action |
|------|--------|
| `k8s/jobs/model-upload-spaces.yaml` | Create — Job: HuggingFace -> Spaces |
| `k8s/jobs/model-download-nfs.yaml` | Create — Job: Spaces -> NFS |
| `scripts/setup-model.sh` | Create — Orchestrates both jobs |
| `Makefile` | Edit — Add MODEL/CONTEXT vars, implement model-to-spaces, model-to-nfs, setup-model |

## Step 1: Fix NFS PVC Binding

1. Check PV status: `kubectl get pv model-nfs-pv`
2. If status is `Released`, clear stale claimRef:
   ```
   kubectl patch pv model-nfs-pv --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'
   ```
3. Apply PVC: `kubectl apply -f k8s/storage/model-nfs-pvc.yaml`
4. Verify PVC shows `Bound` to `model-nfs-pv`

## Step 2: Create `k8s/jobs/model-upload-spaces.yaml`

K8s Job manifest with these specs:
- Namespace: `dynamo-workload`
- Image: `python:3.11-slim`
- `${MODEL}` and `${MODEL_SLUG}` are envsubst placeholders (templated at apply time)
- Job name: `model-upload-spaces-${MODEL_SLUG}`
- Container script:
  1. `pip install huggingface-hub awscli`
  2. Check idempotency: `aws s3api head-object` for `.upload-complete` sentinel in `s3://do-gtc2026-doks-demo/models/${MODEL}/`
  3. If not found: `huggingface-cli download ${MODEL}` to `/tmp/model`
  4. `aws s3 sync /tmp/model s3://do-gtc2026-doks-demo/models/${MODEL}/`
  5. Write `.upload-complete` sentinel
- `envFrom` referencing secrets: `hf-token` and `spaces-credentials`
- Env var: `ENDPOINT=https://atl1.digitaloceanspaces.com`, `AWS_DEFAULT_REGION=atl1`
- No GPU toleration (schedules on mgmt nodes, which have no GPU taint)
- Resources: requests cpu 1 memory 2Gi, limits cpu 2 memory 3Gi (mgmt nodes are s-2vcpu-4gb)
- `backoffLimit: 3`, `ttlSecondsAfterFinished: 3600`
- `restartPolicy: Never`

## Step 3: Create `k8s/jobs/model-download-nfs.yaml`

Same pattern as upload job but simpler:
- Job name: `model-download-nfs-${MODEL_SLUG}`
- Only `spaces-credentials` secret (no HF token needed)
- Mounts `model-nfs-pvc` at `/models`
- Script: check `.download-complete` sentinel on NFS, if not found: `aws s3 sync` from Spaces to `/models/${MODEL}/`, write sentinel
- Resources: requests cpu 1 memory 1Gi, limits cpu 2 memory 2Gi

## Step 4: Create `scripts/setup-model.sh`

```
#!/usr/bin/env bash
set -euo pipefail
```

- `MODEL` env var (default: `meta-llama/Llama-3.1-8B-Instruct`)
- `MODEL_SLUG` = `echo "${MODEL}" | tr '/' '--'`
- `CONTEXT` = `${KUBE_CONTEXT:-do-nyc2-gtc-demo}`
- `NAMESPACE` = `dynamo-workload`
- `TIMEOUT` = `${MODEL_TIMEOUT:-1800}` (30 min per job)
- For each job:
  1. Delete previous: `kubectl delete job ${JOB_NAME} -n ${NAMESPACE} --ignore-not-found=true`
  2. Template and apply: `envsubst '${MODEL} ${MODEL_SLUG}' < manifest.yaml | kubectl apply -f -`
  3. Wait: `kubectl wait --for=condition=complete --timeout=${TIMEOUT}s job/${JOB_NAME} -n ${NAMESPACE}`
- Run Job 1 (upload) then Job 2 (download) sequentially
- Make executable: `chmod +x scripts/setup-model.sh`

## Step 5: Update Makefile

Add after line 11 (after `TF_VARS`):
```makefile
MODEL   ?= meta-llama/Llama-3.1-8B-Instruct
MODEL_SLUG = $(subst /,--,$(MODEL))
CONTEXT ?= do-nyc2-gtc-demo
```

Replace the three TODO stubs for model targets:
- **`model-to-spaces`**: delete prev job, envsubst + apply, kubectl wait
- **`model-to-nfs`**: delete prev job, envsubst + apply, kubectl wait
- **`setup-model`**: `MODEL=$(MODEL) scripts/setup-model.sh`

## Step 6: Execute & Validate

1. Source env: `source ~/env/gtc.env`
2. Run: `make setup-model` (~20-40 min for 8B model)
3. Verify model on NFS:
   ```
   kubectl run nfs-check --rm -it --restart=Never --image=busybox:1.36 \
     -n dynamo-workload \
     --overrides='{"spec":{"volumes":[{"name":"nfs","persistentVolumeClaim":{"claimName":"model-nfs-pvc"}}],"containers":[{"name":"c","image":"busybox:1.36","command":["ls","-la","/models/meta-llama/Llama-3.1-8B-Instruct/"],"volumeMounts":[{"name":"nfs","mountPath":"/models"}],"resources":{"limits":{"memory":"16Mi"}}}]}}'
   ```

**Checkpoint — all must pass:**
- [ ] PVC `model-nfs-pvc` is `Bound` to `model-nfs-pv`
- [ ] Model files exist on NFS at `/models/meta-llama/Llama-3.1-8B-Instruct/`
- [ ] Both jobs completed successfully
