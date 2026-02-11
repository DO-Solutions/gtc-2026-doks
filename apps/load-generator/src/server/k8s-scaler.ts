import * as k8s from '@kubernetes/client-node';
import type { AppConfig } from './config.js';

export type WorkerType = 'prefill' | 'decode';

export class K8sScaler {
  private customApi: k8s.CustomObjectsApi | null = null;
  private enabled = false;
  private namespace: string;
  private dgdsaNames: Record<WorkerType, string>;
  private kedaScaledObjects: string[];

  constructor(config: AppConfig) {
    this.namespace = config.k8sNamespace;
    this.dgdsaNames = {
      prefill: config.dgdsaPrefillName,
      decode: config.dgdsaDecodeName,
    };
    this.kedaScaledObjects = config.kedaScaledObjects;

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromCluster();
      this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      this.enabled = true;
      console.log('[k8s] In-cluster config loaded');
    } catch (err) {
      this.enabled = false;
      console.warn('[k8s] In-cluster config not available (local dev mode) — scaling operations will be no-ops');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async scaleDGDSA(workerType: WorkerType, replicas: number): Promise<void> {
    const name = this.dgdsaNames[workerType];
    if (!this.enabled || !this.customApi) {
      console.log(`[k8s] (no-op) scaleDGDSA ${name} → ${replicas} replicas`);
      return;
    }

    console.log(`[k8s] Scaling DGDSA ${name} → ${replicas} replicas`);
    try {
      await this.customApi.patchNamespacedCustomObjectScale(
        {
          group: 'nvidia.com',
          version: 'v1alpha1',
          namespace: this.namespace,
          plural: 'dynamographdeploymentscalingadapters',
          name,
          body: [{ op: 'replace', path: '/spec/replicas', value: replicas }],
        }
      );
      console.log(`[k8s] DGDSA ${name} scaled to ${replicas}`);
    } catch (err: any) {
      console.error(`[k8s] Failed to scale DGDSA ${name}:`, err?.body?.message ?? err?.message ?? err);
    }
  }

  async pauseKEDA(): Promise<void> {
    await this.setKEDAPaused('true');
  }

  async resumeKEDA(): Promise<void> {
    await this.setKEDAPaused('false');
  }

  private async setKEDAPaused(value: string): Promise<void> {
    if (!this.enabled || !this.customApi) {
      console.log(`[k8s] (no-op) setKEDAPaused(${value})`);
      return;
    }

    if (this.kedaScaledObjects.length === 0) {
      console.log(`[k8s] No KEDA ScaledObjects configured — skipping pause/resume`);
      return;
    }

    for (const name of this.kedaScaledObjects) {
      try {
        await this.customApi.patchNamespacedCustomObject(
          {
            group: 'keda.sh',
            version: 'v1alpha1',
            namespace: this.namespace,
            plural: 'scaledobjects',
            name,
            body: [{ op: 'add', path: '/metadata/annotations/autoscaling.keda.sh~1paused', value }],
          }
        );
        console.log(`[k8s] ScaledObject ${name} paused=${value}`);
      } catch (err: any) {
        console.warn(`[k8s] Failed to patch ScaledObject ${name}:`, err?.body?.message ?? err?.message ?? err);
      }
    }
  }
}
