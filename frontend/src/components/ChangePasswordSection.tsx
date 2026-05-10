import { useState } from "react";
import { changePassword } from "../lib/api";

/**
 * Settings → Account → Change password.
 *
 * Two modes: if the user already has a password (the common case) we ask
 * for the current one first. If they don't (legacy account that signed
 * in via magic-link, or someone the admin issued a temp password to and
 * we didn't track that), the current_password field is collapsed and the
 * backend accepts the change without verifying.
 *
 * "Has password?" isn't on /me yet, so we let the backend tell us: try
 * without current_password first; if 400 says "current_password required",
 * show the field and retry.
 */
export function ChangePasswordSection() {
  const [needsCurrent, setNeedsCurrent] = useState(true);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setError("Confirmation doesn't match."); return; }
    setBusy(true);
    try {
      await changePassword({
        new_password: next,
        ...(needsCurrent && current ? { current_password: current } : {}),
      });
      setCurrent(""); setNext(""); setConfirm("");
      setDone(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Backend tells us when current_password is required
      if (msg.toLowerCase().includes("current_password required")) {
        setNeedsCurrent(true);
        setError("Enter your current password to continue.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: 280, maxWidth: "100%", padding: "8px 12px",
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 6, color: "var(--ink-0, #f4f4f5)",
    fontFamily: "var(--font-sans)", fontSize: "0.9rem",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 4,
    fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
    color: "var(--a-mute)", textTransform: "lowercase",
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
        color: "var(--a-mute)", textTransform: "lowercase", marginBottom: 4,
      }}>
        change password
      </div>

      {needsCurrent && (
        <label style={labelStyle}>
          current password
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)}
                 autoComplete="current-password" style={inputStyle} />
        </label>
      )}
      <label style={labelStyle}>
        new password
        <input type="password" value={next} onChange={e => setNext(e.target.value)}
               minLength={8} autoComplete="new-password" required style={inputStyle} />
      </label>
      <label style={labelStyle}>
        confirm new password
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
               minLength={8} autoComplete="new-password" required style={inputStyle} />
      </label>

      {error && (
        <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
          {error}
        </div>
      )}
      {done && (
        <div style={{ color: "var(--sem-green, #aee2ad)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
          ✓ password updated
        </div>
      )}

      <div>
        <button type="submit" disabled={busy} style={{
          padding: "8px 18px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
          background: "linear-gradient(135deg, var(--violet, #E89060) 0%, #C4663A 100%)",
          color: "#170c05", border: "1px solid rgba(255,255,255,0.16)",
          borderRadius: 6, cursor: "pointer", fontWeight: 600,
          letterSpacing: "0.06em", textTransform: "uppercase",
        }}>{busy ? "updating…" : "update password"}</button>
        {!needsCurrent && (
          <button type="button" onClick={() => setNeedsCurrent(true)} style={{
            marginLeft: 10, padding: "8px 14px", fontFamily: "var(--font-mono)",
            fontSize: "var(--t-1)", background: "transparent",
            border: "1px solid rgba(255,255,255,0.10)", color: "var(--a-mute)",
            borderRadius: 6, cursor: "pointer",
          }}>I have a current password</button>
        )}
      </div>
    </form>
  );
}
