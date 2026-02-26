#!/usr/bin/env bash
# vllm-benchmark.sh — Reusable vLLM benchmark runner (server lifecycle + rate sweep)
#
# Env vars:
#   RESULT_LABEL      — subdirectory name for results (default: "default")
#   VLLM_EXTRA_ARGS   — additional args for vllm serve (default: empty)
#   BENCHMARK_RATES   — space-separated request rates (default: "0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0")
#   NUM_PROMPTS       — prompts per rate (default: 300)
#   MODEL             — model path (default: /models/nvidia/Llama-3.1-70B-Instruct-FP8)
#   TP_SIZE           — tensor parallel size (default: 1)
#   DATASET_PATH      — path to ShareGPT JSON dataset (default: auto-downloads ShareGPT_V3)
#   BENCH_BACKEND     — vllm bench serve backend (default: "vllm"; use "openai-chat" for chat endpoint)
#   BENCH_ENDPOINT    — API endpoint path (default: "/v1/completions"; use "/v1/chat/completions" for chat)
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
RESULT_LABEL="${RESULT_LABEL:-default}"
VLLM_EXTRA_ARGS="${VLLM_EXTRA_ARGS:-}"
BENCHMARK_RATES="${BENCHMARK_RATES:-0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0}"
NUM_PROMPTS="${NUM_PROMPTS:-300}"
MODEL="${MODEL:-/models/nvidia/Llama-3.1-70B-Instruct-FP8}"
TP_SIZE="${TP_SIZE:-1}"
PORT=8000
DEFAULT_DATASET="/models/benchmarks/ShareGPT_V3_unfiltered_cleaned_split.json"
DATASET_PATH="${DATASET_PATH:-${DEFAULT_DATASET}}"
BENCH_BACKEND="${BENCH_BACKEND:-vllm}"
BENCH_ENDPOINT="${BENCH_ENDPOINT:-/v1/completions}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
RESULT_DIR="/models/benchmarks/${RESULT_LABEL}/${TIMESTAMP}"
SERVER_LOG="/tmp/vllm-server.log"
SERVER_PID=""

