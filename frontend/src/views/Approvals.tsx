import { useEffect, useMemo, useState, useCallback } from "react";
import { navigate } from "../lib/router";
import {
  listVerifierConstraints,
  acceptVerifierConstraint,
  rejectVerifierConstraint,
  getAgentSettings,
  type VerifierConstraint,
  type VerifierConstraintRole,
} from "../lib/api";

// Fallback ordering used when /settings/agents is unreachable. Mirrors the
// canonical 7-agent set; Settings + the eval harness consume the same list.
// system / cofounder / founder are non-agent emitters and append at the end.
const FALLBACK_ROLE_ORDER: VerifierConstraintRole[] = [
  "drafter",
  "fixer",
  "researcher",
  "allocator",
  "implementer",
  "senior_reviewer",
  "reflect",
];

// Audience filter heuristics. Per-event audience tagging is a Phase B item
// (verifier_unverified events don't carry assigned_to_user_id today). Until
// then we route by agent role; the surface labels this clearly.
type AudienceFilter = "all" | "mine" | "technical" | "business" | "mixed";

const TECHNICAL_ROLES: ReadonlySet<string> = new Set([
  "drafter", "fixer", "researcher", "allocator", "implementer", "reflect",
]);
const MIXED_ROLES: ReadonlySet<string> = new Set([
  "senior_reviewer",
]);

function passesAudience(c: VerifierConstraint, f: AudienceFilter): boolean {
  if (f === "all") return true;
  if (f === "mine") return TECHNICAL_ROLES.has(c.agent_role); // single-founder Phase A
  if (f === "technical") return TECHNICAL_ROLES.has(c.agent_role);
  if (f === "business") return false; // no business-routed agents today
  if (f === "mixed") return MIXED_ROLES.has(c.agent_role);
  return true;
}

const FILTER_KEYS: AudienceFilter[] = ["all", "mine", "technical", "business", "mixed"];

interface ApprovalsProps {
  project: string;
}

