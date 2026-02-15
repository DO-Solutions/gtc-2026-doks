import type { InfrastructureMetrics, PodInfraMetrics } from '../types';

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

export function InfrastructurePanel({ infra }: Props) {
  // Not yet connected
  if (!infra) {
    return (
      <div className="infra-section">
        <h2>Infrastructure</h2>
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
      <div className="infra-section">
        <h2>Infrastructure</h2>
        {promWarning}
        <div className="collecting-data">Waiting for worker pods...</div>
      </div>
    );
  }

  return (
    <div className="infra-section">
      <h2>Infrastructure</h2>
      {promWarning}
      <div className="infra-pods-row">
        {infra.pods.map((pod) => (
          <PodCard key={pod.podName} pod={pod} />
        ))}
      </div>
    </div>
  );
}
