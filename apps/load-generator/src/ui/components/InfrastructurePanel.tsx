import { useState, useEffect, useRef } from 'react';
import type { InfrastructureMetrics, PodInfraMetrics } from '../types';
import { InfoIcon } from './InfoIcon';

interface Props {
  infra: InfrastructureMetrics | null;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function gpuColorClass(hbmBw: number | null): string {
  if (hbmBw === null) return 'gpu-none';
  if (hbmBw < 20) return 'gpu-low';
  if (hbmBw < 60) return 'gpu-mid';
  return 'gpu-high';
}

function PodCard({ pod }: { pod: PodInfraMetrics }) {
  return (
    <div className="infra-pod-card">
      <div className="infra-pod-header">
        <span className="infra-pod-name">Worker {pod.shortName}</span>
      </div>
      <div className="infra-gpu-grid">
        {pod.gpus.map((gpu) => (
          <div key={gpu.index} className={`gpu-box ${gpuColorClass(gpu.hbmBandwidth)}`}>
            <div className="gpu-box-label">GPU {gpu.index}</div>
            <div className="gpu-box-value">
              {gpu.hbmBandwidth !== null ? `${fmt(gpu.hbmBandwidth, 0)}%` : '\u2014'}
            </div>
            {gpu.tensorCoreActivity !== null && (
              <div className="gpu-box-secondary">{fmt(gpu.tensorCoreActivity, 0)}% TC</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function InfraHeader({ infra, openPopover, setOpenPopover }: { infra: InfrastructureMetrics | null; openPopover: string | null; setOpenPopover: (v: string | null) => void }) {
  return (
    <div className="infra-header">
      <h2><span className="section-title">Infrastructure <InfoIcon id="infra-header" description="Per-worker GPU metrics from DCGM. HBM BW = High Bandwidth Memory utilization %. TC = Tensor Core activity %." openPopover={openPopover} setOpenPopover={setOpenPopover} /></span></h2>
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
