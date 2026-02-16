#!/usr/bin/env bash
# scripts/kv-benefit-comparison.sh — A/B comparison of KV-aware vs round-robin routing.
#
# Patches the DGD routing mode, runs kv-benefit-test.py for each mode,
# restores the original mode, and runs compare-kv-results.py on both TSVs.
#
# Usage:
#   ./scripts/kv-benefit-comparison.sh
#   ./scripts/kv-benefit-comparison.sh --levels 10,12,15,18,20,25,30 --warmup 60 --measure 300
#   ./scripts/kv-benefit-comparison.sh --skip-kv --rr-tsv dev/kv-benefit-test-roundrobin-*.tsv
#   ./scripts/kv-benefit-comparison.sh --skip-roundrobin --kv-tsv dev/kv-benefit-test-kv-*.tsv

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
CONTEXT="${KUBE_CONTEXT:-do-ams3-gtc-demo}"
NAMESPACE="dynamo-workload"
DGD_NAME="gtc-demo"
DGD_LABEL="nvidia.com/dynamo-graph-deployment-name=${DGD_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LEVELS="10,12,15,18,20,25,30"
RPS="10.0"
WARMUP=60
MEASURE=300
OUTPUT_DIR="dev"

SKIP_KV=false
SKIP_RR=false
KV_TSV=""
RR_TSV=""
COOLDOWN=30

# ── Argument parsing ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

A/B comparison of KV-aware vs round-robin routing modes.
Patches the DGD, runs kv-benefit-test.py for each mode, and compares results.

Options:
  --levels CSV        Concurrency levels (default: $LEVELS)
  --rps NUM           Target RPS (default: $RPS)
  --warmup SEC        Warmup per level (default: $WARMUP)
  --measure SEC       Measurement per level (default: $MEASURE)
  --output-dir DIR    Output directory (default: $OUTPUT_DIR)
  --skip-kv           Skip KV-mode test (use --kv-tsv for existing results)
  --skip-roundrobin   Skip round-robin test (use --rr-tsv for existing results)
  --kv-tsv FILE       Reuse existing KV-mode TSV instead of running test
  --rr-tsv FILE       Reuse existing round-robin TSV instead of running test
  --context NAME      kubectl context (default: $CONTEXT)
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --levels)          LEVELS="$2"; shift 2 ;;
    --rps)             RPS="$2"; shift 2 ;;
    --warmup)          WARMUP="$2"; shift 2 ;;
    --measure)         MEASURE="$2"; shift 2 ;;
    --output-dir)      OUTPUT_DIR="$2"; shift 2 ;;
    --skip-kv)         SKIP_KV=true; shift ;;
    --skip-roundrobin) SKIP_RR=true; shift ;;
    --kv-tsv)          KV_TSV="$2"; SKIP_KV=true; shift 2 ;;
    --rr-tsv)          RR_TSV="$2"; SKIP_RR=true; shift 2 ;;
    --context)         CONTEXT="$2"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ── Logging helpers ──────────────────────────────────────────────────────────
info() { echo "[$(date +%H:%M:%S)] INFO  $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN  $*" >&2; }
err()  { echo "[$(date +%H:%M:%S)] ERROR $*" >&2; }

# ── Routing mode helpers ────────────────────────────────────────────────────
get_routing_mode() {
  kubectl --context "$CONTEXT" get dgd "$DGD_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.services.Frontend.envs[0].value}' 2>/dev/null
}

set_routing_mode() {
  local mode="$1"
  info "Patching DGD routing mode → ${mode}"
  kubectl --context "$CONTEXT" patch dgd "$DGD_NAME" -n "$NAMESPACE" \
    --type='json' \
    -p="[{\"op\":\"replace\",\"path\":\"/spec/services/Frontend/envs/0/value\",\"value\":\"${mode}\"}]"
}

verify_frontend_mode() {
  local expected="$1" timeout="${2:-120}" interval=10 elapsed=0
  info "Waiting for frontend pod to run with DYN_ROUTER_MODE=${expected}..."

  while [[ $elapsed -lt $timeout ]]; do
    # Get the frontend pod name
    local frontend_pod
    frontend_pod=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
      -l "$DGD_LABEL" --no-headers 2>/dev/null \
      | awk '/frontend/ && /Running/ {print $1; exit}') || true

    if [[ -n "$frontend_pod" ]]; then
      local actual
      actual=$(kubectl --context "$CONTEXT" exec "$frontend_pod" -n "$NAMESPACE" \
        -- printenv DYN_ROUTER_MODE 2>/dev/null) || true
      if [[ "$actual" == "$expected" ]]; then
        info "Frontend pod ${frontend_pod} confirmed: DYN_ROUTER_MODE=${actual}"
        return 0
      fi
      info "  Frontend pod has DYN_ROUTER_MODE=${actual:-unknown}, waiting... (${elapsed}s)"
    else
      info "  No running frontend pod yet (${elapsed}s)"
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  err "Frontend pod did not reach DYN_ROUTER_MODE=${expected} within ${timeout}s"
  return 1
}

