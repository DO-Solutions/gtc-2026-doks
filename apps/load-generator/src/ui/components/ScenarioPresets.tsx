import type { WorkloadConfig } from '../types';

interface Props {
  onSelect: (config: Partial<WorkloadConfig>) => void;
  running: boolean;
  disabled?: boolean;
}

const PRESETS: { label: string; totalRPS: number; mix: { a: number }; maxConcurrency: number }[] = [
  { label: 'Few Conversations', totalRPS: 0.5, mix: { a: 1.0 }, maxConcurrency: 3  },
  { label: 'Steady Traffic',    totalRPS: 2.0, mix: { a: 1.0 }, maxConcurrency: 10 },
  { label: 'Peak Traffic',      totalRPS: 4.0, mix: { a: 1.0 }, maxConcurrency: 20 },
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
