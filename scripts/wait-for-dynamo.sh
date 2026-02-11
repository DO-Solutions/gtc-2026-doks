#!/usr/bin/env bash
set -euo pipefail

TIMEOUT="${1:-600}"
INTERVAL=15
NAMESPACE="dynamo-workload"
LABEL="nvidia.com/dynamo-graph-deployment=gtc-demo"
EXPECTED=3

elapsed=0

echo "Waiting for ${EXPECTED} DGD pods to be Running (timeout: ${TIMEOUT}s)..."

while [ "$elapsed" -lt "$TIMEOUT" ]; do
  running=$(kubectl get pods -n "$NAMESPACE" -l "$LABEL" --no-headers 2>/dev/null \
    | awk '$3 == "Running" {count++} END {print count+0}')

  echo "[${elapsed}s] ${running}/${EXPECTED} pods Running"

  if [ "$running" -ge "$EXPECTED" ]; then
    echo ""
    echo "All ${EXPECTED} DGD pods are Running!"
    echo ""
    echo "--- DGDSA Status ---"
    kubectl get dgdsa -n "$NAMESPACE" 2>/dev/null || echo "(no DGDSA resources found)"
    echo ""
    echo "--- Pod Status ---"
    kubectl get pods -n "$NAMESPACE" -l "$LABEL" -o wide
    exit 0
  fi

  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

echo ""
echo "TIMEOUT: Only ${running}/${EXPECTED} pods Running after ${TIMEOUT}s"
echo ""
echo "--- Pod Status ---"
kubectl get pods -n "$NAMESPACE" -l "$LABEL" -o wide
echo ""
echo "--- Pod Logs (last 20 lines each) ---"
for pod in $(kubectl get pods -n "$NAMESPACE" -l "$LABEL" --no-headers -o custom-columns=NAME:.metadata.name); do
  echo ""
  echo "=== ${pod} ==="
  kubectl logs "$pod" -n "$NAMESPACE" --tail=20 2>/dev/null || echo "(no logs available)"
done
exit 1
