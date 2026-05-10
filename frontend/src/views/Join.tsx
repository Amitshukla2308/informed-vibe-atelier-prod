/**
 * Join view — shown when the URL carries ?inv=<invite_token>. Takes over the
 * whole viewport regardless of the current identity state. After a successful
 * claim, reloads the app cleanly (cookie is now set) to land on Home/Now.
 *
 * Three UI states: loading → preview (form) → success (redirect shim).
 * Errors (invalid / expired / redeemed) render inline with a clear cause.
 */

import { useEffect, useState } from "react";
import { claimInvite, getInvitePreview, type InvitePreview } from "../lib/api";

interface Props {
  inviteToken: string;
  onClaimed: () => void;
}

export function Join({ inviteToken, onClaimed }: Props) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getInvitePreview(inviteToken)
      .then(p => { if (!cancelled) { setPreview(p); setEmail(p.intended_email ?? ""); } })
      .catch(e => { if (!cancelled) setLoadError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [inviteToken]);

  async function handleClaim() {
    if (!displayName.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await claimInvite({
        inv: inviteToken,
        display_name: displayName.trim(),
        email: email.trim() || undefined,
      });
      onClaimed();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="onb">
      <div className="onb-card">
        <div className="onb-brand">atelier</div>
        <div className="onb-tagline">you've been invited</div>

        {loading && (
          <div style={{ padding: "2rem 0", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)" }}>
            verifying invite…
          </div>
        )}

        {!loading && loadError && (
          <div>
            <h2>this invite can't be used</h2>
            <p style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)" }}>
              {loadError}
            </p>
            <p style={{ color: "var(--a-mute)", marginTop: 12 }}>
              Ask the person who sent you the link to generate a new one.
            </p>
          </div>
        )}

        {!loading && preview && (
          <div>
            <h2>{preview.invited_by} invited you to <em>{preview.org.name}</em></h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0 18px", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
              <span>role: <strong style={{ color: "var(--a-accent)" }}>{preview.role}</strong></span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>expires: {new Date(preview.expires_at).toLocaleString()}</span>
              {preview.intended_email && <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>for: {preview.intended_email}</span>
              </>}
            </div>

            <p style={{ color: "var(--a-mute)", marginBottom: 16, fontSize: "var(--t-2)", lineHeight: 1.5 }}>
              Atelier is the working environment for this org. A quick claim and you'll meet the agent.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <label style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                your name
              </label>
              <input
                autoFocus
                placeholder="display name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && displayName.trim() && handleClaim()}
              />

              <label style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", marginTop: 6 }}>
                email <span style={{ opacity: 0.6 }}>(optional — only used to reach you if your access needs to be restored)</span>
              </label>
              <input
                placeholder="you@example.com"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>

            <button
              className="primary"
              disabled={!displayName.trim() || submitting}
              onClick={handleClaim}
            >
              {submitting ? "claiming…" : "claim access"}
            </button>

            {submitError && <p style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", marginTop: 10 }}>{submitError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
