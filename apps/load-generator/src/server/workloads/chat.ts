import type { AppConfig } from '../config.js';
import type { ChatMessage, ChatPassage, RequestMetrics } from '../types.js';
import { sendStreamingRequestWithCapture, type InferenceRequest } from '../dynamo-client.js';
import { BaseRunner } from './base-runner.js';
import type { ConversationStore } from '../conversation-store.js';

const SYSTEM_PROMPT =
  'You are a knowledgeable assistant. Engage thoughtfully with the user\'s questions, providing detailed explanations.';

const BROKER_SYSTEM_PROMPT =
  'Based on the conversation so far, ask a single concise follow-up question that explores the topic deeper.';

const FALLBACK_QUESTION = 'Can you elaborate further on that?';

export type TurnCallback = (metrics: RequestMetrics) => void;

export class ChatRunner extends BaseRunner {
  private passages: ChatPassage[];
  private onTurnComplete: TurnCallback;
  private conversationStore: ConversationStore;

  constructor(config: AppConfig, passages: ChatPassage[], onTurnComplete: TurnCallback, conversationStore: ConversationStore) {
    super(config, 'a');
    this.passages = passages;
    this.onTurnComplete = onTurnComplete;
    this.conversationStore = conversationStore;
  }

  corpusSize(): number {
    return this.passages.length;
  }

  buildRequest(): InferenceRequest {
    const passage = this.passages[Math.floor(Math.random() * this.passages.length)];
    return {
      workload: 'a',
      itemId: `${passage.id}-t0`,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Here is some information about ${passage.topic}:\n\n${passage.text}\n\nPlease explain the key concepts discussed in this passage.`,
        },
      ],
      maxTokens: 512,
    };
  }

  async run(): Promise<RequestMetrics> {
    const passage = this.passages[Math.floor(Math.random() * this.passages.length)];
    const turnCount = 5;
    const conversationId = `${passage.id}-${Date.now()}`;

    const history: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Here is some information about ${passage.topic}:\n\n${passage.text}\n\nPlease explain the key concepts discussed in this passage.`,
      },
    ];

    this.conversationStore.start(conversationId, passage.topic);

    let lastMetrics: RequestMetrics | null = null;

    for (let turn = 0; turn < turnCount; turn++) {
      const itemId = `${passage.id}-t${turn}`;
      const userMessage = history[history.length - 1].content;

      const result = await sendStreamingRequestWithCapture(this.config, {
        workload: 'a',
        itemId,
        messages: [...history],
        maxTokens: 512,
      });

      lastMetrics = result.metrics;

      if (result.metrics.status === 'error') {
        this.conversationStore.addTurn(conversationId, {
          turnNumber: turn,
          userMessage,
          assistantMessage: '',
          metrics: result.metrics,
        });
        this.conversationStore.error(conversationId);
        return result.metrics;
      }

      // Append assistant response to history
      history.push({ role: 'assistant', content: result.responseText });

      this.conversationStore.addTurn(conversationId, {
        turnNumber: turn,
        userMessage,
        assistantMessage: result.responseText,
        metrics: result.metrics,
      });

      // Report intermediate turns (all except last)
      if (turn < turnCount - 1) {
        this.onTurnComplete(result.metrics);

        // Generate follow-up question via Serverless Inference
        const followUp = await this.generateFollowUp(history, passage.topic);
        history.push({ role: 'user', content: followUp });
      }
    }

    this.conversationStore.complete(conversationId);
    return lastMetrics!;
  }

  private async generateFollowUp(history: ChatMessage[], topic: string): Promise<string> {
    if (!this.config.gradientApiKey) {
      return FALLBACK_QUESTION;
    }

    try {
      const url = `${this.config.serverlessInferenceUrl}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.gradientApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.serverlessInferenceModel,
          messages: [
            ...history,
            { role: 'system', content: BROKER_SYSTEM_PROMPT },
          ],
          max_tokens: 100,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        console.warn(`[chat] Serverless Inference returned ${resp.status}, using fallback question`);
        return FALLBACK_QUESTION;
      }

      const data = await resp.json() as any;
      const content = data?.choices?.[0]?.message?.content?.trim();
      return content || FALLBACK_QUESTION;
    } catch (err: any) {
      console.warn(`[chat] Serverless Inference error: ${err?.message || err}, using fallback question`);
      return FALLBACK_QUESTION;
    }
  }
}
