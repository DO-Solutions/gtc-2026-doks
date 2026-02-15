import { useState, useCallback } from 'react';
import { startAutoMode, stopAutoMode } from '../api';
import type { ScenarioStateData, ScenarioPhase } from '../types';

interface Props {
  scenarioState: ScenarioStateData | null;
  connected: boolean;
}

const PHASE_LABELS: Record<ScenarioPhase, string> = {
  IDLE: 'Idle',
  RAMP_UP: 'Ramp Up',
  STEADY_STATE: 'Steady State',
  HIGH_LOAD: 'High Load',
  COOLDOWN: 'Cooldown',
};

const PHASE_DESCRIPTIONS: Record<ScenarioPhase, string> = {
  IDLE: 'Waiting to start',
  RAMP_UP: 'Ramping up — light multi-turn chat load',
  STEADY_STATE: 'Steady state — moderate load, KV cache warming',
  HIGH_LOAD: 'High load — heavy multi-turn traffic',
  COOLDOWN: 'Cooling down — resetting to baseline',
};

function formatCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AutoModeControls({ scenarioState, connected }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = scenarioState !== null;

  const handleToggle = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      if (active) {
        await stopAutoMode();
      } else {
        await startAutoMode();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [active]);

  const progressPct = scenarioState
    ? ((scenarioState.phaseDurationMs - scenarioState.remainingMs) / scenarioState.phaseDurationMs) * 100
    : 0;

  return (
    <div className="auto-mode card">
      <h2>Auto Mode</h2>

      <button
        className={`btn ${active ? 'btn-stop' : 'btn-auto'}`}
        disabled={!connected || loading}
        onClick={handleToggle}
      >
        {loading ? '...' : active ? 'Stop Auto Mode' : 'Start Auto Mode'}
      </button>

      {error && <div className="auto-mode-error">{error}</div>}

      {scenarioState && (
        <div className="auto-mode-status">
          <div className="phase-info">
            <span className="phase-label">{PHASE_LABELS[scenarioState.phase]}</span>
            <span className="phase-description">{PHASE_DESCRIPTIONS[scenarioState.phase]}</span>
          </div>

          <div className="phase-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="countdown">{formatCountdown(scenarioState.remainingMs)}</span>
          </div>

          <div className="cycle-count">
            Phase {scenarioState.phaseIndex + 1}/{scenarioState.totalPhases}
            {scenarioState.cycleCount > 0 && ` — Cycle ${scenarioState.cycleCount + 1}`}
          </div>
        </div>
      )}
    </div>
  );
}
