import { useState, useEffect } from 'react';
import { fetchConversations } from '../api';
import type { ConversationSummary } from '../types';

interface Props {
  navigate: (hash: string) => void;
}

export function ConversationList({ navigate }: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      fetchConversations()
        .then((data) => { if (active) setConversations(data); })
        .catch((e) => { if (active) setError(e.message); });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const formatDuration = (ms: number | null): string => {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTime = (ts: number): string => {
    return new Date(ts).toLocaleTimeString();
  };

  const statusClass = (status: string): string => {
    if (status === 'active') return 'conv-status-badge conv-status-active';
    if (status === 'error') return 'conv-status-badge conv-status-error';
    return 'conv-status-badge conv-status-completed';
  };

  return (
    <div className="conversations-section">
      <div className="conversations-header">
        <h2>Conversations</h2>
        <button className="btn btn-reset" onClick={() => navigate('#/')}>
          Back to Dashboard
        </button>
      </div>

      {error && (
        <div style={{ color: 'var(--accent-red)', marginBottom: 12, fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      {conversations.length === 0 ? (
        <div className="collecting-data">
          No conversations yet. Start the workload to generate conversations.
        </div>
      ) : (
        <div className="conversation-table">
          <div className="conversation-table-header">
            <span className="conv-col-status">Status</span>
            <span className="conv-col-topic">Topic</span>
            <span className="conv-col-turns">Turns</span>
            <span className="conv-col-duration">Duration</span>
            <span className="conv-col-started">Started</span>
          </div>
          {conversations.map((c) => (
            <div
              key={c.id}
              className="conversation-table-row"
              onClick={() => navigate(`#/conversations/${encodeURIComponent(c.id)}`)}
            >
              <span className="conv-col-status">
                <span className={statusClass(c.status)}>{c.status}</span>
              </span>
              <span className="conv-col-topic">{c.topic}</span>
              <span className="conv-col-turns">{c.turnCount}</span>
              <span className="conv-col-duration">{formatDuration(c.totalDurationMs)}</span>
              <span className="conv-col-started">{formatTime(c.startedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
