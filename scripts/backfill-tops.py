#!/usr/bin/env python3
"""Backfill 'tops' (output tokens/s) column into benchmark sweep TSVs.

Queries Prometheus range API for dynamo_frontend_output_tokens_total rate
during each row's measurement window. Adds a 'tops' column between
'actual_rps' and 'measure_start_utc'.

Usage:
    python3 scripts/backfill-tops.py [--prom-url URL] [--update-averaged] TSV [TSV ...]
"""

import argparse
import csv
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import json
from collections import defaultdict


def parse_args():
    p = argparse.ArgumentParser(description="Backfill TOPS into benchmark TSVs")
    p.add_argument("tsv_files", nargs="+", help="TSV file paths to backfill")
    p.add_argument("--prom-url", default="http://localhost:9090",
                   help="Prometheus base URL (default: http://localhost:9090)")
    p.add_argument("--update-averaged", action="store_true",
                   help="Also regenerate dev/benchmark-sweep-averaged.tsv")
    return p.parse_args()


def prom_range_query(base_url: str, query: str, start: str, end: str, step: str = "60") -> float | None:
    """Query Prometheus range API, return average of all values."""
    params = urllib.parse.urlencode({
        "query": query,
        "start": start,
        "end": end,
        "step": step,
    })
    url = f"{base_url}/api/v1/query_range?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  WARN: Prometheus query failed: {e}", file=sys.stderr)
        return None

    if data.get("status") != "success":
        return None

    results = data.get("data", {}).get("result", [])
    if not results:
        return None

    values = []
    for series in results:
        for _, val_str in series.get("values", []):
            try:
                v = float(val_str)
                if not (math.isnan(v) or math.isinf(v)):
                    values.append(v)
            except (ValueError, TypeError):
                pass

    if not values:
        return None

    return sum(values) / len(values)


def backfill_tsv(path: str, prom_url: str) -> list[dict]:
    """Read TSV, query Prometheus for each row, add tops column, write back."""
    with open(path, newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        fieldnames = reader.fieldnames
        rows = list(reader)

    if not rows:
        print(f"  WARN: {path} is empty", file=sys.stderr)
        return rows

    # Check if tops already exists
    has_tops = "tops" in fieldnames

    query = 'sum(rate(dynamo_frontend_output_tokens_total{dynamo_namespace="dynamo-workload-gtc-demo"}[1m]))'

    for i, row in enumerate(rows):
        start = row.get("measure_start_utc", "")
        end = row.get("measure_end_utc", "")

        if not start or not end:
            row["tops"] = "NaN"
            continue

        if has_tops and row.get("tops", "NaN") != "NaN":
            # Already has a value, skip
            print(f"  Row {i+1}: tops already set ({row['tops']}), skipping")
            continue

        print(f"  Row {i+1}/{len(rows)}: {row['mode']} conc={row['concurrency']} [{start} → {end}]")
        tops = prom_range_query(prom_url, query, start, end)

        if tops is not None:
            row["tops"] = f"{tops:.6f}"
            print(f"    → {tops:.2f} tok/s")
        else:
            row["tops"] = "NaN"
            print(f"    → NaN (no data)")

        time.sleep(0.2)

    # Build output fieldnames: insert tops between actual_rps and measure_start_utc
    if not has_tops:
        new_fieldnames = []
        for fn in fieldnames:
            new_fieldnames.append(fn)
            if fn == "actual_rps":
                new_fieldnames.append("tops")
        fieldnames = new_fieldnames

    # Write back
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter="\t",
                                lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(f"  Written: {path} ({len(fieldnames)} columns)")
    return rows


def generate_averaged(all_rows: list[dict], output_path: str):
    """Group by (mode, concurrency), average all numeric columns, write TSV."""
    groups = defaultdict(list)
    for row in all_rows:
        key = (row["mode"], row["concurrency"])
        groups[key].append(row)

    # Numeric columns to average
    numeric_cols = ["rps", "ttft_p50_sec", "ttft_p95_sec", "kv_hit_rate",
                    "error_pct", "actual_rps", "tops"]

    avg_rows = []
    for (mode, conc), rows in sorted(groups.items(), key=lambda x: (x[0][0], int(x[0][1]))):
        avg_row = {"mode": mode, "concurrency": conc}
        for col in numeric_cols:
            vals = []
            for r in rows:
                try:
                    v = float(r.get(col, "NaN"))
                    if not (math.isnan(v) or math.isinf(v)):
                        vals.append(v)
                except (ValueError, TypeError):
                    pass
            if vals:
                avg_row[col] = f"{sum(vals) / len(vals):.6f}"
            else:
                avg_row[col] = "NaN"
        avg_rows.append(avg_row)

    fieldnames = ["mode", "concurrency"] + numeric_cols

    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter="\t",
                                lineterminator="\n")
        writer.writeheader()
        writer.writerows(avg_rows)

    print(f"Averaged: {output_path} ({len(avg_rows)} rows, {len(fieldnames)} columns)")


def main():
    args = parse_args()

    all_rows = []
    for path in args.tsv_files:
        print(f"\nBackfilling: {path}")
        rows = backfill_tsv(path, args.prom_url)
        all_rows.extend(rows)

    if args.update_averaged:
        # Determine output dir from first TSV file
        output_dir = os.path.dirname(args.tsv_files[0]) or "dev"
        avg_path = os.path.join(output_dir, "benchmark-sweep-averaged.tsv")
        print(f"\nRegenerating averaged TSV...")
        generate_averaged(all_rows, avg_path)

    print("\nDone.")


if __name__ == "__main__":
    main()
