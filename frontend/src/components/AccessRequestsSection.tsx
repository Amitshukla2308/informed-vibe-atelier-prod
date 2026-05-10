import { useEffect, useState } from "react";
import {
  listAccessRequests, decideAccessRequest, listOrgs, listOrgProjects,
  type AccessRequest, type OrgListEntry, type OrgProjectEntry,
} from "../lib/api";

/**
 * Admin-only section listing pending access requests. Each row expands inline
 * to ask the admin: which org? what org-role? for non-admin members on a
 * members-default org, which projects? Then approve / reject in one click.
 *
 * The decision endpoint accepts the whole shape in a single transaction, so
 * approval is atomic: status flip + membership row + project_members rows.
 */
export function AccessRequestsSection() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [orgs, setOrgs] = useState<OrgListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Per-row decision form state
  const [orgId, setOrgId] = useState<string>("");
  const [orgRole, setOrgRole] = useState<"admin" | "member">("member");
  const [contributorKind, setContributorKind] = useState<"founder" | "technical" | "business" | "observer">("technical");
  const [projectRole, setProjectRole] = useState<"editor" | "viewer">("editor");
  const [projects, setProjects] = useState<OrgProjectEntry[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());

  function reload() {
    listAccessRequests().then(setRequests).catch(e => setError(String(e)));
  }

  useEffect(() => {
    reload();
    listOrgs().then(o => {
      const adminOrgs = o.filter(x => x.role === "admin");
      setOrgs(adminOrgs);
      if (adminOrgs.length > 0) setOrgId(adminOrgs[0].id);
    }).catch(() => { /* not admin anywhere — no requests will be actionable */ });
  }, []);

  // When the admin opens a row OR changes the org, reload that org's projects
  useEffect(() => {
    if (!openId || !orgId) return;
    listOrgProjects(orgId).then(p => {
      setProjects(p);
      setSelectedProjects(new Set());
    }).catch(() => setProjects([]));
  }, [openId, orgId]);

  async function decide(userId: string, action: "approve" | "reject") {
    setBusy(userId);
    setError(null);
    try {
      await decideAccessRequest({
        user_id: userId,
        action,
        ...(action === "approve" ? {
          org_id: orgId,
          role: orgRole,
          contributor_kind: contributorKind,
          project_role: projectRole,
          project_ids: orgRole === "admin" ? [] : Array.from(selectedProjects),
        } : {}),
      });
      setOpenId(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) return null;

  const fieldStyle: React.CSSProperties = {
    padding: "5px 8px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 4,
    color: "var(--ink-0, #f4f4f5)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--t-2)",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 4,
    fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
    color: "var(--a-mute)", textTransform: "lowercase",
  };

  return (
    <section>
      <h3 style={{
        fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 600,
        margin: "0 0 8px",
      }}>
        access requests <span style={{ color: "var(--a-accent)" }}>· {requests.length} pending</span>
      </h3>
      {error && <div style={{
        color: "var(--sem-red)", fontFamily: "var(--font-mono)",
        fontSize: "var(--t-1)", marginBottom: 8,
      }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {requests.map(r => {
          const isOpen = openId === r.id;
          return (
            <div key={r.id} style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 8,
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 14px",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "var(--font-serif)", fontSize: "var(--t-3)",
                    color: "var(--ink-0, #f4f4f5)",
                  }}>{r.display_name}</div>
                  <div style={{
                    fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                    color: "var(--a-mute)",
                  }}>
                    {r.email} · requested {new Date(r.requested_at).toLocaleDateString()}
                  </div>
                </div>
                {!isOpen ? (
                  <>
                    <button onClick={() => setOpenId(r.id)} disabled={busy !== null} style={{
                      padding: "6px 14px", fontFamily: "var(--font-mono)",
                      fontSize: "var(--t-2)", background: "rgba(232,144,96,0.14)",
                      border: "1px solid rgba(232,144,96,0.30)", color: "var(--ink-0, #f4f4f5)",
                      borderRadius: 6, cursor: "pointer",
                    }}>review</button>
                    <button onClick={() => decide(r.id, "reject")} disabled={busy === r.id} style={{
                      padding: "6px 14px", fontFamily: "var(--font-mono)",
                      fontSize: "var(--t-2)", background: "transparent",
                      border: "1px solid rgba(255,255,255,0.14)", color: "var(--a-mute)",
                      borderRadius: 6, cursor: "pointer",
                    }}>reject</button>
                  </>
                ) : (
                  <button onClick={() => setOpenId(null)} disabled={busy !== null} style={{
                    padding: "6px 14px", fontFamily: "var(--font-mono)",
                    fontSize: "var(--t-2)", background: "transparent",
                    border: "1px solid rgba(255,255,255,0.14)", color: "var(--a-mute)",
                    borderRadius: 6, cursor: "pointer",
                  }}>cancel</button>
                )}
              </div>
              {isOpen && (
                <div style={{
                  padding: "12px 14px 14px",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                  display: "flex", flexDirection: "column", gap: 12,
                }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    <label style={labelStyle}>
                      org
                      <select value={orgId} onChange={e => setOrgId(e.target.value)} style={fieldStyle}>
                        {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </label>
                    <label style={labelStyle}>
                      org role
                      <select value={orgRole} onChange={e => setOrgRole(e.target.value as "admin" | "member")} style={fieldStyle}>
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>
                    <label style={labelStyle}>
                      contributor
                      <select value={contributorKind} onChange={e => setContributorKind(e.target.value as typeof contributorKind)} style={fieldStyle}>
                        <option value="founder">founder</option>
                        <option value="technical">technical</option>
                        <option value="business">business</option>
                        <option value="observer">observer</option>
                      </select>
                    </label>
                    {orgRole === "member" && (
                      <label style={labelStyle}>
                        project access
                        <select value={projectRole} onChange={e => setProjectRole(e.target.value as "editor" | "viewer")} style={fieldStyle}>
                          <option value="editor">editor</option>
                          <option value="viewer">viewer</option>
                        </select>
                      </label>
                    )}
                  </div>

                  {orgRole === "member" && projects.length > 0 && (
                    <div>
                      <div style={{
                        fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                        color: "var(--a-mute)", marginBottom: 6, textTransform: "lowercase",
                      }}>which projects?</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {projects.map(p => {
                          const sel = selectedProjects.has(p.id);
                          return (
                            <button
                              key={p.id}
                              onClick={() => {
                                const next = new Set(selectedProjects);
                                if (sel) next.delete(p.id); else next.add(p.id);
                                setSelectedProjects(next);
                              }}
                              style={{
                                padding: "4px 10px",
                                fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                                background: sel ? "rgba(232,144,96,0.18)" : "transparent",
                                border: sel ? "1px solid rgba(232,144,96,0.45)" : "1px solid rgba(255,255,255,0.10)",
                                color: sel ? "var(--ink-0, #f4f4f5)" : "var(--ink-2, #a1a1aa)",
                                borderRadius: 4, cursor: "pointer",
                              }}>{p.name}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {orgRole === "admin" && (
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                      color: "var(--a-mute)",
                    }}>
                      org admins see every project automatically — no per-project picks needed.
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => decide(r.id, "approve")} disabled={busy === r.id || !orgId} style={{
                      padding: "8px 18px", fontFamily: "var(--font-mono)",
                      fontSize: "var(--t-2)",
                      background: "linear-gradient(135deg, var(--violet, #E89060) 0%, #C4663A 100%)",
                      color: "#170c05", border: "1px solid rgba(255,255,255,0.16)",
                      borderRadius: 6, cursor: "pointer", fontWeight: 600,
                      letterSpacing: "0.06em", textTransform: "uppercase",
                    }}>{busy === r.id ? "approving…" : "approve"}</button>
                    <button onClick={() => decide(r.id, "reject")} disabled={busy === r.id} style={{
                      padding: "8px 18px", fontFamily: "var(--font-mono)",
                      fontSize: "var(--t-2)",
                      background: "rgba(244,63,94,0.10)", color: "#f7c2b3",
                      border: "1px solid rgba(244,63,94,0.30)",
                      borderRadius: 6, cursor: "pointer",
                    }}>reject</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
