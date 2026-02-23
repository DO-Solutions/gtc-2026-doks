#!/usr/bin/env bash
set -euo pipefail

# validate-nvlink.sh — Post-deployment NVLink validation for disaggregated serving
# Checks pod readiness, co-location, inference, NVLink counters, and UCX transport selection.
#
# Usage: scripts/validate-nvlink.sh [--label "Test description"]

LABEL_TEXT="(no label)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL_TEXT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

CONTEXT="${KUBE_CONTEXT:-do-nyc2-gtc-demo}"
NAMESPACE="dynamo-workload"
DGD_LABEL="nvidia.com/dynamo-graph-deployment-name=gtc-demo"
TIMEOUT=600
INTERVAL=15

echo "============================================"
echo "NVLink Validation: ${LABEL_TEXT}"
echo "============================================"
echo ""

# --- 1. Wait for all 3 DGD pods Running/Ready ---
echo "[1/5] Waiting for 3 DGD pods to be Running (timeout: ${TIMEOUT}s)..."
elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  running=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" --no-headers 2>/dev/null \
    | awk '$3 == "Running" {count++} END {print count+0}')
  if [ "$running" -ge 3 ]; then
    echo "  All 3 pods Running after ${elapsed}s"
    break
  fi
  echo "  [${elapsed}s] ${running}/3 Running..."
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

if [ "$running" -lt 3 ]; then
  echo "  FAIL: Only ${running}/3 pods Running after ${TIMEOUT}s"
  kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" -o wide
  echo ""
  echo "--- Recent logs from non-Running pods ---"
  for pod in $(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" --no-headers \
    | awk '$3 != "Running" {print $1}'); do
    echo "=== ${pod} ==="
    kubectl --context "$CONTEXT" logs "$pod" -n "$NAMESPACE" --tail=30 2>/dev/null || echo "(no logs)"
  done
  exit 1
fi

kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" -o wide
echo ""

# --- 2. Confirm workers on same node ---
echo "[2/5] Checking worker co-location..."
PREFILL_NODE=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "${DGD_LABEL},nvidia.com/dynamo-component-type=worker,nvidia.com/dynamo-sub-component-type=prefill" \
  -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || echo "")
DECODE_NODE=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "${DGD_LABEL},nvidia.com/dynamo-component-type=worker,nvidia.com/dynamo-sub-component-type=decode" \
  -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || echo "")

if [ -z "$PREFILL_NODE" ] || [ -z "$DECODE_NODE" ]; then
  echo "  WARN: Could not determine worker nodes (prefill=${PREFILL_NODE:-?}, decode=${DECODE_NODE:-?})"
elif [ "$PREFILL_NODE" = "$DECODE_NODE" ]; then
  echo "  OK: Both workers on node ${PREFILL_NODE}"
else
  echo "  WARN: Workers on different nodes (prefill=${PREFILL_NODE}, decode=${DECODE_NODE})"
  echo "  NVLink requires same-node co-location."
fi
GPU_NODE="${PREFILL_NODE:-$DECODE_NODE}"
echo ""

# --- 3. Run inference test ---
echo "[3/5] Running inference test..."
FRONTEND_POD=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "${DGD_LABEL},nvidia.com/dynamo-component-type=frontend" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [ -z "$FRONTEND_POD" ]; then
  echo "  FAIL: No frontend pod found"
  INFERENCE_OK=false
