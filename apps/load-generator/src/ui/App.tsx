import { useState, useEffect, useCallback } from 'react';
import { useMetrics } from './hooks/useMetrics';
import { useHashRouter } from './hooks/useHashRouter';
import { fetchStatus, startWorkload, stopWorkload, updateConfig } from './api';
import { MetricsPanel } from './components/MetricsPanel';
import { LiveMetricsPanel } from './components/LiveMetricsPanel';
import { BenchmarkTable } from './components/BenchmarkTable';
import { InfrastructurePanel } from './components/InfrastructurePanel';
import { ConversationList } from './components/ConversationList';
import { ConversationDetail } from './components/ConversationDetail';
import type { WorkloadConfig } from './types';

const DEFAULT_CONFIG: WorkloadConfig = {
  totalRPS: 10,
  mix: { a: 1.0 },
  maxConcurrency: 60,
};

export function App() {
  const ws = useMetrics();
  const { route, navigate } = useHashRouter();
  const [localConfig, setLocalConfig] = useState<WorkloadConfig>(DEFAULT_CONFIG);
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
      })
      .catch(() => {});
  }, []);

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

  return (
    <>
      <header className="header">
        <div className="header-left">
          <h1>Serve More Users on the Same GPUs with KV-Aware Routing</h1>
          <div className="header-subtitle">Powered by NVIDIA Dynamo and DigitalOcean Kubernetes Service</div>
          <nav className="header-nav">
            <a
              href="#/"
              className={`nav-link ${route.page === 'dashboard' ? 'nav-link-active' : ''}`}
            >
              Dashboard
            </a>
            <a
              href="#/conversations"
              className={`nav-link ${route.page === 'conversations' || route.page === 'conversation-detail' ? 'nav-link-active' : ''}`}
            >
              Conversations
            </a>
            <a
              href="#/demo-arch"
              className={`nav-link ${route.page === 'demo-arch' ? 'nav-link-active' : ''}`}
            >
              Demo Architecture
            </a>
            <a
              href="#/routing-arch"
              className={`nav-link ${route.page === 'routing-arch' ? 'nav-link-active' : ''}`}
            >
              KV Routing
            </a>
            <a
              href="#/dynamo-features"
              className={`nav-link ${route.page === 'dynamo-features' ? 'nav-link-active' : ''}`}
            >
              Dynamo Features
            </a>
          </nav>
        </div>
        <div className="header-actions">
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
      </header>

      {route.page === 'dashboard' && (
        <>
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

          <div className="main-grid">
            <LiveMetricsPanel
              metrics={ws.metrics}
              running={ws.running}
              concurrency={localConfig.maxConcurrency}
              config={localConfig}
              onConfigChange={handleConfigChange}
            />
            <MetricsPanel metrics={ws.metrics} running={ws.running} />
          </div>

          <BenchmarkTable />

          <InfrastructurePanel infra={ws.infrastructure} />
        </>
      )}

      {route.page === 'conversations' && (
        <ConversationList navigate={navigate} />
      )}

      {route.page === 'conversation-detail' && (
        <ConversationDetail conversationId={route.conversationId} navigate={navigate} />
      )}

      {route.page === 'demo-arch' && (
        <div className="infographic-page">
          <img src="/content/do-demo-arch.png" alt="Demo Architecture" className="infographic-img" />
        </div>
      )}

      {route.page === 'routing-arch' && (
        <div className="infographic-page">
          <img src="/content/kv-cache-arch.png" alt="KV Cache-Aware Routing Architecture" className="infographic-img" />
        </div>
      )}

      {route.page === 'dynamo-features' && (
        <div className="infographic-page">
          <img src="/content/dynamo-features.png" alt="Dynamo Features" className="infographic-img" />
        </div>
      )}
    </>
  );
}
