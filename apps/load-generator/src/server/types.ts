// ---------------------------------------------------------------------------
// Corpus shapes (match JSONL produced by corpus-curator)
// ---------------------------------------------------------------------------

export interface SummarizationDoc {
  id: string;
  text: string;
  source: string;
  title: string;
  token_count: number;
}

export interface ReasoningPrompt {
  id: string;
  category: string;
  prompt: string;
  expected_output_length: number;
  prompt_token_count: number;
}

export interface ChatPassage {
  id: string;
  text: string;
  topic: string;
  token_count: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Workload configuration
// ---------------------------------------------------------------------------

/** Workload types: a = chat, b = summarization, c = reasoning. */
export type WorkloadType = 'a' | 'b' | 'c';

/** Mix ratios for each workload type (0-1, should sum to 1). */
export type WorkloadMix = Partial<Record<WorkloadType, number>>;

export interface WorkloadConfig {
  totalRPS: number;
  mix: WorkloadMix;
  maxConcurrency: number;
}

// ---------------------------------------------------------------------------
// Request metrics
// ---------------------------------------------------------------------------

export interface RequestMetrics {
  workload: WorkloadType;
  status: 'ok' | 'error';
  /** Time to first token in ms */
  ttftMs: number;
  /** Mean inter-token latency in ms */
  itlMs: number;
  /** Total request duration in ms */
  latencyMs: number;
  /** Number of generated tokens */
  outputTokens: number;
  /** Timestamp when the request completed */
  completedAt: number;
  /** Error message if status is 'error' */
  error?: string;
  /** Corpus item ID used */
  itemId?: string;
}

// ---------------------------------------------------------------------------
// Aggregate metrics (rolling window)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Infrastructure metrics
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

export type WSMessage =
  | { type: 'request_complete'; data: RequestMetrics }
  | { type: 'aggregate'; data: AggregateMetrics }
  | { type: 'state_change'; data: { running: boolean; config?: WorkloadConfig } }
  | { type: 'infrastructure'; data: InfrastructureMetrics };

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

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
