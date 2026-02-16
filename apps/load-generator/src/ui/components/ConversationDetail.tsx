import { useState, useEffect } from 'react';
import { fetchConversation } from '../api';
import type { ConversationRecord } from '../types';

interface Props {
  conversationId: string;
  navigate: (hash: string) => void;
}

export function ConversationDetail({ conversationId, navigate }: Props) {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      fetchConversation(conversationId)
        .then((data) => { if (active) setConversation(data); })
        .catch((e) => { if (active) setError(e.message); });
    };
    load();
    // Auto-refresh for active conversations
    const timer = setInterval(() => {
      if (conversation?.status === 'active' || !conversation) load();
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatDuration = (ms: number | null): string => {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const statusClass = (status: string): string => {
    if (status === 'active') return 'conv-status-badge conv-status-active';
    if (status === 'error') return 'conv-status-badge conv-status-error';
    return 'conv-status-badge conv-status-completed';
  };

  if (error) {
    return (
      <div className="conversation-detail-section">
        <div style={{ color: 'var(--accent-red)', marginBottom: 12 }}>{error}</div>
        <button className="btn btn-reset" onClick={() => navigate('#/conversations')}>
          Back to List
        </button>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="conversation-detail-section">
        <div className="collecting-data">Loading...</div>
      </div>
    );
  }

  return (
    <div className="conversation-detail-section">
      <div className="conversations-header">
        <div>
          <h2>{conversation.topic}</h2>
          <div className="conversation-meta">
            <span className={statusClass(conversation.status)}>{conversation.status}</span>
            <span>{conversation.turns.length} turns</span>
            <span>{formatDuration(conversation.totalDurationMs)}</span>
          </div>
        </div>
        <button className="btn btn-reset" onClick={() => navigate('#/conversations')}>
          Back to List
        </button>
      </div>

      <div className="chat-log">
        {conversation.turns.map((turn) => (
          <div key={turn.turnNumber} className="chat-turn">
            <div className="chat-turn-label">Turn {turn.turnNumber + 1}</div>
            <div className="turn-metrics-row">
              <div className="turn-metric">
                <span className="turn-metric-label">TTFT</span>
                <span className="turn-metric-value">{turn.metrics.ttftMs.toFixed(0)}ms</span>
              </div>
              <div className="turn-metric">
                <span className="turn-metric-label">ITL</span>
                <span className="turn-metric-value">{turn.metrics.itlMs.toFixed(1)}ms</span>
              </div>
              <div className="turn-metric">
                <span className="turn-metric-label">Tokens</span>
                <span className="turn-metric-value">{turn.metrics.outputTokens}</span>
              </div>
              <div className="turn-metric">
                <span className="turn-metric-label">Latency</span>
                <span className="turn-metric-value">{turn.metrics.latencyMs.toFixed(0)}ms</span>
              </div>
            </div>
            <div className="chat-message chat-message-user">
              <div className="chat-role">User</div>
              <div className="chat-content">{turn.userMessage}</div>
            </div>
            <div className="chat-message chat-message-assistant">
              <div className="chat-role">Assistant</div>
              <div className="chat-content">{turn.assistantMessage || '(no response)'}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
