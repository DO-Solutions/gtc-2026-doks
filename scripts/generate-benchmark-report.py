#!/usr/bin/env python3
"""Generate markdown report + JSON reference from benchmark sweep TSV.

Usage:
    python3 scripts/generate-benchmark-report.py --input dev/benchmark-sweep-*.tsv --output-dir dev
"""

import argparse
import csv
import glob
import json
import math
import os
import sys
from datetime import datetime, timezone


def parse_args():
    p = argparse.ArgumentParser(description="Generate benchmark report from sweep TSV")
    p.add_argument("--input", required=True, help="TSV file path (supports glob)")
    p.add_argument("--output-dir", default="dev", help="Output directory (default: dev)")
    return p.parse_args()


def resolve_input(pattern: str) -> str:
    matches = sorted(glob.glob(pattern))
    if not matches:
        print(f"ERROR: No files matching '{pattern}'", file=sys.stderr)
        sys.exit(1)
    # Use the most recent (last alphabetically, since filenames include timestamps)
    return matches[-1]


def read_tsv(path: str) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            rows.append(row)
    return rows


def safe_float(v: str) -> float | None:
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return None


def sec_to_ms(v: float | None) -> float | None:
    return round(v * 1000, 1) if v is not None else None


def pct_improvement(rr: float | None, kv: float | None) -> float | None:
    if rr is None or kv is None or rr == 0:
        return None
    return round((rr - kv) / rr * 100, 1)


def fmt_ms(v: float | None) -> str:
    return f"{v:.0f}ms" if v is not None else "N/A"


def fmt_pct(v: float | None) -> str:
    return f"{v:.1f}%" if v is not None else "N/A"


def fmt_ratio_pct(v: float | None) -> str:
    """Format a 0-1 ratio as a percentage (e.g., 0.955 → '95.5%')."""
    return f"{v * 100:.1f}%" if v is not None else "N/A"


def fmt_tops(v: float | None) -> str:
    return f"{v:.1f}" if v is not None else "N/A"


