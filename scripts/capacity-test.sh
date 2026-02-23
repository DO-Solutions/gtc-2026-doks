#!/usr/bin/env bash
# scripts/capacity-test.sh — Staircase capacity test for Dynamo deployment.
# Steps through increasing load levels, collects Prometheus metrics, finds max
# sustainable concurrency before errors or unacceptable latency.
#
# Usage: ./scripts/capacity-test.sh [--context NAME] [--output-dir DIR] [--dry-run]

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
CONTEXT="${KUBE_CONTEXT:-do-nyc2-gtc-demo}"
OUTPUT_DIR="dev"
DRY_RUN=false

LOADGEN_PORT=3000
PROM_PORT=9090
LOADGEN_NS="dynamo-workload"
PROM_NS="monitoring"
PROM_SVC="kube-prometheus-stack-prometheus"

WARMUP_SEC=60
SNAPSHOT_COUNT=3
SNAPSHOT_INTERVAL=40   # seconds between snapshots (3 × 40 = 120s measurement)

# ── Prometheus label selectors ──────────────────────────────────────────────
FRONTEND_NS='dynamo_namespace="dynamo-workload-gtc-demo"'
COMPONENT_NS='dynamo_namespace="dynamo_workload_gtc_demo"'
GPU_NS='exported_namespace="dynamo-workload"'

# ── Test levels: name  maxConcurrency  RPS ──────────────────────────────────
LEVELS=(
  "L1 20 4.0"
  "L2 25 5.0"
  "L3 30 6.0"
  "L4 35 7.0"
  "L5 40 8.0"
  "L6 45 9.0"
  "L7 50 10.0"
)

# ── Zone thresholds ─────────────────────────────────────────────────────────
#                      Green       Yellow      Red (stop)
TTFT_P95_GREEN=1.5   # < 1.5s     1.5-3.0s    > 3.0s
TTFT_P95_RED=3.0
ITL_P95_GREEN=0.080  # < 80ms     80-150ms    > 150ms
ITL_P95_RED=0.150
ERROR_GREEN=1.0      # < 1%       1-5%        > 5%
ERROR_RED=5.0
QUEUE_GREEN=5        # < 5        5-15        > 15
QUEUE_RED=15
KV_GREEN=70.0        # < 70%      70-90%      > 90% (stop at 95%)
KV_RED=95.0

# ── Argument parsing ───────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Staircase capacity test for Dynamo 3-replica TP=1 deployment.
Steps through increasing load levels and finds max sustainable concurrency.

Options:
  --context NAME     kubectl context (default: $CONTEXT)
  --output-dir DIR   Output directory for results (default: $OUTPUT_DIR)
  --dry-run          Print test plan without executing
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)     CONTEXT="$2"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ── Logging helpers ─────────────────────────────────────────────────────────
info() { echo "[$(date +%H:%M:%S)] INFO  $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN  $*" >&2; }
err()  { echo "[$(date +%H:%M:%S)] ERROR $*" >&2; }

# ── Cleanup ─────────────────────────────────────────────────────────────────
PIDS_TO_KILL=()
cleanup() {
  info "Cleaning up..."
  for pid in "${PIDS_TO_KILL[@]}"; do
    kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
  done
  curl -sf -X POST "http://localhost:${LOADGEN_PORT}/api/workload/stop" \
    >/dev/null 2>&1 || true
  info "Done."
}
trap cleanup EXIT INT TERM

# ── Port-forward helper ────────────────────────────────────────────────────
# Args: service  local_port  remote_port  namespace  label  health_path
start_port_forward() {
  local svc="$1" lport="$2" rport="$3" ns="$4" label="$5" health="$6"

  # Already responding?
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
      err "${label}: port-forward failed after 20 s"
      return 1
    fi
  done
  info "${label}: ready"
}

# ── Prometheus instant query ────────────────────────────────────────────────
# Returns a numeric string or "NaN"
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

