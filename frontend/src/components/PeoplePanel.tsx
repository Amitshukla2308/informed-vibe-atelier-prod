/**
 * Admin "People" panel — lives inside Settings. Lists users, pending invites,
 * creates new invites, revokes. Only meaningful when the viewer is an admin;
 * non-admins see a 403 hint from the admin/* endpoints.
 *
 * Minimal styling — uses existing atelier tokens. No new CSS classes.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import {
  adminListUsers, adminListInvites, adminRevokeInvite, createInvite, getMe,
  bootstrapSession, removeUserFromOrg, adminResetPassword,
  type UserListEntry, type InviteListEntry, type MeResponse, type AtelierRole,
} from "../lib/api";
import { AccessRequestsSection } from "./AccessRequestsSection";

const ROLES: AtelierRole[] = ["admin", "founder", "technical", "business", "observer"];

/** Copy text to clipboard with reliable fallback for non-secure / focus-loss scenarios. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function PeoplePanel() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [users, setUsers] = useState<UserListEntry[]>([]);
  // Maps user_id → temp password just generated. Cleared after the admin closes it.
  const [resetReveals, setResetReveals] = useState<Map<string, string>>(new Map());
  const [invites, setInvites] = useState<InviteListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // new-invite form
  const [orgId, setOrgId] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<Set<AtelierRole>>(new Set(["business"]));
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  // Synchronous double-click guard. React state updates are async — a rapid
  // 200ms double-click can fire `handleCreate` twice before `setCreating(true)`
  // re-renders the disabled button. The ref blocks the second call inline.
  const creatingRef = useRef(false);
  const [mintedLink, setMintedLink] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  function toggleRole(r: AtelierRole) {
    setSelectedRoles(prev => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      let m = await getMe();
      // No session yet AND backend is in dev mode → try the bootstrap one-shot
      // for a single-user install (the legacy-migrated admin). Idempotent.
      if (!m.user) {
        const bs = await bootstrapSession();
        if (bs.ok) m = await getMe();
      }
      setMe(m);
      if (!m.user) { setLoading(false); return; }
      const [u, i] = await Promise.all([adminListUsers(), adminListInvites()]);
      setUsers(u);
      setInvites(i);
      const firstAdminMembership = m.memberships.find(mm => mm.role === "admin");
      if (firstAdminMembership && !orgId) setOrgId(firstAdminMembership.org_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function handleCreate() {
    // Synchronous re-entry guard. Stops a rapid double-click from firing two
    // POST /admin/invites in flight before React re-renders the disabled button.
    if (creatingRef.current) return;
    if (!orgId) { setCreateError("pick an org"); return; }
    if (selectedRoles.size === 0) { setCreateError("pick at least one role"); return; }
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    setMintedLink(null);
    setCopyStatus("idle");
    try {
      const res = await createInvite({
        org_id: orgId,
        roles: Array.from(selectedRoles),
        intended_email: email.trim() || undefined,
      });
      const url = `${window.location.origin}/?inv=${encodeURIComponent(res.invite_token)}`;
      setMintedLink(url);
      setEmail("");
      refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function handleCopy(url: string) {
    const ok = await copyToClipboard(url);
    setCopyStatus(ok ? "copied" : "failed");
    setTimeout(() => setCopyStatus("idle"), 2000);
  }

  async function handleRevoke(tokenHash: string) {
    try {
      await adminRevokeInvite(tokenHash);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRemoveUser(userId: string, orgIdToRemove: string, displayName: string) {
    if (!confirm(`Remove ${displayName} from this org? This revokes all their access tokens and deletes their memberships. They'd need a new invite to return.`)) return;
    try {
      await removeUserFromOrg(userId, orgIdToRemove);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleResetPassword(userId: string, displayName: string) {
    if (!confirm(`Generate a temporary password for ${displayName}?\n\nTheir current password (if any) is revoked, all their active sessions are signed out. The new temp password is shown to you ONCE — copy it and share it with them out-of-band.`)) return;
    try {
      const r = await adminResetPassword(userId);
      const next = new Map(resetReveals);
      next.set(userId, r.temp_password);
      setResetReveals(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function dismissReveal(userId: string) {
    const next = new Map(resetReveals);
    next.delete(userId);
    setResetReveals(next);
  }

  const adminOrgs = me?.memberships.filter(m => m.role === "admin") ?? [];
  const canAdmin = adminOrgs.length > 0;

  if (loading) return <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", padding: "1rem 0" }}>loading people…</div>;

  if (!canAdmin) {
    return (
      <div style={{ padding: "1rem 0", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)" }}>
        You aren't an admin on any org. The People panel is admin-only.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {error && (
        <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>{error}</div>
      )}

      <AccessRequestsSection />

      {/* ── New invite form ───────────────────────────────────────────────── */}
      <section>
        <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 600, margin: "0 0 8px" }}>invite someone</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            org
            <select value={orgId} onChange={e => setOrgId(e.target.value)} style={fieldStyle}>
              {adminOrgs.map(m => <option key={m.org_id} value={m.org_id}>{m.org_name}</option>)}
            </select>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            <span>roles <span style={{ opacity: 0.6 }}>(pick multiple — e.g. business + founder)</span></span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "4px 0" }}>
              {ROLES.map(r => {
                const on = selectedRoles.has(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleRole(r)}
                    style={{
                      padding: "4px 10px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--t-1)",
                      textTransform: "lowercase",
                      border: `1px solid ${on ? "var(--a-accent)" : "var(--a-line)"}`,
                      background: on ? "var(--a-accent-soft)" : "var(--a-paper)",
                      color: on ? "var(--a-accent-2)" : "var(--a-mute)",
                      borderRadius: 3,
                      cursor: "pointer",
                      fontWeight: on ? 600 : 400,
                    }}
                  >{on ? "✓ " : ""}{r}</button>
                );
              })}
            </div>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            email (optional · for display only)
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={fieldStyle}
            />
          </label>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            aria-busy={creating}
            style={{
              ...fieldStyle,
              cursor: creating ? "wait" : "pointer",
              color: "var(--a-accent)",
              borderColor: "var(--a-accent)",
              padding: "6px 14px",
              fontWeight: 500,
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    border: "1.5px solid var(--a-accent)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "atelier-spin 0.8s linear infinite",
                  }}
                />
                creating…
              </span>
            ) : "create invite"}
          </button>
        </div>

        {mintedLink && (
          <div style={{ marginTop: 12, padding: 10, background: "var(--a-paper-2)", border: "1px solid var(--a-accent)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            <div style={{ color: "var(--a-mute)", marginBottom: 4, textTransform: "lowercase" }}>share this link — single-use, 7-day TTL, copy it now</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <code
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--a-ink)", cursor: "pointer", userSelect: "all" }}
                onClick={() => handleCopy(mintedLink)}
                title="click to copy"
              >{mintedLink}</code>
              <button
                onClick={() => handleCopy(mintedLink)}
                style={{
                  ...fieldStyle,
                  cursor: "pointer",
                  padding: "3px 10px",
                  color: copyStatus === "copied" ? "var(--sem-green)" : copyStatus === "failed" ? "var(--sem-red)" : "var(--a-ink)",
                  borderColor: copyStatus === "copied" ? "var(--sem-green)" : copyStatus === "failed" ? "var(--sem-red)" : "var(--a-line)",
                }}
              >{copyStatus === "copied" ? "copied ✓" : copyStatus === "failed" ? "failed" : "copy"}</button>
            </div>
          </div>
        )}
        {createError && <div style={{ marginTop: 8, color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>{createError}</div>}
      </section>

      {/* ── Users list ────────────────────────────────────────────────────── */}
      <section>
        <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 600, margin: "0 0 8px" }}>users ({users.length})</h3>
        <table style={tableStyle}>
          <thead>
            <tr style={theadRowStyle}>
              <th style={thStyle}>name</th>
              <th style={thStyle}>email</th>
              <th style={thStyle}>memberships</th>
              <th style={thStyle}>last seen</th>
              <th style={thStyle}>actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const isSelf = me?.user?.id === u.id;
              const reveal = resetReveals.get(u.id);
              return (
                // React.Fragment with explicit `key` — needed because the map yields two <tr> per user
                // (the row, and an optional reveal row). Without a key here React warns and may misorder rows on reset.
                <Fragment key={u.id}>
                  <tr style={{ borderBottom: reveal ? "0" : "1px solid var(--a-line)" }}>
                    <td style={tdStyle}>{u.display_name}{isSelf && <span style={{ color: "var(--a-accent)", marginLeft: 6 }}>· you</span>}</td>
                    <td style={tdStyleMute}>{u.email || "—"}</td>
                    <td style={tdStyleMute}>{u.memberships || "—"}</td>
                    <td style={tdStyleMute}>{u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {canAdmin && (
                          <button
                            onClick={() => handleResetPassword(u.id, u.display_name)}
                            style={{ ...fieldStyle, cursor: "pointer", padding: "3px 10px" }}
                            title="generate a temp password · revokes existing password and sessions"
                          >reset password</button>
                        )}
                        {!isSelf && orgId && (
                          <button
                            onClick={() => handleRemoveUser(u.id, orgId, u.display_name)}
                            style={{ ...fieldStyle, cursor: "pointer", padding: "3px 10px", color: "var(--sem-red)", borderColor: "var(--sem-red)" }}
                            title="remove from this org · revokes all access tokens"
                          >remove</button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {reveal && (
                    <tr style={{ borderBottom: "1px solid var(--a-line)" }}>
                      <td colSpan={5} style={{
                        padding: "8px 12px 12px",
                        background: "rgba(232,144,96,0.06)",
                      }}>
                        <div style={{
                          fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                          color: "var(--a-accent)", marginBottom: 6, textTransform: "uppercase",
                          letterSpacing: "0.10em",
                        }}>temp password — copy now, won't be shown again</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <code style={{
                            flex: 1, padding: "8px 12px",
                            background: "rgba(0,0,0,0.30)",
                            border: "1px solid rgba(232,144,96,0.30)",
                            borderRadius: 4,
                            fontFamily: "var(--font-mono)", fontSize: "0.95rem",
                            color: "var(--ink-0, #f4f4f5)", letterSpacing: "0.04em",
                            wordBreak: "break-all",
                          }}>{reveal}</code>
                          <button
                            onClick={async () => { await copyToClipboard(reveal); }}
                            style={{ ...fieldStyle, cursor: "pointer", padding: "6px 12px" }}
                          >copy</button>
                          <button
                            onClick={() => dismissReveal(u.id)}
                            style={{ ...fieldStyle, cursor: "pointer", padding: "6px 12px" }}
                          >done</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ── Invites list ──────────────────────────────────────────────────── */}
      <section>
        <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 600, margin: "0 0 8px" }}>invites ({invites.length})</h3>
        <table style={tableStyle}>
          <thead>
            <tr style={theadRowStyle}>
              <th style={thStyle}>org</th>
              <th style={thStyle}>role</th>
              <th style={thStyle}>invited</th>
              <th style={thStyle}>status</th>
              <th style={thStyle}>actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.map(i => {
              const expired = new Date(i.expires_at) < new Date();
              const status = i.redeemed_at ? `redeemed by ${i.redeemed_by_name}` : expired ? "expired/revoked" : `pending · expires ${new Date(i.expires_at).toLocaleDateString()}`;
              const statusColor = i.redeemed_at ? "var(--sem-green)" : expired ? "var(--a-mute-2)" : "var(--sem-amber)";
              return (
                <tr key={i.token_hash} style={{ borderBottom: "1px solid var(--a-line)" }}>
                  <td style={tdStyle}>{i.org_name}</td>
                  <td style={tdStyleMute}>{i.role}</td>
                  <td style={tdStyleMute}>{i.intended_email || "(no email)"} · by {i.invited_by_name}</td>
                  <td style={{ ...tdStyle, color: statusColor }}>{status}</td>
                  <td style={tdStyle}>
                    {!i.redeemed_at && !expired && (
                      <button
                        onClick={() => handleRevoke(i.token_hash)}
                        style={{ ...fieldStyle, cursor: "pointer", padding: "3px 10px", color: "var(--sem-red)", borderColor: "var(--sem-red)" }}
                      >revoke</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const fieldStyle = {
  background: "var(--a-paper)",
  border: "1px solid var(--a-line)",
  borderRadius: 3,
  padding: "6px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-2)",
  color: "var(--a-ink)",
} as const;

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--t-1)",
};
const theadRowStyle = { borderBottom: "1px solid var(--a-line-2)" } as const;
const thStyle = {
  textAlign: "left" as const,
  padding: "8px 4px",
  color: "var(--a-mute)",
  textTransform: "lowercase" as const,
  fontWeight: 500,
  letterSpacing: "0.06em",
};
const tdStyle = { padding: "8px 4px", color: "var(--a-ink)" };
const tdStyleMute = { padding: "8px 4px", color: "var(--a-mute)" };