else
  # Find a free local port
  LOCAL_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
  kubectl --context "$CONTEXT" port-forward "pod/${FRONTEND_POD}" "${LOCAL_PORT}:8000" -n "$NAMESPACE" &
  PF_PID=$!
  sleep 3

  INFERENCE_RESULT=$(curl -s --max-time 120 "http://localhost:${LOCAL_PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"/models/nvidia/Llama-3.1-8B-Instruct-FP8","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":50,"stream":false}' 2>&1 || echo "CURL_FAILED")

  kill "$PF_PID" 2>/dev/null; wait "$PF_PID" 2>/dev/null || true

  if echo "$INFERENCE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null; then
    echo "  OK: Inference succeeded"
    INFERENCE_OK=true
  else
    echo "  FAIL: Inference failed"
    echo "  Response: ${INFERENCE_RESULT:0:500}"
    INFERENCE_OK=false
  fi
fi
echo ""

# --- 4. Check NVLink counters ---
echo "[4/5] Checking NVLink counters on ${GPU_NODE:-unknown}..."
NVLINK_OUTPUT=""
if [ -n "$GPU_NODE" ]; then
  # Use a debug pod to run nvidia-smi on the GPU node
  NVLINK_OUTPUT=$(kubectl --context "$CONTEXT" debug "node/${GPU_NODE}" -n "$NAMESPACE" \
    --image=nvcr.io/nvidia/cuda:12.8.0-base-ubuntu22.04 \
    -it --quiet \
    -- nvidia-smi nvlink -gt d 2>&1 || echo "NVLINK_CHECK_FAILED")

  # Extract TX/RX totals — look for non-zero data counters
  if echo "$NVLINK_OUTPUT" | grep -qiE "nvlink_check_failed|error|not found"; then
    echo "  WARN: nvidia-smi nvlink command failed or unavailable"
    echo "  Output: ${NVLINK_OUTPUT:0:300}"
    NVLINK_NONZERO=false
  else
    # Check for any non-zero data throughput values
    NONZERO_LINES=$(echo "$NVLINK_OUTPUT" | grep -E "Data Tx|Data Rx" | grep -v " 0 " | grep -v ": 0$" | head -10 || true)
    if [ -n "$NONZERO_LINES" ]; then
      echo "  NVLink traffic DETECTED:"
      echo "$NONZERO_LINES" | sed 's/^/    /'
      NVLINK_NONZERO=true
    else
      echo "  No NVLink data traffic detected (all counters zero)"
      NVLINK_NONZERO=false
    fi
  fi
else
  echo "  SKIP: No GPU node identified"
  NVLINK_NONZERO=false
fi
echo ""

# --- 5. UCX transport logs ---
echo "[5/5] Extracting UCX transport logs..."

PREFILL_POD=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "${DGD_LABEL},nvidia.com/dynamo-component-type=worker,nvidia.com/dynamo-sub-component-type=prefill" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
DECODE_POD=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "${DGD_LABEL},nvidia.com/dynamo-component-type=worker,nvidia.com/dynamo-sub-component-type=decode" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

UCX_PREFILL=""
UCX_DECODE=""

if [ -n "$PREFILL_POD" ]; then
  echo "  --- Prefill (${PREFILL_POD}) ---"
  UCX_PREFILL=$(kubectl --context "$CONTEXT" logs "$PREFILL_POD" -n "$NAMESPACE" 2>/dev/null \
    | grep -iE "ucx|cuda_ipc|rma|transport|zcopy|nixl|cache_transceiver|nvlink" | tail -30 || echo "(no UCX lines)")
  echo "$UCX_PREFILL" | sed 's/^/    /'
fi
echo ""

if [ -n "$DECODE_POD" ]; then
  echo "  --- Decode (${DECODE_POD}) ---"
  UCX_DECODE=$(kubectl --context "$CONTEXT" logs "$DECODE_POD" -n "$NAMESPACE" 2>/dev/null \
    | grep -iE "ucx|cuda_ipc|rma|transport|zcopy|nixl|cache_transceiver|nvlink" | tail -30 || echo "(no UCX lines)")
  echo "$UCX_DECODE" | sed 's/^/    /'
fi
echo ""

# --- Summary ---
echo "============================================"
echo "SUMMARY: ${LABEL_TEXT}"
echo "============================================"
echo "  Pods Running:     3/3"
echo "  Co-located:       ${PREFILL_NODE:-?} == ${DECODE_NODE:-?}"
echo "  Inference:        ${INFERENCE_OK}"
echo "  NVLink traffic:   ${NVLINK_NONZERO}"

if [ "$NVLINK_NONZERO" = true ] && [ "$INFERENCE_OK" = true ]; then
  echo ""
  echo "  RESULT: PASS — NVLink traffic detected with successful inference"
elif [ "$INFERENCE_OK" = true ]; then
  echo ""
  echo "  RESULT: PARTIAL — Inference works but no NVLink traffic (KV transfers still on TCP)"
else
  echo ""
  echo "  RESULT: FAIL — Inference failed"
fi
echo "============================================"