# ── Collect all metrics (pipe-delimited) ────────────────────────────────────
# Output: ttft_p50|ttft_p95|itl_p50|itl_p95|queue|kv_usage|kv_hit|error%|rps|gpu%
collect_metrics() {
  local t50 t95 i50 i95 qd ku kh er ar gu

  t50=$(prom_query "histogram_quantile(0.50, sum(rate(dynamo_frontend_time_to_first_token_seconds_bucket{${FRONTEND_NS}}[2m])) by (le))")
  t95=$(prom_query "histogram_quantile(0.95, sum(rate(dynamo_frontend_time_to_first_token_seconds_bucket{${FRONTEND_NS}}[2m])) by (le))")
  i50=$(prom_query "histogram_quantile(0.50, sum(rate(dynamo_frontend_inter_token_latency_seconds_bucket{${FRONTEND_NS}}[2m])) by (le))")
  i95=$(prom_query "histogram_quantile(0.95, sum(rate(dynamo_frontend_inter_token_latency_seconds_bucket{${FRONTEND_NS}}[2m])) by (le))")
  qd=$(prom_query  "sum(dynamo_frontend_queued_requests{${FRONTEND_NS}}) or vector(0)")
  ku=$(prom_query  "avg(dynamo_component_kvstats_gpu_cache_usage_percent{${COMPONENT_NS}}) or vector(0)")
  kh=$(prom_query  "avg(dynamo_component_kvstats_gpu_prefix_cache_hit_rate{${COMPONENT_NS}}) or vector(0)")
  ar=$(prom_query  "sum(rate(dynamo_frontend_requests_total{${FRONTEND_NS}}[2m])) or vector(0)")
  gu=$(prom_query  "avg(DCGM_FI_DEV_GPU_UTIL{${GPU_NS}}) or vector(0)")

  # Error rate from load generator (captures client-side timeouts too)
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

  echo "${t50}|${t95}|${i50}|${i95}|${qd}|${ku}|${kh}|${er}|${ar}|${gu}"
}

