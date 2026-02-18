#!/usr/bin/env bash
# scripts/benchmark-sweep.sh — A/B benchmark of KV-aware vs round-robin routing.
#
# Runs 5 concurrency levels under both routing modes, collects Prometheus
# TTFT metrics (loadgen_ttft_all_seconds Summary), and writes a TSV file.
#
# Usage:
#   ./scripts/benchmark-sweep.sh [--levels 40,60,80,100,120] [--rps 10] \
#       [--warmup 60] [--measure 300] [--output-dir dev] [--context NAME] [--dry-run]

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
CONTEXT="${KUBE_CONTEXT:-do-ams3-gtc-demo}"
OUTPUT_DIR="dev"
DRY_RUN=false
MODE="both"   # both | kv | round_robin

LEVELS="40,60,80,100,120"
RPS=10
WARMUP_SEC=60
MEASURE_SEC=300
SNAPSHOT_COUNT=3       # 3 snapshots at 100s intervals covering 300s

LOADGEN_PORT=3000
PROM_PORT=9090
LOADGEN_NS="dynamo-workload"
PROM_NS="monitoring"
PROM_SVC="kube-prometheus-stack-prometheus"

NAMESPACE="dynamo-workload"
DGD_NAME="gtc-demo"
DGD_LABEL="nvidia.com/dynamo-graph-deployment-name=${DGD_NAME}"

# Prometheus label selectors
COMPONENT_NS='dynamo_namespace="dynamo-workload-gtc-demo"'

# ── Argument parsing ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

A/B benchmark of KV-aware vs round-robin routing across multiple concurrency levels.
Measures TTFT via loadgen_ttft_all_seconds Prometheus Summary.

Options:
  --levels CSV       Concurrency levels, comma-separated (default: $LEVELS)
  --rps NUM          Target RPS (default: $RPS)
  --warmup SEC       Warmup per level (default: $WARMUP_SEC)
  --measure SEC      Measurement per level (default: $MEASURE_SEC)
  --mode MODE        Run mode: both, kv, round_robin (default: $MODE)
  --output-dir DIR   Output directory (default: $OUTPUT_DIR)
  --context NAME     kubectl context (default: $CONTEXT)
  --dry-run          Print test plan without executing
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --levels)      LEVELS="$2"; shift 2 ;;
    --rps)         RPS="$2"; shift 2 ;;
    --warmup)      WARMUP_SEC="$2"; shift 2 ;;
    --measure)     MEASURE_SEC="$2"; shift 2 ;;
    --mode)        MODE="$2"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    --context)     CONTEXT="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Validate mode
if [[ "$MODE" != "both" && "$MODE" != "kv" && "$MODE" != "round_robin" ]]; then
  echo "Invalid --mode: $MODE (must be both, kv, or round_robin)"; exit 1
fi

# Parse levels into array
IFS=',' read -ra LEVEL_ARRAY <<< "$LEVELS"

SNAPSHOT_INTERVAL=$(( MEASURE_SEC / SNAPSHOT_COUNT ))

# ── Logging helpers ──────────────────────────────────────────────────────────
info() { echo "[$(date +%H:%M:%S)] INFO  $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN  $*" >&2; }
err()  { echo "[$(date +%H:%M:%S)] ERROR $*" >&2; }

# ── Cleanup / restore ────────────────────────────────────────────────────────
PIDS_TO_KILL=()
ORIGINAL_MODE=""
MODE_CHANGED=false
cleanup() {
  info "Cleaning up..."
  # Stop workload
  curl -sf -X POST "http://localhost:${LOADGEN_PORT}/api/workload/stop" \
    >/dev/null 2>&1 || true
  # Restore to kv mode (only if we changed it)
  if $MODE_CHANGED; then
    info "Restoring routing mode → kv"
    set_routing_mode "kv" 2>/dev/null || true
  fi
  # Kill port-forwards
  for pid in "${PIDS_TO_KILL[@]}"; do
    kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
  done
  info "Done."
}
trap cleanup EXIT INT TERM

