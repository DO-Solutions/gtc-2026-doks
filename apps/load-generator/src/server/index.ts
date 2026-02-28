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
import { InfraCollector } from './infra-collector.js';
import { ConversationStore } from './conversation-store.js';
import { recordPrometheusMetrics, register } from './prom-metrics.js';
import type { BaseRunner } from './workloads/base-runner.js';
import type {
  RequestMetrics,
  InfrastructureMetrics,
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

  // Send latest infrastructure snapshot if available
  if (lastInfra) {
    const infraMsg: WSMessage = { type: 'infrastructure', data: lastInfra };
    ws.send(JSON.stringify(infraMsg));
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scheduler: Scheduler | null = null;
let startTime: number | null = null;
const metrics = new MetricsAggregator(config.metricsWindowSec);
const runners = new Map<WorkloadType, BaseRunner>();
const infraCollector = new InfraCollector(config);
const conversationStore = new ConversationStore();
let lastInfra: InfrastructureMetrics | null = null;

// Corpus counts (set after loading)
let corpusCounts = { chatPassages: 0, summarizationDocs: 0, reasoningPrompts: 0 };

/** Shared callback: record metrics, broadcast via WS, and log. */
function onComplete(m: RequestMetrics): void {
  metrics.record(m);
  recordPrometheusMetrics(m);
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
// Conversation viewer API
// ---------------------------------------------------------------------------

app.get('/api/conversations', (_req, res) => {
  res.json(conversationStore.list());
});

app.get('/api/conversations/:id', (req, res) => {
  const record = conversationStore.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json(record);
});

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Static UI serving
// ---------------------------------------------------------------------------

app.use('/content', express.static(path.join(__dirname, '../content')));
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
    runners.set('a', new ChatRunner(config, corpus.chatPassages, onComplete, conversationStore));
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

  // Infrastructure metrics poll loop (runs always, independent of workload)
  setInterval(async () => {
    try {
      lastInfra = await infraCollector.collect();
      broadcast({ type: 'infrastructure', data: lastInfra });
    } catch (err) {
      console.log(`[infra] Collection error: ${err instanceof Error ? err.message : err}`);
    }
  }, config.infraPollIntervalMs);
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
