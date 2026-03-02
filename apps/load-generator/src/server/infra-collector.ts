import fs from 'node:fs';
import type { AppConfig } from './config.js';
import type { InfrastructureMetrics, PodInfraMetrics, GpuMetrics } from './types.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const POD_CACHE_TTL_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;
const STATIC_CACHE_TTL_MS = 300_000;

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
  private cachedGpuType = 'Unknown';
  private cachedModelName = 'Unknown';
  private staticCacheExpiry = 0;

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

    // Discover pods and fetch static info
    let podNames: string[] = [];
    let podsDiscovered = false;
    if (this.inCluster) {
      podNames = await this.discoverPods();
      podsDiscovered = podNames.length > 0;
      await this.fetchStaticInfo();
    }

    // Query Prometheus — all queries in parallel
    let prometheusAvailable = false;
    let kvCacheHitRate: number | null = null;
    let queuedRequests: number | null = null;

    // Per-GPU maps: pod → gpu index → value
    const hbmBandwidthByPod = new Map<string, Map<number, number>>();
    const tensorCoreByPod = new Map<string, Map<number, number>>();

    try {
      const [
        hbmBandwidthResult,
        tensorCoreResult,
        cachedTokensResult,
        inputTokensResult,
        queuedResult,
      ] = await Promise.all([
        this.queryPrometheus(
          'DCGM_FI_PROF_DRAM_ACTIVE{exported_namespace="dynamo-workload"}'
        ),
        this.queryPrometheus(
          'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE{exported_namespace="dynamo-workload"}'
        ),
        this.queryPrometheus(
          'rate(dynamo_frontend_cached_tokens_sum[1m])'
        ),
        this.queryPrometheus(
          'rate(dynamo_frontend_input_sequence_tokens_sum[1m])'
        ),
        this.queryPrometheus(
          'sum(dynamo_frontend_queued_requests{namespace="dynamo-workload"})'
        ),
      ]);

      prometheusAvailable = true;

      // GPU metrics: exported_pod + gpu → value (DCGM returns 0.0-1.0 fractions)
      this.mapGpuMetric(hbmBandwidthResult, hbmBandwidthByPod);
      this.mapGpuMetric(tensorCoreResult, tensorCoreByPod);

      // Global KV cache hit rate: cached_tokens / input_tokens * 100
      const cachedRate = cachedTokensResult.length > 0 ? parseFloat(cachedTokensResult[0].value[1]) : 0;
      const inputRate = inputTokensResult.length > 0 ? parseFloat(inputTokensResult[0].value[1]) : 0;
      if (inputRate > 0) {
        kvCacheHitRate = (cachedRate / inputRate) * 100;
      }

      // Queued requests
      if (queuedResult.length > 0) {
        queuedRequests = parseFloat(queuedResult[0].value[1]);
      }
    } catch (err) {
      console.log(`[infra] Prometheus query failed: ${err instanceof Error ? err.message : err}`);
    }

    // Build per-pod metrics
    const pods: PodInfraMetrics[] = podNames.map((podName) => {
      const shortName = podName.length > 8 ? `...${podName.slice(-5)}` : podName;

      // Build GPU list from DCGM exported_pod mapping
      const hbmMap = hbmBandwidthByPod.get(podName);
      const tcMap = tensorCoreByPod.get(podName);
      const gpuIndices = new Set<number>();
      if (hbmMap) for (const k of hbmMap.keys()) gpuIndices.add(k);
      if (tcMap) for (const k of tcMap.keys()) gpuIndices.add(k);

      // DCGM returns 0.0-1.0 fractions; multiply by 100 for percentage display
      const gpus: GpuMetrics[] = [...gpuIndices].sort((a, b) => a - b).map((gpuIdx) => ({
        index: gpuIdx,
        hbmBandwidth: hbmMap?.get(gpuIdx) != null ? hbmMap.get(gpuIdx)! * 100 : null,
        tensorCoreActivity: tcMap?.get(gpuIdx) != null ? tcMap.get(gpuIdx)! * 100 : null,
      }));

      return {
        podName,
        shortName,
        gpus,
      };
    });

    return {
      collectedAt, pods, kvCacheHitRate, queuedRequests, prometheusAvailable, podsDiscovered,
      gpuType: this.cachedGpuType,
      modelName: this.cachedModelName,
    };
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

  private async fetchStaticInfo(): Promise<void> {
    if (Date.now() < this.staticCacheExpiry) return;

    const [gpuType, modelName] = await Promise.all([
      this.fetchGpuType().catch(() => this.cachedGpuType),
      this.fetchModelName().catch(() => this.cachedModelName),
    ]);

    this.cachedGpuType = gpuType;
    this.cachedModelName = modelName;
    this.staticCacheExpiry = Date.now() + STATIC_CACHE_TTL_MS;
    console.log(`[infra] Static info: gpuType=${gpuType}, modelName=${modelName}`);
  }

  private async fetchGpuType(): Promise<string> {
    const url = 'https://kubernetes.default.svc/api/v1/nodes'
      + '?labelSelector=doks.digitalocean.com/gpu-brand=nvidia';

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.saToken}` },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });

    if (!resp.ok) {
      console.log(`[infra] Node list returned ${resp.status}`);
      return 'Unknown';
    }

    const body = (await resp.json()) as { items: Array<{ metadata: { labels?: Record<string, string> } }> };
    if (body.items.length === 0) return 'Unknown';

    const label = body.items[0].metadata.labels?.['doks.digitalocean.com/gpu-model'] ?? '';
    return label ? label.toUpperCase() : 'Unknown';
  }

  private async fetchModelName(): Promise<string> {
    const ns = this.config.k8sNamespace;
    const url = `https://kubernetes.default.svc/apis/nvidia.com/v1alpha1/namespaces/${ns}/dynamographdeployments/gtc-demo`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.saToken}` },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });

    if (!resp.ok) {
      console.log(`[infra] DGD fetch returned ${resp.status}`);
      return 'Unknown';
    }

    const body = (await resp.json()) as {
      spec?: { services?: Record<string, { extraPodSpec?: { mainContainer?: { args?: string[] } } }> };
    };

    const args = body.spec?.services?.TrtllmWorker?.extraPodSpec?.mainContainer?.args;
    if (!args) return 'Unknown';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--model-path' && i + 1 < args.length) {
        const segments = args[i + 1].split('/');
        return segments[segments.length - 1] || 'Unknown';
      }
    }

    return 'Unknown';
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
