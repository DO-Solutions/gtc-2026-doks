import type { WorkloadConfig } from '../types';

interface Props {
  onSelect: (config: Partial<WorkloadConfig>) => void;
  running: boolean;
  disabled?: boolean;
}

const PRESETS: { label: string; totalRPS: number; mix: { a: number; b: number; c: number }; maxConcurrency: number }[] = [
  { label: 'Light Load',    totalRPS: 1.0, mix: { a: 1.0, b: 0, c: 0 }, maxConcurrency: 5  },
  { label: 'Moderate Load', totalRPS: 2.0, mix: { a: 1.0, b: 0, c: 0 }, maxConcurrency: 10 },
  { label: 'Heavy Load',    totalRPS: 4.0, mix: { a: 1.0, b: 0, c: 0 }, maxConcurrency: 20 },
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
