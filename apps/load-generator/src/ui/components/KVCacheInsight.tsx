import type { TurnMetrics } from '../hooks/useTurnMetrics';

interface Props {
  turnMetrics: TurnMetrics;
  running: boolean;
  kvCacheHitRate: number | null;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

const MIN_SAMPLES = 5;

function kvHitClass(rate: number | null): string {
  if (rate === null) return 'muted';
  if (rate >= 50) return 'healthy';
  if (rate >= 20) return 'warning';
  return 'critical';
}

export function KVCacheInsight({ turnMetrics, running, kvCacheHitRate }: Props) {
  const { firstTurn, followUpTurns, speedupRatio, totalConversations, totalTurns } = turnMetrics;
  const hasData = running && firstTurn.count >= MIN_SAMPLES && followUpTurns.count >= MIN_SAMPLES;

  return (
    <div className="insight-panel">
      <h2>KV Cache Routing Insight</h2>

      {!running ? (
        <div className="collecting-data">Start the workload to see KV cache metrics</div>
      ) : !hasData ? (
        <div className="collecting-data">
          Collecting data... ({firstTurn.count} first-turn, {followUpTurns.count} follow-up samples)
        </div>
      ) : (
        <>
          <div className="turn-cards">
            <div className="turn-card">
              <div className="turn-card-header">Initial TTFT (Cold)</div>
              <div className="turn-value">{fmt(firstTurn.p50TTFT)}<span className="turn-unit">ms</span></div>
              <div className="turn-sub">p95: {fmt(firstTurn.p95TTFT)} ms</div>
            </div>

            <div className="turn-card">
              <div className="turn-card-header">Follow-up TTFT (Cached)</div>
              <div className="turn-value">{fmt(followUpTurns.p50TTFT)}<span className="turn-unit">ms</span></div>
              <div className="turn-sub">p95: {fmt(followUpTurns.p95TTFT)} ms</div>
            </div>

            <div className="turn-card">
              <div className="turn-card-header">KV Cache Hit Rate</div>
              <div className={`turn-value ${kvHitClass(kvCacheHitRate)}`}>
                {kvCacheHitRate !== null ? `${fmt(kvCacheHitRate)}` : '\u2014'}<span className="turn-unit">{kvCacheHitRate !== null ? '%' : ''}</span>
              </div>
              <div className="turn-sub">cached / total input tokens</div>
            </div>
          </div>

          <div className={`speedup-callout${speedupRatio > 2 ? ' speedup-glow' : ''}`}>
            {fmt(speedupRatio, 1)}&times; faster on follow-ups
          </div>

        </>
      )}
    </div>
  );
}
