export function AutoModeControls() {
  return (
    <div className="auto-mode card">
      <h2>Auto Mode</h2>
      <div className="auto-mode-toggle">
        <input type="checkbox" disabled />
        <label>Enable Auto Mode (Coming in Phase 2e)</label>
      </div>
      <div style={{ marginTop: 12, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
        <div>Phase: &mdash;</div>
        <div>Countdown: &mdash;</div>
      </div>
    </div>
  );
}
