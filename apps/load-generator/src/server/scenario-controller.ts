import type { WorkloadConfig, ScenarioPhase, ScenarioStateData, WorkloadMix } from './types.js';
import type { K8sScaler, WorkerType } from './k8s-scaler.js';

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
  prefillReplicas: number | null;
  decodeReplicas: number | null;
}

const PHASES: PhaseSpec[] = [
  { phase: 'BALANCED',         durationMs: 120_000, mix: { a: 0.40, b: 0.30, c: 0.30 }, totalRPS: 2,   prefillReplicas: 1,    decodeReplicas: 1    },
  { phase: 'KV_CACHE_DEMO',    durationMs: 120_000, mix: { a: 1.00, b: 0,    c: 0    }, totalRPS: 2,   prefillReplicas: null,  decodeReplicas: null  },
  { phase: 'PREFILL_STRESS',   durationMs: 90_000,  mix: { a: 0,    b: 0.80, c: 0.20 }, totalRPS: 3,   prefillReplicas: null,  decodeReplicas: null  },
  { phase: 'PREFILL_RECOVERY', durationMs: 90_000,  mix: { a: 0,    b: 0.80, c: 0.20 }, totalRPS: 3,   prefillReplicas: 2,     decodeReplicas: null  },
  { phase: 'DECODE_STRESS',    durationMs: 90_000,  mix: { a: 0,    b: 0.20, c: 0.80 }, totalRPS: 3,   prefillReplicas: null,  decodeReplicas: null  },
  { phase: 'DECODE_RECOVERY',  durationMs: 90_000,  mix: { a: 0,    b: 0.20, c: 0.80 }, totalRPS: 3,   prefillReplicas: null,  decodeReplicas: 2     },
  { phase: 'FULL_LOAD',        durationMs: 120_000, mix: { a: 0.30, b: 0.35, c: 0.35 }, totalRPS: 4,   prefillReplicas: null,  decodeReplicas: null  },
  { phase: 'COOLDOWN',         durationMs: 60_000,  mix: { a: 0.33, b: 0.33, c: 0.34 }, totalRPS: 0.5, prefillReplicas: 1,     decodeReplicas: 1     },
];

const PHASE_DESCRIPTIONS: Record<ScenarioPhase, string> = {
  IDLE:              'Waiting to start',
  BALANCED:          'Balanced workload — all metrics nominal',
  KV_CACHE_DEMO:     'Multi-turn chat — TTFT drops on cache hits',
  PREFILL_STRESS:    'Heavy summarization — TTFT degrading',
  PREFILL_RECOVERY:  'Scaling prefill workers — TTFT recovering',
  DECODE_STRESS:     'Heavy reasoning — ITL degrading',
  DECODE_RECOVERY:   'Scaling decode workers — ITL recovering',
  FULL_LOAD:         'Full load — all GPUs active',
  COOLDOWN:          'Cooling down — resetting to baseline',
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

  private initialPrefillReplicas: number;
  private initialDecodeReplicas: number;

  constructor(
    scheduler: SchedulerControl,
    scaler: K8sScaler,
    broadcastFn: (type: 'scenario_state', data: ScenarioStateData | null) => void,
    initialPrefillReplicas: number,
    initialDecodeReplicas: number,
  ) {
    this.scheduler = scheduler;
    this.scaler = scaler;
    this.broadcastFn = broadcastFn;
    this.initialPrefillReplicas = initialPrefillReplicas;
    this.initialDecodeReplicas = initialDecodeReplicas;
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

    // Pause KEDA so it doesn't interfere
    await this.scaler.pauseKEDA();

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

    // Resume KEDA for manual mode
    await this.scaler.resumeKEDA();

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
    };

    if (spec.phase === 'BALANCED' && !this.scheduler.isSchedulerRunning()) {
      // Start scheduler with full config
      this.scheduler.startScheduler({
        totalRPS: spec.totalRPS,
        mix: spec.mix,
        maxConcurrency: 10,
      });
    } else if (this.scheduler.isSchedulerRunning()) {
      this.scheduler.updateSchedulerConfig(configUpdate);
    }

    // Fire scaling if specified (don't block phase transition)
    if (spec.prefillReplicas !== null) {
      this.scaler.scaleDGDSA('prefill', spec.prefillReplicas).catch((err) => {
        console.error('[scenario] Prefill scale error:', err);
      });
    }
    if (spec.decodeReplicas !== null) {
      this.scaler.scaleDGDSA('decode', spec.decodeReplicas).catch((err) => {
        console.error('[scenario] Decode scale error:', err);
      });
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
