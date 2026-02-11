import type { AppConfig } from '../config.js';
import type { RequestMetrics, WorkloadType } from '../types.js';
import { sendStreamingRequest, type InferenceRequest } from '../dynamo-client.js';

/**
 * Abstract base for workload runners. Subclasses implement buildRequest()
 * to produce the InferenceRequest from their corpus, and corpusSize() to
 * report how many items are loaded.
 */
export abstract class BaseRunner {
  protected config: AppConfig;
  readonly workloadType: WorkloadType;

  constructor(config: AppConfig, workloadType: WorkloadType) {
    this.config = config;
    this.workloadType = workloadType;
  }

  /** Build an InferenceRequest by sampling from the corpus. */
  abstract buildRequest(): InferenceRequest;

  /** Number of corpus items available. */
  abstract corpusSize(): number;

  /** Fire one inference request and return metrics. */
  async run(): Promise<RequestMetrics> {
    const req = this.buildRequest();
    return sendStreamingRequest(this.config, req);
  }
}
