import type { TurnMetrics } from '../hooks/useTurnMetrics';
import { getRRBenchmark } from '../data/rr-benchmark';

interface Props {
  turnMetrics: TurnMetrics;
  running: boolean;
  concurrency: number;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function ImprovementBadge({ kv, rr }: { kv: number; rr: number }) {
  const diff = rr - kv;
  const pct = rr > 0 ? (diff / rr) * 100 : 0;
  const positive = pct > 0;

  return (
    <span className={`improvement-badge ${positive ? 'improvement-positive' : 'improvement-neutral'}`}>
      {positive ? '-' : '+'}{fmt(Math.abs(pct))}%
      <span className="improvement-detail"> ({positive ? '-' : '+'}{fmt(Math.abs(diff))} ms)</span>
    </span>
  );
}

const MIN_SAMPLES = 5;

export function KVCacheInsight({ turnMetrics, running, concurrency }: Props) {
  const { allTurns } = turnMetrics;
  const hasData = running && allTurns.count >= MIN_SAMPLES;
  const rr = getRRBenchmark(concurrency);

  return (
    <div className="insight-panel">
      <h2>TTFT</h2>

      {!running ? (
        <div className="collecting-data">Start the workload to see TTFT metrics</div>
      ) : !hasData ? (
        <div className="collecting-data">
          Collecting data... ({allTurns.count} samples)
        </div>
      ) : (
        <div className="turn-cards">
          <div className="turn-card">
            <div className="turn-card-header">p50</div>
            <div className="turn-value">{fmt(allTurns.p50TTFT)}<span className="turn-unit">ms</span></div>
            <div className="benchmark-comparison">
              <div className="benchmark-baseline">
                <span className="benchmark-label">Round-Robin</span>
                <span className="benchmark-value">{rr.p50} ms</span>
              </div>
              <ImprovementBadge kv={allTurns.p50TTFT} rr={rr.p50} />
            </div>
          </div>
          <div className="turn-card">
            <div className="turn-card-header">p95</div>
            <div className="turn-value">{fmt(allTurns.p95TTFT)}<span className="turn-unit">ms</span></div>
            <div className="benchmark-comparison">
              <div className="benchmark-baseline">
                <span className="benchmark-label">Round-Robin</span>
                <span className="benchmark-value">{rr.p95} ms</span>
              </div>
              <ImprovementBadge kv={allTurns.p95TTFT} rr={rr.p95} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