get_worker_pods() {
  kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
    -l "$DGD_LABEL" --no-headers 2>/dev/null \
    | grep -v frontend | awk '/Running/ {print $1}' | sort
}

wait_for_workers() {
  local expected_count="$1" timeout="${2:-600}" interval=15 elapsed=0
  info "Waiting for ${expected_count} worker pods to be Running (timeout: ${timeout}s)..."

  while [[ $elapsed -lt $timeout ]]; do
    local running
    running=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
      -l "$DGD_LABEL" --no-headers 2>/dev/null \
      | grep -v frontend | awk '$3 == "Running" {count++} END {print count+0}')

    if [[ "$running" -ge "$expected_count" ]]; then
      info "  ${running}/${expected_count} worker pods Running"
      return 0
    fi

    info "  ${running}/${expected_count} worker pods Running (${elapsed}s)"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  err "Only ${running:-0}/${expected_count} workers Running after ${timeout}s"
  return 1
}

# ── Cleanup / restore ────────────────────────────────────────────────────────
ORIGINAL_MODE=""
cleanup() {
  if [[ -n "$ORIGINAL_MODE" ]]; then
    info "Restoring routing mode → ${ORIGINAL_MODE}"
    set_routing_mode "$ORIGINAL_MODE" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── Pre-checks ──────────────────────────────────────────────────────────────
info "Pre-checks..."

if ! kubectl --context "$CONTEXT" cluster-info >/dev/null 2>&1; then
  err "Cannot reach cluster with context '${CONTEXT}'"
  exit 1
fi
info "  Cluster reachable"

# DGD pods
WORKER_COUNT=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "$DGD_LABEL" --no-headers 2>/dev/null \
  | grep -v frontend | awk '$3 == "Running" {count++} END {print count+0}')
FRONTEND_COUNT=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "$DGD_LABEL" --no-headers 2>/dev/null \
  | awk '/frontend/ && /Running/ {count++} END {print count+0}')

if [[ "$WORKER_COUNT" -lt 2 ]]; then
  err "Expected >=2 worker pods, found ${WORKER_COUNT}"
  kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" --no-headers
  exit 1
fi
if [[ "$FRONTEND_COUNT" -lt 1 ]]; then
  err "No frontend pod running"
  kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" --no-headers
  exit 1
fi
info "  ${FRONTEND_COUNT} frontend + ${WORKER_COUNT} worker pods running"

# Load generator
LOADGEN_PODS=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l app=loadgen --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
if [[ "$LOADGEN_PODS" -eq 0 ]]; then
  err "No load generator pod running"
  exit 1
fi
info "  Load generator pod running"

# Record original routing mode
ORIGINAL_MODE=$(get_routing_mode)
info "  Current routing mode: ${ORIGINAL_MODE}"

# Record worker pod names for comparison
WORKERS_BEFORE=$(get_worker_pods)
info "  Worker pods: $(echo "$WORKERS_BEFORE" | tr '\n' ' ')"

# ── Banner ──────────────────────────────────────────────────────────────────
NUM_LEVELS=$(echo "$LEVELS" | tr ',' '\n' | wc -l)
EST_PER_RUN=$(( NUM_LEVELS * (WARMUP + MEASURE + 10) / 60 ))
EST_TOTAL=$(( EST_PER_RUN * 2 + 3 ))

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         KV Routing A/B Comparison Test                   ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Levels:      %-42s║\n" "$LEVELS"
printf "║  Per level:   %-42s║\n" "${WARMUP}s warmup + ${MEASURE}s measure"
printf "║  Phase A:     %-42s║\n" "$(if $SKIP_KV; then echo "SKIP (using $KV_TSV)"; else echo "KV-aware routing"; fi)"
printf "║  Phase B:     %-42s║\n" "$(if $SKIP_RR; then echo "SKIP (using $RR_TSV)"; else echo "Round-robin baseline"; fi)"
printf "║  Estimated:   %-42s║\n" "~${EST_TOTAL} min total"
printf "║  Output:      %-42s║\n" "$OUTPUT_DIR/"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

mkdir -p "$OUTPUT_DIR"