def main():
    args = parse_args()
    tsv_path = resolve_input(args.input)
    print(f"Reading: {tsv_path}")

    rows = read_tsv(tsv_path)
    if not rows:
        print("ERROR: TSV file is empty", file=sys.stderr)
        sys.exit(1)

    # Group by concurrency, keyed by mode
    levels: dict[int, dict[str, dict]] = {}
    for row in rows:
        conc = int(row["concurrency"])
        mode = row["mode"]
        if conc not in levels:
            levels[conc] = {}
        levels[conc][mode] = {
            "ttft_p50_sec": safe_float(row["ttft_p50_sec"]),
            "ttft_p95_sec": safe_float(row["ttft_p95_sec"]),
            "kv_hit_rate": safe_float(row["kv_hit_rate"]),
            "error_pct": safe_float(row["error_pct"]),
            "actual_rps": safe_float(row["actual_rps"]),
            "tops": safe_float(row.get("tops")),
            "rps": safe_float(row["rps"]),
        }

    sorted_conc = sorted(levels.keys())
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d-%H%M%S")

    # ── Build JSON reference ──────────────────────────────────────────────────
    json_levels = []
    for conc in sorted_conc:
        entry: dict = {"concurrency": conc}
        rr = levels[conc].get("round_robin", {})
        kv = levels[conc].get("kv", {})
        entry["round_robin"] = {
            "ttft_p50_ms": sec_to_ms(rr.get("ttft_p50_sec")),
            "ttft_p95_ms": sec_to_ms(rr.get("ttft_p95_sec")),
            "kv_hit_rate_pct": round((rr.get("kv_hit_rate", 0) or 0) * 100, 1),
            "tops": rr.get("tops"),
        }
        entry["kv_aware"] = {
            "ttft_p50_ms": sec_to_ms(kv.get("ttft_p50_sec")),
            "ttft_p95_ms": sec_to_ms(kv.get("ttft_p95_sec")),
            "kv_hit_rate_pct": round((kv.get("kv_hit_rate", 0) or 0) * 100, 1),
            "tops": kv.get("tops"),
        }
        json_levels.append(entry)

    rps_val = None
    for row in rows:
        rps_val = safe_float(row["rps"])
        if rps_val is not None:
            break

    json_data = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": "Llama-3.1-70B-Instruct-FP8",
        "metric": "loadgen_ttft_all_seconds",
        "target_rps": rps_val,
        "levels": json_levels,
    }

    # ── Build markdown report ─────────────────────────────────────────────────
    md_lines = []
    md_lines.append(f"# Benchmark Sweep: KV Cache Routing vs Round-Robin")
    md_lines.append(f"")
    md_lines.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    md_lines.append(f"")

    # Methodology
    md_lines.append(f"## Test Methodology")
    md_lines.append(f"")
    md_lines.append(f"- **Routing modes:** Round-robin (baseline) vs KV cache-aware")
    md_lines.append(f"- **Concurrency levels:** {', '.join(str(c) for c in sorted_conc)}")
    md_lines.append(f"- **Target RPS:** {rps_val}")
    md_lines.append(f"- **Warmup:** per level (Summary window flush)")
    md_lines.append(f"- **Measurement:** 3 snapshots averaged per level")
    md_lines.append(f"- **Workload:** Multi-turn chat (3-5 turns per conversation)")
    md_lines.append(f"- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)")
    md_lines.append(f"")

    # Deployment
    md_lines.append(f"## Deployment Details")
    md_lines.append(f"")
    md_lines.append(f"| Parameter | Value |")
    md_lines.append(f"|:----------|:------|")
    md_lines.append(f"| Model | Llama 3.1 70B Instruct FP8 |")
    md_lines.append(f"| GPUs | 8x H100 (1 node) |")
    md_lines.append(f"| Replicas | 4x TP=2 |")
    md_lines.append(f"| Backend | TensorRT-LLM via Dynamo |")
    md_lines.append(f"| Frontend | Dynamo Frontend (Rust) |")
    md_lines.append(f"| Max batch size | 64 |")
    md_lines.append(f"| Free GPU memory fraction | 0.85 |")
    md_lines.append(f"| KV cache dtype | FP8 |")
    md_lines.append(f"| Chunked prefill | Enabled |")
    md_lines.append(f"")

    # Results table
    md_lines.append(f"## Results")
    md_lines.append(f"")
    md_lines.append(f"| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |")
    md_lines.append(f"|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|")

    improvements_p50 = []
    improvements_p95 = []
    kv_hit_rates = []
    rr_hit_rates = []

    for conc in sorted_conc:
        rr = levels[conc].get("round_robin", {})
        kv = levels[conc].get("kv", {})

        rr_p50 = sec_to_ms(rr.get("ttft_p50_sec"))
        kv_p50 = sec_to_ms(kv.get("ttft_p50_sec"))
        rr_p95 = sec_to_ms(rr.get("ttft_p95_sec"))
        kv_p95 = sec_to_ms(kv.get("ttft_p95_sec"))
        rr_hit = rr.get("kv_hit_rate")
        kv_hit = kv.get("kv_hit_rate")

        imp_p50 = pct_improvement(rr_p50, kv_p50)
        imp_p95 = pct_improvement(rr_p95, kv_p95)

        if imp_p50 is not None:
            improvements_p50.append((conc, imp_p50))
        if imp_p95 is not None:
            improvements_p95.append((conc, imp_p95))
        if kv_hit is not None:
            kv_hit_rates.append((conc, kv_hit))
        if rr_hit is not None:
            rr_hit_rates.append((conc, rr_hit))

        md_lines.append(
            f"| {conc} "
            f"| {fmt_ms(rr_p50)} "
            f"| {fmt_ms(kv_p50)} "
            f"| {fmt_pct(imp_p50)} "
            f"| {fmt_ms(rr_p95)} "
            f"| {fmt_ms(kv_p95)} "
            f"| {fmt_pct(imp_p95)} "
            f"| {fmt_ratio_pct(rr_hit)} "
            f"| {fmt_ratio_pct(kv_hit)} |"
        )

    md_lines.append(f"")

    # Error rates
    md_lines.append(f"### Error Rates")
    md_lines.append(f"")
    md_lines.append(f"| Concurrency | RR Error % | KV Error % |")
    md_lines.append(f"|:-----------:|:----------:|:----------:|")
    for conc in sorted_conc:
        rr = levels[conc].get("round_robin", {})
        kv = levels[conc].get("kv", {})
        md_lines.append(
            f"| {conc} "
            f"| {fmt_pct(rr.get('error_pct'))} "
            f"| {fmt_pct(kv.get('error_pct'))} |"
        )
    md_lines.append(f"")

    # Throughput table (only if tops data exists)
    has_tops = any(
        levels[c].get(m, {}).get("tops") is not None
        for c in sorted_conc
        for m in ("round_robin", "kv")
    )
    if has_tops:
        md_lines.append(f"### Throughput (Output Tokens/s)")
        md_lines.append(f"")
        md_lines.append(f"| Concurrency | RR TOPS | KV TOPS |")
        md_lines.append(f"|:-----------:|:-------:|:-------:|")
        for conc in sorted_conc:
            rr = levels[conc].get("round_robin", {})
            kv = levels[conc].get("kv", {})
            md_lines.append(
                f"| {conc} "
                f"| {fmt_tops(rr.get('tops'))} "
                f"| {fmt_tops(kv.get('tops'))} |"
            )
        md_lines.append(f"")

    # JSON reference block
    md_lines.append(f"## Reference Data (JSON)")
    md_lines.append(f"")
    md_lines.append(f"```json")
    md_lines.append(json.dumps(json_data, indent=2))
    md_lines.append(f"```")
    md_lines.append(f"")

    # Summary narrative
    md_lines.append(f"## Summary")
    md_lines.append(f"")

    if improvements_p50:
        lowest_conc, lowest_imp = improvements_p50[0]
        highest_conc, highest_imp = improvements_p50[-1]
        max_conc, max_imp = max(improvements_p50, key=lambda x: x[1])

        md_lines.append(
            f"- **TTFT p50 improvement at lowest concurrency ({lowest_conc}):** {fmt_pct(lowest_imp)}"
        )
        md_lines.append(
            f"- **TTFT p50 improvement at highest concurrency ({highest_conc}):** {fmt_pct(highest_imp)}"
        )

        if len(improvements_p50) > 1:
            if highest_imp > lowest_imp:
                md_lines.append(
                    f"- **Trend:** The TTFT improvement from KV-aware routing **increases** with concurrency "
                    f"({fmt_pct(lowest_imp)} at {lowest_conc} → {fmt_pct(highest_imp)} at {highest_conc}), "
                    f"as expected — higher load means more conversations competing for cache, "
                    f"making routing intelligence more valuable."
                )
            elif highest_imp < lowest_imp:
                md_lines.append(
                    f"- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency "
                    f"({fmt_pct(lowest_imp)} at {lowest_conc} → {fmt_pct(highest_imp)} at {highest_conc}). "
                    f"This may indicate cache pressure at higher loads."
                )
            else:
                md_lines.append(
                    f"- **Trend:** The TTFT improvement is **consistent** across concurrency levels."
                )

        md_lines.append(
            f"- **Peak benefit:** Concurrency {max_conc} shows the maximum p50 improvement at {fmt_pct(max_imp)}."
        )

    if kv_hit_rates:
        avg_hit = sum(h for _, h in kv_hit_rates) / len(kv_hit_rates)
        min_hit = min(kv_hit_rates, key=lambda x: x[1])
        max_hit = max(kv_hit_rates, key=lambda x: x[1])
        md_lines.append(
            f"- **KV cache hit rate (KV mode):** {fmt_ratio_pct(min_hit[1])} (at {min_hit[0]}) to "
            f"{fmt_ratio_pct(max_hit[1])} (at {max_hit[0]}), average {fmt_ratio_pct(avg_hit)}."
        )

    if rr_hit_rates:
        avg_rr_hit = sum(h for _, h in rr_hit_rates) / len(rr_hit_rates)
        min_rr_hit = min(rr_hit_rates, key=lambda x: x[1])
        max_rr_hit = max(rr_hit_rates, key=lambda x: x[1])
        md_lines.append(
            f"- **KV cache hit rate (RR mode):** {fmt_ratio_pct(min_rr_hit[1])} (at {min_rr_hit[0]}) to "
            f"{fmt_ratio_pct(max_rr_hit[1])} (at {max_rr_hit[0]}), average {fmt_ratio_pct(avg_rr_hit)}."
        )

    md_lines.append(f"")

    # ── Write files ───────────────────────────────────────────────────────────
    os.makedirs(args.output_dir, exist_ok=True)

    md_path = os.path.join(args.output_dir, f"benchmark-report-{timestamp}.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md_lines))
    print(f"Report:    {md_path}")

    json_path = os.path.join(args.output_dir, f"benchmark-reference-{timestamp}.json")
    with open(json_path, "w") as f:
        json.dump(json_data, f, indent=2)
        f.write("\n")
    print(f"Reference: {json_path}")


if __name__ == "__main__":
    main()
