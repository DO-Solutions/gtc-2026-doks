#!/usr/bin/env python3
"""
KV Cache Benefit Test — Find the concurrency threshold where KV-aware routing
benefits disappear due to queuing.

Steps through increasing concurrency levels, collects per-request TTFT via
the load generator websocket, and separates initial turns (t0) from follow-up
turns (t1+) to measure the KV cache TTFT speedup at each level.

Prerequisites:
  - Port-forward load generator:  kubectl port-forward svc/loadgen 3000:3000 -n dynamo-workload &
  - Port-forward Prometheus:      kubectl port-forward svc/kube-prometheus-stack-prometheus 9090:9090 -n monitoring &

Usage:
  python3 scripts/kv-benefit-test.py
  python3 scripts/kv-benefit-test.py --levels 10,12,15,18,20,25,30
  python3 scripts/kv-benefit-test.py --warmup 60 --measure 90 --rps 10
"""

import argparse
import asyncio
import json
import math
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

try:
    import websockets
except ImportError:
    print("ERROR: websockets library required. Install with: pip install websockets")
    sys.exit(1)

# ── Defaults ──────────────────────────────────────────────────────────────────
LOADGEN_URL = "http://localhost:3000"
WS_URL = "ws://localhost:3000/ws"
PROM_URL = "http://localhost:9090"
TURN_REGEX = re.compile(r"-t(\d+)$")

DEFAULT_LEVELS = [10, 12, 15, 18, 20, 25, 30]
DEFAULT_RPS = 10.0
WARMUP_SEC = 60
MEASURE_SEC = 120

# Prometheus label selectors (must match capacity-test.sh)
FRONTEND_NS = 'dynamo_namespace="dynamo-workload-gtc-demo"'
COMPONENT_NS = 'dynamo_namespace="dynamo_workload_gtc_demo"'

KUBE_CONTEXT = "do-nyc2-gtc-demo"
LOADGEN_NS = "dynamo-workload"
PROM_NS = "monitoring"
PROM_SVC = "kube-prometheus-stack-prometheus"

# ── Port-forward management ──────────────────────────────────────────────────
port_forward_procs = []


