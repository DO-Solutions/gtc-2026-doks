/** Round-robin TTFT benchmark data (ms) by concurrency level. */
const RR_BENCHMARK: Record<number, { p50: number; p95: number }> = {
  20:  { p50: 237, p95: 427 },
  30:  { p50: 241, p95: 426 },
  40:  { p50: 241, p95: 435 },
  50:  { p50: 249, p95: 443 },
  60:  { p50: 258, p95: 452 },
  70:  { p50: 276, p95: 466 },
  80:  { p50: 290, p95: 477 },
  100: { p50: 307, p95: 490 },
  120: { p50: 324, p95: 496 },
};

const KEYS = Object.keys(RR_BENCHMARK).map(Number).sort((a, b) => a - b);

/** Get RR benchmark for a concurrency level. Exact match or nearest key. */
export function getRRBenchmark(concurrency: number): { p50: number; p95: number } {
  if (RR_BENCHMARK[concurrency]) return RR_BENCHMARK[concurrency];

  let nearest = KEYS[0];
  let minDist = Math.abs(concurrency - nearest);
  for (const k of KEYS) {
    const dist = Math.abs(concurrency - k);
    if (dist < minDist) {
      minDist = dist;
      nearest = k;
    }
  }
  return RR_BENCHMARK[nearest];
}
