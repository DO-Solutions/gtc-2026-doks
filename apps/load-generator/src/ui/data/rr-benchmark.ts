/** Benchmark data by concurrency level for both Round-Robin (RR) and KV-aware routing. */

export interface BenchmarkEntry {
  concurrency: number;
  rr: {
    ttft: { p50: number; p95: number };
    tpot: { p50: number; p95: number };
    itl: { p50: number; p95: number };
    latency: { p50: number; p95: number };
    tops: number;
  };
  kv: {
    ttft: { p50: number; p95: number };
    tpot: { p50: number; p95: number };
    itl: { p50: number; p95: number };
    latency: { p50: number; p95: number };
    tops: number;
  };
}

const BENCHMARKS: BenchmarkEntry[] = [
  {
    concurrency: 60,
    rr: {
      ttft: { p50: 274, p95: 655 },
      tpot: { p50: 28, p95: 30 },
      itl: { p50: 28, p95: 30 },
      latency: { p50: 24600, p95: 30100 },
      tops: 2146.9,
    },
    kv: {
      ttft: { p50: 249, p95: 446 },
      tpot: { p50: 26, p95: 27 },
      itl: { p50: 26, p95: 27 },
      latency: { p50: 24300, p95: 27700 },
      tops: 2262.8,
    },
  },
  {
    concurrency: 80,
    rr: {
      ttft: { p50: 306, p95: 637 },
      tpot: { p50: 31, p95: 33 },
      itl: { p50: 31, p95: 33 },
      latency: { p50: 29300, p95: 33400 },
      tops: 2543.2,
    },
    kv: {
      ttft: { p50: 267, p95: 508 },
      tpot: { p50: 28, p95: 33 },
      itl: { p50: 28, p95: 33 },
      latency: { p50: 26600, p95: 32500 },
      tops: 2742.3,
    },
  },
  {
    concurrency: 100,
    rr: {
      ttft: { p50: 342, p95: 652 },
      tpot: { p50: 38, p95: 48 },
      itl: { p50: 38, p95: 48 },
      latency: { p50: 32100, p95: 49000 },
      tops: 2547.5,
    },
    kv: {
      ttft: { p50: 329, p95: 547 },
      tpot: { p50: 36, p95: 43 },
      itl: { p50: 36, p95: 43 },
      latency: { p50: 31800, p95: 43600 },
      tops: 2780.1,
    },
  },
  {
    concurrency: 120,
    rr: {
      ttft: { p50: 375, p95: 643 },
      tpot: { p50: 45, p95: 50 },
      itl: { p50: 45, p95: 50 },
      latency: { p50: 41200, p95: 50400 },
      tops: 2642.6,
    },
    kv: {
      ttft: { p50: 382, p95: 530 },
      tpot: { p50: 43, p95: 46 },
      itl: { p50: 43, p95: 46 },
      latency: { p50: 38100, p95: 47200 },
      tops: 2805.7,
    },
  },
  {
    concurrency: 140,
    rr: {
      ttft: { p50: 398, p95: 643 },
      tpot: { p50: 49, p95: 52 },
      itl: { p50: 49, p95: 52 },
      latency: { p50: 45700, p95: 53000 },
      tops: 2816.8,
    },
    kv: {
      ttft: { p50: 415, p95: 650 },
      tpot: { p50: 44, p95: 46 },
      itl: { p50: 44, p95: 46 },
      latency: { p50: 38700, p95: 46700 },
      tops: 3167.8,
    },
  },
  {
    concurrency: 160,
    rr: {
      ttft: { p50: 422, p95: 722 },
      tpot: { p50: 51, p95: 54 },
      itl: { p50: 51, p95: 54 },
      latency: { p50: 45200, p95: 55400 },
      tops: 3126.8,
    },
    kv: {
      ttft: { p50: 424, p95: 704 },
      tpot: { p50: 46, p95: 48 },
      itl: { p50: 46, p95: 48 },
      latency: { p50: 40800, p95: 48100 },
      tops: 3471.8,
    },
  },
  {
    concurrency: 180,
    rr: {
      ttft: { p50: 413, p95: 732 },
      tpot: { p50: 52, p95: 54 },
      itl: { p50: 52, p95: 54 },
      latency: { p50: 46100, p95: 54600 },
      tops: 3434.0,
    },
    kv: {
      ttft: { p50: 472, p95: 3143 },
      tpot: { p50: 45, p95: 48 },
      itl: { p50: 45, p95: 48 },
      latency: { p50: 41400, p95: 48700 },
      tops: 3907.7,
    },
  },
];

const BY_CONCURRENCY = new Map(BENCHMARKS.map((b) => [b.concurrency, b]));
const LEVELS = BENCHMARKS.map((b) => b.concurrency);

/** Get benchmark data for a concurrency level. Exact match or nearest. */
export function getBenchmark(concurrency: number): BenchmarkEntry {
  const exact = BY_CONCURRENCY.get(concurrency);
  if (exact) return exact;

  let nearest = BENCHMARKS[0];
  let minDist = Math.abs(concurrency - nearest.concurrency);
  for (const b of BENCHMARKS) {
    const dist = Math.abs(concurrency - b.concurrency);
    if (dist < minDist) {
      minDist = dist;
      nearest = b;
    }
  }
  return nearest;
}

/** Get all benchmark concurrency levels. */
export function getAllBenchmarkLevels(): number[] {
  return LEVELS;
}

/** @deprecated Use getBenchmark instead */
export function getRRBenchmark(concurrency: number): { p50: number; p95: number } {
  const b = getBenchmark(concurrency);
  return b.rr.ttft;
}
