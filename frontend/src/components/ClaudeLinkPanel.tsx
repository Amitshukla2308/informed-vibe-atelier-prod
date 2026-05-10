/**
 * Claude-Link panel — self-service UI for uploading ~/.claude/config.json.
 * Lives in Settings. Per-user: each user links their own Claude. Required
 * before a session can spawn for non-legacy users (the legacy admin gets
 * auto-seeded from the system HOME at boot).
 *
 * The founder's workflow (documented inline so they don't google it):
 *   1. On their own laptop, ensure `claude auth login` has been done.
 *   2. Open ~/.claude/config.json in a text editor. Copy contents.
 *   3. Paste here. Click "link".
 * That's it — Atelier writes to data/users/<uid>/.claude/config.json with
 * 0600 perms; next PTY spawn uses their auth, their history, their memory.
 */

import { useEffect, useState } from "react";
import {
  getClaudeLinkStatus, uploadClaudeCredentials, unlinkClaude,
  type ClaudeLinkStatus,
} from "../lib/api";

export function ClaudeLinkPanel() {
  const [status, setStatus] = useState<ClaudeLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const s = await getClaudeLinkStatus();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleLink() {
    if (!draft.trim()) { setError("paste your .credentials.json contents first"); return; }
    setSubmitting(true);
    setError(null);
    setSuccessNote(null);
    try {
      const res = await uploadClaudeCredentials(draft.trim());
      setSuccessNote(res.recognized_shape
        ? "linked · recognized claude credentials shape"
        : "linked · but the file doesn't look like standard claude credentials (accepted anyway; you may want to verify)");
      setDraft("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnlink() {
    if (!confirm("Remove your linked Claude config? Sessions won't be able to spawn until you link again.")) return;
    try {
      await unlinkClaude();
      setSuccessNote(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div style={muteStyle}>checking link status…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          display: "inline-block",
          width: 8, height: 8, borderRadius: "50%",
          background: status?.linked ? "var(--sem-green)" : "var(--sem-amber)",
        }} />
        <div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 600 }}>
            {status?.linked ? "claude linked" : "claude not linked"}
          </div>
          <div style={muteStyle}>
            {status?.linked && status.linked_at
              ? `linked ${new Date(status.linked_at).toLocaleString()} · ${status.size_bytes} bytes`
              : "upload your config.json to activate sessions"}
          </div>
        </div>
        {status?.linked && (
          <button onClick={handleUnlink} style={{ marginLeft: "auto", ...dangerButtonStyle }}>unlink</button>
        )}
      </div>

      {!status?.linked && (
        <>
          <div style={{ ...muteStyle, lineHeight: 1.5 }}>
            On your local machine, after running <code style={codeStyle}>claude auth login</code>, open
            <code style={codeStyle}>~/.claude/.credentials.json</code> (note the leading dot — it's a hidden file),
            copy its contents, and paste below. Stored with 0600 perms under your scoped home dir.
          </div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...,"scopes":[...],"subscriptionType":"..."}}'
            rows={10}
            style={textareaStyle}
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={handleLink} disabled={submitting || !draft.trim()} style={primaryButtonStyle}>
              {submitting ? "linking…" : "link"}
            </button>
            <span style={muteStyle}>{draft.length} chars</span>
          </div>
        </>
      )}

      {successNote && (
        <div style={{ ...muteStyle, color: "var(--sem-green)" }}>{successNote}</div>
      )}
      {error && (
        <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>{error}</div>
      )}
    </div>
  );
}

const muteStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
  color: "var(--a-mute)",
  textTransform: "lowercase" as const,
};
const codeStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
  background: "var(--a-paper-2)",
  padding: "1px 5px",
  borderRadius: 3,
  color: "var(--a-ink)",
};
const textareaStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
  background: "var(--a-paper-2)",
  border: "1px solid var(--a-line)",
  borderRadius: 3,
  padding: 10,
  color: "var(--a-ink)",
  lineHeight: 1.5,
  resize: "vertical" as const,
};
const primaryButtonStyle = {
  padding: "6px 16px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
  textTransform: "lowercase" as const,
  border: "1px solid var(--a-accent)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--a-accent)",
  cursor: "pointer",
};
const dangerButtonStyle = {
  padding: "4px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
  textTransform: "lowercase" as const,
  border: "1px solid var(--sem-red)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--sem-red)",
  cursor: "pointer",
};
