import { useState, useEffect, useRef, useCallback } from 'react';
import type { RequestMetrics } from '../types';

const WINDOW_SIZE = 100;
const TURN_REGEX = /-t(\d+)$/;

export interface TurnBucketStats {
  count: number;
  meanTTFT: number;
  p50TTFT: number;
  p95TTFT: number;
}

export interface TurnMetrics {
  firstTurn: TurnBucketStats;
  followUpTurns: TurnBucketStats;
  speedupRatio: number;
  totalConversations: number;
  totalTurns: number;
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

export function useTurnMetrics(
  lastRequest: RequestMetrics | null,
  lastRequestId: number,
  running: boolean,
): TurnMetrics {
  const firstTurnValues = useRef<number[]>([]);
  const followUpValues = useRef<number[]>([]);
  const conversationIds = useRef<Set<string>>(new Set());
  const totalTurnsRef = useRef(0);
  const prevRunning = useRef(false);

  const [metrics, setMetrics] = useState<TurnMetrics>({
    firstTurn: EMPTY_BUCKET,
    followUpTurns: EMPTY_BUCKET,
    speedupRatio: 0,
    totalConversations: 0,
    totalTurns: 0,
  });

  // Reset when running transitions to true
  const reset = useCallback(() => {
    firstTurnValues.current = [];
    followUpValues.current = [];
    conversationIds.current = new Set();
    totalTurnsRef.current = 0;
    setMetrics({
      firstTurn: EMPTY_BUCKET,
      followUpTurns: EMPTY_BUCKET,
      speedupRatio: 0,
      totalConversations: 0,
      totalTurns: 0,
    });
  }, []);

  useEffect(() => {
    if (running && !prevRunning.current) {
      reset();
    }
    prevRunning.current = running;
  }, [running, reset]);

  // Process each new request
  useEffect(() => {
    if (!lastRequest || lastRequest.status !== 'ok') return;

    const itemId = lastRequest.itemId;
    if (!itemId) return;

    const match = itemId.match(TURN_REGEX);
    if (!match) return;

    const turnNum = parseInt(match[1], 10);
    const conversationId = itemId.replace(TURN_REGEX, '');

    conversationIds.current.add(conversationId);
    totalTurnsRef.current++;

    if (turnNum === 0) {
      const arr = firstTurnValues.current;
      arr.push(lastRequest.ttftMs);
      if (arr.length > WINDOW_SIZE) arr.shift();
    } else {
      const arr = followUpValues.current;
      arr.push(lastRequest.ttftMs);
      if (arr.length > WINDOW_SIZE) arr.shift();
    }

    const firstStats = computeStats(firstTurnValues.current);
    const followUpStats = computeStats(followUpValues.current);
    const ratio =
      followUpStats.p50TTFT > 0 ? firstStats.p50TTFT / followUpStats.p50TTFT : 0;

    setMetrics({
      firstTurn: firstStats,
      followUpTurns: followUpStats,
      speedupRatio: ratio,
      totalConversations: conversationIds.current.size,
      totalTurns: totalTurnsRef.current,
    });
  }, [lastRequestId]); // eslint-disable-line react-hooks/exhaustive-deps

  return metrics;
}
