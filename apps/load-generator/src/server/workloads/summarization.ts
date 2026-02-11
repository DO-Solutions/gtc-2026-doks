import type { AppConfig } from '../config.js';
import type { SummarizationDoc } from '../types.js';
import type { InferenceRequest } from '../dynamo-client.js';
import { BaseRunner } from './base-runner.js';

const SYSTEM_PROMPT =
  'You are a concise summarizer. Read the provided text and produce a clear, ' +
  'accurate summary capturing the key points. Keep the summary under 200 words.';

export class SummarizationRunner extends BaseRunner {
  private docs: SummarizationDoc[];

  constructor(config: AppConfig, docs: SummarizationDoc[]) {
    super(config, 'b');
    this.docs = docs;
  }

  corpusSize(): number {
    return this.docs.length;
  }

  buildRequest(): InferenceRequest {
    const doc = this.docs[Math.floor(Math.random() * this.docs.length)];
    return {
      workload: 'b',
      itemId: doc.id,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: doc.text },
      ],
      maxTokens: 200,
    };
  }
}
