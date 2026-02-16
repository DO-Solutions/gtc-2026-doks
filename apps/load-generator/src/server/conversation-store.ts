import type { ConversationRecord, ConversationSummary, TurnRecord } from './types.js';

const MAX_CONVERSATIONS = 500;

export class ConversationStore {
  private conversations = new Map<string, ConversationRecord>();
  private insertionOrder: string[] = [];

  start(id: string, topic: string): void {
    this.evictIfNeeded();
    const record: ConversationRecord = {
      id,
      topic,
      status: 'active',
      startedAt: Date.now(),
      completedAt: null,
      turns: [],
      totalDurationMs: null,
    };
    this.conversations.set(id, record);
    this.insertionOrder.push(id);
  }

  addTurn(id: string, turn: TurnRecord): void {
    const record = this.conversations.get(id);
    if (record) {
      record.turns.push(turn);
    }
  }

  complete(id: string): void {
    const record = this.conversations.get(id);
    if (record) {
      record.status = 'completed';
      record.completedAt = Date.now();
      record.totalDurationMs = record.completedAt - record.startedAt;
    }
  }

  error(id: string): void {
    const record = this.conversations.get(id);
    if (record) {
      record.status = 'error';
      record.completedAt = Date.now();
      record.totalDurationMs = record.completedAt - record.startedAt;
    }
  }

  get(id: string): ConversationRecord | undefined {
    return this.conversations.get(id);
  }

  list(): ConversationSummary[] {
    const summaries: ConversationSummary[] = [];
    for (const record of this.conversations.values()) {
      summaries.push({
        id: record.id,
        topic: record.topic,
        status: record.status,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        turnCount: record.turns.length,
        totalDurationMs: record.totalDurationMs,
      });
    }
    // newest first
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  }

  private evictIfNeeded(): void {
    while (this.conversations.size >= MAX_CONVERSATIONS && this.insertionOrder.length > 0) {
      const oldest = this.insertionOrder.shift()!;
      this.conversations.delete(oldest);
    }
  }
}
