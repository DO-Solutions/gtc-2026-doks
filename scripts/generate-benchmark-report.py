#!/usr/bin/env python3
"""Generate markdown report + JSON reference from benchmark sweep TSV.

Supports both single-mode (e.g., round-robin only) and dual-mode (A/B comparison)
data. Single-mode produces clean tables without N/A columns.

Usage:
    python3 scripts/generate-benchmark-report.py --input dev/benchmark-sweep-*.tsv --output-dir dev

    # With deployment details:
    python3 scripts/generate-benchmark-report.py --input dev/benchmark-sweep-*.tsv \
        --output-dir dev \
        --model "Llama 3.3 70B Instruct FP8" \
        --gpu "1x H200 (1 node)" \
        --workers "1x TP=1" \
        --backend "vLLM via Dynamo" \
        --extra-config "Speculative decoding: EAGLE-3 (3 draft tokens)" \
        --extra-config "gpu-memory-utilization: 0.90" \
        --extra-config "max-num-seqs: 64"
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
    p.add_argument("--model", default=None, help="Model name for deployment details")
    p.add_argument("--gpu", default=None, help="GPU description (e.g., '1x H200 (1 node)')")
    p.add_argument("--workers", default=None, help="Worker config (e.g., '1x TP=1')")
    p.add_argument("--backend", default=None, help="Backend description (e.g., 'vLLM via Dynamo')")
    p.add_argument(
        "--extra-config",
        action="append",
        default=[],
        help="Extra config lines for deployment table (repeatable, format: 'Key: Value')",
    )
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


def fmt_sec(v: float | None) -> str:
    return f"{v:.1f}s" if v is not None else "N/A"


def fmt_pct(v: float | None) -> str:
    return f"{v:.1f}%" if v is not None else "N/A"


def fmt_ratio_pct(v: float | None) -> str:
    """Format a 0-1 ratio as a percentage (e.g., 0.955 -> '95.5%')."""
    return f"{v * 100:.1f}%" if v is not None else "N/A"


def fmt_tops(v: float | None) -> str:
    return f"{v:.1f}" if v is not None else "N/A"


def fmt_rps(v: float | None) -> str:
    return f"{v:.2f}" if v is not None else "N/A"


def mode_label(mode: str) -> str:
    """Human-readable label for a routing mode."""
    return {"kv": "KV-aware", "round_robin": "Round-robin"}.get(mode, mode)


def build_json_single(
    sorted_conc, levels, mode, rps_val, now
) -> dict:
    """Build JSON reference for single-mode data."""
    json_levels = []
    for conc in sorted_conc:
        d = levels[conc].get(mode, {})
        entry = {
            "concurrency": conc,
            "ttft_p50_ms": sec_to_ms(d.get("ttft_p50_sec")),
            "ttft_p95_ms": sec_to_ms(d.get("ttft_p95_sec")),
            "kv_hit_rate_pct": round((d.get("kv_hit_rate", 0) or 0) * 100, 1),
            "error_pct": d.get("error_pct"),
            "actual_rps": d.get("actual_rps"),
            "tops": d.get("tops"),
            "itl_p50_ms": sec_to_ms(d.get("itl_p50_sec")),
            "itl_p95_ms": sec_to_ms(d.get("itl_p95_sec")),
            "tpot_p50_ms": sec_to_ms(d.get("tpot_p50_sec")),
            "tpot_p95_ms": sec_to_ms(d.get("tpot_p95_sec")),
            "latency_p50_ms": sec_to_ms(d.get("latency_p50_sec")),
            "latency_p95_ms": sec_to_ms(d.get("latency_p95_sec")),
        }
        json_levels.append(entry)

    return {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": mode,
        "target_rps": rps_val,
        "levels": json_levels,
    }


def build_json_dual(sorted_conc, levels, rps_val, now) -> dict:
    """Build JSON reference for dual-mode (A/B comparison) data."""
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
            "itl_p50_ms": sec_to_ms(rr.get("itl_p50_sec")),
            "itl_p95_ms": sec_to_ms(rr.get("itl_p95_sec")),
            "tpot_p50_ms": sec_to_ms(rr.get("tpot_p50_sec")),
            "tpot_p95_ms": sec_to_ms(rr.get("tpot_p95_sec")),
            "latency_p50_ms": sec_to_ms(rr.get("latency_p50_sec")),
            "latency_p95_ms": sec_to_ms(rr.get("latency_p95_sec")),
        }
        entry["kv_aware"] = {
            "ttft_p50_ms": sec_to_ms(kv.get("ttft_p50_sec")),
            "ttft_p95_ms": sec_to_ms(kv.get("ttft_p95_sec")),
            "kv_hit_rate_pct": round((kv.get("kv_hit_rate", 0) or 0) * 100, 1),
            "tops": kv.get("tops"),
            "itl_p50_ms": sec_to_ms(kv.get("itl_p50_sec")),
            "itl_p95_ms": sec_to_ms(kv.get("itl_p95_sec")),
            "tpot_p50_ms": sec_to_ms(kv.get("tpot_p50_sec")),
            "tpot_p95_ms": sec_to_ms(kv.get("tpot_p95_sec")),
            "latency_p50_ms": sec_to_ms(kv.get("latency_p50_sec")),
            "latency_p95_ms": sec_to_ms(kv.get("latency_p95_sec")),
        }
        json_levels.append(entry)

    return {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "metric": "loadgen_ttft_all_seconds",
        "target_rps": rps_val,
        "levels": json_levels,
    }


def build_deployment_table(args) -> list[str]:
    """Build deployment details table from CLI args with sensible defaults."""
    lines = []
    lines.append("## Deployment Details")
    lines.append("")
    lines.append("| Parameter | Value |")
    lines.append("|:----------|:------|")
    lines.append(f"| Model | {args.model or 'Llama 3.1 70B Instruct FP8'} |")
    lines.append(f"| GPU | {args.gpu or '1x H200 (1 node)'} |")
    lines.append(f"| Workers | {args.workers or '1x TP=1'} |")
    lines.append(f"| Backend | {args.backend or 'vLLM via Dynamo'} |")
    lines.append("| Frontend | Dynamo Frontend (Rust) |")
    for extra in args.extra_config:
        if ":" in extra:
            key, val = extra.split(":", 1)
            lines.append(f"| {key.strip()} | {val.strip()} |")
        else:
            lines.append(f"| {extra} | |")
    lines.append("")
    return lines


def build_single_mode_report(
    sorted_conc, levels, mode, rps_val, now, args, json_data
) -> list[str]:
    """Build markdown for single-mode data (Phase 0-style tables)."""
    md = []
    ml = mode_label(mode)

    md.append(f"# Benchmark Sweep: {ml} Concurrency Scaling ({sorted_conc[0]}-{sorted_conc[-1]})")
    md.append("")
    md.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    md.append("")

    # Methodology
    md.append("## Test Methodology")
    md.append("")
    md.append(f"- **Routing mode:** {ml}")
    md.append(f"- **Concurrency levels:** {', '.join(str(c) for c in sorted_conc)}")
    md.append(f"- **Target RPS:** {rps_val}")
    md.append("- **Warmup:** 60s per level (Summary window flush)")
    md.append("- **Measurement:** 300s per level (3 snapshots @ 100s, averaged)")
    md.append("- **Workload:** Multi-turn chat (3-5 turns per conversation)")
    md.append("- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)")
    md.append("")

    # Deployment
    md.extend(build_deployment_table(args))

    # Helper to get data for each concurrency level
    def d(conc):
        return levels[conc].get(mode, {})

    # ITL table
    has_itl = any(d(c).get("itl_p50_sec") is not None for c in sorted_conc)
    if has_itl:
        md.append("## ITL -- Inter-Token Latency")
        md.append("")
        md.append("| Concurrency | ITL p50 | ITL p95 | Error % |")
        md.append("|:-----------:|:-------:|:-------:|:-------:|")
        for conc in sorted_conc:
            row = d(conc)
            md.append(
                f"| {conc} "
                f"| {fmt_ms(sec_to_ms(row.get('itl_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(row.get('itl_p95_sec')))} "
                f"| {fmt_pct(row.get('error_pct'))} |"
            )
        md.append("")

    # TPOT table
    has_tpot = any(d(c).get("tpot_p50_sec") is not None for c in sorted_conc)
    if has_tpot:
        md.append("## TPOT -- Time Per Output Token")
        md.append("")
        md.append("| Concurrency | TPOT p50 | TPOT p95 |")
        md.append("|:-----------:|:--------:|:--------:|")
        for conc in sorted_conc:
            row = d(conc)
            md.append(
                f"| {conc} "
                f"| {fmt_ms(sec_to_ms(row.get('tpot_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(row.get('tpot_p95_sec')))} |"
            )
        md.append("")

    # TTFT table
    md.append("## TTFT -- Time to First Token")
    md.append("")
    md.append("| Concurrency | TTFT p50 | TTFT p95 |")
    md.append("|:-----------:|:--------:|:--------:|")
    for conc in sorted_conc:
        row = d(conc)
        md.append(
            f"| {conc} "
            f"| {fmt_ms(sec_to_ms(row.get('ttft_p50_sec')))} "
            f"| {fmt_ms(sec_to_ms(row.get('ttft_p95_sec')))} |"
        )
    md.append("")

    # End-to-End Latency table
    has_latency = any(d(c).get("latency_p50_sec") is not None for c in sorted_conc)
    if has_latency:
        md.append("## End-to-End Latency")
        md.append("")
        md.append("| Concurrency | Latency p50 | Latency p95 |")
        md.append("|:-----------:|:-----------:|:-----------:|")
        for conc in sorted_conc:
            row = d(conc)
            md.append(
                f"| {conc} "
                f"| {fmt_sec(row.get('latency_p50_sec'))} "
                f"| {fmt_sec(row.get('latency_p95_sec'))} |"
            )
        md.append("")

    # Error Rates table
    md.append("## Error Rates")
    md.append("")
    md.append("| Concurrency | Error % |")
    md.append("|:-----------:|:-------:|")
    for conc in sorted_conc:
        row = d(conc)
        md.append(f"| {conc} | {fmt_pct(row.get('error_pct'))} |")
    md.append("")

    # Actual RPS table
    has_rps = any(d(c).get("actual_rps") is not None for c in sorted_conc)
    if has_rps:
        md.append("## Actual RPS (Conversation Starts/s)")
        md.append("")
        md.append("| Concurrency | Actual RPS |")
        md.append("|:-----------:|:----------:|")
        for conc in sorted_conc:
            row = d(conc)
            md.append(f"| {conc} | {fmt_rps(row.get('actual_rps'))} |")
        md.append("")

    # Throughput table
    has_tops = any(d(c).get("tops") is not None for c in sorted_conc)
    if has_tops:
        md.append("## Throughput (Output Tokens/s)")
        md.append("")
        md.append("| Concurrency | TOPS |")
        md.append("|:-----------:|:----:|")
        for conc in sorted_conc:
            row = d(conc)
            md.append(f"| {conc} | {fmt_tops(row.get('tops'))} |")
        md.append("")

    # Reference data
    md.append("## Reference Data (JSON)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(json_data, indent=2))
    md.append("```")
    md.append("")

    return md


def build_dual_mode_report(
    sorted_conc, levels, rps_val, now, args, json_data
) -> list[str]:
    """Build markdown for dual-mode A/B comparison (original format)."""
    md = []
    md.append("# Benchmark Sweep: KV Cache Routing vs Round-Robin")
    md.append("")
    md.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    md.append("")

    # Methodology
    md.append("## Test Methodology")
    md.append("")
    md.append("- **Routing modes:** Round-robin (baseline) vs KV cache-aware")
    md.append(f"- **Concurrency levels:** {', '.join(str(c) for c in sorted_conc)}")
    md.append(f"- **Target RPS:** {rps_val}")
    md.append("- **Warmup:** per level (Summary window flush)")
    md.append("- **Measurement:** 3 snapshots averaged per level")
    md.append("- **Workload:** Multi-turn chat (3-5 turns per conversation)")
    md.append("- **Metric source:** `loadgen_ttft_all_seconds` Prometheus Summary (60s window, client-side TTFT)")
    md.append("")

    # Deployment
    md.extend(build_deployment_table(args))

    # Results table
    md.append("## Results")
    md.append("")
    md.append("| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |")
    md.append("|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|")

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

        md.append(
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

    md.append("")

    # Error rates
    md.append("### Error Rates")
    md.append("")
    md.append("| Concurrency | RR Error % | KV Error % |")
    md.append("|:-----------:|:----------:|:----------:|")
    for conc in sorted_conc:
        rr = levels[conc].get("round_robin", {})
        kv = levels[conc].get("kv", {})
        md.append(
            f"| {conc} "
            f"| {fmt_pct(rr.get('error_pct'))} "
            f"| {fmt_pct(kv.get('error_pct'))} |"
        )
    md.append("")

    # Throughput table
    has_tops = any(
        levels[c].get(m, {}).get("tops") is not None
        for c in sorted_conc
        for m in ("round_robin", "kv")
    )
    if has_tops:
        md.append("### Throughput (Output Tokens/s)")
        md.append("")
        md.append("| Concurrency | RR TOPS | KV TOPS |")
        md.append("|:-----------:|:-------:|:-------:|")
        for conc in sorted_conc:
            rr = levels[conc].get("round_robin", {})
            kv = levels[conc].get("kv", {})
            md.append(
                f"| {conc} "
                f"| {fmt_tops(rr.get('tops'))} "
                f"| {fmt_tops(kv.get('tops'))} |"
            )
        md.append("")

    # ITL table
    has_itl = any(
        levels[c].get(m, {}).get("itl_p50_sec") is not None
        for c in sorted_conc
        for m in ("round_robin", "kv")
    )
    if has_itl:
        md.append("### ITL -- Inter-Token Latency")
        md.append("")
        md.append("| Concurrency | RR ITL p50 | KV ITL p50 | RR ITL p95 | KV ITL p95 |")
        md.append("|:-----------:|:----------:|:----------:|:----------:|:----------:|")
        for conc in sorted_conc:
            rr = levels[conc].get("round_robin", {})
            kv = levels[conc].get("kv", {})
            md.append(
                f"| {conc} "
                f"| {fmt_ms(sec_to_ms(rr.get('itl_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('itl_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(rr.get('itl_p95_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('itl_p95_sec')))} |"
            )
        md.append("")

    # TPOT table
    has_tpot = any(
        levels[c].get(m, {}).get("tpot_p50_sec") is not None
        for c in sorted_conc
        for m in ("round_robin", "kv")
    )
    if has_tpot:
        md.append("### TPOT -- Time Per Output Token")
        md.append("")
        md.append("| Concurrency | RR TPOT p50 | KV TPOT p50 | RR TPOT p95 | KV TPOT p95 |")
        md.append("|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|")
        for conc in sorted_conc:
            rr = levels[conc].get("round_robin", {})
            kv = levels[conc].get("kv", {})
            md.append(
                f"| {conc} "
                f"| {fmt_ms(sec_to_ms(rr.get('tpot_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('tpot_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(rr.get('tpot_p95_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('tpot_p95_sec')))} |"
            )
        md.append("")

    # Latency table
    has_latency = any(
        levels[c].get(m, {}).get("latency_p50_sec") is not None
        for c in sorted_conc
        for m in ("round_robin", "kv")
    )
    if has_latency:
        md.append("### End-to-End Latency")
        md.append("")
        md.append("| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |")
        md.append("|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|")
        for conc in sorted_conc:
            rr = levels[conc].get("round_robin", {})
            kv = levels[conc].get("kv", {})
            md.append(
                f"| {conc} "
                f"| {fmt_ms(sec_to_ms(rr.get('latency_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('latency_p50_sec')))} "
                f"| {fmt_ms(sec_to_ms(rr.get('latency_p95_sec')))} "
                f"| {fmt_ms(sec_to_ms(kv.get('latency_p95_sec')))} |"
            )
        md.append("")

    # JSON reference block
    md.append("## Reference Data (JSON)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(json_data, indent=2))
    md.append("```")
    md.append("")

    # Summary narrative
    md.append("## Summary")
    md.append("")

    if improvements_p50:
        lowest_conc, lowest_imp = improvements_p50[0]
        highest_conc, highest_imp = improvements_p50[-1]
        max_conc, max_imp = max(improvements_p50, key=lambda x: x[1])

        md.append(
            f"- **TTFT p50 improvement at lowest concurrency ({lowest_conc}):** {fmt_pct(lowest_imp)}"
        )
        md.append(
            f"- **TTFT p50 improvement at highest concurrency ({highest_conc}):** {fmt_pct(highest_imp)}"
        )

        if len(improvements_p50) > 1:
            if highest_imp > lowest_imp:
                md.append(
                    f"- **Trend:** The TTFT improvement from KV-aware routing **increases** with concurrency "
                    f"({fmt_pct(lowest_imp)} at {lowest_conc} -> {fmt_pct(highest_imp)} at {highest_conc}), "
                    f"as expected -- higher load means more conversations competing for cache, "
                    f"making routing intelligence more valuable."
                )
            elif highest_imp < lowest_imp:
                md.append(
                    f"- **Trend:** The TTFT improvement **decreases** slightly at higher concurrency "
                    f"({fmt_pct(lowest_imp)} at {lowest_conc} -> {fmt_pct(highest_imp)} at {highest_conc}). "
                    f"This may indicate cache pressure at higher loads."
                )
            else:
                md.append(
                    "- **Trend:** The TTFT improvement is **consistent** across concurrency levels."
                )

        md.append(
            f"- **Peak benefit:** Concurrency {max_conc} shows the maximum p50 improvement at {fmt_pct(max_imp)}."
        )

    if kv_hit_rates:
        avg_hit = sum(h for _, h in kv_hit_rates) / len(kv_hit_rates)
        min_hit = min(kv_hit_rates, key=lambda x: x[1])
        max_hit = max(kv_hit_rates, key=lambda x: x[1])
        md.append(
            f"- **KV cache hit rate (KV mode):** {fmt_ratio_pct(min_hit[1])} (at {min_hit[0]}) to "
            f"{fmt_ratio_pct(max_hit[1])} (at {max_hit[0]}), average {fmt_ratio_pct(avg_hit)}."
        )

    if rr_hit_rates:
        avg_rr_hit = sum(h for _, h in rr_hit_rates) / len(rr_hit_rates)
        min_rr_hit = min(rr_hit_rates, key=lambda x: x[1])
        max_rr_hit = max(rr_hit_rates, key=lambda x: x[1])
        md.append(
            f"- **KV cache hit rate (RR mode):** {fmt_ratio_pct(min_rr_hit[1])} (at {min_rr_hit[0]}) to "
            f"{fmt_ratio_pct(max_rr_hit[1])} (at {max_rr_hit[0]}), average {fmt_ratio_pct(avg_rr_hit)}."
        )

    md.append("")

    return md


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
            "itl_p50_sec": safe_float(row.get("itl_p50_sec")),
            "itl_p95_sec": safe_float(row.get("itl_p95_sec")),
            "tpot_p50_sec": safe_float(row.get("tpot_p50_sec")),
            "tpot_p95_sec": safe_float(row.get("tpot_p95_sec")),
            "latency_p50_sec": safe_float(row.get("latency_p50_sec")),
            "latency_p95_sec": safe_float(row.get("latency_p95_sec")),
            "rps": safe_float(row["rps"]),
        }

    sorted_conc = sorted(levels.keys())
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d-%H%M%S")

    # Detect modes present
    modes_present = set(row["mode"] for row in rows)
    single_mode = len(modes_present) == 1

    rps_val = None
    for row in rows:
        rps_val = safe_float(row["rps"])
        if rps_val is not None:
            break

    if single_mode:
        mode = modes_present.pop()
        print(f"Single-mode data detected: {mode}")
        json_data = build_json_single(sorted_conc, levels, mode, rps_val, now)
        md_lines = build_single_mode_report(
            sorted_conc, levels, mode, rps_val, now, args, json_data
        )
    else:
        print(f"Dual-mode data detected: {', '.join(sorted(modes_present))}")
        json_data = build_json_dual(sorted_conc, levels, rps_val, now)
        md_lines = build_dual_mode_report(
            sorted_conc, levels, rps_val, now, args, json_data
        )

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
