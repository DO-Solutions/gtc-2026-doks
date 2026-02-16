import { useState, useEffect, useRef, useCallback } from 'react';
import type { RequestMetrics } from '../types';

const WINDOW_MS = 60_000;

export interface TurnBucketStats {
  count: number;
  meanTTFT: number;
  p50TTFT: number;
  p95TTFT: number;
}

export interface TurnMetrics {
  allTurns: TurnBucketStats;
}

interface Sample {
  ttftMs: number;
  completedAt: number;
}

const EMPTY_BUCKET: TurnBucketStats = { count: 0, meanTTFT: 0, p50TTFT: 0, p95TTFT: 0 };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(values: number[]): TurnBucketStats {
  if (values.length === 0) return EMPTY_BUCKET;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    meanTTFT: sum / sorted.length,
    p50TTFT: percentile(sorted, 50),
    p95TTFT: percentile(sorted, 95),
  };
}

function pruneAndExtract(samples: Sample[]): number[] {
  const cutoff = Date.now() - WINDOW_MS;
  let i = 0;
  while (i < samples.length && samples[i].completedAt < cutoff) i++;
  if (i > 0) samples.splice(0, i);
  return samples.map(s => s.ttftMs);
}

export function useTurnMetrics(
  lastRequest: RequestMetrics | null,
  lastRequestId: number,
  running: boolean,
): TurnMetrics {
  const allValues = useRef<Sample[]>([]);
  const prevRunning = useRef(false);

  const [metrics, setMetrics] = useState<TurnMetrics>({
    allTurns: EMPTY_BUCKET,
  });

  const recompute = useCallback(() => {
    const vals = pruneAndExtract(allValues.current);
    setMetrics({ allTurns: computeStats(vals) });
  }, []);

  const reset = useCallback(() => {
    allValues.current = [];
    setMetrics({ allTurns: EMPTY_BUCKET });
  }, []);

  useEffect(() => {
    if (running && !prevRunning.current) {
      reset();
    }
    prevRunning.current = running;
  }, [running, reset]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(recompute, 1000);
    return () => clearInterval(id);
  }, [running, recompute]);

  useEffect(() => {
    if (!lastRequest || lastRequest.status !== 'ok') return;
    if (lastRequest.ttftMs <= 0) return;

    allValues.current.push({ ttftMs: lastRequest.ttftMs, completedAt: Date.now() });
    recompute();
  }, [lastRequestId, recompute]); // eslint-disable-line react-hooks/exhaustive-deps

  return metrics;
}
