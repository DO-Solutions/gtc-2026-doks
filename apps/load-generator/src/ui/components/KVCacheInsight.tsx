import type { TurnMetrics } from '../hooks/useTurnMetrics';

interface Props {
  turnMetrics: TurnMetrics;
  running: boolean;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

const MIN_SAMPLES = 5;

export function KVCacheInsight({ turnMetrics, running }: Props) {
  const { allTurns } = turnMetrics;
  const hasData = running && allTurns.count >= MIN_SAMPLES;

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
          </div>
          <div className="turn-card">
            <div className="turn-card-header">p95</div>
            <div className="turn-value">{fmt(allTurns.p95TTFT)}<span className="turn-unit">ms</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
