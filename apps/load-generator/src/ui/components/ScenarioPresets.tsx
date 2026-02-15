import type { WorkloadConfig } from '../types';

interface Props {
  onSelect: (config: Partial<WorkloadConfig>) => void;
  running: boolean;
  disabled?: boolean;
}

const PRESETS: { label: string; totalRPS: number; mix: { a: number }; maxConcurrency: number }[] = [
  { label: 'Few Conversations', totalRPS: 10, mix: { a: 1.0 }, maxConcurrency: 30 },
  { label: 'Steady Traffic',    totalRPS: 10, mix: { a: 1.0 }, maxConcurrency: 35 },
  { label: 'Peak Traffic',      totalRPS: 10, mix: { a: 1.0 }, maxConcurrency: 40 },
];

export function ScenarioPresets({ onSelect, running, disabled }: Props) {
  return (
    <div className="presets">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className="preset-btn"
          disabled={disabled || !running}
          onClick={() => onSelect({ mix: p.mix, totalRPS: p.totalRPS, maxConcurrency: p.maxConcurrency })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
