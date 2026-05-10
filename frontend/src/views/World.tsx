export function World() {
  return (
    <div className="world-root">
      <div className="world-head">
        <div className="kicker">world layer · what the agent noticed</div>
        <h1>No signals yet.</h1>
        <p className="sub">
          Watchers run in the background — domain news, regulation changes, competitive moves.
          When something relevant arrives, it shows up here before your next session.
        </p>
      </div>
      <div className="world-feed">
        <div style={{ padding:"48px 0", fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", color:"var(--a-mute)", textTransform:"lowercase", lineHeight:1.8 }}>
          watchers not yet configured.<br />
          ask the agent to set up a watcher for your domain.
        </div>
      </div>
    </div>
  );
}
