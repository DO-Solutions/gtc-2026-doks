import client from 'prom-client';
import type { RequestMetrics } from './types.js';

export const register = client.register;

const TURN_REGEX = /-t(\d+)$/;

const ttftSummary = new client.Summary({
  name: 'loadgen_ttft_seconds',
  help: 'Time to first token measured client-side',
  labelNames: ['turn_type'] as const,
  percentiles: [0.5, 0.95],
  maxAgeSeconds: 300,
  ageBuckets: 5,
});

const itlSummary = new client.Summary({
  name: 'loadgen_itl_seconds',
  help: 'Inter-token latency measured client-side',
  labelNames: ['turn_type'] as const,
  percentiles: [0.5, 0.95],
  maxAgeSeconds: 300,
  ageBuckets: 5,
});

const ttftAllSummary = new client.Summary({
  name: 'loadgen_ttft_all_seconds',
  help: 'Time to first token for all requests (no turn-type split)',
  percentiles: [0.5, 0.95],
  maxAgeSeconds: 300,
  ageBuckets: 5,
});

const requestsCounter = new client.Counter({
  name: 'loadgen_requests_total',
  help: 'Total requests by turn type and status',
  labelNames: ['turn_type', 'status'] as const,
});

export function recordPrometheusMetrics(m: RequestMetrics): void {
  // Generic TTFT for all requests
  if (m.ttftMs > 0) {
    ttftAllSummary.observe(m.ttftMs / 1000);
  }

  if (!m.itemId) return;
  const match = TURN_REGEX.exec(m.itemId);
  if (!match) return;

  const turnType = match[1] === '0' ? 'initial' : 'followup';

  ttftSummary.observe({ turn_type: turnType }, m.ttftMs / 1000);
  itlSummary.observe({ turn_type: turnType }, m.itlMs / 1000);
  requestsCounter.inc({ turn_type: turnType, status: m.status });
}