def start_port_forward(svc, local_port, remote_port, namespace, label):
    """Start a kubectl port-forward if the port isn't already responding."""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(1)
        sock.connect(("localhost", local_port))
        sock.close()
        print(f"  {label}: already listening on localhost:{local_port}")
        return True
    except (ConnectionRefusedError, OSError):
        sock.close()

    print(f"  Starting port-forward: {label} → localhost:{local_port}")
    proc = subprocess.Popen(
        [
            "kubectl",
            "--context",
            KUBE_CONTEXT,
            "port-forward",
            f"svc/{svc}",
            f"{local_port}:{remote_port}",
            "-n",
            namespace,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    port_forward_procs.append(proc)

    # Wait for it to be ready
    for _ in range(20):
        time.sleep(1)
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            sock.connect(("localhost", local_port))
            sock.close()
            print(f"  {label}: ready")
            return True
        except (ConnectionRefusedError, OSError):
            sock.close()

    print(f"  ERROR: {label} port-forward failed after 20s")
    return False


def cleanup_port_forwards():
    for proc in port_forward_procs:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ── HTTP helpers ──────────────────────────────────────────────────────────────


def api_call(method, path, body=None, base_url=LOADGEN_URL):
    """Simple HTTP call."""
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def get_status():
    return api_call("GET", "/api/status")


def start_workload(concurrency, rps):
    return api_call(
        "POST",
        "/api/workload/start",
        {"totalRPS": rps, "mix": {"a": 1.0}, "maxConcurrency": concurrency},
    )


def update_config(concurrency, rps):
    return api_call(
        "POST",
        "/api/workload/config",
        {"totalRPS": rps, "mix": {"a": 1.0}, "maxConcurrency": concurrency},
    )


def stop_workload():
    return api_call("POST", "/api/workload/stop")


# ── Prometheus queries ────────────────────────────────────────────────────────


def prom_query(query):
    """Execute a Prometheus instant query, return float or None."""
    try:
        from urllib.parse import urlencode

        url = f"{PROM_URL}/api/v1/query?{urlencode({'query': query})}"
        req = Request(url, method="GET")
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        if data["status"] != "success" or not data["data"]["result"]:
            return None

        val = float(data["data"]["result"][0]["value"][1])
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    except Exception:
        return None


def collect_prometheus_metrics():
    """Collect queue depth, KV hit rate, KV usage, GPU util from Prometheus."""
    queue = prom_query(
        f'sum(dynamo_frontend_queued_requests{{{FRONTEND_NS}}}) or vector(0)'
    )
    kv_hit = prom_query(
        f'avg(dynamo_component_kvstats_gpu_prefix_cache_hit_rate{{{COMPONENT_NS}}}) or vector(0)'
    )
    kv_usage = prom_query(
        f'avg(dynamo_component_kvstats_gpu_cache_usage_percent{{{COMPONENT_NS}}}) or vector(0)'
    )
    return {
        "queue_depth": queue,
        "kv_hit_rate": kv_hit,
        "kv_usage": kv_usage,
    }


# ── Statistics ────────────────────────────────────────────────────────────────


def percentile(values, p):
    """Compute percentile using linear interpolation."""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    idx = (p / 100.0) * (n - 1)
    lo = int(math.floor(idx))
    hi = min(int(math.ceil(idx)), n - 1)
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def compute_stats(values):
    """Compute count, mean, p50, p95 for a list of values."""
    if not values:
        return {"count": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0}
    return {
        "count": len(values),
        "mean": statistics.mean(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
    }


# ── Websocket event collection ───────────────────────────────────────────────


async def collect_events(duration_sec):
    """Connect to websocket, collect request_complete events for duration_sec."""
    events = []
    deadline = time.time() + duration_sec
    reconnect_delay = 1

    while time.time() < deadline:
        try:
            async with websockets.connect(WS_URL, close_timeout=5) as ws:
                reconnect_delay = 1  # Reset on successful connect
                while time.time() < deadline:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        break
                    try:
                        raw = await asyncio.wait_for(
                            ws.recv(), timeout=min(2.0, remaining)
                        )
                        msg = json.loads(raw)
                        if msg.get("type") == "request_complete":
                            data = msg["data"]
                            if data.get("status") == "ok" and data.get("itemId"):
                                events.append(data)
                    except asyncio.TimeoutError:
                        continue
        except (
            websockets.exceptions.ConnectionClosed,
            ConnectionRefusedError,
            OSError,
        ) as e:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            wait = min(reconnect_delay, remaining)
            print(f"│  WS reconnecting in {wait:.0f}s ({e})")
            await asyncio.sleep(wait)
            reconnect_delay = min(reconnect_delay * 2, 10)

    return events


def analyze_events(events):
    """Separate events by turn number (t0 = initial, t1+ = follow-up)."""
    initial_ttfts = []
    followup_ttfts = []
    initial_itls = []
    followup_itls = []
    initial_latencies = []
    followup_latencies = []
    conversations = set()

    for ev in events:
        item_id = ev.get("itemId", "")
        match = TURN_REGEX.search(item_id)
        if not match:
            continue

        turn = int(match.group(1))
        conv_id = item_id[: match.start()]
        conversations.add(conv_id)

        ttft = ev.get("ttftMs", 0)
        itl = ev.get("itlMs", 0)
        latency = ev.get("latencyMs", 0)

        if turn == 0:
            initial_ttfts.append(ttft)
            initial_itls.append(itl)
            initial_latencies.append(latency)
        else:
            followup_ttfts.append(ttft)
            followup_itls.append(itl)
            followup_latencies.append(latency)

    i_ttft = compute_stats(initial_ttfts)
    f_ttft = compute_stats(followup_ttfts)
    i_itl = compute_stats(initial_itls)
    f_itl = compute_stats(followup_itls)

    speedup = i_ttft["p50"] / f_ttft["p50"] if f_ttft["p50"] > 0 else 0.0
    delta = i_ttft["p50"] - f_ttft["p50"]

    return {
        "initial_ttft": i_ttft,
        "followup_ttft": f_ttft,
        "initial_itl": i_itl,
        "followup_itl": f_itl,
        "initial_latency": compute_stats(initial_latencies),
        "followup_latency": compute_stats(followup_latencies),
        "speedup_ratio": speedup,
        "delta_ms": delta,
        "total_events": len(events),
        "conversations": len(conversations),
    }


# ── Main test loop ───────────────────────────────────────────────────────────


async def run_test(levels, rps, warmup_sec, measure_sec, output_dir, label=""):
    """Step through concurrency levels and measure KV cache benefit at each."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    label_part = f"-{label}" if label else ""
    tsv_path = Path(output_dir) / f"kv-benefit-test{label_part}-{timestamp}.tsv"

    # ── Pre-checks ────────────────────────────────────────────────────────
    print("Setting up port forwards...")
    if not start_port_forward("loadgen", 3000, 3000, LOADGEN_NS, "Load Generator"):
        sys.exit(1)
    start_port_forward(PROM_SVC, 9090, 9090, PROM_NS, "Prometheus")

    print("\nChecking load generator connectivity...")
    status = get_status()
    if not status:
        print("ERROR: Cannot reach load generator at", LOADGEN_URL)
        sys.exit(1)
    print(f"  Load generator ready (corpus: {status.get('corpus', {}).get('chatPassages', '?')} passages)")

    if status.get("running"):
        print("  Workload already running — stopping first...")
        stop_workload()
        await asyncio.sleep(5)

    # ── Banner ────────────────────────────────────────────────────────────
    est_min = len(levels) * (warmup_sec + measure_sec + 10) // 60
    print(f"\n{'=' * 70}")
    print(f"  KV Cache Benefit Threshold Test")
    print(f"  Concurrency levels: {levels}")
    print(f"  RPS: {rps}")
    print(f"  Per level: {warmup_sec}s warmup + {measure_sec}s measurement")
    print(f"  Estimated duration: ~{est_min} min")
    print(f"  Output: {tsv_path}")
    print(f"{'=' * 70}")

    # ── TSV header ────────────────────────────────────────────────────────
    header_cols = [
        "concurrency",
        "rps",
        "initial_ttft_p50",
        "initial_ttft_p95",
        "initial_ttft_mean",
        "followup_ttft_p50",
        "followup_ttft_p95",
        "followup_ttft_mean",
        "speedup_p50",
        "delta_p50_ms",
        "initial_itl_p50",
        "followup_itl_p50",
        "initial_count",
        "followup_count",
        "total_events",
        "conversations",
        "queue_depth",
        "kv_hit_rate",
        "kv_usage",
        "actual_rps",
        "error_pct",
    ]
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    with open(tsv_path, "w") as f:
        f.write("\t".join(header_cols) + "\n")

    results = []
    first = True

    for conc in levels:
        print(f"\n┌─ Concurrency={conc}, RPS={rps} {'─' * 40}")

        # Start or reconfigure
        if first:
            start_workload(conc, rps)
            first = False
        else:
            update_config(conc, rps)

        # Warmup
        print(f"│  Warmup ({warmup_sec}s)...")
        await asyncio.sleep(warmup_sec)

        # Collect events via websocket
        print(f"│  Measuring ({measure_sec}s via websocket)...")
        events = await collect_events(measure_sec)

        # Also grab aggregate metrics from load generator + Prometheus
        lg_status = get_status()
        prom_metrics = collect_prometheus_metrics()

        actual_rps = 0.0
        error_pct = 0.0
        if lg_status and lg_status.get("metrics"):
            m = lg_status["metrics"]
            actual_rps = m.get("actualRPS", 0)
            req_count = m.get("requestCount", 0)
            err_count = m.get("errorCount", 0)
            error_pct = (100.0 * err_count / req_count) if req_count > 0 else 0.0

        # Analyze events
        analysis = analyze_events(events)
        i_ttft = analysis["initial_ttft"]
        f_ttft = analysis["followup_ttft"]
        i_itl = analysis["initial_itl"]
        f_itl = analysis["followup_itl"]
        speedup = analysis["speedup_ratio"]
        delta = analysis["delta_ms"]
        qd = prom_metrics.get("queue_depth")
        kv_hit = prom_metrics.get("kv_hit_rate")
        kv_usage = prom_metrics.get("kv_usage")

        # ── Print results ─────────────────────────────────────────────────
        print(f"│")
        print(
            f"│  Initial TTFT:   p50={i_ttft['p50']:>7.0f}ms  p95={i_ttft['p95']:>7.0f}ms  mean={i_ttft['mean']:>7.0f}ms  (n={i_ttft['count']})"
        )
        print(
            f"│  Follow-up TTFT: p50={f_ttft['p50']:>7.0f}ms  p95={f_ttft['p95']:>7.0f}ms  mean={f_ttft['mean']:>7.0f}ms  (n={f_ttft['count']})"
        )
        print(
            f"│  Speedup: {speedup:.2f}x  (delta={delta:+.0f}ms)"
        )
        print(
            f"│  ITL:     initial p50={i_itl['p50']:.1f}ms  followup p50={f_itl['p50']:.1f}ms"
        )
        print(
            f"│  Infra:   queue={qd if qd is not None else 'N/A'}  "
            f"kv_hit={f'{kv_hit:.1f}%' if kv_hit is not None else 'N/A'}  "
            f"kv_usage={f'{kv_usage:.1f}%' if kv_usage is not None else 'N/A'}"
        )
        print(
            f"│  Load:    actual_rps={actual_rps:.1f}  errors={error_pct:.1f}%  "
            f"events={analysis['total_events']}  conversations={analysis['conversations']}"
        )

        # Assessment
        if speedup < 1.05:
            print(f"│  >>> KV cache benefit GONE at concurrency {conc}")
        elif speedup < 1.15:
            print(f"│  >>> KV benefit MARGINAL (speedup < 1.15x)")
        elif delta < 15:
            print(f"│  >>> KV benefit small — delta < 15ms")
        else:
            print(f"│  KV benefit visible")

        print(f"└{'─' * 55}")

        # ── Write TSV row ─────────────────────────────────────────────────
        def fmt(v, decimals=1):
            return f"{v:.{decimals}f}" if v is not None else "NaN"

        row = "\t".join(
            [
                str(conc),
                str(rps),
                fmt(i_ttft["p50"]),
                fmt(i_ttft["p95"]),
                fmt(i_ttft["mean"]),
                fmt(f_ttft["p50"]),
                fmt(f_ttft["p95"]),
                fmt(f_ttft["mean"]),
                fmt(speedup, 3),
                fmt(delta),
                fmt(i_itl["p50"]),
                fmt(f_itl["p50"]),
                str(i_ttft["count"]),
                str(f_ttft["count"]),
                str(analysis["total_events"]),
                str(analysis["conversations"]),
                fmt(qd),
                fmt(kv_hit),
                fmt(kv_usage),
                fmt(actual_rps),
                fmt(error_pct),
            ]
        )
        with open(tsv_path, "a") as f:
            f.write(row + "\n")

        results.append(
            {
                "concurrency": conc,
                "speedup": speedup,
                "delta": delta,
                "initial_p50": i_ttft["p50"],
                "followup_p50": f_ttft["p50"],
                "initial_p95": i_ttft["p95"],
                "followup_p95": f_ttft["p95"],
                "kv_hit": kv_hit,
                "queue": qd,
                "initial_count": i_ttft["count"],
                "followup_count": f_ttft["count"],
            }
        )

    # ── Stop workload ─────────────────────────────────────────────────────
    print("\nStopping workload...")
    stop_workload()

    # ── Summary ───────────────────────────────────────────────────────────
    print(f"\n{'=' * 78}")
    print(f"  KV Cache Benefit Summary")
    print(f"{'=' * 78}")
    print(
        f"  {'Conc':>5}  {'Init p50':>9}  {'F/U p50':>9}  {'Delta':>8}  "
        f"{'Speed':>7}  {'KV Hit':>7}  {'Queue':>6}  {'n(i)':>5}  {'n(f)':>5}"
    )
    print(
        f"  {'─' * 5}  {'─' * 9}  {'─' * 9}  {'─' * 8}  "
        f"{'─' * 7}  {'─' * 7}  {'─' * 6}  {'─' * 5}  {'─' * 5}"
    )

    threshold_found = None
    for r in results:
        marker = ""
        if r["speedup"] < 1.05:
            marker = " << GONE"
            if threshold_found is None:
                threshold_found = r["concurrency"]
        elif r["speedup"] < 1.15:
            marker = " < marginal"

        kv_str = f"{r['kv_hit']:.0f}%" if r["kv_hit"] is not None else "  N/A"
        q_str = f"{r['queue']:.0f}" if r["queue"] is not None else "N/A"

        print(
            f"  {r['concurrency']:>5}  {r['initial_p50']:>7.0f}ms  {r['followup_p50']:>7.0f}ms  "
            f"{r['delta']:>+7.0f}ms  {r['speedup']:>6.2f}x  {kv_str:>7}  {q_str:>6}  "
            f"{r['initial_count']:>5}  {r['followup_count']:>5}{marker}"
        )

    print(f"\n  {'─' * 70}")
    if threshold_found:
        print(
            f"  KV cache benefit disappears at concurrency {threshold_found}"
        )
        prev = [r for r in results if r["concurrency"] < threshold_found]
        if prev:
            best = max(prev, key=lambda r: r["speedup"])
            print(
                f"  Best KV benefit: concurrency {best['concurrency']} "
                f"(speedup {best['speedup']:.2f}x, delta {best['delta']:+.0f}ms)"
            )
        print(
            f"\n  Recommendation: Set 'high water mark' at concurrency "
            f"{threshold_found - (threshold_found - results[0]['concurrency']) // 2 if prev else results[0]['concurrency']} "
            f"for demos with KV routing"
        )
    else:
        best = max(results, key=lambda r: r["speedup"]) if results else None
        if best and best["speedup"] > 1.0:
            print(
                f"  KV benefit still visible at highest tested concurrency ({results[-1]['concurrency']})"
            )
            print(
                f"  Best KV benefit: concurrency {best['concurrency']} "
                f"(speedup {best['speedup']:.2f}x, delta {best['delta']:+.0f}ms)"
            )
            print(f"\n  Consider testing higher concurrency levels to find the threshold.")
        else:
            print(f"  No clear KV benefit observed at any level.")

    print(f"\n  Full results: {tsv_path}")
    print(f"{'=' * 78}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="KV Cache Benefit Threshold Test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/kv-benefit-test.py
  python3 scripts/kv-benefit-test.py --levels 10,12,15,18,20,25,30
  python3 scripts/kv-benefit-test.py --warmup 45 --measure 90
  python3 scripts/kv-benefit-test.py --levels 8,10,15,20 --rps 8
""",
    )
    parser.add_argument(
        "--levels",
        default=",".join(map(str, DEFAULT_LEVELS)),
        help=f"Comma-separated concurrency levels (default: {','.join(map(str, DEFAULT_LEVELS))})",
    )
    parser.add_argument(
        "--rps",
        type=float,
        default=DEFAULT_RPS,
        help=f"Target RPS (default: {DEFAULT_RPS})",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=WARMUP_SEC,
        help=f"Warmup seconds per level (default: {WARMUP_SEC})",
    )
    parser.add_argument(
        "--measure",
        type=int,
        default=MEASURE_SEC,
        help=f"Measurement seconds per level (default: {MEASURE_SEC})",
    )
    parser.add_argument(
        "--output-dir",
        default="dev",
        help="Output directory for TSV results (default: dev)",
    )
    parser.add_argument(
        "--label",
        default="",
        help="Label for output filename (e.g. 'kv' → kv-benefit-test-kv-{timestamp}.tsv)",
    )
    args = parser.parse_args()

    levels = sorted(int(x.strip()) for x in args.levels.split(","))

    try:
        asyncio.run(
            run_test(levels, args.rps, args.warmup, args.measure, args.output_dir, args.label)
        )
    except KeyboardInterrupt:
        print("\n\nInterrupted — stopping workload...")
        stop_workload()
    finally:
        cleanup_port_forwards()
