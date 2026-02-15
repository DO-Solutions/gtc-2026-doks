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
            <div className="turn-card turn-card-cold">
              <div className="turn-card-header">First Turn (Cold)</div>
              <div className="turn-value">{fmt(firstTurn.p50TTFT)}<span className="turn-unit">ms</span></div>
              <div className="turn-sub">p95: {fmt(firstTurn.p95TTFT)} ms &middot; n={firstTurn.count}</div>
            </div>

            <div className="turn-card turn-card-warm">
              <div className="turn-card-header">Follow-up Turns (Cached)</div>
              <div className="turn-value">{fmt(followUpTurns.p50TTFT)}<span className="turn-unit">ms</span></div>
              <div className="turn-sub">p95: {fmt(followUpTurns.p95TTFT)} ms &middot; n={followUpTurns.count}</div>
            </div>
          </div>

          <div className={`speedup-callout${speedupRatio > 2 ? ' speedup-glow' : ''}`}>
            {fmt(speedupRatio, 1)}&times; faster on follow-ups
          </div>

          <div className="insight-counters">
            Conversations: {totalConversations} &middot; Turns: {totalTurns}
          </div>
        </>
      )}
    </div>
  );
}