# ── Port-forward helper ──────────────────────────────────────────────────────
start_port_forward() {
  local svc="$1" lport="$2" rport="$3" ns="$4" label="$5" health="$6"

  if curl -sf -o /dev/null --max-time 2 "http://localhost:${lport}${health}" 2>/dev/null; then
    info "${label}: already listening on localhost:${lport}"
    return 0
  fi

  info "Starting port-forward: ${label} → localhost:${lport}"
  kubectl --context "$CONTEXT" port-forward "svc/${svc}" "${lport}:${rport}" \
    -n "$ns" >/dev/null 2>&1 &
  PIDS_TO_KILL+=($!)

  local tries=0
  while ! curl -sf -o /dev/null --max-time 2 "http://localhost:${lport}${health}" 2>/dev/null; do
    sleep 1
    tries=$((tries + 1))
    if [[ $tries -ge 20 ]]; then
      err "${label}: port-forward failed after 20s"
      return 1
    fi
  done
  info "${label}: ready"
}

# ── Prometheus instant query ──────────────────────────────────────────────────
prom_query() {
  local query="$1"
  local raw
  raw=$(curl -sf --max-time 10 \
    "http://localhost:${PROM_PORT}/api/v1/query" \
    --data-urlencode "query=${query}" 2>/dev/null) || { echo "NaN"; return; }

  python3 -c "
import sys, json, math
try:
    d = json.load(sys.stdin)
    if d['status'] != 'success' or not d['data']['result']:
        print('NaN')
    else:
        v = float(d['data']['result'][0]['value'][1])
        print('NaN' if (math.isnan(v) or math.isinf(v)) else f'{v:.6f}')
except Exception:
    print('NaN')
" <<< "$raw"
}

