import type { AppConfig } from './config.js';

export type WorkerType = 'prefill' | 'decode';

export class K8sScaler {
  constructor(_config: AppConfig) {
    console.log('[k8s] Scaling disabled in Phase 1 (fixed 2x TP=4 replicas)');
  }

  get isEnabled(): boolean {
    return false;
  }

  async scaleDGDSA(_workerType: WorkerType, _replicas: number): Promise<void> {
    console.debug('[k8s] scaleDGDSA: scaling disabled in Phase 1');
  }

  async pauseKEDA(): Promise<void> {
    console.debug('[k8s] pauseKEDA: scaling disabled in Phase 1');
  }

  async resumeKEDA(): Promise<void> {
    console.debug('[k8s] resumeKEDA: scaling disabled in Phase 1');
  }
}
