import type { AggregateMetrics } from '../types';

interface Props {
  metrics: AggregateMetrics | null;
  running: boolean;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function itlClass(p95: number): string {
  if (p95 < 50) return 'healthy';
  if (p95 < 100) return 'warning';
  return 'critical';
}

function errorClass(count: number, total: number): string {
  if (count === 0) return 'healthy';
  if (total > 0 && count / total < 0.05) return 'warning';
  return 'critical';
}

export function MetricsPanel({ metrics, running }: Props) {
  const m = metrics;
  const noData = !running || !m;

  return (
    <div className="metrics-row">
      <div className="metric-card-compact">
        <div className="metric-label">RPS</div>
        <div className={`metric-value ${noData ? 'muted' : 'healthy'}`}>
          {noData ? '\u2014' : fmt(m.actualRPS, 1)}
        </div>
      </div>

      <div className="metric-card-compact">
        <div className="metric-label">Requests</div>
        <div className={`metric-value ${noData ? 'muted' : ''}`}>
          {noData ? '\u2014' : m.requestCount}
        </div>
      </div>

      <div className="metric-card-compact">
        <div className="metric-label">Errors</div>
        <div className={`metric-value ${noData ? 'muted' : errorClass(m.errorCount, m.requestCount)}`}>
          {noData ? '\u2014' : m.errorCount}
        </div>
      </div>

      <div className="metric-card-compact">
        <div className="metric-label">ITL (ms)</div>
        <div className={`metric-value ${noData ? 'muted' : itlClass(m.itl.p95)}`}>
          {noData ? '\u2014' : fmt(m.itl.p50, 1)}
        </div>
      </div>

      <div className="metric-card-compact">
        <div className="metric-label">Latency (s)</div>
        <div className={`metric-value ${noData ? 'muted' : ''}`}>
          {noData ? '\u2014' : fmt(m.latency.p50 / 1000, 1)}
        </div>
      </div>
    </div>
  );
}
