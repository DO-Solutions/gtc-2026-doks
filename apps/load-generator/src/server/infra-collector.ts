import fs from 'node:fs';
import type { AppConfig } from './config.js';
import type { InfrastructureMetrics, PodInfraMetrics, GpuMetrics } from './types.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const POD_CACHE_TTL_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;

interface K8sPod {
  metadata: { name: string; namespace: string };
}

interface PromResult {
  metric: Record<string, string>;
  value: [number, string];
}

export class InfraCollector {
  private config: AppConfig;
  private saToken: string | null = null;
  private inCluster: boolean = false;
  private cachedPods: string[] = [];
  private podCacheExpiry = 0;

  constructor(config: AppConfig) {
    this.config = config;
    try {
      this.saToken = fs.readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
      this.inCluster = true;
    } catch {
      console.log('[infra] Not running in-cluster (no SA token), pod discovery disabled');
    }
  }

  async collect(): Promise<InfrastructureMetrics> {
    const collectedAt = Date.now();

    // Discover pods
    let podNames: string[] = [];
    let podsDiscovered = false;
    if (this.inCluster) {
      podNames = await this.discoverPods();
      podsDiscovered = podNames.length > 0;
    }

    // Query Prometheus — all queries in parallel
    let prometheusAvailable = false;
    let kvCacheHitRate: number | null = null;

    // Per-GPU maps: keyed by "pod:gpuIndex"
    const gpuUtilByPod = new Map<string, Map<number, number>>();
    const gpuMemUsedByPod = new Map<string, Map<number, number>>();
    const gpuMemFreeByPod = new Map<string, Map<number, number>>();

    try {
      const [
        gpuUtilResult,
        gpuMemUsedResult,
        gpuMemFreeResult,
        cachedTokensResult,
        inputTokensResult,
      ] = await Promise.all([
        this.queryPrometheus(
          'avg_over_time(DCGM_FI_DEV_GPU_UTIL{exported_namespace="dynamo-workload"}[1m])'
        ),
        this.queryPrometheus(
          'DCGM_FI_DEV_FB_USED{exported_namespace="dynamo-workload"}'
        ),
        this.queryPrometheus(
          'DCGM_FI_DEV_FB_FREE{exported_namespace="dynamo-workload"}'
        ),
        this.queryPrometheus(
          'rate(dynamo_frontend_cached_tokens_sum[1m])'
        ),
        this.queryPrometheus(
          'rate(dynamo_frontend_input_sequence_tokens_sum[1m])'
        ),
      ]);

      prometheusAvailable = true;

      // GPU util: exported_pod + gpu → value
      this.mapGpuMetric(gpuUtilResult, gpuUtilByPod);
      this.mapGpuMetric(gpuMemUsedResult, gpuMemUsedByPod);
      this.mapGpuMetric(gpuMemFreeResult, gpuMemFreeByPod);

      // Global KV cache hit rate: cached_tokens / input_tokens * 100
      const cachedRate = cachedTokensResult.length > 0 ? parseFloat(cachedTokensResult[0].value[1]) : 0;
      const inputRate = inputTokensResult.length > 0 ? parseFloat(inputTokensResult[0].value[1]) : 0;
      if (inputRate > 0) {
        kvCacheHitRate = (cachedRate / inputRate) * 100;
      }
    } catch (err) {
      console.log(`[infra] Prometheus query failed: ${err instanceof Error ? err.message : err}`);
    }

    // Build per-pod metrics
    const pods: PodInfraMetrics[] = podNames.map((podName) => {
      const shortName = podName.length > 8 ? `...${podName.slice(-5)}` : podName;

      // Build GPU list from DCGM exported_pod mapping
      const utilMap = gpuUtilByPod.get(podName);
      const usedMap = gpuMemUsedByPod.get(podName);
      const freeMap = gpuMemFreeByPod.get(podName);
      const gpuIndices = new Set<number>();
      if (utilMap) for (const k of utilMap.keys()) gpuIndices.add(k);
      if (usedMap) for (const k of usedMap.keys()) gpuIndices.add(k);
      if (freeMap) for (const k of freeMap.keys()) gpuIndices.add(k);

      const gpus: GpuMetrics[] = [...gpuIndices].sort((a, b) => a - b).map((gpuIdx) => ({
        index: gpuIdx,
        utilization: utilMap?.get(gpuIdx) ?? null,
        memoryUsedMiB: usedMap?.get(gpuIdx) ?? null,
        memoryFreeMiB: freeMap?.get(gpuIdx) ?? null,
      }));

      return {
        podName,
        shortName,
        gpus,
      };
    });

    return { collectedAt, pods, kvCacheHitRate, prometheusAvailable, podsDiscovered };
  }

  /** Map DCGM per-GPU results to pod → gpu index → value using exported_pod label. */
  private mapGpuMetric(results: PromResult[], target: Map<string, Map<number, number>>): void {
    for (const r of results) {
      const pod = r.metric.exported_pod;
      const gpuIdx = parseInt(r.metric.gpu, 10);
      if (!pod || isNaN(gpuIdx)) continue;
      let podMap = target.get(pod);
      if (!podMap) { podMap = new Map(); target.set(pod, podMap); }
      podMap.set(gpuIdx, parseFloat(r.value[1]));
    }
  }

  private async discoverPods(): Promise<string[]> {
    if (Date.now() < this.podCacheExpiry && this.cachedPods.length > 0) {
      return this.cachedPods;
    }

    try {
      const ns = this.config.k8sNamespace;
      const url = `https://kubernetes.default.svc/api/v1/namespaces/${ns}/pods`
        + '?labelSelector=nvidia.com/dynamo-graph-deployment-name=gtc-demo'
        + ',nvidia.com/dynamo-component-type=main';

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.saToken}` },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });

      if (!resp.ok) {
        console.log(`[infra] K8s API returned ${resp.status}`);
        return this.cachedPods;
      }

      const body = (await resp.json()) as { items: K8sPod[] };
      const names = body.items.map((p) => p.metadata.name).sort();
      this.cachedPods = names;
      this.podCacheExpiry = Date.now() + POD_CACHE_TTL_MS;

      if (names.length > 0) {
        console.log(`[infra] Discovered ${names.length} worker pod(s): ${names.join(', ')}`);
      }

      return names;
    } catch (err) {
      console.log(`[infra] Pod discovery failed: ${err instanceof Error ? err.message : err}`);
      return this.cachedPods;
    }
  }

  private async queryPrometheus(query: string): Promise<PromResult[]> {
    const url = `${this.config.prometheusUrl}/api/v1/query`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `query=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Prometheus returned ${resp.status}`);
    }

    const body = (await resp.json()) as { status: string; data: { result: PromResult[] } };
    if (body.status !== 'success') {
      throw new Error(`Prometheus query status: ${body.status}`);
    }

    return body.data.result;
  }
}
