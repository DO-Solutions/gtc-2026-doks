import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { loadConfig } from './config.js';
import { loadCorpus } from './corpus-loader.js';
import { MetricsAggregator } from './metrics.js';
import { Scheduler } from './scheduler.js';
import { SummarizationRunner } from './workloads/summarization.js';
import { ReasoningRunner } from './workloads/reasoning.js';
import type { BaseRunner } from './workloads/base-runner.js';
import type {
  WorkloadType,
  WorkloadConfig,
  WSMessage,
  ServerStatus,
} from './types.js';

const config = loadConfig();
const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scheduler: Scheduler | null = null;
let startTime: number | null = null;
const metrics = new MetricsAggregator(config.metricsWindowSec);
const runners = new Map<WorkloadType, BaseRunner>();

// Corpus counts (set after loading)
let corpusCounts = { summarizationDocs: 0, reasoningPrompts: 0 };

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
  };
  res.json(status);
});

app.post('/api/workload/start', (req, res) => {
  if (scheduler?.running) {
    res.status(409).json({ error: 'Already running. POST /api/workload/stop first.' });
    return;
  }

  const body = req.body as Partial<WorkloadConfig>;
  const wConfig: WorkloadConfig = {
    totalRPS: body.totalRPS ?? config.defaultRPS,
    mix: body.mix ?? { b: 0.5, c: 0.5 },
    maxConcurrency: body.maxConcurrency ?? config.defaultMaxConcurrency,
  };

  scheduler = new Scheduler(runners, wConfig, (m) => {
    metrics.record(m);
    broadcast({ type: 'request_complete', data: m });
    console.log(
      `[req] wl=${m.workload} status=${m.status} ttft=${m.ttftMs.toFixed(0)}ms ` +
      `itl=${m.itlMs.toFixed(1)}ms tokens=${m.outputTokens} lat=${m.latencyMs.toFixed(0)}ms` +
      (m.error ? ` err=${m.error.slice(0, 100)}` : '')
    );
  });
  scheduler.start();
  startTime = Date.now();
  startAggregateBroadcast();

  broadcast({ type: 'state_change', data: { running: true, config: wConfig } });
  res.json({ status: 'started', config: wConfig });
});

app.post('/api/workload/stop', (_req, res) => {
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
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[boot] Loading corpus from Spaces...');
  const corpus = await loadCorpus(config);
  corpusCounts = {
    summarizationDocs: corpus.summarizationDocs.length,
    reasoningPrompts: corpus.reasoningPrompts.length,
  };

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
