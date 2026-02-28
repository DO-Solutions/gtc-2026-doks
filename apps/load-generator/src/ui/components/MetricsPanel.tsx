import { useState, useEffect, useRef } from 'react';
import type { AggregateMetrics, InfrastructureMetrics } from '../types';
import { InfoIcon } from './InfoIcon';

interface Props {
  metrics: AggregateMetrics | null;
  running: boolean;
  infrastructure: InfrastructureMetrics | null;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function errorClass(count: number): string {
  if (count === 0) return '';
  return 'critical';
}

export function MetricsPanel({ metrics, running, infrastructure }: Props) {
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
          <div className="metric-label">RPS <InfoIcon id="rps" description="Requests per second — rate of completed requests" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : fmt(m.actualRPS, 1)}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">Requests <InfoIcon id="requests" description="Total number of completed requests" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : m.requestCount}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">TOPS <InfoIcon id="tops" description="Tokens per second — output token throughput" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : ''}`}>
            {noData ? '\u2014' : m.tops.toFixed(0)}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">KV Cache Hit <InfoIcon id="kvHit" description="KV cache hit rate — percentage of input tokens served from cache" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${infrastructure?.kvCacheHitRate == null ? 'muted' : ''}`}>
            {infrastructure?.kvCacheHitRate != null ? fmt(infrastructure.kvCacheHitRate, 1) + '%' : '\u2014'}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">Queued <InfoIcon id="queued" description="Requests currently queued at the Dynamo frontend" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${infrastructure?.queuedRequests == null ? 'muted' : ''}`}>
            {infrastructure?.queuedRequests != null ? fmt(infrastructure.queuedRequests) : '\u2014'}
          </div>
        </div>

        <div className="metric-card-compact">
          <div className="metric-label">Errors <InfoIcon id="errors" description="Number of failed requests" openPopover={openPopover} setOpenPopover={setOpenPopover} /></div>
          <div className={`metric-value ${noData ? 'muted' : errorClass(m.errorCount)}`}>
            {noData ? '\u2014' : m.errorCount}
          </div>
        </div>
      </div>
    </div>
  );
}
