#!/usr/bin/env bash
set -euo pipefail

MODEL="${MODEL:-meta-llama/Llama-3.1-8B-Instruct}"
MODEL_SLUG="$(echo "${MODEL}" | tr '/' '--' | tr '[:upper:]' '[:lower:]')"
CONTEXT="${KUBE_CONTEXT:-do-nyc2-gtc-demo}"
NAMESPACE="dynamo-workload"
TIMEOUT="${MODEL_TIMEOUT:-1800}"

export MODEL MODEL_SLUG

echo "=== Model Storage Pipeline ==="
echo "Model:     ${MODEL}"
echo "Slug:      ${MODEL_SLUG}"
echo "Context:   ${CONTEXT}"
echo "Namespace: ${NAMESPACE}"
echo "Timeout:   ${TIMEOUT}s per job"
echo ""

# --- Job 1: HuggingFace -> Spaces ---
JOB_NAME="model-upload-spaces-${MODEL_SLUG}"
echo ">>> Step 1: Upload model to Spaces (${JOB_NAME})"

kubectl --context "${CONTEXT}" delete job "${JOB_NAME}" \
  -n "${NAMESPACE}" --ignore-not-found=true

envsubst '${MODEL} ${MODEL_SLUG}' \
  < k8s/jobs/model-upload-spaces.yaml \
  | kubectl --context "${CONTEXT}" apply -f -

echo "Waiting for upload job to complete (timeout: ${TIMEOUT}s)..."
kubectl --context "${CONTEXT}" wait \
  --for=condition=complete \
  --timeout="${TIMEOUT}s" \
  "job/${JOB_NAME}" -n "${NAMESPACE}"

echo "Upload job completed successfully."
echo ""

# --- Job 2: Spaces -> NFS ---
JOB_NAME="model-download-nfs-${MODEL_SLUG}"
echo ">>> Step 2: Download model to NFS (${JOB_NAME})"

kubectl --context "${CONTEXT}" delete job "${JOB_NAME}" \
  -n "${NAMESPACE}" --ignore-not-found=true

envsubst '${MODEL} ${MODEL_SLUG}' \
  < k8s/jobs/model-download-nfs.yaml \
  | kubectl --context "${CONTEXT}" apply -f -

echo "Waiting for download job to complete (timeout: ${TIMEOUT}s)..."
kubectl --context "${CONTEXT}" wait \
  --for=condition=complete \
  --timeout="${TIMEOUT}s" \
  "job/${JOB_NAME}" -n "${NAMESPACE}"

echo "Download job completed successfully."
echo ""
echo "=== Model Storage Pipeline Complete ==="
