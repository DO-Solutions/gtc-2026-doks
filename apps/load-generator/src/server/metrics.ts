import type { RequestMetrics, AggregateMetrics, PercentileStats } from './types.js';

export class MetricsAggregator {
  private window: RequestMetrics[] = [];
  private readonly windowMs: number;

  constructor(windowSec: number) {
    this.windowMs = windowSec * 1000;
  }

  record(m: RequestMetrics): void {
    this.window.push(m);
    this.prune();
  }

  getAggregate(): AggregateMetrics {
    this.prune();
    const ok = this.window.filter((m) => m.status === 'ok');
    const windowSec = this.windowMs / 1000;
    const totalOutputTokens = ok.reduce((sum, m) => sum + m.outputTokens, 0);

    const ttft = percentiles(ok.map((m) => m.ttftMs));
    const latency = percentiles(ok.map((m) => m.latencyMs));
    const avgOutputTokens = ok.length > 0 ? totalOutputTokens / ok.length : 1;

    // TPOT: decode time / avg output tokens (matches benchmark methodology)
    const tpot: PercentileStats = {
      mean: avgOutputTokens > 0 ? (latency.mean - ttft.mean) / avgOutputTokens : 0,
      p50: avgOutputTokens > 0 ? (latency.p50 - ttft.p50) / avgOutputTokens : 0,
      p95: avgOutputTokens > 0 ? (latency.p95 - ttft.p95) / avgOutputTokens : 0,
    };

    return {
      windowSec,
      requestCount: this.window.length,
      errorCount: this.window.length - ok.length,
      actualRPS: this.window.length / windowSec,
      ttft,
      itl: percentiles(ok.map((m) => m.itlMs)),
      tpot,
      latency,
      outputTokens: percentiles(ok.map((m) => m.outputTokens)),
      tops: totalOutputTokens / windowSec,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.window = this.window.filter((m) => m.completedAt >= cutoff);
  }
}

function percentiles(values: number[]): PercentileStats {
  if (values.length === 0) {
    return { mean: 0, p50: 0, p95: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { mean, p50, p95 };
}
