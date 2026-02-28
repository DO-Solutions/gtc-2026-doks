import { useState, useEffect, useRef } from 'react';
import type { InfrastructureMetrics, PodInfraMetrics } from '../types';
import { InfoIcon } from './InfoIcon';

interface Props {
  infra: InfrastructureMetrics | null;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function gpuColorClass(util: number | null): string {
  if (util === null) return 'gpu-none';
  if (util < 30) return 'gpu-low';
  if (util < 70) return 'gpu-mid';
  return 'gpu-high';
}

function gpuMemPercent(used: number | null, free: number | null): number | null {
  if (used === null || free === null) return null;
  const total = used + free;
  if (total === 0) return null;
  return (used / total) * 100;
}

function PodCard({ pod }: { pod: PodInfraMetrics }) {
  return (
    <div className="infra-pod-card">
      <div className="infra-pod-header">
        <span className="infra-pod-name">Worker {pod.shortName}</span>
      </div>
      <div className="infra-gpu-grid">
        {pod.gpus.map((gpu) => {
          const memPct = gpuMemPercent(gpu.memoryUsedMiB, gpu.memoryFreeMiB);
          return (
            <div key={gpu.index} className={`gpu-box ${gpuColorClass(gpu.utilization)}`}>
              <div className="gpu-box-label">GPU {gpu.index}</div>
              <div className="gpu-box-value">
                {gpu.utilization !== null ? `${fmt(gpu.utilization, 0)}%` : '\u2014'}
              </div>
              {memPct !== null && (
                <div className="gpu-box-mem">{fmt(memPct, 0)}% mem</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfraHeader({ infra, openPopover, setOpenPopover }: { infra: InfrastructureMetrics | null; openPopover: string | null; setOpenPopover: (v: string | null) => void }) {
  return (
    <div className="infra-header">
      <h2><span className="section-title">Infrastructure <InfoIcon id="infra-header" description="Per-worker GPU metrics from DCGM. Util = GPU compute utilization %. Mem = GPU framebuffer memory used / total." openPopover={openPopover} setOpenPopover={setOpenPopover} /></span></h2>
      {infra && (
        <div className="infra-meta">
          <span className="infra-meta-item">
            <span className="infra-meta-label">GPU</span>
            <span className="infra-meta-value">{infra.gpuType}</span>
          </span>
          <span className="infra-meta-item">
            <span className="infra-meta-label">Model</span>
            <span className="infra-meta-value">{infra.modelName}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function InfrastructurePanel({ infra }: Props) {
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

  // Not yet connected
  if (!infra) {
    return (
      <div className="infra-section" ref={sectionRef} onClick={() => setOpenPopover(null)}>
        <InfraHeader infra={null} openPopover={openPopover} setOpenPopover={setOpenPopover} />
        <div className="collecting-data">Connecting...</div>
      </div>
    );
  }

  // Prometheus unavailable warning
  const promWarning = !infra.prometheusAvailable && (
    <div className="infra-warning">Prometheus unavailable — metrics may be stale</div>
  );

  // No pods discovered
  if (!infra.podsDiscovered) {
    return (
      <div className="infra-section" ref={sectionRef} onClick={() => setOpenPopover(null)}>
        <InfraHeader infra={infra} openPopover={openPopover} setOpenPopover={setOpenPopover} />
        {promWarning}
        <div className="collecting-data">Waiting for worker pods...</div>
      </div>
    );
  }

  return (
    <div className="infra-section" ref={sectionRef} onClick={() => setOpenPopover(null)}>
      <InfraHeader infra={infra} openPopover={openPopover} setOpenPopover={setOpenPopover} />
      {promWarning}
      <div className="infra-pods-row">
        {infra.pods.map((pod) => (
          <PodCard key={pod.podName} pod={pod} />
        ))}
      </div>
    </div>
  );
}
