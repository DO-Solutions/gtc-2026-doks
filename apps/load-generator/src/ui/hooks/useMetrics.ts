import { useState, useEffect, useRef, useCallback } from 'react';
import type { AggregateMetrics, WorkloadConfig, RequestMetrics, WSMessage } from '../types';

const MAX_RECENT = 20;

export interface UseMetricsResult {
  connected: boolean;
  metrics: AggregateMetrics | null;
  running: boolean;
  config: WorkloadConfig | null;
  recentRequests: RequestMetrics[];
}

export function useMetrics(): UseMetricsResult {
  const [connected, setConnected] = useState(false);
  const [metrics, setMetrics] = useState<AggregateMetrics | null>(null);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<WorkloadConfig | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestMetrics[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      retryRef.current = 0;
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
      retryRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as WSMessage;
      switch (msg.type) {
        case 'aggregate':
          setMetrics(msg.data);
          break;
        case 'state_change':
          setRunning(msg.data.running);
          if (msg.data.config) setConfig(msg.data.config);
          if (!msg.data.running) setMetrics(null);
          break;
        case 'request_complete':
          setRecentRequests((prev) => {
            const next = [...prev, msg.data];
            return next.length > MAX_RECENT ? next.slice(-MAX_RECENT) : next;
          });
          break;
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, metrics, running, config, recentRequests };
}