cleanup() {
    echo "==> Cleaning up..."
    if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ── 1. CUDA compat ─────────────────────────────────────────────────────────
echo "==> Setting up CUDA compat library path"
export LD_LIBRARY_PATH="/usr/local/cuda/compat/lib.real:${LD_LIBRARY_PATH:-}"

# ── 2. Verify benchmarks module ────────────────────────────────────────────
echo "==> Verifying vllm bench serve is available..."
if vllm bench serve --help >/dev/null 2>&1; then
    echo "    vllm bench serve available"
else
    echo "ERROR: vllm bench serve not available in this image"
    exit 1
fi

# ── 3. Ensure dataset exists ──────────────────────────────────────────────
echo "==> Checking for dataset at ${DATASET_PATH}..."
if [[ -f "${DATASET_PATH}" ]]; then
    echo "    Dataset already exists at ${DATASET_PATH}"
elif [[ "${DATASET_PATH}" == "${DEFAULT_DATASET}" ]]; then
    echo "    Downloading ShareGPT dataset..."
    mkdir -p "$(dirname "${DATASET_PATH}")"
    curl -fsSL \
        "https://huggingface.co/datasets/anon8231489123/ShareGPT_Vicuna_unfiltered/resolve/main/ShareGPT_V3_unfiltered_cleaned_split.json" \
        -o "${DATASET_PATH}"
    echo "    Dataset downloaded ($(du -h "${DATASET_PATH}" | cut -f1))"
else
    echo "ERROR: Custom dataset not found at ${DATASET_PATH}"
    echo "       Upload the dataset to NFS before running the benchmark."
    exit 1
fi

# ── 3b. Patch vLLM dataset filter for long-context datasets ───────────────
# vLLM's ShareGPT sampler has hardcoded max_prompt_len=1024, max_total_len=2048.
# Custom datasets from collected conversations have 4K-10K token prompts.
# Patch the defaults when using a non-default dataset.
if [[ "${DATASET_PATH}" != "${DEFAULT_DATASET}" ]]; then
    echo "==> Patching vLLM dataset filter for long-context dataset..."
    DATASETS_PY=$(python3 -c "import vllm.benchmarks.datasets; print(vllm.benchmarks.datasets.__file__)")
    sed -i 's/max_prompt_len: int = 1024/max_prompt_len: int = 16384/' "${DATASETS_PY}"
    sed -i 's/max_total_len: int = 2048/max_total_len: int = 32768/' "${DATASETS_PY}"
    echo "    Patched: max_prompt_len=16384, max_total_len=32768"
fi

# ── 4. Start vLLM server ───────────────────────────────────────────────────
echo "==> Starting vLLM server..."
echo "    Model: ${MODEL}"
echo "    TP size: ${TP_SIZE}"
echo "    Extra args: ${VLLM_EXTRA_ARGS}"

mkdir -p "${RESULT_DIR}"

# shellcheck disable=SC2086
python3 -m vllm.entrypoints.openai.api_server \
    --model "${MODEL}" \
    --tensor-parallel-size "${TP_SIZE}" \
    --port "${PORT}" \
    --disable-log-requests \
    ${VLLM_EXTRA_ARGS} \
    > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

echo "    Server PID: ${SERVER_PID}"
echo "    Server log: ${SERVER_LOG}"

# ── 5. Wait for server ready ───────────────────────────────────────────────
echo "==> Waiting for server to be ready (up to 600s)..."
WAIT_START=$(date +%s)
TIMEOUT=600
while true; do
    ELAPSED=$(( $(date +%s) - WAIT_START ))
    if (( ELAPSED >= TIMEOUT )); then
        echo "ERROR: Server did not become ready within ${TIMEOUT}s"
        echo "==> Last 50 lines of server log:"
        tail -50 "${SERVER_LOG}"
        exit 1
    fi

    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "ERROR: Server process died"
        echo "==> Server log:"
        cat "${SERVER_LOG}"
        exit 1
    fi

    if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
        echo "    Server ready after ${ELAPSED}s"
        break
    fi

    if (( ELAPSED % 30 == 0 )) && (( ELAPSED > 0 )); then
        echo "    Still waiting... (${ELAPSED}s elapsed)"
    fi
    sleep 5
done

# Copy server log to results
cp "${SERVER_LOG}" "${RESULT_DIR}/server.log"

# ── 6. Warm-up run ─────────────────────────────────────────────────────────
echo "==> Running warm-up (10 prompts at rate 0.5)..."
vllm bench serve \
    --backend "${BENCH_BACKEND}" \
    --endpoint "${BENCH_ENDPOINT}" \
    --base-url "http://localhost:${PORT}" \
    --model "${MODEL}" \
    --dataset-name sharegpt \
    --dataset-path "${DATASET_PATH}" \
    --num-prompts 10 \
    --request-rate 0.5 \
    --percentile-metrics ttft,tpot,itl,e2el \
    --metric-percentiles 50,95,99 \
    2>&1 | tee "${RESULT_DIR}/warmup.log" || {
    echo "WARNING: Warm-up failed, continuing anyway..."
}
echo "    Warm-up complete, cooling down 15s..."
sleep 15

# ── 7. Rate sweep ──────────────────────────────────────────────────────────
echo "==> Starting rate sweep"
echo "    Rates: ${BENCHMARK_RATES}"
echo "    Prompts per rate: ${NUM_PROMPTS}"
echo "    Results dir: ${RESULT_DIR}"

RATE_NUM=0
TOTAL_RATES=$(echo "${BENCHMARK_RATES}" | wc -w)

for rate in ${BENCHMARK_RATES}; do
    RATE_NUM=$((RATE_NUM + 1))
    echo ""
    echo "==> [${RATE_NUM}/${TOTAL_RATES}] Benchmarking at request rate ${rate}..."

    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "ERROR: Server process died during sweep"
        tail -50 "${SERVER_LOG}"
        exit 1
    fi

    vllm bench serve \
        --backend "${BENCH_BACKEND}" \
        --endpoint "${BENCH_ENDPOINT}" \
        --base-url "http://localhost:${PORT}" \
        --model "${MODEL}" \
        --dataset-name sharegpt \
        --dataset-path "${DATASET_PATH}" \
        --num-prompts "${NUM_PROMPTS}" \
        --request-rate "${rate}" \
        --percentile-metrics ttft,tpot,itl,e2el \
        --metric-percentiles 50,95,99 \
        --save-result \
        --result-dir "${RESULT_DIR}" \
        --result-filename "rate-${rate}.json" \
        2>&1 | tee "${RESULT_DIR}/rate-${rate}.log"

    echo "    Rate ${rate} complete"

    if (( RATE_NUM < TOTAL_RATES )); then
        echo "    Cooling down 30s..."
        sleep 30
    fi
done

# ── 8. Summary ──────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Benchmark Complete"
echo "============================================================"
echo "  Label:      ${RESULT_LABEL}"
echo "  Timestamp:  ${TIMESTAMP}"
echo "  Results:    ${RESULT_DIR}"
echo ""
echo "  Files:"
ls -la "${RESULT_DIR}/"
echo ""
echo "  JSON result files:"
find "${RESULT_DIR}" -name "*.json" -type f | sort
echo "============================================================"