# ── Average snapshot lines ──────────────────────────────────────────────────
# Reads pipe-delimited lines from stdin, outputs one averaged pipe-delimited line
average_snapshots() {
  python3 -c "
import sys, math
lines = [l.strip() for l in sys.stdin if l.strip()]
if not lines:
    print('|'.join(['NaN']*10)); sys.exit()
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

# ── Load generator API ──────────────────────────────────────────────────────
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

# ── Zone classification + stop-condition check ──────────────────────────────
# Args: ttft_p95  itl_p95  error_rate  queue_depth  kv_usage
# Outputs to stdout: zone|reason1;reason2;...   (reasons empty if no stop)
# Returns: 0 if should stop, 1 if continue
analyze_level() {
  python3 -c "
import math

def f(s):
    try:
        v = float(s)
        return None if (math.isnan(v) or math.isinf(v)) else v
    except:
        return None

t95  = f('$1')
i95  = f('$2')
er   = f('$3')
qd   = f('$4')
ku   = f('$5')

# Zone classification
zone = 'green'
# Yellow checks
if (t95 is not None and t95 > $TTFT_P95_GREEN) or \
   (i95 is not None and i95 > $ITL_P95_GREEN) or \
   (er  is not None and er  > $ERROR_GREEN) or \
   (qd  is not None and qd  > $QUEUE_GREEN) or \
   (ku  is not None and ku  > $KV_GREEN):
    zone = 'yellow'
# Red checks (override yellow)
if (t95 is not None and t95 > $TTFT_P95_RED) or \
   (i95 is not None and i95 > $ITL_P95_RED) or \
   (er  is not None and er  > $ERROR_RED) or \
   (qd  is not None and qd  > $QUEUE_RED) or \
   (ku  is not None and ku  > $KV_RED):
    zone = 'red'

# Stop reasons (red thresholds)
reasons = []
if t95 is not None and t95 > $TTFT_P95_RED:
    reasons.append(f'TTFT p95 {t95:.3f}s > ${TTFT_P95_RED}s')
if i95 is not None and i95 > $ITL_P95_RED:
    reasons.append(f'ITL p95 {i95*1000:.1f}ms > ${ITL_P95_RED}s')
if er is not None and er > $ERROR_RED:
    reasons.append(f'Error rate {er:.1f}% > ${ERROR_RED}%')
if qd is not None and qd > $QUEUE_RED:
    reasons.append(f'Queue depth {qd:.0f} > $QUEUE_RED')
if ku is not None and ku > $KV_RED:
    reasons.append(f'KV cache {ku:.1f}% > ${KV_RED}%')

print(f'{zone}|{\";\".join(reasons)}')
import sys; sys.exit(0 if reasons else 1)
"
}

# ── Format a seconds value for display ──────────────────────────────────────
fmt_sec() {
  python3 -c "
v = '$1'
if v == 'NaN': print('  NaN')
else:
    f = float(v)
    if f < 0.001: print(f'{f*1000000:.0f}µs')
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

# ════════════════════════════════════════════════════════════════════════════
# DRY RUN
# ════════════════════════════════════════════════════════════════════════════
if $DRY_RUN; then
  echo ""
  echo "=== Capacity Test Plan (Dry Run) ==="
  echo ""
  echo "Context:       $CONTEXT"
  echo "Output dir:    $OUTPUT_DIR/"
  echo "Warmup:        ${WARMUP_SEC}s per level"
  echo "Measurement:   $((SNAPSHOT_COUNT * SNAPSHOT_INTERVAL))s per level (${SNAPSHOT_COUNT} snapshots @ ${SNAPSHOT_INTERVAL}s)"
  echo ""
  printf "  %-6s  %15s  %8s\n" "Level" "maxConcurrency" "RPS"
  printf "  %-6s  %15s  %8s\n" "-----" "--------------" "---"
  for entry in "${LEVELS[@]}"; do
    read -r lvl conc rps <<< "$entry"
    printf "  %-6s  %15s  %8s\n" "$lvl" "$conc" "$rps"
  done
  echo ""
  echo "Stop conditions (any triggers stop):"
  echo "  TTFT p95 > ${TTFT_P95_RED}s"
  echo "  ITL  p95 > $(python3 -c "print(f'{${ITL_P95_RED}*1000:.0f}')") ms"
  echo "  Error rate > ${ERROR_RED}%"
  echo "  Queue depth > ${QUEUE_RED}"
  echo "  KV cache usage > ${KV_RED}%"
  echo ""
  echo "Estimated duration: ~$((${#LEVELS[@]} * (WARMUP_SEC + SNAPSHOT_COUNT * SNAPSHOT_INTERVAL + 10) / 60 + 2)) min"
  echo ""
  echo "Output columns:"
  echo "  level  maxConcurrency  rps  ttft_p50  ttft_p95  itl_p50  itl_p95"
  echo "  queue_depth  kv_usage  kv_hit_rate  error_rate  actual_rps  gpu_util  zone"
  exit 0
fi

# ════════════════════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Dynamo Capacity Staircase Test                ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Context:   %-44s║\n" "$CONTEXT"
printf "║  Levels:    %-44s║\n" "${#LEVELS[@]} levels (L1→L${#LEVELS[@]})"
printf "║  Per level: %-44s║\n" "${WARMUP_SEC}s warmup + $((SNAPSHOT_COUNT * SNAPSHOT_INTERVAL))s measure"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Pre-test checks ────────────────────────────────────────────────────────
info "Pre-test checks..."

# Cluster reachable
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

# DGD pods
WORKER_PODS=$(kubectl --context "$CONTEXT" get pods -n "$LOADGEN_NS" \
  -l nvidia.com/dynamo-graph-deployment-name=gtc-demo \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
if [[ "$WORKER_PODS" -lt 4 ]]; then
  warn "Expected >=4 DGD pods (frontend + 3 workers), found ${WORKER_PODS}"
  kubectl --context "$CONTEXT" get pods -n "$LOADGEN_NS" \
    -l nvidia.com/dynamo-graph-deployment-name=gtc-demo --no-headers
fi
info "  ${WORKER_PODS} DGD pod(s) running"

# Load generator
LOADGEN_PODS=$(kubectl --context "$CONTEXT" get pods -n "$LOADGEN_NS" \
  -l app=loadgen --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
if [[ "$LOADGEN_PODS" -eq 0 ]]; then
  err "No load generator pod running"
  exit 1
fi
info "  Load generator pod running"

# ── Port forwards ──────────────────────────────────────────────────────────
info "Setting up port forwards..."
start_port_forward "loadgen" "$LOADGEN_PORT" 3000 "$LOADGEN_NS" \
  "Load Generator" "/api/status"
start_port_forward "$PROM_SVC" "$PROM_PORT" 9090 "$PROM_NS" \
  "Prometheus" "/-/ready"

# ── Smoke test ──────────────────────────────────────────────────────────────
info "Smoke test..."
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

# Quick Prometheus check
PROM_UP=$(prom_query "up{job=~\".*prometheus.*\"}")
info "  Prometheus responding (up=${PROM_UP})"

# ── Output file ─────────────────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TSV_FILE="${OUTPUT_DIR}/capacity-test-results-${TIMESTAMP}.tsv"
mkdir -p "$OUTPUT_DIR"
printf "level\tmaxConcurrency\trps\tttft_p50\tttft_p95\titl_p50\titl_p95\tqueue_depth\tkv_usage\tkv_hit_rate\terror_rate\tactual_rps\tgpu_util\tzone\n" \
  > "$TSV_FILE"
info "Results → ${TSV_FILE}"

# ── Staircase loop ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Starting staircase test at $(date +%H:%M:%S)"
echo "═══════════════════════════════════════════════════════════"

FIRST_LEVEL=true
STOPPED_AT=""
GREEN_CEILING=""
YELLOW_CEILING=""
declare -a RESULT_LINES=()   # "level|conc|rps|zone" for summary

for entry in "${LEVELS[@]}"; do
  read -r level conc rps <<< "$entry"

  echo ""
  echo "┌─ ${level}: maxConcurrency=${conc}  RPS=${rps} ────────────────"

  # Start or reconfigure
  if $FIRST_LEVEL; then
    loadgen_start "$conc" "$rps"
    FIRST_LEVEL=false
  else
    loadgen_config "$conc" "$rps"
  fi

  # Warmup
  info "Warmup ${WARMUP_SEC}s..."
  sleep "$WARMUP_SEC"

  # Measurement snapshots
  info "Measuring ($((SNAPSHOT_COUNT * SNAPSHOT_INTERVAL))s, ${SNAPSHOT_COUNT} snapshots)..."
  SNAP_DATA=""
  for ((s = 1; s <= SNAPSHOT_COUNT; s++)); do
    sleep "$SNAPSHOT_INTERVAL"
    info "  Snapshot ${s}/${SNAPSHOT_COUNT}..."
    line=$(collect_metrics)
    SNAP_DATA+="${line}"$'\n'

    # Print live values for this snapshot
    IFS='|' read -r _t50 _t95 _i50 _i95 _qd _ku _kh _er _ar _gu <<< "$line"
    info "    TTFT p95=$(fmt_sec "$_t95")  ITL p95=$(fmt_sec "$_i95")  Queue=${_qd}  Err=$(fmt_pct "$_er")"
  done

  # Average
  avg_line=$(echo "$SNAP_DATA" | average_snapshots)
  IFS='|' read -r avg_t50 avg_t95 avg_i50 avg_i95 avg_qd avg_ku avg_kh avg_er avg_ar avg_gu <<< "$avg_line"

  # Analyze
  analysis=""
  if analysis=$(analyze_level "$avg_t95" "$avg_i95" "$avg_er" "$avg_qd" "$avg_ku" 2>&1); then
    should_stop=true
  else
    should_stop=false
  fi
  IFS='|' read -r zone stop_reasons <<< "$analysis"

  # Track ceilings
  RESULT_LINES+=("${level}|${conc}|${rps}|${zone}")
  if [[ "$zone" == "green" ]]; then
    GREEN_CEILING="${level} (conc=${conc}, rps=${rps})"
  fi
  if [[ "$zone" != "red" ]]; then
    YELLOW_CEILING="${level} (conc=${conc}, rps=${rps})"
  fi

  # Write TSV row
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$level" "$conc" "$rps" \
    "$avg_t50" "$avg_t95" "$avg_i50" "$avg_i95" \
    "$avg_qd" "$avg_ku" "$avg_kh" "$avg_er" "$avg_ar" "$avg_gu" \
    "$zone" >> "$TSV_FILE"

  # Display level summary
  echo "│"
  echo "│  ${level} averaged results:"
  echo "│    TTFT   p50=$(fmt_sec "$avg_t50")  p95=$(fmt_sec "$avg_t95")"
  echo "│    ITL    p50=$(fmt_sec "$avg_i50")  p95=$(fmt_sec "$avg_i95")"
  echo "│    Queue  ${avg_qd}"
  echo "│    KV     usage=$(fmt_pct "$avg_ku")  hit_rate=$(fmt_pct "$avg_kh")"
  echo "│    Errors $(fmt_pct "$avg_er")"
  echo "│    RPS    ${avg_ar}  (target: ${rps})"
  echo "│    GPU    $(fmt_pct "$avg_gu")"
  echo "│    Zone   ${zone}"
  echo "└──────────────────────────────────────────────────────"

  # Stop check
  if $should_stop; then
    echo ""
    warn "STOP CONDITIONS MET at ${level}:"
    IFS=';' read -ra reasons <<< "$stop_reasons"
    for r in "${reasons[@]}"; do
      [[ -n "$r" ]] && warn "  - $r"
    done
    STOPPED_AT="${level} (conc=${conc}, rps=${rps})"
    break
  fi
done

# Stop workload
echo ""
info "Stopping workload..."
loadgen_stop
sleep 2

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              Capacity Test Summary                       ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
if [[ -n "$GREEN_CEILING" ]]; then
  printf "║  Green ceiling:  %-40s║\n" "$GREEN_CEILING"
else
  printf "║  Green ceiling:  %-40s║\n" "(none — first level already yellow/red)"
fi
if [[ -n "$YELLOW_CEILING" ]]; then
  printf "║  Yellow ceiling: %-40s║\n" "$YELLOW_CEILING"
else
  printf "║  Yellow ceiling: %-40s║\n" "(none — first level already red)"
fi
if [[ -n "$STOPPED_AT" ]]; then
  printf "║  Stopped at:     %-40s║\n" "$STOPPED_AT"
else
  printf "║  Completed:      %-40s║\n" "all ${#LEVELS[@]} levels without hitting red"
fi
echo "║                                                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Per-Level Results:                                      ║"
for entry in "${RESULT_LINES[@]}"; do
  IFS='|' read -r lvl conc rps z <<< "$entry"
  case "$z" in
    green)  marker="[green] " ;;
    yellow) marker="[yellow]" ;;
    red)    marker="[red]   " ;;
    *)      marker="[?]     " ;;
  esac
  printf "║    %s  %-5s conc=%-3s rps=%-5s                      ║\n" \
    "$marker" "$lvl" "$conc" "$rps"
done
echo "║                                                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Recommendations:                                        ║"
if [[ -n "$GREEN_CEILING" ]]; then
  printf "║    Safe demo ceiling: %-36s║\n" "$GREEN_CEILING"
  echo "║    Use these values for auto mode 'high load' phase.    ║"
else
  echo "║    WARNING: Even L1 (conc=20) is outside green zone.    ║"
  echo "║    Consider reducing Peak Traffic preset.                ║"
fi
echo "║                                                          ║"
printf "║  Results: %-48s║\n" "$TSV_FILE"
echo "╚══════════════════════════════════════════════════════════╝"

# Print full results as a formatted table
echo ""
echo "Full results:"
echo ""
column -t -s $'\t' < "$TSV_FILE"

echo ""
info "Capacity test complete."
