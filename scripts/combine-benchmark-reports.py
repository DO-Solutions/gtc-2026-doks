#!/usr/bin/env python3
"""Combine multiple benchmark reference JSONs into an averaged baseline report.

Reads N reference JSON files (from generate-benchmark-report.py), averages all
metrics per concurrency level, and outputs a combined report + reference JSON.

Usage:
    python3 scripts/combine-benchmark-reports.py \
        --input dev/benchmark-reference-*.json \
        --output-dir dev \
        --model "Llama 3.1 70B Instruct FP8" \
        --gpu "3x H200 (3 nodes)" \
        --workers "3x TP=1" \
        --backend "TensorRT-LLM via Dynamo" \
        --extra-config "Max batch size: 64"
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone


def parse_args():
    p = argparse.ArgumentParser(description="Combine benchmark references into averaged baseline")
    p.add_argument("--input", required=True, help="Reference JSON file glob pattern")
    p.add_argument("--output-dir", default="dev", help="Output directory")
    p.add_argument("--model", default="Llama 3.1 70B Instruct FP8")
    p.add_argument("--gpu", default="3x H200 (3 nodes)")
    p.add_argument("--workers", default="3x TP=1")
    p.add_argument("--backend", default="TensorRT-LLM via Dynamo")
    p.add_argument("--extra-config", action="append", default=[])
    return p.parse_args()


def avg(values):
    """Average a list of floats, ignoring None."""
    valid = [v for v in values if v is not None]
    if not valid:
        return None
    return sum(valid) / len(valid)


def fmt_ms(v):
    return f"{v:.0f}ms" if v is not None else "N/A"


def fmt_pct(v):
    return f"{v:.1f}%" if v is not None else "N/A"


def fmt_tops(v):
    return f"{v:.1f}" if v is not None else "N/A"


def pct_improvement(rr, kv):
    if rr is None or kv is None or rr == 0:
        return None
    return round((rr - kv) / rr * 100, 1)


METRICS = [
    "ttft_p50_ms", "ttft_p95_ms", "kv_hit_rate_pct", "tops",
    "tpot_p50_ms", "tpot_p95_ms", "latency_p50_ms", "latency_p95_ms",
]


def main():
    args = parse_args()

    files = sorted(glob.glob(args.input))
    if not files:
        print(f"ERROR: No files matching '{args.input}'", file=sys.stderr)
        sys.exit(1)

    print(f"Combining {len(files)} reference files:")
    for f in files:
        print(f"  {f}")

    # Load all reference JSONs
    refs = []
    for path in files:
        with open(path) as f:
            refs.append(json.load(f))

    # Detect mode (dual-mode vs single-mode) from first file
    first_level = refs[0]["levels"][0]
    is_dual = "round_robin" in first_level and "kv_aware" in first_level

    if not is_dual:
        print("ERROR: Only dual-mode (A/B comparison) references are supported", file=sys.stderr)
        sys.exit(1)

    # Collect concurrency levels
    concurrencies = sorted(set(
        level["concurrency"]
        for ref in refs
        for level in ref["levels"]
    ))

    # Average metrics across sweeps for each concurrency level
    averaged = {}
    for conc in concurrencies:
        averaged[conc] = {"round_robin": {}, "kv_aware": {}}
        for mode in ("round_robin", "kv_aware"):
            for metric in METRICS:
                values = []
                for ref in refs:
                    for level in ref["levels"]:
                        if level["concurrency"] == conc:
                            values.append(level[mode].get(metric))
                            break
                averaged[conc][mode][metric] = round(avg(values), 1) if avg(values) is not None else None

    # Build output
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    n = len(refs)

    # JSON reference
    json_levels = []
    for conc in concurrencies:
        entry = {"concurrency": conc}
        for mode in ("round_robin", "kv_aware"):
            entry[mode] = {k: averaged[conc][mode][k] for k in METRICS}
        json_levels.append(entry)

    json_data = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "type": "averaged_baseline",
        "num_sweeps": n,
        "source_files": [os.path.basename(f) for f in files],
        "metric": "loadgen_ttft_all_seconds",
        "target_rps": refs[0].get("target_rps", 10.0),
        "levels": json_levels,
    }

    # Markdown report
    md = []
    md.append("# Baseline Benchmark: KV Cache Routing vs Round-Robin (Averaged)")
    md.append("")
    md.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    md.append("")
    md.append(f"**Averaged across {n} sweeps** for statistical confidence.")
    md.append("")
    md.append("Source sweeps:")
    for f in files:
        md.append(f"- `{os.path.basename(f)}`")
    md.append("")

    # Methodology
    md.append("## Test Methodology")
    md.append("")
    md.append("- **Routing modes:** Round-robin (baseline) vs KV cache-aware")
    md.append(f"- **Concurrency levels:** {', '.join(str(c) for c in concurrencies)}")
    md.append(f"- **Target RPS:** {refs[0].get('target_rps', 10.0)}")
    md.append("- **Warmup:** 60s per level (Summary window flush)")
    md.append("- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)")
    md.append("- **Workload:** Multi-turn chat (3-5 turns per conversation)")
    md.append(f"- **Sweeps:** {n} independent runs, results averaged")
    md.append("- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)")
    md.append("")

    # Deployment
    md.append("## Deployment Details")
    md.append("")
    md.append("| Parameter | Value |")
    md.append("|:----------|:------|")
    md.append(f"| Model | {args.model} |")
    md.append(f"| GPU | {args.gpu} |")
    md.append(f"| Workers | {args.workers} |")
    md.append(f"| Backend | {args.backend} |")
    md.append("| Frontend | Dynamo Frontend (Rust) |")
    for extra in args.extra_config:
        if ":" in extra:
            key, val = extra.split(":", 1)
            md.append(f"| {key.strip()} | {val.strip()} |")
    md.append("")

    # Results table
    md.append("## Results")
    md.append("")
    md.append("| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |")
    md.append("|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|")

    improvements_p50 = []

    for conc in concurrencies:
        rr = averaged[conc]["round_robin"]
        kv = averaged[conc]["kv_aware"]

        imp_p50 = pct_improvement(rr["ttft_p50_ms"], kv["ttft_p50_ms"])
        imp_p95 = pct_improvement(rr["ttft_p95_ms"], kv["ttft_p95_ms"])

        if imp_p50 is not None:
            improvements_p50.append((conc, imp_p50))

        md.append(
            f"| {conc} "
            f"| {fmt_ms(rr['ttft_p50_ms'])} "
            f"| {fmt_ms(kv['ttft_p50_ms'])} "
            f"| {fmt_pct(imp_p50)} "
            f"| {fmt_ms(rr['ttft_p95_ms'])} "
            f"| {fmt_ms(kv['ttft_p95_ms'])} "
            f"| {fmt_pct(imp_p95)} "
            f"| {fmt_pct(rr['kv_hit_rate_pct'])} "
            f"| {fmt_pct(kv['kv_hit_rate_pct'])} |"
        )
    md.append("")

    # Throughput
    md.append("### Throughput (Output Tokens/s)")
    md.append("")
    md.append("| Concurrency | RR TOPS | KV TOPS | Improvement |")
    md.append("|:-----------:|:-------:|:-------:|:-----------:|")
    for conc in concurrencies:
        rr = averaged[conc]["round_robin"]
        kv = averaged[conc]["kv_aware"]
        imp = pct_improvement(-rr["tops"], -kv["tops"]) if rr["tops"] and kv["tops"] else None
        # For TOPS, higher is better, so improvement = (kv - rr) / rr * 100
        if rr["tops"] and kv["tops"]:
            imp = round((kv["tops"] - rr["tops"]) / rr["tops"] * 100, 1)
        md.append(
            f"| {conc} "
            f"| {fmt_tops(rr['tops'])} "
            f"| {fmt_tops(kv['tops'])} "
            f"| {fmt_pct(imp)} |"
        )
    md.append("")

    # TPOT
    md.append("### TPOT -- Time Per Output Token (ITL)")
    md.append("")
    md.append("| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |")
    md.append("|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|")
    for conc in concurrencies:
        rr = averaged[conc]["round_robin"]
        kv = averaged[conc]["kv_aware"]
        md.append(
            f"| {conc} "
            f"| {fmt_ms(rr['tpot_p50_ms'])} "
            f"| {fmt_ms(kv['tpot_p50_ms'])} "
            f"| {fmt_ms(rr['tpot_p95_ms'])} "
            f"| {fmt_ms(kv['tpot_p95_ms'])} |"
        )
    md.append("")

    # End-to-End Latency
    md.append("### End-to-End Latency")
    md.append("")
    md.append("| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |")
    md.append("|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|")
    for conc in concurrencies:
        rr = averaged[conc]["round_robin"]
        kv = averaged[conc]["kv_aware"]
        md.append(
            f"| {conc} "
            f"| {fmt_ms(rr['latency_p50_ms'])} "
            f"| {fmt_ms(kv['latency_p50_ms'])} "
            f"| {fmt_ms(rr['latency_p95_ms'])} "
            f"| {fmt_ms(kv['latency_p95_ms'])} |"
        )
    md.append("")

    # Summary
    md.append("## Summary")
    md.append("")

    if improvements_p50:
        lowest_conc, lowest_imp = improvements_p50[0]
        highest_conc, highest_imp = improvements_p50[-1]
        max_conc, max_imp = max(improvements_p50, key=lambda x: x[1])
        avg_imp = round(sum(x[1] for x in improvements_p50) / len(improvements_p50), 1)

        md.append(f"- **Average TTFT p50 improvement across all concurrency levels:** {fmt_pct(avg_imp)}")
        md.append(f"- **Peak TTFT p50 improvement:** {fmt_pct(max_imp)} at concurrency {max_conc}")
        md.append(f"- **TTFT p50 improvement range:** {fmt_pct(min(x[1] for x in improvements_p50))} to {fmt_pct(max_imp)}")

        kv_hits = [averaged[c]["kv_aware"]["kv_hit_rate_pct"] for c in concurrencies if averaged[c]["kv_aware"]["kv_hit_rate_pct"]]
        rr_hits = [averaged[c]["round_robin"]["kv_hit_rate_pct"] for c in concurrencies if averaged[c]["round_robin"]["kv_hit_rate_pct"]]
        if kv_hits:
            md.append(f"- **KV cache hit rate (KV mode):** {fmt_pct(min(kv_hits))} to {fmt_pct(max(kv_hits))}, average {fmt_pct(sum(kv_hits)/len(kv_hits))}")
        if rr_hits:
            md.append(f"- **KV cache hit rate (RR mode):** {fmt_pct(min(rr_hits))} to {fmt_pct(max(rr_hits))}, average {fmt_pct(sum(rr_hits)/len(rr_hits))}")

        kv_tops = [averaged[c]["kv_aware"]["tops"] for c in concurrencies if averaged[c]["kv_aware"]["tops"]]
        rr_tops = [averaged[c]["round_robin"]["tops"] for c in concurrencies if averaged[c]["round_robin"]["tops"]]
        if kv_tops and rr_tops:
            md.append(f"- **Peak throughput (KV):** {fmt_tops(max(kv_tops))} tokens/s at concurrency {concurrencies[kv_tops.index(max(kv_tops))]}")
            md.append(f"- **Peak throughput (RR):** {fmt_tops(max(rr_tops))} tokens/s at concurrency {concurrencies[rr_tops.index(max(rr_tops))]}")

    md.append("")

    # JSON reference block
    md.append("## Reference Data (JSON)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(json_data, indent=2))
    md.append("```")
    md.append("")

    # Write files
    os.makedirs(args.output_dir, exist_ok=True)

    md_path = os.path.join(args.output_dir, f"benchmark-baseline-{timestamp}.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md))
    print(f"Report:    {md_path}")

    json_path = os.path.join(args.output_dir, f"benchmark-baseline-{timestamp}.json")
    with open(json_path, "w") as f:
        json.dump(json_data, f, indent=2)
        f.write("\n")
    print(f"Reference: {json_path}")


if __name__ == "__main__":
    main()
