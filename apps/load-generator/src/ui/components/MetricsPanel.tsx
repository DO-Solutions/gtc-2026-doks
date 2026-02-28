import { useState, useEffect, useRef } from 'react';
import type { AggregateMetrics } from '../types';

interface Props {
  metrics: AggregateMetrics | null;
  running: boolean;
}

const metricDescriptions: Record<string, string> = {
  rps: 'Requests per second — rate of completed requests',
  requests: 'Total number of completed requests',
  errors: 'Number of failed requests',
  tops: 'Tokens per second — output token throughput',
};

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function errorClass(count: number, total: number): string {
  if (count === 0) return 'healthy';
  if (total > 0 && count / total < 0.05) return 'warning';
  return 'critical';
}

function InfoIcon({ id, openPopover, setOpenPopover }: { id: string; openPopover: string | null; setOpenPopover: (v: string | null) => void }) {
  return (
    <>
      <span
        className="metric-info"
        onClick={(e) => { e.stopPropagation(); setOpenPopover(openPopover === id ? null : id); }}
      >&#9432;</span>
      {openPopover === id && (
        <div className="metric-popover">{metricDescriptions[id]}</div>
      )}
    </>
  );
}

export function MetricsPanel({ metrics, running }: Props) {
  const m = metrics;
  const noData = !running || !m;
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    function handleClick(e: MouseEvent) {
      if (sectionRef.current && !sectionRef.current.contains(e.target as Node)) {
        setOpenPopover(null);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openPopover]);

  return (
    <div className="metrics-section" ref={sectionRef} onClick={() => setOpenPopover(null)}>
      <h2>Metrics</h2>
      <div className="metrics-row">
        <div className="metric-card-compact">
          <div className="metric-label">RPS <InfoIcon id="rps" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : fmt(m.actualRPS, 1)}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">Requests <InfoIcon id="requests" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : m.requestCount}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">Errors <InfoIcon id="errors" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : errorClass(m.errorCount, m.requestCount)}`}>
            {noData ? '\u2014' : m.errorCount}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">TOPS <InfoIcon id="tops" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : m.tops.toFixed(1)}
          </div>
        </div>
      </div>
    </div>
  );
}
