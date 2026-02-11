import type { AppConfig } from './config.js';
import type { RequestMetrics, WorkloadType } from './types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceRequest {
  workload: WorkloadType;
  itemId: string;
  messages: ChatMessage[];
  maxTokens: number;
}

/**
 * Sends a streaming chat completion request to the Dynamo frontend
 * (OpenAI-compatible SSE endpoint) and extracts TTFT/ITL metrics.
 */
export async function sendStreamingRequest(
  config: AppConfig,
  req: InferenceRequest,
): Promise<RequestMetrics> {
  const url = `${config.dynamoFrontendUrl}/v1/chat/completions`;
  const startTime = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.modelName,
        messages: req.messages,
        max_tokens: req.maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return errorMetrics(req, startTime, `HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }

    if (!resp.body) {
      return errorMetrics(req, startTime, 'No response body');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    let firstTokenTime: number | null = null;
    const tokenTimes: number[] = [];
    let outputTokens = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta;
        if (!delta?.content) continue;

        const now = performance.now();
        outputTokens++;

        if (firstTokenTime === null) {
          firstTokenTime = now;
        } else {
          tokenTimes.push(now);
        }
      }
    }

    const endTime = performance.now();
    const ttftMs = firstTokenTime !== null ? firstTokenTime - startTime : 0;

    // ITL: mean of inter-token deltas (between consecutive token arrivals)
    let itlMs = 0;
    if (tokenTimes.length > 0) {
      const deltas: number[] = [];
      let prev = firstTokenTime!;
      for (const t of tokenTimes) {
        deltas.push(t - prev);
        prev = t;
      }
      itlMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    }

    clearTimeout(timeout);

    return {
      workload: req.workload,
      status: 'ok',
      ttftMs,
      itlMs,
      latencyMs: endTime - startTime,
      outputTokens,
      completedAt: Date.now(),
      itemId: req.itemId,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    const msg = err?.name === 'AbortError' ? 'Request timeout (120s)' : (err?.message || String(err));
    return errorMetrics(req, startTime, msg);
  }
}

function errorMetrics(
  req: InferenceRequest,
  startTime: number,
  error: string,
): RequestMetrics {
  return {
    workload: req.workload,
    status: 'error',
    ttftMs: 0,
    itlMs: 0,
    latencyMs: performance.now() - startTime,
    outputTokens: 0,
    completedAt: Date.now(),
    error,
    itemId: req.itemId,
  };
}
