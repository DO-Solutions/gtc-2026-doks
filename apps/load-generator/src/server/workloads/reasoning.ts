import type { AppConfig } from '../config.js';
import type { ReasoningPrompt } from '../types.js';
import type { InferenceRequest } from '../dynamo-client.js';
import { BaseRunner } from './base-runner.js';

const SYSTEM_PROMPT =
  'You are a careful analytical thinker. Think step by step through the problem, ' +
  'showing your reasoning at each stage before arriving at your final answer.';

export class ReasoningRunner extends BaseRunner {
  private prompts: ReasoningPrompt[];

  constructor(config: AppConfig, prompts: ReasoningPrompt[]) {
    super(config, 'c');
    this.prompts = prompts;
  }

  corpusSize(): number {
    return this.prompts.length;
  }

  buildRequest(): InferenceRequest {
    const p = this.prompts[Math.floor(Math.random() * this.prompts.length)];
    return {
      workload: 'c',
      itemId: p.id,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: p.prompt },
      ],
      maxTokens: p.expected_output_length || 1024,
    };
  }
}
