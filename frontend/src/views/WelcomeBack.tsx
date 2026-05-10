import { useState } from "react";
import { resumeIdentity, wipeIdentity, type PreviousIdentity } from "../lib/api";

interface Props {
  previous: PreviousIdentity;
  onResume: (p: PreviousIdentity) => void;
  onStartFresh: () => void;
}

export function WelcomeBack({ previous, onResume, onStartFresh }: Props) {
  const [busy, setBusy] = useState<"resume" | "fresh" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doResume() {
    setBusy("resume");
    setError(null);
    try {
      await resumeIdentity();
      onResume(previous);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  async function doFresh() {
    if (!window.confirm(
      "Sign out of this identity? Your projects, sessions, and brain stay where they are — " +
      "they're tied to your account, not this browser. You'll be able to sign back in or claim an invite to return."
    )) return;
    setBusy("fresh");
    setError(null);
    try {
      await wipeIdentity();
      onStartFresh();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  return (
    <div className="onb">
      <div className="onb-card welcome-card">
        <div className="onb-brand">atelier</div>
        <div className="onb-tagline">welcome back</div>

        <div className="welcome-identity">
          <div className="welcome-line">
            <span className="welcome-label">founder</span>
            <span className="welcome-val">{previous.founder_name || "—"}</span>
          </div>
          <div className="welcome-line">
            <span className="welcome-label">agent</span>
            <span className="welcome-val">{previous.agent_name}</span>
          </div>
          {previous.org_name && (
            <div className="welcome-line">
              <span className="welcome-label">org</span>
              <span className="welcome-val">{previous.org_name}</span>
            </div>
          )}
          <div className="welcome-line">
            <span className="welcome-label">project</span>
            <span className="welcome-val">{previous.active_project}</span>
          </div>
        </div>

        <div className="welcome-copy">
          everything is where you left it — canvas, sessions, brain, all intact.
        </div>

        <div className="welcome-actions">
          <button
            className="primary welcome-primary"
            onClick={doResume}
            disabled={busy !== null}
          >
            {busy === "resume" ? "resuming…" : `continue as ${previous.founder_name || previous.agent_name}`}
          </button>
          <button
            className="welcome-fresh"
            onClick={doFresh}
            disabled={busy !== null}
          >
            {busy === "fresh" ? "signing out…" : "sign out · not me"}
          </button>
        </div>

        {error && <div className="welcome-error">error · {error}</div>}

        <div className="welcome-foot">
          your account data lives separately · signing out doesn't touch it
        </div>
      </div>
    </div>
  );
}
