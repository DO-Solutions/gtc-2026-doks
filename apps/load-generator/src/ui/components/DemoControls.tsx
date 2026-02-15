import { useCallback, useRef, useEffect } from 'react';
import type { WorkloadConfig } from '../types';

interface Props {
  config: WorkloadConfig;
  running: boolean;
  onConfigChange: (partial: Partial<WorkloadConfig>) => void;
  disabled?: boolean;
}

export function DemoControls({ config, running, onConfigChange, disabled }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<WorkloadConfig> | null>(null);

  const flush = useCallback(() => {
    if (pendingRef.current) {
      onConfigChange(pendingRef.current);
      pendingRef.current = null;
    }
  }, [onConfigChange]);

  const debounced = useCallback(
    (partial: Partial<WorkloadConfig>) => {
      pendingRef.current = { ...pendingRef.current, ...partial };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 300);
    },
    [flush],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div>
      <div className="slider-group">
        <div className="slider-label">
          <span>Concurrency</span>
          <span className="value">{config.maxConcurrency}</span>
        </div>
        <input
          type="range"
          min={1}
          max={60}
          step={1}
          value={config.maxConcurrency}
          disabled={disabled || !running}
          onChange={(e) => debounced({ maxConcurrency: parseInt(e.target.value) })}
        />
      </div>
    </div>
  );
}
