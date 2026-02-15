import type { WorkloadConfig, ScenarioPhase, ScenarioStateData, WorkloadMix } from './types.js';
import type { K8sScaler } from './k8s-scaler.js';

export interface SchedulerControl {
  startScheduler(config: WorkloadConfig): void;
  stopScheduler(): void;
  updateSchedulerConfig(partial: Partial<WorkloadConfig>): void;
  isSchedulerRunning(): boolean;
}

interface PhaseSpec {
  phase: ScenarioPhase;
  durationMs: number;
  mix: WorkloadMix;
  totalRPS: number;
  maxConcurrency: number;
}

const PHASES: PhaseSpec[] = [
  { phase: 'RAMP_UP',      durationMs: 60_000,  mix: { a: 1.0, b: 0, c: 0 }, totalRPS: 1.0, maxConcurrency: 5  },
  { phase: 'STEADY_STATE', durationMs: 120_000, mix: { a: 1.0, b: 0, c: 0 }, totalRPS: 2.0, maxConcurrency: 10 },
  { phase: 'HIGH_LOAD',    durationMs: 90_000,  mix: { a: 1.0, b: 0, c: 0 }, totalRPS: 4.0, maxConcurrency: 20 },
  { phase: 'COOLDOWN',     durationMs: 60_000,  mix: { a: 1.0, b: 0, c: 0 }, totalRPS: 0.5, maxConcurrency: 5  },
];

const PHASE_DESCRIPTIONS: Record<ScenarioPhase, string> = {
  IDLE:         'Waiting to start',
  RAMP_UP:      'Ramping up — light multi-turn chat load',
  STEADY_STATE: 'Steady state — moderate load, KV cache warming',
  HIGH_LOAD:    'High load — heavy multi-turn traffic',
  COOLDOWN:     'Cooling down — resetting to baseline',
};

export { PHASE_DESCRIPTIONS };

export class ScenarioController {
  private scheduler: SchedulerControl;
  private scaler: K8sScaler;
  private broadcastFn: (type: 'scenario_state', data: ScenarioStateData | null) => void;

  private phaseIndex = -1;
  private cycleCount = 0;
  private phaseStartedAt = 0;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private _active = false;

  constructor(
    scheduler: SchedulerControl,
    scaler: K8sScaler,
    broadcastFn: (type: 'scenario_state', data: ScenarioStateData | null) => void,
  ) {
    this.scheduler = scheduler;
    this.scaler = scaler;
    this.broadcastFn = broadcastFn;
  }

  get active(): boolean {
    return this._active;
  }

  getState(): ScenarioStateData | null {
    if (!this._active || this.phaseIndex < 0) return null;
    const spec = PHASES[this.phaseIndex];
    const elapsed = Date.now() - this.phaseStartedAt;
    const remaining = Math.max(0, spec.durationMs - elapsed);
    return {
      phase: spec.phase,
      remainingMs: remaining,
      phaseDurationMs: spec.durationMs,
      phaseIndex: this.phaseIndex,
      totalPhases: PHASES.length,
      cycleCount: this.cycleCount,
    };
  }

  async start(): Promise<void> {
    if (this._active) return;
    this._active = true;
    this.cycleCount = 0;
    this.phaseIndex = -1;

    console.log('[scenario] Starting auto mode');

    // Start the tick timer (1/sec) for UI countdown
    this.tickTimer = setInterval(() => {
      this.broadcastFn('scenario_state', this.getState());
    }, 1000);

    // Begin phase sequence
    this.advancePhase();
  }

  async stop(): Promise<void> {
    if (!this._active) return;
    this._active = false;

    console.log('[scenario] Stopping auto mode');

    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.phaseIndex = -1;

    // Broadcast null state
    this.broadcastFn('scenario_state', null);
  }

  private advancePhase(): void {
    if (!this._active) return;

    this.phaseIndex++;
    if (this.phaseIndex >= PHASES.length) {
      this.phaseIndex = 0;
      this.cycleCount++;
      console.log(`[scenario] Starting cycle ${this.cycleCount}`);
    }

    const spec = PHASES[this.phaseIndex];
    this.phaseStartedAt = Date.now();

    console.log(`[scenario] Phase ${this.phaseIndex}/${PHASES.length - 1}: ${spec.phase} (${spec.durationMs / 1000}s)`);

    // Update workload config
    const configUpdate: Partial<WorkloadConfig> = {
      totalRPS: spec.totalRPS,
      mix: spec.mix,
      maxConcurrency: spec.maxConcurrency,
    };

    if (spec.phase === 'RAMP_UP' && !this.scheduler.isSchedulerRunning()) {
      // Start scheduler with full config
      this.scheduler.startScheduler({
        totalRPS: spec.totalRPS,
        mix: spec.mix,
        maxConcurrency: spec.maxConcurrency,
      });
    } else if (this.scheduler.isSchedulerRunning()) {
      this.scheduler.updateSchedulerConfig(configUpdate);
    }

    // Broadcast state immediately
    this.broadcastFn('scenario_state', this.getState());

    // Handle COOLDOWN: stop scheduler halfway through
    if (spec.phase === 'COOLDOWN') {
      const halfDuration = spec.durationMs / 2;
      setTimeout(() => {
        if (this._active && this.scheduler.isSchedulerRunning()) {
          console.log('[scenario] COOLDOWN: stopping scheduler');
          this.scheduler.stopScheduler();
        }
      }, halfDuration);
    }

    // Schedule next phase
    this.phaseTimer = setTimeout(() => this.advancePhase(), spec.durationMs);
  }
}
