#!/usr/bin/env python3
"""Generate markdown report comparing Phase 1 parameter sweep results.

Reads rate-*.json files from each parameter combination's results directory,
compares against a Phase 0 baseline, and produces a markdown report with
configuration tables, SLO compliance analysis, and winner identification.

Usage:
    python3 scripts/generate-phase1-report.py \
        --results-dir dev/vllm/benchmarks \
        --baseline-label phase0 --baseline-timestamp 20260224-214806 \
        --phase1-labels phase1-baseline-rerun,phase1-mem095,phase1-batch16k,phase1-seqs128,phase1-moderate,phase1-aggressive \
        --output dev/vllm/benchmarks/phase1/report.md
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone


# ── SLO Targets ──────────────────────────────────────────────────────────────
TTFT_P99_SLO_MS = 1000.0
TPOT_P99_SLO_MS = 60.0

# ── Parameter definitions per combo label ─────────────────────────────────────
COMBO_PARAMS = {
    "phase1-baseline-rerun": {
        "gpu_memory_utilization": 0.9,
        "max_num_batched_tokens": 8192,
        "max_num_seqs": 1024,
        "description": "Control — same as Phase 0 defaults",
    },
    "phase1-mem095": {
        "gpu_memory_utilization": 0.95,
        "max_num_batched_tokens": 8192,
        "max_num_seqs": 1024,
        "description": "Isolate memory effect (+~7GB KV cache)",
    },
    "phase1-batch16k": {
        "gpu_memory_utilization": 0.9,
        "max_num_batched_tokens": 16384,
        "max_num_seqs": 1024,
        "description": "Isolate prefill budget effect (2x default)",
    },
    "phase1-seqs128": {
        "gpu_memory_utilization": 0.9,
        "max_num_batched_tokens": 8192,
        "max_num_seqs": 128,
        "description": "Isolate max-seqs effect (avoids preemption)",
    },
    "phase1-moderate": {
        "gpu_memory_utilization": 0.95,
        "max_num_batched_tokens": 16384,
        "max_num_seqs": 128,
        "description": "Combined moderate tuning",
    },
    "phase1-aggressive": {
        "gpu_memory_utilization": 0.95,
        "max_num_batched_tokens": 32768,
        "max_num_seqs": 256,
        "description": "Combined aggressive tuning",
    },
    "phase3-eagle3": {
        "gpu_memory_utilization": 0.90,
        "max_num_batched_tokens": 16384,
        "max_num_seqs": 64,
        "description": "EAGLE-3 speculative decoding (num_speculative_tokens=3)",
    },
    "phase3-eagle3-chat": {
        "gpu_memory_utilization": 0.90,
        "max_num_batched_tokens": 16384,
        "max_num_seqs": 64,
        "description": "EAGLE-3 speculative decoding (chat endpoint, num_speculative_tokens=3)",
    },
    "phase3-draft-8b": {
        "gpu_memory_utilization": 0.90,
        "max_num_batched_tokens": 16384,
        "max_num_seqs": 64,
        "description": "Draft-model spec decode (Llama 3.1 8B FP8, num_speculative_tokens=5)",
    },
}


def parse_args():
    p = argparse.ArgumentParser(description="Generate Phase 1 benchmark comparison report")
    p.add_argument("--results-dir", required=True,
                    help="Root directory containing label subdirectories (e.g., dev/vllm/benchmarks)")
    p.add_argument("--baseline-label", default="phase0",
                    help="Label for Phase 0 baseline (default: phase0)")
    p.add_argument("--baseline-timestamp", required=True,
                    help="Timestamp directory for Phase 0 baseline (e.g., 20260224-214806)")
    p.add_argument("--phase1-labels", required=True,
                    help="Comma-separated Phase 1 combo labels")
    p.add_argument("--output", required=True,
                    help="Output markdown file path")
    return p.parse_args()


def load_rates(result_dir: str) -> dict[float, dict]:
    """Load all rate-*.json files from a results directory, keyed by request_rate."""
    rates = {}
    for path in sorted(glob.glob(os.path.join(result_dir, "rate-*.json"))):
        with open(path) as f:
            data = json.load(f)
        rate = data["request_rate"]
        rates[rate] = data
    return rates


def find_latest_timestamp(results_dir: str, label: str) -> str | None:
    """Find the most recent timestamp directory for a label."""
    label_dir = os.path.join(results_dir, label)
    if not os.path.isdir(label_dir):
        return None
    timestamps = sorted(
        d for d in os.listdir(label_dir)
        if os.path.isdir(os.path.join(label_dir, d)) and re.match(r"\d{8}-\d{6}", d)
    )
    return timestamps[-1] if timestamps else None


def extract_kv_cache_info(result_dir: str) -> str:
    """Extract KV cache size from server.log if available."""
    log_path = os.path.join(result_dir, "server.log")
    if not os.path.isfile(log_path):
        return "N/A"
    with open(log_path) as f:
        for line in f:
            # vLLM logs: "KV cache size: XX.XX GiB (N tokens)"
            # or "GPU KV cache size: XX.XX GiB"
            if "KV cache" in line and "GiB" in line:
                m = re.search(r"(\d+\.\d+)\s*GiB", line)
                if m:
                    return f"{m.group(1)} GiB"
            # Also check for token count
            if "number of GPU blocks" in line.lower() or "gpu_cache_block_num" in line:
                m = re.search(r"(\d+)", line)
                if m:
                    return f"{m.group(1)} blocks"
    return "N/A"


def slo_pass(data: dict) -> bool:
    """Check if a single rate result passes both SLOs."""
    ttft_ok = data.get("p99_ttft_ms", float("inf")) < TTFT_P99_SLO_MS
    tpot_ok = data.get("p99_tpot_ms", float("inf")) < TPOT_P99_SLO_MS
    return ttft_ok and tpot_ok


def slo_status(data: dict) -> str:
    """Return SLO status string."""
    ttft = data.get("p99_ttft_ms", float("inf"))
    tpot = data.get("p99_tpot_ms", float("inf"))
    ttft_ok = ttft < TTFT_P99_SLO_MS
    tpot_ok = tpot < TPOT_P99_SLO_MS
    if ttft_ok and tpot_ok:
        return "PASS"
    failures = []
    if not ttft_ok:
        failures.append("TTFT")
    if not tpot_ok:
        failures.append("TPOT")
    return f"FAIL ({'+'.join(failures)})"


def max_slo_rate(rates: dict[float, dict]) -> float | None:
    """Find highest request rate that passes both SLOs."""
    passing = [r for r, d in sorted(rates.items()) if slo_pass(d)]
    return passing[-1] if passing else None


def fmt_ms(v: float | None) -> str:
    if v is None:
        return "N/A"
    return f"{v:.0f}" if v >= 10 else f"{v:.1f}"


def fmt_rate(v: float | None) -> str:
    return f"{v:.2f}" if v is not None else "N/A"


def main():
    args = parse_args()
    phase1_labels = [l.strip() for l in args.phase1_labels.split(",") if l.strip()]

    now = datetime.now(timezone.utc)

    # ── Load baseline ─────────────────────────────────────────────────────────
    baseline_dir = os.path.join(args.results_dir, args.baseline_label, args.baseline_timestamp)
    if not os.path.isdir(baseline_dir):
        print(f"ERROR: Baseline directory not found: {baseline_dir}", file=sys.stderr)
        sys.exit(1)

    baseline_rates = load_rates(baseline_dir)
    if not baseline_rates:
        print(f"ERROR: No rate-*.json files in {baseline_dir}", file=sys.stderr)
        sys.exit(1)

    baseline_max_rate = max_slo_rate(baseline_rates)
    baseline_kv_cache = extract_kv_cache_info(baseline_dir)

    # ── Load Phase 1 combos ──────────────────────────────────────────────────
    combos: dict[str, dict] = {}  # label -> {rates, timestamp, dir, kv_cache, max_rate}

    for label in phase1_labels:
        ts = find_latest_timestamp(args.results_dir, label)
        if ts is None:
            print(f"WARNING: No results found for {label}, skipping", file=sys.stderr)
            continue
        result_dir = os.path.join(args.results_dir, label, ts)
        rates = load_rates(result_dir)
        if not rates:
            print(f"WARNING: No rate-*.json files for {label}/{ts}, skipping", file=sys.stderr)
            continue
        combos[label] = {
            "rates": rates,
            "timestamp": ts,
            "dir": result_dir,
            "kv_cache": extract_kv_cache_info(result_dir),
            "max_rate": max_slo_rate(rates),
        }

    if not combos:
        print("ERROR: No Phase 1 results found", file=sys.stderr)
        sys.exit(1)

    # ── Collect all rates across all combos ───────────────────────────────────
    all_rates = sorted(set(
        list(baseline_rates.keys()) +
        [r for c in combos.values() for r in c["rates"].keys()]
    ))

    # ── Build report ──────────────────────────────────────────────────────────
    md = []
    md.append("# Phase 1 Parameter Tuning — Benchmark Report")
    md.append("")
    md.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    md.append("")

    # ── Configuration table ───────────────────────────────────────────────────
    md.append("## Configuration")
    md.append("")
    md.append("| # | Label | gpu-memory-util | max-num-batched-tokens | max-num-seqs | KV Cache | Description |")
    md.append("|:-:|-------|:-:|:-:|:-:|--------|-------------|")

    # Baseline row
    md.append(
        f"| 0 | {args.baseline_label} (baseline) | 0.9 | 8192 | 1024 "
        f"| {baseline_kv_cache} | Phase 0 custom dataset baseline |"
    )

    for i, label in enumerate(phase1_labels, 1):
        params = COMBO_PARAMS.get(label, {})
        kv_cache = combos[label]["kv_cache"] if label in combos else "N/A"
        md.append(
            f"| {i} | {label} "
            f"| {params.get('gpu_memory_utilization', 'N/A')} "
            f"| {params.get('max_num_batched_tokens', 'N/A')} "
            f"| {params.get('max_num_seqs', 'N/A')} "
            f"| {kv_cache} "
            f"| {params.get('description', '')} |"
        )
    md.append("")

    # ── SLO targets ───────────────────────────────────────────────────────────
    md.append("## SLO Targets")
    md.append("")
    md.append(f"| Metric | Target |")
    md.append(f"|--------|--------|")
    md.append(f"| TTFT p99 | < {TTFT_P99_SLO_MS:.0f}ms |")
    md.append(f"| TPOT p99 | < {TPOT_P99_SLO_MS:.0f}ms |")
    md.append("")

    # ── Side-by-side results at key rates ─────────────────────────────────────
    md.append("## Results — TTFT p99 (ms)")
    md.append("")

    # Header
    header = "| Rate |"
    sep = "|-----:|"
    header += f" {args.baseline_label} |"
    sep += "--------:|"
    for label in phase1_labels:
        if label in combos:
            header += f" {label} |"
            sep += "--------:|"
    md.append(header)
    md.append(sep)

    for rate in all_rates:
        row = f"| {rate:.2f} |"
        bd = baseline_rates.get(rate)
        val = fmt_ms(bd["p99_ttft_ms"]) if bd else "—"
        row += f" {val} |"
        for label in phase1_labels:
            if label not in combos:
                continue
            cd = combos[label]["rates"].get(rate)
            val = fmt_ms(cd["p99_ttft_ms"]) if cd else "—"
            row += f" {val} |"
        md.append(row)
    md.append("")

    # ── TPOT p99 table ────────────────────────────────────────────────────────
    md.append("## Results — TPOT p99 (ms)")
    md.append("")

    header = "| Rate |"
    sep = "|-----:|"
    header += f" {args.baseline_label} |"
    sep += "--------:|"
    for label in phase1_labels:
        if label in combos:
            header += f" {label} |"
            sep += "--------:|"
    md.append(header)
    md.append(sep)

    for rate in all_rates:
        row = f"| {rate:.2f} |"
        bd = baseline_rates.get(rate)
        val = fmt_ms(bd["p99_tpot_ms"]) if bd else "—"
        row += f" {val} |"
        for label in phase1_labels:
            if label not in combos:
                continue
            cd = combos[label]["rates"].get(rate)
            val = fmt_ms(cd["p99_tpot_ms"]) if cd else "—"
            row += f" {val} |"
        md.append(row)
    md.append("")

    # ── Throughput table ──────────────────────────────────────────────────────
    md.append("## Results — Output Throughput (tok/s)")
    md.append("")

    header = "| Rate |"
    sep = "|-----:|"
    header += f" {args.baseline_label} |"
    sep += "--------:|"
    for label in phase1_labels:
        if label in combos:
            header += f" {label} |"
            sep += "--------:|"
    md.append(header)
    md.append(sep)

    for rate in all_rates:
        row = f"| {rate:.2f} |"
        bd = baseline_rates.get(rate)
        val = f"{bd['output_throughput']:.0f}" if bd else "—"
        row += f" {val} |"
        for label in phase1_labels:
            if label not in combos:
                continue
            cd = combos[label]["rates"].get(rate)
            val = f"{cd['output_throughput']:.0f}" if cd else "—"
            row += f" {val} |"
        md.append(row)
    md.append("")

    # ── Max concurrent requests table ─────────────────────────────────────────
    md.append("## Results — Max Concurrent Requests")
    md.append("")

    header = "| Rate |"
    sep = "|-----:|"
    header += f" {args.baseline_label} |"
    sep += "--------:|"
    for label in phase1_labels:
        if label in combos:
            header += f" {label} |"
            sep += "--------:|"
    md.append(header)
    md.append(sep)

    for rate in all_rates:
        row = f"| {rate:.2f} |"
        bd = baseline_rates.get(rate)
        val = str(bd["max_concurrent_requests"]) if bd else "—"
        row += f" {val} |"
        for label in phase1_labels:
            if label not in combos:
                continue
            cd = combos[label]["rates"].get(rate)
            val = str(cd["max_concurrent_requests"]) if cd else "—"
            row += f" {val} |"
        md.append(row)
    md.append("")

    # ── SLO Compliance Matrix ─────────────────────────────────────────────────
    md.append("## SLO Compliance Matrix")
    md.append("")
    md.append(f"PASS = TTFT p99 < {TTFT_P99_SLO_MS:.0f}ms AND TPOT p99 < {TPOT_P99_SLO_MS:.0f}ms")
    md.append("")

    header = "| Rate |"
    sep = "|-----:|"
    header += f" {args.baseline_label} |"
    sep += "--------|"
    for label in phase1_labels:
        if label in combos:
            header += f" {label} |"
            sep += "--------|"
    md.append(header)
    md.append(sep)

    for rate in all_rates:
        row = f"| {rate:.2f} |"
        bd = baseline_rates.get(rate)
        val = slo_status(bd) if bd else "—"
        row += f" {val} |"
        for label in phase1_labels:
            if label not in combos:
                continue
            cd = combos[label]["rates"].get(rate)
            val = slo_status(cd) if cd else "—"
            row += f" {val} |"
        md.append(row)
    md.append("")

    # ── Winner Identification ─────────────────────────────────────────────────
    md.append("## Winner Identification")
    md.append("")

    # Collect max SLO-compliant rate for each combo
    results = []
    results.append((args.baseline_label, baseline_max_rate, "—"))

    for label in phase1_labels:
        if label not in combos:
            continue
        mr = combos[label]["max_rate"]
        if mr is not None and baseline_max_rate is not None and baseline_max_rate > 0:
            improvement = (mr - baseline_max_rate) / baseline_max_rate * 100
            results.append((label, mr, f"{improvement:+.0f}%"))
        else:
            results.append((label, mr, "N/A"))

    md.append("| Label | Max SLO-Compliant Rate | Capacity vs Baseline |")
    md.append("|-------|:----------------------:|:--------------------:|")
    for label, mr, imp in results:
        rate_str = fmt_rate(mr) if mr is not None else "None (all rates fail)"
        marker = ""
        if label != args.baseline_label and mr is not None:
            # Check if this is the winner
            all_max = [c["max_rate"] for c in combos.values() if c["max_rate"] is not None]
            if all_max and mr == max(all_max):
                marker = " **WINNER**"
        md.append(f"| {label}{marker} | {rate_str} | {imp} |")
    md.append("")

    # Find overall winner
    winner_label = None
    winner_rate = baseline_max_rate or 0
    for label in phase1_labels:
        if label not in combos:
            continue
        mr = combos[label]["max_rate"]
        if mr is not None and mr > winner_rate:
            winner_rate = mr
            winner_label = label

    if winner_label and baseline_max_rate:
        improvement = (winner_rate - baseline_max_rate) / baseline_max_rate * 100
        md.append(f"**Winner: {winner_label}** at {winner_rate:.2f} RPS "
                   f"({improvement:+.0f}% vs baseline {baseline_max_rate:.2f} RPS)")
    elif winner_label:
        md.append(f"**Winner: {winner_label}** at {winner_rate:.2f} RPS")
    else:
        md.append("**No combo improved over baseline.**")
    md.append("")

    # ── Detailed comparison at baseline's max rate ────────────────────────────
    if baseline_max_rate and baseline_max_rate in baseline_rates:
        md.append(f"## Detailed Comparison at Baseline Max Rate ({baseline_max_rate:.2f} RPS)")
        md.append("")
        md.append("| Metric | " + " | ".join(
            [args.baseline_label] +
            [l for l in phase1_labels if l in combos]
        ) + " |")
        md.append("|--------|" + "|".join(
            ["--------:"] * (1 + len([l for l in phase1_labels if l in combos]))
        ) + "|")

        bd = baseline_rates[baseline_max_rate]
        metrics = [
            ("TTFT p50 (ms)", "p50_ttft_ms"),
            ("TTFT p95 (ms)", "p95_ttft_ms"),
            ("TTFT p99 (ms)", "p99_ttft_ms"),
            ("TPOT p50 (ms)", "p50_tpot_ms"),
            ("TPOT p95 (ms)", "p95_tpot_ms"),
            ("TPOT p99 (ms)", "p99_tpot_ms"),
            ("ITL p50 (ms)", "p50_itl_ms"),
            ("ITL p99 (ms)", "p99_itl_ms"),
            ("Max Concurrent", "max_concurrent_requests"),
            ("Output tok/s", "output_throughput"),
            ("Completed", "completed"),
            ("Failed", "failed"),
        ]

        for name, key in metrics:
            row = f"| {name} |"
            bv = bd.get(key)
            if isinstance(bv, float):
                row += f" {fmt_ms(bv)} |"
            else:
                row += f" {bv} |"
            for label in phase1_labels:
                if label not in combos:
                    continue
                cd = combos[label]["rates"].get(baseline_max_rate)
                if cd:
                    cv = cd.get(key)
                    if isinstance(cv, float):
                        row += f" {fmt_ms(cv)} |"
                    else:
                        row += f" {cv} |"
                else:
                    row += " — |"
            md.append(row)
        md.append("")

    # ── Key Observations (placeholder) ────────────────────────────────────────
    md.append("## Key Observations")
    md.append("")
    md.append("*To be filled in after reviewing results.*")
    md.append("")

    # ── Workload Parameters ───────────────────────────────────────────────────
    md.append("## Workload Parameters")
    md.append("")
    md.append("| Parameter | Value |")
    md.append("|-----------|-------|")
    md.append("| Tool | `vllm bench serve` (vLLM 0.14.1) |")
    md.append("| Dataset | Custom multi-turn conversations (avg ~5,806 input tokens) |")
    # Use first combo's first rate for prompts count
    sample = None
    for c in combos.values():
        for d in c["rates"].values():
            sample = d
            break
        if sample:
            break
    if sample:
        md.append(f"| Prompts per Rate | {sample.get('num_prompts', 'N/A')} |")
    md.append(f"| Request Rates | {', '.join(f'{r:.2f}' for r in all_rates)} RPS |")
    md.append("| Arrival Distribution | Poisson (burstiness=1.0) |")
    md.append("| Warm-up | 10 prompts at 0.5 RPS, 15s cooldown |")
    md.append("| Cooldown Between Rates | 30s |")
    md.append("")

    # ── Write output ──────────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        f.write("\n".join(md))
        f.write("\n")

    print(f"Report written to: {args.output}")
    print(f"  Baseline: {args.baseline_label}/{args.baseline_timestamp} "
          f"(max SLO rate: {fmt_rate(baseline_max_rate)})")
    for label in phase1_labels:
        if label in combos:
            mr = combos[label]["max_rate"]
            print(f"  {label}/{combos[label]['timestamp']}: max SLO rate {fmt_rate(mr)}")
        else:
            print(f"  {label}: NOT FOUND")
    if winner_label:
        print(f"  Winner: {winner_label}")


if __name__ == "__main__":
    main()
