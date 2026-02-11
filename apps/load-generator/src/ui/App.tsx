import { useState, useEffect, useCallback } from 'react';
import { useMetrics } from './hooks/useMetrics';
import { fetchStatus, startWorkload, stopWorkload, updateConfig } from './api';
import { WorkloadSliders } from './components/WorkloadSliders';
import { ScenarioPresets } from './components/ScenarioPresets';
import { MetricsPanel } from './components/MetricsPanel';
import { AutoModeControls } from './components/AutoModeControls';
import type { WorkloadConfig } from './types';

const DEFAULT_CONFIG: WorkloadConfig = {
  totalRPS: 2,
  mix: { a: 0.4, b: 0.3, c: 0.3 },
  maxConcurrency: 10,
};

export function App() {
  const ws = useMetrics();
  const [localConfig, setLocalConfig] = useState<WorkloadConfig>(DEFAULT_CONFIG);
  const [uptimeMs, setUptimeMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Sync config from WebSocket state_change events
  useEffect(() => {
    if (ws.config) setLocalConfig(ws.config);
  }, [ws.config]);

  // Fetch initial status on mount
  useEffect(() => {
    fetchStatus()
      .then((s) => {
        if (s.config) setLocalConfig(s.config);
        setUptimeMs(s.uptimeMs);
      })
      .catch(() => {});
  }, []);

  // Update uptime every second while running
  useEffect(() => {
    if (!ws.running) return;
    const t = setInterval(() => setUptimeMs((prev) => prev + 1000), 1000);
    return () => clearInterval(t);
  }, [ws.running]);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      await startWorkload(localConfig);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [localConfig]);

  const handleStop = useCallback(async () => {
    setError(null);
    try {
      await stopWorkload();
      setUptimeMs(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleConfigChange = useCallback(
    async (partial: Partial<WorkloadConfig>) => {
      const merged = { ...localConfig, ...partial };
      if (partial.mix) merged.mix = partial.mix;
      setLocalConfig(merged);
      if (ws.running) {
        try {
          await updateConfig(partial);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [localConfig, ws.running],
  );

  const formatUptime = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  return (
    <>
      <header className="header">
        <h1>GTC Demo &mdash; Load Generator</h1>
        <div className="header-status">
          <div
            className={`status-dot ${ws.connected ? (ws.running ? 'running' : 'connected') : ''}`}
          />
          <span>
            {!ws.connected
              ? 'Disconnected'
              : ws.running
                ? `Running (${formatUptime(uptimeMs)})`
                : 'Idle'}
          </span>
        </div>
      </header>

      {error && (
        <div
          style={{
            background: 'rgba(229,57,53,0.15)',
            border: '1px solid var(--accent-red)',
            borderRadius: 'var(--radius)',
            padding: '10px 16px',
            marginBottom: 16,
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      <div className="actions">
        <button
          className="btn btn-start"
          disabled={!ws.connected || ws.running}
          onClick={handleStart}
        >
          Start
        </button>
        <button
          className="btn btn-stop"
          disabled={!ws.connected || !ws.running}
          onClick={handleStop}
        >
          Stop
        </button>
      </div>

      <div className="main-grid">
        <div className="card">
          <h2>Workload Controls</h2>
          <ScenarioPresets onSelect={handleConfigChange} running={ws.running} />
          <WorkloadSliders
            config={localConfig}
            running={ws.running}
            onConfigChange={handleConfigChange}
          />
        </div>

        <div className="card">
          <h2>Live Metrics</h2>
          <MetricsPanel metrics={ws.metrics} running={ws.running} />
        </div>
      </div>

      <AutoModeControls />
    </>
  );
}
