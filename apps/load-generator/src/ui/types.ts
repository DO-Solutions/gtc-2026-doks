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
  tpotMs: number;
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
  tpot: PercentileStats;
  latency: PercentileStats;
  outputTokens: PercentileStats;
  tops: number;
}

export interface GpuMetrics {
  index: number;
  utilization: number | null;
  memoryUsedMiB: number | null;
  memoryFreeMiB: number | null;
}

export interface PodInfraMetrics {
  podName: string;
  shortName: string;
  gpus: GpuMetrics[];
}

export interface InfrastructureMetrics {
  collectedAt: number;
  pods: PodInfraMetrics[];
  kvCacheHitRate: number | null;
  prometheusAvailable: boolean;
  podsDiscovered: boolean;
  gpuType: string;
  modelName: string;
}

export type WSMessage =
  | { type: 'request_complete'; data: RequestMetrics }
  | { type: 'aggregate'; data: AggregateMetrics }
  | { type: 'state_change'; data: { running: boolean; config?: WorkloadConfig } }
  | { type: 'infrastructure'; data: InfrastructureMetrics };

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
}

// ---------------------------------------------------------------------------
// Conversation records (for conversation viewer)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  turnNumber: number;
  userMessage: string;
  assistantMessage: string;
  metrics: RequestMetrics;
}

export interface ConversationRecord {
  id: string;
  topic: string;
  status: 'active' | 'completed' | 'error';
  startedAt: number;
  completedAt: number | null;
  turns: TurnRecord[];
  totalDurationMs: number | null;
}

export interface ConversationSummary {
  id: string;
  topic: string;
  status: 'active' | 'completed' | 'error';
  startedAt: number;
  completedAt: number | null;
  turnCount: number;
  totalDurationMs: number | null;
}
