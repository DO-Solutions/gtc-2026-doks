#!/usr/bin/env python3
"""
Compare KV-aware vs round-robin routing test results.

Reads two TSV files from kv-benefit-test.py (one per routing mode),
joins on concurrency level, and produces a side-by-side comparison
with crossover analysis.

Usage:
  python3 scripts/compare-kv-results.py --kv dev/kv-benefit-test-kv-*.tsv --rr dev/kv-benefit-test-roundrobin-*.tsv
  python3 scripts/compare-kv-results.py --kv FILE --rr FILE --output-dir dev
"""

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path


def read_tsv(path):
    """Read a kv-benefit-test TSV and return rows keyed by concurrency."""
    rows = {}
    with open(path) as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            conc = int(row["concurrency"])
            rows[conc] = row
    return rows


def safe_float(val, default=0.0):
    try:
        v = float(val)
        if v != v:  # NaN check
            return default
        return v
    except (ValueError, TypeError):
        return default


def fmt_ms(val):
    """Format milliseconds for display."""
    v = safe_float(val)
    if v == 0:
        return "    N/A"
    return f"{v:>7.0f}"


def fmt_ratio(val):
    v = safe_float(val)
    if v == 0:
        return "  N/A"
    return f"{v:>5.2f}x"


def main():
    parser = argparse.ArgumentParser(
        description="Compare KV-aware vs round-robin routing results",
    )
    parser.add_argument("--kv", required=True, help="KV-mode TSV file")
    parser.add_argument("--rr", required=True, help="Round-robin TSV file")
    parser.add_argument(
        "--output-dir", default="dev", help="Output directory (default: dev)"
    )
    args = parser.parse_args()

    kv_data = read_tsv(args.kv)
    rr_data = read_tsv(args.rr)

    if not kv_data:
        print(f"ERROR: No data in KV file: {args.kv}", file=sys.stderr)
        sys.exit(1)
    if not rr_data:
        print(f"ERROR: No data in RR file: {args.rr}", file=sys.stderr)
        sys.exit(1)

    # Join on concurrency levels present in both
    all_concs = sorted(set(kv_data.keys()) & set(rr_data.keys()))
    if not all_concs:
        print("ERROR: No overlapping concurrency levels between files", file=sys.stderr)
        sys.exit(1)

    # ── Console output ──────────────────────────────────────────────────────
    print()
    print("=" * 100)
    print("  KV-Aware vs Round-Robin Routing Comparison")
    print("=" * 100)
    print(f"  KV file:    {args.kv}")
    print(f"  RR file:    {args.rr}")
    print(f"  Levels:     {all_concs}")
    print()

    # Header
    print(
        f"  {'Conc':>4} │ {'── KV Mode ──────────────────':^30} │ "
        f"{'── Round-Robin ──────────────':^30} │ {'── KV Advantage ──────':^22}"
    )
    print(
        f"  {'':>4} │ {'Init p50':>8} {'F/U p50':>8} {'Spd':>6} {'KVhit':>6} │ "
        f"{'Init p50':>8} {'F/U p50':>8} {'Spd':>6} {'KVhit':>6} │ "
        f"{'F/U Δ':>7} {'Spd Δ':>7} {'Note':>6}"
    )
    print(f"  {'─' * 4} │ {'─' * 30} │ {'─' * 30} │ {'─' * 22}")

    # ── Build comparison rows ───────────────────────────────────────────────
    comparison_rows = []
    crossover_conc = None
    best_advantage = {"conc": 0, "delta": 0, "speedup_diff": 0}

    for conc in all_concs:
        kv = kv_data[conc]
        rr = rr_data[conc]

        kv_init_p50 = safe_float(kv["initial_ttft_p50"])
        kv_fu_p50 = safe_float(kv["followup_ttft_p50"])
        kv_speedup = safe_float(kv["speedup_p50"])
        kv_hit = safe_float(kv.get("kv_hit_rate", 0))

        rr_init_p50 = safe_float(rr["initial_ttft_p50"])
        rr_fu_p50 = safe_float(rr["followup_ttft_p50"])
        rr_speedup = safe_float(rr["speedup_p50"])
        rr_hit = safe_float(rr.get("kv_hit_rate", 0))

        # KV advantage: how much better is KV follow-up vs RR follow-up
        fu_delta = rr_fu_p50 - kv_fu_p50  # positive = KV is faster
        speedup_diff = kv_speedup - rr_speedup  # positive = KV has more speedup

        # Note
        note = ""
        if kv_speedup < 1.05 and rr_speedup < 1.05:
            note = "both flat"
        elif fu_delta < 5 and abs(speedup_diff) < 0.05:
            note = "~equal"
            if crossover_conc is None:
                crossover_conc = conc
        elif fu_delta < 0:
            note = "RR wins"
            if crossover_conc is None:
                crossover_conc = conc
        elif kv_speedup < 1.05:
            note = "gone"
            if crossover_conc is None:
                crossover_conc = conc
        elif kv_speedup < 1.15:
            note = "marginal"

        if fu_delta > best_advantage["delta"]:
            best_advantage = {"conc": conc, "delta": fu_delta, "speedup_diff": speedup_diff}

        comp_row = {
            "concurrency": conc,
            "kv_init_p50": kv_init_p50,
            "kv_fu_p50": kv_fu_p50,
            "kv_speedup": kv_speedup,
            "kv_hit": kv_hit,
            "rr_init_p50": rr_init_p50,
            "rr_fu_p50": rr_fu_p50,
            "rr_speedup": rr_speedup,
            "rr_hit": rr_hit,
            "fu_delta": fu_delta,
            "speedup_diff": speedup_diff,
            "note": note,
        }
        comparison_rows.append(comp_row)

        # Print row
        marker = ""
        if note in ("gone", "RR wins", "both flat"):
            marker = " <<<"
        elif note == "marginal":
            marker = " <"

        print(
            f"  {conc:>4} │ "
            f"{fmt_ms(kv_init_p50)} {fmt_ms(kv_fu_p50)} {fmt_ratio(kv_speedup)} {kv_hit:>5.0f}% │ "
            f"{fmt_ms(rr_init_p50)} {fmt_ms(rr_fu_p50)} {fmt_ratio(rr_speedup)} {rr_hit:>5.0f}% │ "
            f"{fu_delta:>+6.0f}ms {speedup_diff:>+6.2f}x {note:>6}{marker}"
        )

    print()

    # ── Summary ─────────────────────────────────────────────────────────────
    print(f"  {'─' * 90}")
    print()

    if crossover_conc:
        print(f"  Crossover point: concurrency {crossover_conc}")
        print(f"    KV-aware routing benefit disappears at this level.")
        if best_advantage["conc"]:
            print(
                f"    Best KV advantage: concurrency {best_advantage['conc']} "
                f"(follow-up TTFT {best_advantage['delta']:+.0f}ms faster)"
            )
        safe_ceiling = [
            r["concurrency"] for r in comparison_rows
            if r["concurrency"] < crossover_conc
            and r["kv_speedup"] >= 1.15
        ]
        if safe_ceiling:
            rec = max(safe_ceiling)
            print(f"\n  Recommendation: Set demo concurrency ceiling at {rec}")
            print(f"    (highest level with clear KV benefit before crossover at {crossover_conc})")
        else:
            print(f"\n  Recommendation: KV benefit is marginal even at low concurrency.")
    else:
        if best_advantage["conc"]:
            print(
                f"  No crossover found — KV benefit persists through concurrency {all_concs[-1]}."
            )
            print(
                f"  Best KV advantage: concurrency {best_advantage['conc']} "
                f"(follow-up TTFT {best_advantage['delta']:+.0f}ms faster)"
            )
            print(f"\n  Recommendation: Demo can safely use up to concurrency {all_concs[-1]}.")
            print(f"    Consider testing higher levels to find the crossover.")
        else:
            print("  No meaningful KV advantage observed at any level.")

    print()
    print("=" * 100)

    # ── Write combined TSV ──────────────────────────────────────────────────
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tsv_path = out_dir / f"kv-comparison-{timestamp}.tsv"

    with open(tsv_path, "w") as f:
        cols = [
            "concurrency",
            "kv_init_p50", "kv_fu_p50", "kv_speedup", "kv_hit",
            "rr_init_p50", "rr_fu_p50", "rr_speedup", "rr_hit",
            "fu_delta_ms", "speedup_diff", "note",
        ]
        f.write("\t".join(cols) + "\n")
        for r in comparison_rows:
            f.write("\t".join([
                str(r["concurrency"]),
                f"{r['kv_init_p50']:.1f}",
                f"{r['kv_fu_p50']:.1f}",
                f"{r['kv_speedup']:.3f}",
                f"{r['kv_hit']:.1f}",
                f"{r['rr_init_p50']:.1f}",
                f"{r['rr_fu_p50']:.1f}",
                f"{r['rr_speedup']:.3f}",
                f"{r['rr_hit']:.1f}",
                f"{r['fu_delta']:.1f}",
                f"{r['speedup_diff']:.3f}",
                r["note"],
            ]) + "\n")

    print(f"  Combined TSV: {tsv_path}")
    print()


if __name__ == "__main__":
    main()
