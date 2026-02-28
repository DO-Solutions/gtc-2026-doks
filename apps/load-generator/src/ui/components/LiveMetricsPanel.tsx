import type { AggregateMetrics } from '../types';
import { getBenchmark } from '../data/rr-benchmark';

interface Props {
  metrics: AggregateMetrics | null;
  running: boolean;
  concurrency: number;
}

function sloClass(metric: 'ttft' | 'tpot', valueMs: number): string {
  if (metric === 'ttft') {
    if (valueMs < 600) return 'slo-green';
    if (valueMs < 800) return 'slo-yellow';
    return 'slo-red';
  }
  // tpot
  if (valueMs < 60) return 'slo-green';
  if (valueMs < 80) return 'slo-yellow';
  return 'slo-red';
}

function fmtMs(ms: number): string {
  return ms.toFixed(0);
}

function fmtLatency(ms: number): string {
  return (ms / 1000).toFixed(1);
}

interface MetricRowProps {
  label: string;
  liveP50: number;
  liveP95: number;
  rrP50: number;
  rrP95: number;
  format: (ms: number) => string;
  unit: string;
  sloMetric?: 'ttft' | 'tpot';
}

function MetricRow({ label, liveP50, liveP95, rrP50, rrP95, format, unit, sloMetric }: MetricRowProps) {
  const p95Class = sloMetric ? sloClass(sloMetric, liveP95) : '';
  return (
    <div className="live-metric-row">
      <div className="live-metric-label">{label}</div>
      <div className="live-metric-cell">
        <span className="live-metric-value">{format(liveP50)}</span>
        <span className="live-metric-unit">{unit}</span>
      </div>
      <div className="live-metric-cell live-metric-baseline">
        <span className="benchmark-value">{format(rrP50)}</span>
        <span className="live-metric-unit">{unit}</span>
      </div>
      <div className="live-metric-cell">
        <span className={`live-metric-value ${p95Class}`}>{format(liveP95)}</span>
        <span className="live-metric-unit">{unit}</span>
      </div>
      <div className="live-metric-cell live-metric-baseline">
        <span className="benchmark-value">{format(rrP95)}</span>
        <span className="live-metric-unit">{unit}</span>
      </div>
    </div>
  );
}

export function LiveMetricsPanel({ metrics, running, concurrency }: Props) {
  const bench = getBenchmark(concurrency);
  const hasData = running && metrics && metrics.requestCount > 0;

  return (
    <div className="insight-panel">
      <h2>Live vs Round-Robin Benchmark</h2>

      {!running ? (
        <div className="collecting-data">Start the workload to see live metrics</div>
      ) : !hasData ? (
        <div className="collecting-data">Collecting data...</div>
      ) : (
        <div className="live-metrics-table">
          <div className="live-metric-row live-metric-header">
            <div className="live-metric-label"></div>
            <div className="live-metric-cell">Live p50</div>
            <div className="live-metric-cell live-metric-baseline">RR p50</div>
            <div className="live-metric-cell">Live p95</div>
            <div className="live-metric-cell live-metric-baseline">RR p95</div>
          </div>
          <MetricRow
            label="TTFT"
            liveP50={metrics!.ttft.p50}
            liveP95={metrics!.ttft.p95}
            rrP50={bench.rr.ttft.p50}
            rrP95={bench.rr.ttft.p95}
            format={fmtMs}
            unit="ms"
            sloMetric="ttft"
          />
          <MetricRow
            label="TPOT"
            liveP50={metrics!.tpot.p50}
            liveP95={metrics!.tpot.p95}
            rrP50={bench.rr.tpot.p50}
            rrP95={bench.rr.tpot.p95}
            format={fmtMs}
            unit="ms"
            sloMetric="tpot"
          />
          <MetricRow
            label="ITL"
            liveP50={metrics!.itl.p50}
            liveP95={metrics!.itl.p95}
            rrP50={bench.rr.itl.p50}
            rrP95={bench.rr.itl.p95}
            format={fmtMs}
            unit="ms"
          />
          <MetricRow
            label="Latency"
            liveP50={metrics!.latency.p50}
            liveP95={metrics!.latency.p95}
            rrP50={bench.rr.latency.p50}
            rrP95={bench.rr.latency.p95}
            format={fmtLatency}
            unit="s"
          />
        </div>
      )}
    </div>
  );
}