# ── Phase A: KV-aware routing ───────────────────────────────────────────────
if ! $SKIP_KV; then
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  Phase A: KV-aware routing test"
  echo "═══════════════════════════════════════════════════════════"

  # Ensure we're in KV mode
  current=$(get_routing_mode)
  if [[ "$current" != "kv" ]]; then
    set_routing_mode "kv"
    verify_frontend_mode "kv" 120
  else
    info "Already in KV mode"
  fi

  info "Running kv-benefit-test.py --label kv ..."
  python3 "${SCRIPT_DIR}/kv-benefit-test.py" \
    --levels "$LEVELS" \
    --rps "$RPS" \
    --warmup "$WARMUP" \
    --measure "$MEASURE" \
    --output-dir "$OUTPUT_DIR" \
    --label kv

  # Find the output file (most recent kv-benefit-test-kv-*.tsv)
  KV_TSV=$(ls -t "${OUTPUT_DIR}"/kv-benefit-test-kv-*.tsv 2>/dev/null | head -1)
  if [[ -z "$KV_TSV" ]]; then
    err "KV test completed but no output TSV found"
    exit 1
  fi
  info "Phase A complete: ${KV_TSV}"
else
  if [[ -z "$KV_TSV" ]]; then
    err "--skip-kv requires --kv-tsv FILE"
    exit 1
  fi
  if [[ ! -f "$KV_TSV" ]]; then
    err "KV TSV file not found: ${KV_TSV}"
    exit 1
  fi
  info "Skipping Phase A, using: ${KV_TSV}"
fi

# ── Cooldown ────────────────────────────────────────────────────────────────
if ! $SKIP_KV && ! $SKIP_RR; then
  info "Cooldown (${COOLDOWN}s) between phases..."
  sleep "$COOLDOWN"
fi

# ── Phase B: Round-robin routing ────────────────────────────────────────────
if ! $SKIP_RR; then
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  Phase B: Round-robin routing test"
  echo "═══════════════════════════════════════════════════════════"

  # Switch to round-robin
  set_routing_mode "round_robin"

  # Wait for frontend pod to restart with new mode
  verify_frontend_mode "round_robin" 180

  # Check if workers survived the patch
  WORKERS_AFTER=$(get_worker_pods)
  if [[ "$WORKERS_BEFORE" != "$WORKERS_AFTER" ]]; then
    warn "Worker pods changed after Frontend patch!"
    warn "  Before: $(echo "$WORKERS_BEFORE" | tr '\n' ' ')"
    warn "  After:  $(echo "$WORKERS_AFTER" | tr '\n' ' ')"
    warn "Waiting for workers to reload model (~10 min)..."
    wait_for_workers "$WORKER_COUNT" 900

    # Wait extra for model to load after pods are Running
    info "Workers running — waiting 120s for model initialization..."
    sleep 120
  else
    info "Worker pods unchanged (as expected for Frontend-only patch)"
    # Small settle time after frontend restart
    sleep 10
  fi

  info "Running kv-benefit-test.py --label roundrobin ..."
  python3 "${SCRIPT_DIR}/kv-benefit-test.py" \
    --levels "$LEVELS" \
    --rps "$RPS" \
    --warmup "$WARMUP" \
    --measure "$MEASURE" \
    --output-dir "$OUTPUT_DIR" \
    --label roundrobin

  # Find the output file
  RR_TSV=$(ls -t "${OUTPUT_DIR}"/kv-benefit-test-roundrobin-*.tsv 2>/dev/null | head -1)
  if [[ -z "$RR_TSV" ]]; then
    err "Round-robin test completed but no output TSV found"
    exit 1
  fi
  info "Phase B complete: ${RR_TSV}"
else
  if [[ -z "$RR_TSV" ]]; then
    err "--skip-roundrobin requires --rr-tsv FILE"
    exit 1
  fi
  if [[ ! -f "$RR_TSV" ]]; then
    err "Round-robin TSV file not found: ${RR_TSV}"
    exit 1
  fi
  info "Skipping Phase B, using: ${RR_TSV}"
fi

# ── Restore original mode ──────────────────────────────────────────────────
if [[ "$(get_routing_mode)" != "$ORIGINAL_MODE" ]]; then
  info "Restoring routing mode → ${ORIGINAL_MODE}"
  set_routing_mode "$ORIGINAL_MODE"
  verify_frontend_mode "$ORIGINAL_MODE" 120
fi
# Clear so trap doesn't double-restore
ORIGINAL_MODE=""

# ── Comparison ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Comparison"
echo "═══════════════════════════════════════════════════════════"

python3 "${SCRIPT_DIR}/compare-kv-results.py" \
  --kv "$KV_TSV" \
  --rr "$RR_TSV" \
  --output-dir "$OUTPUT_DIR"

echo ""
info "A/B comparison complete."
info "  KV results:         ${KV_TSV}"
info "  Round-robin results: ${RR_TSV}"
info "  Comparison:          ${OUTPUT_DIR}/kv-comparison-*.tsv"