# ── Collect metrics (pipe-delimited) ──────────────────────────────────────────
# Output: ttft_p50|ttft_p95|kv_hit_rate|error_pct|actual_rps|tops
collect_metrics() {
  local t50 t95 kh er ar tops

  t50=$(prom_query 'loadgen_ttft_all_seconds{quantile="0.5"}')
  t95=$(prom_query 'loadgen_ttft_all_seconds{quantile="0.95"}')
  kh=$(prom_query "clamp_max(rate(dynamo_frontend_cached_tokens_sum{${COMPONENT_NS}}[1m]) / (rate(dynamo_frontend_input_sequence_tokens_sum{${COMPONENT_NS}}[1m]) > 0), 1) or vector(0)")

  # Actual RPS from Prometheus
  ar=$(prom_query "sum(rate(loadgen_requests_total[1m])) or vector(0)")

  # Output tokens per second
  tops=$(prom_query "sum(rate(dynamo_frontend_output_tokens_total{${COMPONENT_NS}}[1m])) or vector(0)")

  # Error rate from load generator /api/status
  local status_json
  status_json=$(curl -sf --max-time 5 "http://localhost:${LOADGEN_PORT}/api/status" 2>/dev/null) || status_json='{}'
  er=$(python3 -c "
import sys, json
try:
    m = json.load(sys.stdin).get('metrics')
    if not m or m.get('requestCount', 0) == 0:
        print('0.000000')
    else:
        print(f'{100.0 * m[\"errorCount\"] / m[\"requestCount\"]:.6f}')
except Exception:
    print('NaN')
" <<< "$status_json")

  echo "${t50}|${t95}|${kh}|${er}|${ar}|${tops}"
}

# ── Average snapshot lines ────────────────────────────────────────────────────
average_snapshots() {
  python3 -c "
import sys, math
lines = [l.strip() for l in sys.stdin if l.strip()]
if not lines:
    print('|'.join(['NaN']*6)); sys.exit()
cols = [l.split('|') for l in lines]
ncols = len(cols[0])
avgs = []
for i in range(ncols):
    vals = []
    for row in cols:
        try:
            v = float(row[i])
            if not (math.isnan(v) or math.isinf(v)):
                vals.append(v)
        except (ValueError, IndexError):
            pass
    avgs.append(f'{sum(vals)/len(vals):.6f}' if vals else 'NaN')
print('|'.join(avgs))
"
}

# ── Load generator API ────────────────────────────────────────────────────────
loadgen_start() {
  local conc="$1" rps="$2"
  local code
  code=$(curl -sf -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:${LOADGEN_PORT}/api/workload/start" \
    -H 'Content-Type: application/json' \
    -d "{\"totalRPS\":${rps},\"mix\":{\"a\":1.0},\"maxConcurrency\":${conc}}" 2>/dev/null) || code="000"

  if [[ "$code" == "409" ]]; then
    warn "Workload already running — updating config instead"
    loadgen_config "$conc" "$rps"
    return
  elif [[ "$code" != "200" ]]; then
    err "Failed to start workload (HTTP ${code})"
    return 1
  fi
  info "Workload started: concurrency=${conc}, rps=${rps}"
}

loadgen_config() {
  local conc="$1" rps="$2"
  curl -sf -X POST "http://localhost:${LOADGEN_PORT}/api/workload/config" \
    -H 'Content-Type: application/json' \
    -d "{\"totalRPS\":${rps},\"mix\":{\"a\":1.0},\"maxConcurrency\":${conc}}" \
    >/dev/null 2>&1
  info "Workload updated: concurrency=${conc}, rps=${rps}"
}

loadgen_stop() {
  curl -sf -X POST "http://localhost:${LOADGEN_PORT}/api/workload/stop" \
    >/dev/null 2>&1 || true
  info "Workload stopped"
}

# ── DGD routing mode helpers ──────────────────────────────────────────────────
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

wait_for_dgd_pods() {
  local expected_count="$1" timeout="${2:-600}" interval=15 elapsed=0
  info "Waiting for ${expected_count} DGD pods (frontend + workers) to be Running..."

  while [[ $elapsed -lt $timeout ]]; do
    local running
    running=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
      -l "$DGD_LABEL" --field-selector=status.phase=Running \
      --no-headers 2>/dev/null | wc -l)

    if [[ "$running" -ge "$expected_count" ]]; then
      info "  ${running}/${expected_count} DGD pods Running"
      return 0
    fi

    info "  ${running}/${expected_count} DGD pods Running (${elapsed}s)"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  err "Only ${running:-0}/${expected_count} DGD pods Running after ${timeout}s"
  return 1
}

# ── Pod restart helpers ───────────────────────────────────────────────────
restart_worker_pods() {
  info "Deleting worker pods to force restart..."
  kubectl --context "$CONTEXT" delete pods -n "$NAMESPACE" \
    -l "${DGD_LABEL},nvidia.com/dynamo-component-type=main" \
    --wait=false 2>/dev/null || true
  sleep 5
  wait_for_dgd_pods 5 600
}

restart_all_dgd_pods() {
  info "Deleting ALL DGD pods (frontend + workers) to force fresh start..."
  kubectl --context "$CONTEXT" delete pods -n "$NAMESPACE" \
    -l "$DGD_LABEL" --wait=false 2>/dev/null || true
  sleep 5
  wait_for_dgd_pods 5 600
}

# ── Format helpers ────────────────────────────────────────────────────────────
fmt_sec() {
  python3 -c "
v = '$1'
if v == 'NaN': print('  NaN')
else:
    f = float(v)
    if f < 0.001: print(f'{f*1000000:.0f}us')
    elif f < 1.0: print(f'{f*1000:.1f}ms')
    else: print(f'{f:.3f}s')
"
}

fmt_pct() {
  python3 -c "
v = '$1'
if v == 'NaN': print('NaN')
else: print(f'{float(v):.1f}%')
"
}

# ══════════════════════════════════════════════════════════════════════════════
# DRY RUN
# ══════════════════════════════════════════════════════════════════════════════
if $DRY_RUN; then
  echo ""
  echo "=== Benchmark Sweep Plan (Dry Run) ==="
  echo ""
  echo "Context:       $CONTEXT"
  echo "Mode:          $MODE"
  echo "Output dir:    $OUTPUT_DIR/"
  echo "Levels:        ${LEVEL_ARRAY[*]}"
  echo "RPS:           $RPS"
  echo "Warmup:        ${WARMUP_SEC}s per level"
  echo "Measurement:   ${MEASURE_SEC}s per level (${SNAPSHOT_COUNT} snapshots @ ${SNAPSHOT_INTERVAL}s)"
  echo ""
  if [[ "$MODE" == "both" || "$MODE" == "kv" ]]; then
    echo "Phase 1: KV-aware routing"
    if [[ "$MODE" == "both" ]]; then
      echo "  - Verify cluster in kv mode (deployed default)"
      echo "  - If not: patch to kv, restart worker pods"
    else
      echo "  - (cluster already in kv mode, no restart)"
    fi
    echo "  - Prime KV cache (3 conversations at concurrency ${LEVEL_ARRAY[0]})"
    for lvl in "${LEVEL_ARRAY[@]}"; do
      echo "  - Concurrency ${lvl}: ${WARMUP_SEC}s warmup + ${MEASURE_SEC}s measure"
    done
    echo "  - Stop workload, cooldown 30s"
    echo ""
  fi
  if [[ "$MODE" == "both" || "$MODE" == "round_robin" ]]; then
    echo "Phase 2: Round-robin baseline"
    echo "  - Patch DGD to round_robin"
    echo "  - Wait for frontend restart"
    for lvl in "${LEVEL_ARRAY[@]}"; do
      echo "  - Concurrency ${lvl}: ${WARMUP_SEC}s warmup + ${MEASURE_SEC}s measure"
    done
    echo "  - Stop workload"
    echo ""
  fi
  if [[ "$MODE" == "both" ]]; then
    echo "Restore to kv mode + restart all DGD pods"
    echo ""
  fi
  local_per_phase=$(( ${#LEVEL_ARRAY[@]} * (WARMUP_SEC + MEASURE_SEC + 10) ))
  local_phases=1
  [[ "$MODE" == "both" ]] && local_phases=2
  local_total=$(( local_per_phase * local_phases / 60 + 3 ))
  echo "Estimated duration: ~${local_total} min"
  echo ""
  echo "Output: ${OUTPUT_DIR}/benchmark-sweep-YYYYMMDD-HHMMSS.tsv"
  echo "Columns: mode  concurrency  rps  ttft_p50_sec  ttft_p95_sec  kv_hit_rate  error_pct  actual_rps  tops  measure_start_utc  measure_end_utc"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ══════════════════════════════════════════════════════════════════════════════
PER_PHASE=$(( ${#LEVEL_ARRAY[@]} * (WARMUP_SEC + MEASURE_SEC + 10) / 60 ))
NUM_PHASES=2
[[ "$MODE" != "both" ]] && NUM_PHASES=1
EST_TOTAL=$(( PER_PHASE * NUM_PHASES + 3 ))

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║           Benchmark Sweep: KV vs Round-Robin             ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Context:     %-42s║\n" "$CONTEXT"
printf "║  Mode:        %-42s║\n" "$MODE"
printf "║  Levels:      %-42s║\n" "${LEVEL_ARRAY[*]}"
printf "║  RPS:         %-42s║\n" "$RPS"
printf "║  Per level:   %-42s║\n" "${WARMUP_SEC}s warmup + ${MEASURE_SEC}s measure"
printf "║  Estimated:   %-42s║\n" "~${EST_TOTAL} min"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Pre-checks ────────────────────────────────────────────────────────────────
info "Pre-checks..."

if ! kubectl --context "$CONTEXT" cluster-info >/dev/null 2>&1; then
  err "Cannot reach cluster with context '${CONTEXT}'"
  exit 1
fi
info "  Cluster reachable"

# GPU nodes
GPU_NODES=$(kubectl --context "$CONTEXT" get nodes \
  -l doks.digitalocean.com/gpu-brand=nvidia \
  --no-headers 2>/dev/null | grep -c " Ready" || echo 0)
if [[ "$GPU_NODES" -eq 0 ]]; then
  err "No GPU nodes in Ready state"
  exit 1
fi
info "  ${GPU_NODES} GPU node(s) ready"

# DGD pods (frontend + 4 workers = 5)
DGD_PODS=$(kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" \
  -l "$DGD_LABEL" --field-selector=status.phase=Running \
  --no-headers 2>/dev/null | wc -l)
if [[ "$DGD_PODS" -lt 5 ]]; then
  warn "Expected >=5 DGD pods (frontend + 4 workers), found ${DGD_PODS}"
  kubectl --context "$CONTEXT" get pods -n "$NAMESPACE" -l "$DGD_LABEL" --no-headers
fi
info "  ${DGD_PODS} DGD pod(s) running"

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

# ── Port forwards ──────────────────────────────────────────────────────────────
info "Setting up port forwards..."
start_port_forward "loadgen" "$LOADGEN_PORT" 3000 "$LOADGEN_NS" \
  "Load Generator" "/api/status"
start_port_forward "$PROM_SVC" "$PROM_PORT" 9090 "$PROM_NS" \
  "Prometheus" "/-/ready"

# Smoke test — stop any existing workload
SMOKE=$(curl -sf --max-time 10 "http://localhost:${LOADGEN_PORT}/api/status") || {
  err "Load generator /api/status not responding"
  exit 1
}
LG_RUNNING=$(python3 -c "import json; print(json.loads('''${SMOKE}''').get('running',False))")
if [[ "$LG_RUNNING" == "True" ]]; then
  warn "Workload already running — stopping first"
  loadgen_stop
  sleep 5
fi
info "  Load generator ready"

# ── Output file ────────────────────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TSV_FILE="${OUTPUT_DIR}/benchmark-sweep-${TIMESTAMP}.tsv"
mkdir -p "$OUTPUT_DIR"
printf "mode\tconcurrency\trps\tttft_p50_sec\tttft_p95_sec\tkv_hit_rate\terror_pct\tactual_rps\ttops\tmeasure_start_utc\tmeasure_end_utc\n" \
  > "$TSV_FILE"
info "Results → ${TSV_FILE}"

# ── Helper: run one phase (one routing mode, all levels) ──────────────────────
run_phase() {
  local mode="$1"
  local first_level=true

  for conc in "${LEVEL_ARRAY[@]}"; do
    echo ""
    echo "┌─ ${mode} @ concurrency=${conc}  RPS=${RPS} ────────────────"

    if $first_level; then
      loadgen_start "$conc" "$RPS"
      first_level=false
    else
      loadgen_config "$conc" "$RPS"
    fi

    # Warmup
    info "Warmup ${WARMUP_SEC}s..."
    sleep "$WARMUP_SEC"

    # Measurement snapshots
    local measure_start measure_end
    measure_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    info "Measuring (${MEASURE_SEC}s, ${SNAPSHOT_COUNT} snapshots @ ${SNAPSHOT_INTERVAL}s)..."
    SNAP_DATA=""
    for ((s = 1; s <= SNAPSHOT_COUNT; s++)); do
      sleep "$SNAPSHOT_INTERVAL"
      info "  Snapshot ${s}/${SNAPSHOT_COUNT}..."
      line=$(collect_metrics)
      SNAP_DATA+="${line}"$'\n'

      # Print live snapshot values
      IFS='|' read -r _t50 _t95 _kh _er _ar <<< "$line"
      info "    TTFT p50=$(fmt_sec "$_t50")  p95=$(fmt_sec "$_t95")  KV hit=$(fmt_pct "$_kh")  Err=$(fmt_pct "$_er")"
    done
    measure_end=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Average snapshots
    avg_line=$(echo "$SNAP_DATA" | average_snapshots)
    IFS='|' read -r avg_t50 avg_t95 avg_kh avg_er avg_ar avg_tops <<< "$avg_line"

    # Write TSV row
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
      "$mode" "$conc" "$RPS" \
      "$avg_t50" "$avg_t95" "$avg_kh" "$avg_er" "$avg_ar" "$avg_tops" \
      "$measure_start" "$measure_end" >> "$TSV_FILE"

    # Display level summary
    echo "│"
    echo "│  ${mode} @ concurrency=${conc} averaged results:"
    echo "│    TTFT   p50=$(fmt_sec "$avg_t50")  p95=$(fmt_sec "$avg_t95")"
    echo "│    KV hit $(fmt_pct "$avg_kh")"
    echo "│    Errors $(fmt_pct "$avg_er")"
    echo "│    RPS    ${avg_ar}  (target: ${RPS})"
    echo "│    TOPS   ${avg_tops} tok/s"
    echo "│    Window ${measure_start} → ${measure_end}"
    echo "└──────────────────────────────────────────────────────"
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# Phase 1: KV-aware routing
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "both" || "$MODE" == "kv" ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  Phase 1: KV-aware routing"
  echo "═══════════════════════════════════════════════════════════"

  current_mode=$(get_routing_mode)
  if [[ "$current_mode" == "kv" ]]; then
    info "Already in kv mode — frontend has been tracking KV state since deploy"
    wait_for_dgd_pods 5 300
  else
    # Not in KV mode — switch and restart workers so frontend tracks from start
    set_routing_mode "kv"
    MODE_CHANGED=true
    verify_frontend_mode "kv" 180
    restart_worker_pods
  fi
  sleep 10

  # Prime KV cache: run 3 conversations at lowest concurrency
  info "Priming KV cache (3 conversations at concurrency ${LEVEL_ARRAY[0]})..."
  loadgen_start "${LEVEL_ARRAY[0]}" "$RPS"
  sleep 30
  loadgen_stop
  sleep 5

  run_phase "kv"

  # Stop workload, cooldown between phases
  loadgen_stop
  if [[ "$MODE" == "both" ]]; then
    info "Cooldown 30s between phases..."
    sleep 30
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 2: Round-robin baseline
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "both" || "$MODE" == "round_robin" ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  Phase 2: Round-robin baseline"
  echo "═══════════════════════════════════════════════════════════"

  current_mode=$(get_routing_mode)
  if [[ "$current_mode" != "round_robin" ]]; then
    set_routing_mode "round_robin"
    MODE_CHANGED=true
    verify_frontend_mode "round_robin" 180
  else
    info "Already in round_robin mode"
  fi

  # Wait for workers to be stable after any frontend restart
  wait_for_dgd_pods 5 300
  sleep 10

  run_phase "round_robin"

  # Stop workload
  loadgen_stop
fi

# ══════════════════════════════════════════════════════════════════════════════
# Restore & summarize
# ══════════════════════════════════════════════════════════════════════════════

# Restore to kv mode (default) and restart all pods for fresh KV tracking
if $MODE_CHANGED; then
  if [[ "$(get_routing_mode)" != "kv" ]]; then
    info "Restoring routing mode → kv"
    set_routing_mode "kv"
    verify_frontend_mode "kv" 120
  fi
  info "Restarting all DGD pods so frontend tracks KV state from fresh start..."
  restart_all_dgd_pods
fi
ORIGINAL_MODE=""    # Clear so trap doesn't double-restore
MODE_CHANGED=false

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║           Benchmark Sweep Complete                       ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Results: %-48s║\n" "$TSV_FILE"
echo "║                                                          ║"
echo "║  Generate report:                                        ║"
printf "║    python3 scripts/generate-benchmark-report.py \\       ║\n"
printf "║      --input %-44s║\n" "$TSV_FILE"
printf "║      --output-dir %-39s║\n" "$OUTPUT_DIR"
echo "╚══════════════════════════════════════════════════════════╝"

echo ""
echo "Full results:"
echo ""
column -t -s $'\t' < "$TSV_FILE"

echo ""
info "Benchmark sweep complete."
