/** Workload types: a = chat, b = summarization, c = reasoning. */
export type WorkloadType = 'a' | 'b' | 'c';

/** Mix ratios for each workload type (0-1, should sum to 1). */
export type WorkloadMix = Partial<Record<WorkloadType, number>>;

export interface WorkloadConfig {
  totalRPS: number;
  mix: WorkloadMix;
  maxConcurrency: number;
}

export interface RequestMetrics {
  workload: WorkloadType;
  status: 'ok' | 'error';
  ttftMs: number;
  itlMs: number;
  latencyMs: number;
  outputTokens: number;
  completedAt: number;
  error?: string;
  itemId?: string;
}

export interface PercentileStats {
  mean: number;
  p50: number;
  p95: number;
}

export interface AggregateMetrics {
  windowSec: number;
  requestCount: number;
  errorCount: number;
  actualRPS: number;
  ttft: PercentileStats;
  itl: PercentileStats;
  latency: PercentileStats;
  outputTokens: PercentileStats;
}

export type ScenarioPhase =
  | 'IDLE'
  | 'BALANCED'
  | 'KV_CACHE_DEMO'
  | 'PREFILL_STRESS'
  | 'PREFILL_RECOVERY'
  | 'DECODE_STRESS'
  | 'DECODE_RECOVERY'
  | 'FULL_LOAD'
  | 'COOLDOWN';

export interface ScenarioStateData {
  phase: ScenarioPhase;
  remainingMs: number;
  phaseDurationMs: number;
  phaseIndex: number;
  totalPhases: number;
  cycleCount: number;
}

export type WSMessage =
  | { type: 'request_complete'; data: RequestMetrics }
  | { type: 'aggregate'; data: AggregateMetrics }
  | { type: 'state_change'; data: { running: boolean; config?: WorkloadConfig } }
  | { type: 'scenario_state'; data: ScenarioStateData | null };

export interface ServerStatus {
  running: boolean;
  config: WorkloadConfig | null;
  uptimeMs: number;
  corpus: {
    chatPassages: number;
    summarizationDocs: number;
    reasoningPrompts: number;
  };
  metrics: AggregateMetrics | null;
  scenario: ScenarioStateData | null;
}
