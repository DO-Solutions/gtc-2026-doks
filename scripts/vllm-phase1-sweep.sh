#!/usr/bin/env bash
# vllm-phase1-sweep.sh — Run structured parameter sweep for Phase 1 tuning
#
# Iterates over 6 parameter combinations, calling vllm-benchmark.sh for each.
# Each combo gets its own RESULT_LABEL and VLLM_EXTRA_ARGS.
#
# Env vars (inherited from Job YAML):
#   MODEL             — model path (required)
#   TP_SIZE           — tensor parallel size (required)
#   DATASET_PATH      — path to ShareGPT JSON dataset (required)
#   NUM_PROMPTS       — prompts per rate (default: 300)
#   BENCHMARK_RATES   — space-separated request rates (default: see below)
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
NUM_PROMPTS="${NUM_PROMPTS:-300}"
BENCHMARK_RATES="${BENCHMARK_RATES:-0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0}"
PORT=8000

# ── Parameter Combinations ────────────────────────────────────────────────────
# Format: "LABEL|EXTRA_ARGS"
COMBOS=(
    "phase1-baseline-rerun|"
    "phase1-mem095|--gpu-memory-utilization 0.95"
    "phase1-batch16k|--max-num-batched-tokens 16384"
    "phase1-seqs128|--max-num-seqs 128"
    "phase1-moderate|--gpu-memory-utilization 0.95 --max-num-batched-tokens 16384 --max-num-seqs 128"
    "phase1-aggressive|--gpu-memory-utilization 0.95 --max-num-batched-tokens 32768 --max-num-seqs 256"
)

TOTAL=${#COMBOS[@]}
PASSED=0
FAILED=0
FAILED_LABELS=""

echo "============================================================"
echo "  Phase 1 Parameter Sweep"
echo "============================================================"
echo "  Model:          ${MODEL}"
echo "  TP size:        ${TP_SIZE}"
echo "  Dataset:        ${DATASET_PATH}"
echo "  Prompts/rate:   ${NUM_PROMPTS}"
echo "  Rates:          ${BENCHMARK_RATES}"
echo "  Combinations:   ${TOTAL}"
echo "============================================================"
echo ""

for i in "${!COMBOS[@]}"; do
    COMBO_NUM=$((i + 1))
    IFS='|' read -r LABEL EXTRA_ARGS <<< "${COMBOS[$i]}"

    echo ""
    echo "************************************************************"
    echo "  [${COMBO_NUM}/${TOTAL}] ${LABEL}"
    echo "  Extra args: ${EXTRA_ARGS:-<none>}"
    echo "************************************************************"
    echo ""

    # Ensure port 8000 is free before starting the next combo
    echo "==> Checking port ${PORT} availability..."
    WAIT_PORT_START=$(date +%s)
    while ss -tlnp 2>/dev/null | grep -q ":${PORT} "; do
        ELAPSED=$(( $(date +%s) - WAIT_PORT_START ))
        if (( ELAPSED >= 120 )); then
            echo "ERROR: Port ${PORT} still in use after 120s. Attempting force cleanup..."
            # Try to kill any leftover vllm processes
            pkill -f "api_server.*--port ${PORT}" 2>/dev/null || true
            sleep 5
            if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
                echo "ERROR: Port ${PORT} still occupied. Skipping ${LABEL}."
                FAILED=$((FAILED + 1))
                FAILED_LABELS="${FAILED_LABELS} ${LABEL}"
                continue 2
            fi
            break
        fi
        echo "    Port ${PORT} in use, waiting... (${ELAPSED}s)"
        sleep 5
    done
    echo "    Port ${PORT} is free"

    # Export env vars for vllm-benchmark.sh
    export RESULT_LABEL="${LABEL}"
    export VLLM_EXTRA_ARGS="${EXTRA_ARGS}"
    export NUM_PROMPTS
    export BENCHMARK_RATES
    export MODEL
    export TP_SIZE
    export DATASET_PATH

    # Run the benchmark — continue on failure
    COMBO_START=$(date +%s)
    if /scripts/vllm-benchmark.sh; then
        COMBO_ELAPSED=$(( $(date +%s) - COMBO_START ))
        echo ""
        echo "==> [${COMBO_NUM}/${TOTAL}] ${LABEL} COMPLETED in ${COMBO_ELAPSED}s"
        PASSED=$((PASSED + 1))
    else
        COMBO_ELAPSED=$(( $(date +%s) - COMBO_START ))
        echo ""
        echo "==> [${COMBO_NUM}/${TOTAL}] ${LABEL} FAILED after ${COMBO_ELAPSED}s"
        FAILED=$((FAILED + 1))
        FAILED_LABELS="${FAILED_LABELS} ${LABEL}"
    fi

    # Cooldown between combos — let GPU memory fully release
    if (( COMBO_NUM < TOTAL )); then
        echo "==> Cooldown 30s before next combo..."
        sleep 30
    fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Phase 1 Sweep Complete"
echo "============================================================"
echo "  Passed: ${PASSED}/${TOTAL}"
echo "  Failed: ${FAILED}/${TOTAL}"
if [[ -n "${FAILED_LABELS}" ]]; then
    echo "  Failed labels:${FAILED_LABELS}"
fi
echo ""
echo "  Results on NFS:"
for combo in "${COMBOS[@]}"; do
    IFS='|' read -r LABEL _ <<< "${combo}"
    LATEST=$(ls -d /models/benchmarks/${LABEL}/*/ 2>/dev/null | sort | tail -1 || echo "NOT FOUND")
    echo "    ${LABEL}: ${LATEST}"
done
echo "============================================================"

# Exit with failure if any combo failed
if (( FAILED > 0 )); then
    exit 1
fi
