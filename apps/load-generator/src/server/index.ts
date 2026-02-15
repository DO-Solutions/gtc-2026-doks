import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { loadConfig } from './config.js';
import { loadCorpus } from './corpus-loader.js';
import { MetricsAggregator } from './metrics.js';
import { Scheduler } from './scheduler.js';
import { SummarizationRunner } from './workloads/summarization.js';
import { ReasoningRunner } from './workloads/reasoning.js';
import { ChatRunner } from './workloads/chat.js';
import { K8sScaler } from './k8s-scaler.js';
import { ScenarioController } from './scenario-controller.js';
import type { SchedulerControl } from './scenario-controller.js';
import type { BaseRunner } from './workloads/base-runner.js';
import type {
  RequestMetrics,
  WorkloadType,
  WorkloadConfig,
  WSMessage,
  ServerStatus,
  ScenarioStateData,
} from './types.js';

const config = loadConfig();
const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Send current running state to newly connected client
  const stateMsg: WSMessage = {
    type: 'state_change',
    data: {
      running: scheduler?.running ?? false,
      config: scheduler?.currentConfig ?? undefined,
    },
  };
  ws.send(JSON.stringify(stateMsg));

  // Send current scenario state if auto mode is active
  const scenarioState = scenario.getState();
  if (scenarioState) {
    ws.send(JSON.stringify({ type: 'scenario_state', data: scenarioState }));
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scheduler: Scheduler | null = null;
let startTime: number | null = null;
const metrics = new MetricsAggregator(config.metricsWindowSec);
const runners = new Map<WorkloadType, BaseRunner>();

// Corpus counts (set after loading)
let corpusCounts = { chatPassages: 0, summarizationDocs: 0, reasoningPrompts: 0 };

// ---------------------------------------------------------------------------
// Scenario controller (auto mode)
// ---------------------------------------------------------------------------

const k8sScaler = new K8sScaler(config);

const schedulerControl: SchedulerControl = {
  startScheduler(wConfig: WorkloadConfig): void {
    if (scheduler?.running) return;
    scheduler = new Scheduler(runners, wConfig, onComplete);
    scheduler.start();
    startTime = Date.now();
    startAggregateBroadcast();
    broadcast({ type: 'state_change', data: { running: true, config: wConfig } });
  },
  stopScheduler(): void {
    if (!scheduler?.running) return;
    scheduler.stop();
    stopAggregateBroadcast();
    broadcast({ type: 'state_change', data: { running: false } });
  },
  updateSchedulerConfig(partial: Partial<WorkloadConfig>): void {
    if (!scheduler?.running) return;
    scheduler.updateConfig(partial);
    broadcast({ type: 'state_change', data: { running: true, config: scheduler.currentConfig } });
  },
  isSchedulerRunning(): boolean {
    return scheduler?.running ?? false;
  },
};

const scenario = new ScenarioController(
  schedulerControl,
  k8sScaler,
  (type: 'scenario_state', data: ScenarioStateData | null) => {
    broadcast({ type, data });
  },
);

/** Shared callback: record metrics, broadcast via WS, and log. */
function onComplete(m: RequestMetrics): void {
  metrics.record(m);
  broadcast({ type: 'request_complete', data: m });
  console.log(
    `[req] wl=${m.workload} status=${m.status} ttft=${m.ttftMs.toFixed(0)}ms ` +
    `itl=${m.itlMs.toFixed(1)}ms tokens=${m.outputTokens} lat=${m.latencyMs.toFixed(0)}ms` +
    (m.error ? ` err=${m.error.slice(0, 100)}` : '')
  );
}

// ---------------------------------------------------------------------------
// WebSocket broadcast
// ---------------------------------------------------------------------------

function broadcast(msg: WSMessage): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Periodic aggregate broadcast (1/sec)
let aggregateTimer: ReturnType<typeof setInterval> | null = null;

function startAggregateBroadcast(): void {
  if (aggregateTimer) return;
  aggregateTimer = setInterval(() => {
    broadcast({ type: 'aggregate', data: metrics.getAggregate() });
  }, 1000);
}

function stopAggregateBroadcast(): void {
  if (aggregateTimer) {
    clearInterval(aggregateTimer);
    aggregateTimer = null;
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/status', (_req, res) => {
  const status: ServerStatus = {
    running: scheduler?.running ?? false,
    config: scheduler?.currentConfig ?? null,
    uptimeMs: startTime ? Date.now() - startTime : 0,
    corpus: corpusCounts,
    metrics: scheduler?.running ? metrics.getAggregate() : null,
    scenario: scenario.getState(),
  };
  res.json(status);
});

app.post('/api/workload/start', (req, res) => {
  if (scenario.active) {
    res.status(409).json({ error: 'Cannot manually start during auto mode' });
    return;
  }
  if (scheduler?.running) {
    res.status(409).json({ error: 'Already running. POST /api/workload/stop first.' });
    return;
  }

  const body = req.body as Partial<WorkloadConfig>;
  const wConfig: WorkloadConfig = {
    totalRPS: body.totalRPS ?? config.defaultRPS,
    mix: body.mix ?? { a: 1.0, b: 0, c: 0 },
    maxConcurrency: body.maxConcurrency ?? config.defaultMaxConcurrency,
  };

  scheduler = new Scheduler(runners, wConfig, onComplete);
  scheduler.start();
  startTime = Date.now();
  startAggregateBroadcast();

  broadcast({ type: 'state_change', data: { running: true, config: wConfig } });
  res.json({ status: 'started', config: wConfig });
});

app.post('/api/workload/stop', (_req, res) => {
  if (scenario.active) {
    res.status(409).json({ error: 'Cannot manually stop during auto mode' });
    return;
  }
  if (!scheduler?.running) {
    res.status(409).json({ error: 'Not running.' });
    return;
  }
  scheduler.stop();
  stopAggregateBroadcast();
  broadcast({ type: 'state_change', data: { running: false } });
  res.json({ status: 'stopped' });
});

app.post('/api/workload/config', (req, res) => {
  if (scenario.active) {
    res.status(409).json({ error: 'Cannot change config during auto mode' });
    return;
  }
  if (!scheduler?.running) {
    res.status(409).json({ error: 'Not running. POST /api/workload/start first.' });
    return;
  }
  const body = req.body as Partial<WorkloadConfig>;
  scheduler.updateConfig(body);
  const updated = scheduler.currentConfig;
  broadcast({ type: 'state_change', data: { running: true, config: updated } });
  res.json({ status: 'updated', config: updated });
});

// ---------------------------------------------------------------------------
// Scenario (auto mode) routes
// ---------------------------------------------------------------------------

app.post('/api/scenario/auto', async (_req, res) => {
  if (scenario.active) {
    res.status(409).json({ error: 'Auto mode already active' });
    return;
  }
  await scenario.start();
  res.json({ status: 'auto_started' });
});

app.post('/api/scenario/stop', async (_req, res) => {
  if (!scenario.active) {
    res.status(409).json({ error: 'Auto mode not active' });
    return;
  }
  await scenario.stop();
  res.json({ status: 'auto_stopped' });
});

app.post('/api/scenario/manual', async (_req, res) => {
  if (scenario.active) {
    await scenario.stop();
  }
  await k8sScaler.resumeKEDA();
  res.json({ status: 'manual_mode' });
});

// ---------------------------------------------------------------------------
// Static UI serving
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '../ui')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../ui/index.html'));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[boot] Loading corpus from Spaces...');
  const corpus = await loadCorpus(config);
  corpusCounts = {
    chatPassages: corpus.chatPassages.length,
    summarizationDocs: corpus.summarizationDocs.length,
    reasoningPrompts: corpus.reasoningPrompts.length,
  };

  if (corpus.chatPassages.length > 0) {
    runners.set('a', new ChatRunner(config, corpus.chatPassages, onComplete));
  }
  if (corpus.summarizationDocs.length > 0) {
    runners.set('b', new SummarizationRunner(config, corpus.summarizationDocs));
  }
  if (corpus.reasoningPrompts.length > 0) {
    runners.set('c', new ReasoningRunner(config, corpus.reasoningPrompts));
  }

  console.log(`[boot] Runners ready: ${[...runners.keys()].join(', ')}`);
  console.log(`[boot] Dynamo frontend: ${config.dynamoFrontendUrl}`);
  console.log(`[boot] Model: ${config.modelName}`);

  server.listen(config.port, () => {
    console.log(`[boot] Server listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
