import type { WorkloadConfig } from '../types';

interface Props {
  onSelect: (config: Partial<WorkloadConfig>) => void;
  running: boolean;
  disabled?: boolean;
}

const PRESETS: { label: string; mix: { a: number; b: number; c: number } }[] = [
  { label: 'Balanced', mix: { a: 0.4, b: 0.3, c: 0.3 } },
  { label: 'KV Cache Demo', mix: { a: 1.0, b: 0, c: 0 } },
  { label: 'Prefill Stress', mix: { a: 0, b: 0.8, c: 0.2 } },
  { label: 'Decode Stress', mix: { a: 0, b: 0.2, c: 0.8 } },
  { label: 'Full Load', mix: { a: 0.3, b: 0.35, c: 0.35 } },
];

export function ScenarioPresets({ onSelect, running, disabled }: Props) {
  return (
    <div className="presets">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className="preset-btn"
          disabled={disabled || !running}
          onClick={() => onSelect({ mix: p.mix })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
