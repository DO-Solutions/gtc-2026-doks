#!/usr/bin/env bash
# Wait for GPU nodes to be Ready in the DOKS cluster.
# Usage: scripts/wait-for-gpu.sh [EXPECTED_COUNT] [TIMEOUT_SECONDS]

set -euo pipefail

EXPECTED_COUNT="${1:-3}"
TIMEOUT="${2:-900}"
INTERVAL=15
LABEL="doks.digitalocean.com/gpu-brand=nvidia"

elapsed=0
echo "Waiting for ${EXPECTED_COUNT} GPU node(s) with label ${LABEL} to be Ready (timeout: ${TIMEOUT}s)..."

while true; do
  ready_count=$(kubectl get nodes -l "${LABEL}" --no-headers 2>/dev/null \
    | awk '$2 == "Ready" { count++ } END { print count+0 }')

  echo "[${elapsed}s] GPU nodes Ready: ${ready_count}/${EXPECTED_COUNT}"

  if [[ "${ready_count}" -ge "${EXPECTED_COUNT}" ]]; then
    echo "All ${EXPECTED_COUNT} GPU node(s) are Ready."
    kubectl get nodes -l "${LABEL}" -o wide
    exit 0
  fi

  if [[ "${elapsed}" -ge "${TIMEOUT}" ]]; then
    echo "ERROR: Timed out after ${TIMEOUT}s waiting for GPU nodes."
    echo "Current node status:"
    kubectl get nodes -l "${LABEL}" -o wide 2>/dev/null || echo "  (no GPU nodes found)"
    exit 1
  fi

  sleep "${INTERVAL}"
  elapsed=$((elapsed + INTERVAL))
done
