import type { ServerStatus, WorkloadConfig } from './types';

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`GET /api/status failed: ${res.status}`);
  return res.json();
}

export async function startWorkload(config?: Partial<WorkloadConfig>): Promise<void> {
  const res = await fetch('/api/workload/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config ?? {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/workload/start failed: ${res.status}`);
  }
}

export async function stopWorkload(): Promise<void> {
  const res = await fetch('/api/workload/stop', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/workload/stop failed: ${res.status}`);
  }
}

export async function updateConfig(config: Partial<WorkloadConfig>): Promise<void> {
  const res = await fetch('/api/workload/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/workload/config failed: ${res.status}`);
  }
}

export async function startAutoMode(): Promise<void> {
  const res = await fetch('/api/scenario/auto', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/scenario/auto failed: ${res.status}`);
  }
}

export async function stopAutoMode(): Promise<void> {
  const res = await fetch('/api/scenario/stop', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/scenario/stop failed: ${res.status}`);
  }
}

export async function switchToManual(): Promise<void> {
  const res = await fetch('/api/scenario/manual', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/scenario/manual failed: ${res.status}`);
  }
}