export function Approvals({ project }: ApprovalsProps) {
  const [constraints, setConstraints] = useState<VerifierConstraint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<AudienceFilter>("all");
  const [roleOrder, setRoleOrder] = useState<VerifierConstraintRole[]>(FALLBACK_ROLE_ORDER);

  const refresh = useCallback(() => {
    if (!project) {
      setConstraints([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    listVerifierConstraints(project)
      .then((r) => { setConstraints(r.constraints); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [project]);

  useEffect(() => { refresh(); }, [refresh]);

  // Drive role ordering from the live agent set so Approvals can never drift
  // from Settings — the bug the quality audit caught was hardcoded 5 vs live 7.
  useEffect(() => {
    let cancelled = false;
    getAgentSettings()
      .then((s) => {
        if (cancelled) return;
        const live = (s.agent_names as readonly string[]).filter(
          (n): n is VerifierConstraintRole => FALLBACK_ROLE_ORDER.includes(n as VerifierConstraintRole),
        );
        if (live.length > 0) setRoleOrder(live);
      })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(
    () => constraints.filter(c => passesAudience(c, audience)),
    [constraints, audience],
  );

  const grouped = useMemo(() => {
    const out = new Map<VerifierConstraintRole, VerifierConstraint[]>();
    for (const c of filtered) {
      const role = (c.agent_role as VerifierConstraintRole) || "system";
      const list = out.get(role) ?? [];
      list.push(c);
      out.set(role, list);
    }
    return out;
  }, [filtered]);

  async function handleAccept(c: VerifierConstraint, edited?: string) {
    try {
      await acceptVerifierConstraint(c.event_id, edited);
      setEditingId(null);
      refresh();
    } catch (e) { setError(String(e)); }
  }
  async function handleReject(c: VerifierConstraint) {
    try {
      await rejectVerifierConstraint(c.event_id);
      refresh();
    } catch (e) { setError(String(e)); }
  }

  const groupHeaderLabels: string[] = [];
  for (const role of roleOrder) {
    const list = grouped.get(role) ?? [];
    groupHeaderLabels.push(`${role} (${list.length})`);
  }

  // Total visible after filter, used for the chip-active feedback.
  const visibleCount = filtered.length;

  return (
    <div className="approvals-root">
      <div className="approvals-list">
        <div className="approvals-list-head">
          <h2>Approvals</h2>
          <div className="sub">The agent routes decisions here — technical to you, business to co-founder, mixed to both.</div>
          <div className="approval-filters" role="tablist" aria-label="audience filters">
            {FILTER_KEYS.map(f => {
              const active = f === audience;
              return (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-approval-filter={f}
                  className={`approval-filter ${active ? "on" : ""}`}
                  onClick={() => setAudience(f)}
                >{f}</button>
              );
            })}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-faint)", textTransform: "lowercase", marginTop: 6, lineHeight: 1.5 }}>
            {audience === "all"
              ? `${visibleCount} ${visibleCount === 1 ? "constraint" : "constraints"}`
              : `${visibleCount} matching · audience routing is a heuristic until per-event tagging lands (phase b)`}
          </div>
        </div>

        {/* Existing approvals empty-state CTA */}
        <div style={{ padding:"40px 28px", fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", color:"var(--a-mute)", textTransform:"lowercase", lineHeight:1.7 }}>
          <div style={{ color: "var(--a-ink)", marginBottom: 10 }}>nothing waiting on you.</div>
          approvals appear here when the drafter proposes a canvas node, or when the implementer finishes a node and wants a sign-off before merge.
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => navigate("/canvas")}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", padding: "6px 12px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, color: "var(--a-ink)", cursor: "pointer" }}
            >open canvas</button>
            <button
              type="button"
              onClick={() => navigate("/now")}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", padding: "6px 12px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, color: "var(--a-ink)", cursor: "pointer" }}
            >start a session</button>
          </div>
        </div>

        {/* ── verifier constraints section (A2 flywheel) ─────────────────── */}
        <div style={{ borderTop: "1px solid var(--a-line)", paddingTop: 18, paddingBottom: 18 }}>
          <div style={{ padding: "0 28px 4px 28px" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", color: "var(--a-ink)", letterSpacing: "0.02em" }}>
              verifier constraints
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginTop: 4, lineHeight: 1.5 }}>
              constraints learned from past verifier failures. accept to compile into agent prompts; reject to silence forever.
            </div>
            {!loading && constraints.length > 0 && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-faint)", marginTop: 8 }}>
                {groupHeaderLabels.join(" · ")}
              </div>
            )}
            {error && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--sem-orange)", marginTop: 6 }}>
                {error}
              </div>
            )}
          </div>

          {loading ? (
            <div style={{ padding: "20px 28px", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-faint)", textTransform: "lowercase" }}>
              loading…
            </div>
          ) : constraints.length === 0 ? (
            <div style={{ padding: "20px 28px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.6 }}>
              No pending constraints. The flywheel waits on the next verifier failure.
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              {roleOrder.map((role) => {
                const list = grouped.get(role) ?? [];
                if (list.length === 0) return null;
                return (
                  <div key={role}>
                    <div style={{ padding: "8px 28px 4px 28px", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", textTransform: "lowercase", color: "var(--a-mute)", letterSpacing: "0.04em" }}>
                      {role} ({list.length})
                    </div>
                    {list.map((c) => (
                      <ConstraintRow
                        key={c.event_id}
                        c={c}
                        editing={editingId === c.event_id}
                        editText={editText}
                        onStartEdit={() => { setEditingId(c.event_id); setEditText(c.suggested_constraint); }}
                        onCancelEdit={() => { setEditingId(null); setEditText(""); }}
                        onChangeEdit={setEditText}
                        onSaveEdit={() => handleAccept(c, editText)}
                        onAccept={() => handleAccept(c)}
                        onReject={() => handleReject(c)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="approval-detail" style={{ display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ textAlign:"center", fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", color:"var(--a-faint)", textTransform:"lowercase", maxWidth: 320, lineHeight: 1.7 }}>
          pick an approval from the list to see the diff, evidence, and accept / reject buttons.<br />
          if the list is empty, the agent has nothing pending — keep going in <button onClick={() => navigate("/now")} style={{ background: "transparent", border: 0, padding: 0, color: "var(--a-accent)", cursor: "pointer", textDecoration: "underline", fontFamily: "inherit", fontSize: "inherit", textTransform: "lowercase" }}>now</button>.
        </div>
      </div>
    </div>
  );
}

interface ConstraintRowProps {
  c: VerifierConstraint;
  editing: boolean;
  editText: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (s: string) => void;
  onSaveEdit: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function ConstraintRow({ c, editing, editText, onStartEdit, onCancelEdit, onChangeEdit, onSaveEdit, onAccept, onReject }: ConstraintRowProps) {
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const btn = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--t-1)",
    textTransform: "lowercase" as const,
    padding: "4px 10px",
    background: "transparent",
    borderRadius: 3,
    cursor: "pointer",
    marginLeft: 6,
  };
  return (
    <div style={{ padding: "10px 28px 10px 28px", borderBottom: "1px solid var(--a-line)", display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-ink)" }}>
          {truncate(c.axiom, 80)}
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginTop: 2 }}>
          evidence: {truncate(c.evidence, 140)}
        </div>
        {editing ? (
          <textarea
            value={editText}
            onChange={(e) => onChangeEdit(e.target.value)}
            rows={3}
            style={{
              width: "100%",
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-1)",
              fontStyle: "italic",
              color: "var(--a-ink)",
              background: "transparent",
              border: "1px solid var(--a-line)",
              borderRadius: 3,
              padding: 6,
              resize: "vertical",
            }}
          />
        ) : (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", fontStyle: "italic", color: "var(--a-ink)", marginTop: 2 }}>
            suggested: {c.suggested_constraint}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        {editing ? (
          <>
            <button type="button" onClick={onSaveEdit} style={{ ...btn, border: "1px solid var(--sem-blue)", color: "var(--sem-blue)" }}>save</button>
            <button type="button" onClick={onCancelEdit} style={{ ...btn, border: "1px solid var(--a-line)", color: "var(--a-mute)" }}>cancel</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onAccept} style={{ ...btn, border: "1px solid var(--sem-blue)", color: "var(--sem-blue)" }}>accept</button>
            <button type="button" onClick={onReject} style={{ ...btn, border: "1px solid var(--sem-orange)", color: "var(--sem-orange)" }}>reject</button>
            <button type="button" onClick={onStartEdit} style={{ ...btn, border: "1px solid var(--a-line)", color: "var(--a-mute)" }}>edit</button>
          </>
        )}
      </div>
    </div>
  );
}
