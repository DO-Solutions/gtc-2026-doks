import { useCallback, useRef, useEffect } from 'react';
import type { WorkloadConfig } from '../types';

interface Props {
  config: WorkloadConfig;
  running: boolean;
  onConfigChange: (partial: Partial<WorkloadConfig>) => void;
}

export function WorkloadSliders({ config, running, onConfigChange }: Props) {
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

  const mixA = (config.mix.a ?? 0) * 100;
  const mixB = (config.mix.b ?? 0) * 100;
  const mixC = (config.mix.c ?? 0) * 100;

  function handleMixChange(which: 'a' | 'b' | 'c', rawPct: number) {
    const vals = { a: mixA, b: mixB, c: mixC };
    vals[which] = rawPct;
    const sum = vals.a + vals.b + vals.c;
    if (sum === 0) {
      // Avoid all-zero: reset to equal
      vals.a = vals.b = vals.c = 33.33;
    } else {
      // Normalize to 100%
      const factor = 100 / sum;
      vals.a *= factor;
      vals.b *= factor;
      vals.c *= factor;
    }
    debounced({
      mix: {
        a: Math.round(vals.a) / 100,
        b: Math.round(vals.b) / 100,
        c: Math.round(vals.c) / 100,
      },
    });
  }

  return (
    <div>
      <div className="slider-group">
        <div className="slider-label">
          <span>Total RPS</span>
          <span className="value">{config.totalRPS}</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={20}
          step={0.5}
          value={config.totalRPS}
          disabled={!running}
          onChange={(e) => debounced({ totalRPS: parseFloat(e.target.value) })}
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>Max Concurrency</span>
          <span className="value">{config.maxConcurrency}</span>
        </div>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={config.maxConcurrency}
          disabled={!running}
          onChange={(e) => debounced({ maxConcurrency: parseInt(e.target.value) })}
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>
            <span className="tag tag-a">A</span> Chat
          </span>
          <span className="value">{Math.round(mixA)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(mixA)}
          disabled={!running}
          onChange={(e) => handleMixChange('a', parseInt(e.target.value))}
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>
            <span className="tag tag-b">B</span> Summarization
          </span>
          <span className="value">{Math.round(mixB)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(mixB)}
          disabled={!running}
          onChange={(e) => handleMixChange('b', parseInt(e.target.value))}
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>
            <span className="tag tag-c">C</span> Reasoning
          </span>
          <span className="value">{Math.round(mixC)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(mixC)}
          disabled={!running}
          onChange={(e) => handleMixChange('c', parseInt(e.target.value))}
        />
      </div>
    </div>
  );
}
