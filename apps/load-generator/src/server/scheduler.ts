import type { WorkloadConfig, WorkloadType, RequestMetrics } from './types.js';
import type { BaseRunner } from './workloads/base-runner.js';

export type RequestCallback = (metrics: RequestMetrics) => void;

export class Scheduler {
  private runners: Map<WorkloadType, BaseRunner>;
  private config: WorkloadConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeConcurrency = 0;
  private onComplete: RequestCallback;

  constructor(
    runners: Map<WorkloadType, BaseRunner>,
    config: WorkloadConfig,
    onComplete: RequestCallback,
  ) {
    this.runners = runners;
    this.config = config;
    this.onComplete = onComplete;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = 1000 / this.config.totalRPS;
    this.timer = setInterval(() => this.dispatch(), intervalMs);
    console.log(
      `[scheduler] Started: ${this.config.totalRPS} RPS, ` +
      `max concurrency ${this.config.maxConcurrency}, ` +
      `mix ${JSON.stringify(this.config.mix)}`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[scheduler] Stopped');
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get currentConfig(): WorkloadConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<WorkloadConfig>): void {
    const wasRunning = this.running;
    if (wasRunning) this.stop();

    if (partial.totalRPS !== undefined) this.config.totalRPS = partial.totalRPS;
    if (partial.mix !== undefined) this.config.mix = partial.mix;
    if (partial.maxConcurrency !== undefined) this.config.maxConcurrency = partial.maxConcurrency;

    if (wasRunning) this.start();
    console.log(`[scheduler] Config updated: ${JSON.stringify(this.config)}`);
  }

  private dispatch(): void {
    if (this.activeConcurrency >= this.config.maxConcurrency) return;

    const workload = this.pickWorkload();
    if (!workload) return;

    const runner = this.runners.get(workload);
    if (!runner) return;

    this.activeConcurrency++;
    runner.run().then(
      (metrics) => {
        this.activeConcurrency--;
        this.onComplete(metrics);
      },
      (err) => {
        this.activeConcurrency--;
        console.error(`[scheduler] Unexpected runner error:`, err);
      },
    );
  }

  private pickWorkload(): WorkloadType | null {
    const entries = Object.entries(this.config.mix) as [WorkloadType, number][];
    const active = entries.filter(
      ([wt, weight]) => weight > 0 && this.runners.has(wt)
    );
    if (active.length === 0) return null;

    const totalWeight = active.reduce((sum, [, w]) => sum + w, 0);
    let r = Math.random() * totalWeight;
    for (const [wt, weight] of active) {
      r -= weight;
      if (r <= 0) return wt;
    }
    return active[active.length - 1][0];
  }
}
