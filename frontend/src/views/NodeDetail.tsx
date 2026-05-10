/**
 * NodeDetail — right-side drawer showing full plan.md + meta for a selected Canvas node.
 * Fetches from GET /canvas/node/:id (implemented by the parallel agent). Falls back
 * to the meta Canvas already has if the endpoint errors/404s.
 * Discussion + Outputs are Phase B per SESSION_01_REFLECTION.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  updateNode,
  listNodeComments,
  postNodeComment,
  listNodeEvents,
  runResearcher,
  type NodeState,
  type NodeBadge,
  type NodeComment,
  type NodeEvent,
  type ResearchRunResult,
} from "../lib/api";
import { ImplementerCard } from "../components/ImplementerCard";

interface NodeMeta {
  id: string;
  kind: string;
  intent: string;
  state: string;
  badge: string;
  confidence: string;
  parent_id?: string | null;
  dependencies?: string[];
  classification?: string | null;
  // Cofounder discussion flow (Canvas reframe 2026-05-04).
  mark_for_discussion?: boolean;
  discussion_agenda?: string | null;
  assigned_to_user_id?: string | null;
  // Consultation kind only (Session 4 — Pillar B).
  expert_role?: string | null;
  channel?: string | null;
  question?: string | null;
  answer?: string | null;
  deadline?: string | null;
  answered_at?: string | null;
}

interface Props {
  nodeId: string;
  nodeFallback: NodeMeta;
  baseUrl: string;
  project: string;
  onClose: () => void;
  onSave?: () => void;
}

interface FetchedNode {
  meta?: NodeMeta | null;
  plan?: string | null;
}

/**
 * Tiny hand-rolled markdown → HTML renderer.
 * Supports: headings (# ##), bold **x**, italic *x*, inline `code`,
 * fenced ``` blocks, unordered lists, paragraphs, links [t](u).
 * Not a full CommonMark impl — intentional small surface for Phase A plan.md.
 */
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inList = false;

  const flushList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const inline = (s: string): string => {
    let t = escape(s);
    // code
    t = t.replace(/`([^`]+)`/g, (_m, g) => `<code>${g}</code>`);
    // bold
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // italic (single *)
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    // links
    t = t.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
    return t;
  };

  for (const raw of lines) {
    if (raw.startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) {
    out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
  }
  flushList();
  return out.join("\n");
}

const BADGE_COLORS: Record<string, string> = {
  done: "var(--atelier-sage)",
  shipped: "var(--atelier-sage)",
  verified: "var(--atelier-sage)",
  "in-progress": "var(--atelier-blue)",
  healthy: "var(--atelier-blue)",
  drift: "var(--atelier-yellow)",
  "drift-risk": "var(--atelier-yellow)",
  blocked: "var(--atelier-orange)",
  "awaiting-founder": "var(--atelier-orange)",
  review: "var(--atelier-orange)",
  violation: "var(--atelier-red)",
  "approval-needed": "var(--atelier-red)",
  breaking: "var(--atelier-red)",
  proposed: "var(--atelier-grey)",
  auto: "var(--atelier-purple)",
  "auto-built": "var(--atelier-purple)",
};

export function NodeDetail({ nodeId, nodeFallback, baseUrl, project, onClose, onSave }: Props) {
  const [fetched, setFetched] = useState<FetchedNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editIntent, setEditIntent] = useState("");
  const [editState, setEditState] = useState("");
  const [editBadge, setEditBadge] = useState("");
  const [saving, setSaving] = useState(false);
  // Bumped by ResearcherSection when a run completes; CommentsSection reloads.
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(nodeId)}`);
        if (!r.ok) {
          if (!cancelled) {
            setError(`endpoint returned ${r.status}`);
            setFetched(null);
            setLoading(false);
          }
          return;
        }
        const json = (await r.json()) as FetchedNode;
        if (!cancelled) {
          setFetched(json);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setFetched(null);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, baseUrl]);

  const meta = fetched?.meta ?? nodeFallback;
  const plan = fetched?.plan ?? null;
  const badgeBg = BADGE_COLORS[meta.badge] ?? "var(--atelier-grey)";

  function startEdit() {
    setEditIntent(meta.intent);
    setEditState(meta.state);
    setEditBadge(meta.badge);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateNode(baseUrl, project, nodeId, {
        intent: editIntent,
        state: editState as NodeState,
        badge: editBadge as NodeBadge,
      });
      setEditing(false);
      onSave?.();
      // re-fetch updated meta
      const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(nodeId)}?project=${encodeURIComponent(project)}`);
      if (r.ok) setFetched(await r.json());
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside
      className="node-detail"
      role="dialog"
      aria-label={`Node ${meta.intent}`}
    >
      <header className="node-detail-head">
        <div className="node-detail-head-row">
          <span className="canvas-node-kind">{meta.kind}</span>
          <span className="canvas-node-badge" style={{ background: badgeBg }}>{meta.badge}</span>
        </div>
        {editing ? (
          <div className="node-detail-edit-form">
            <label>intent</label>
            <input value={editIntent} onChange={e => setEditIntent(e.target.value)} />
            <label>state</label>
            <select value={editState} onChange={e => setEditState(e.target.value)}>
              {["triage","proposed","approved","in-progress","review","done","blocked","archived","abandoned"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <label>badge</label>
            <select value={editBadge} onChange={e => setEditBadge(e.target.value)}>
              {["auto","proposed","in-progress","blocked","review","done","drift"].map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <div className="node-detail-save-row">
              <button onClick={handleSave} disabled={saving}>{saving ? "saving…" : "save"}</button>
              <button onClick={() => setEditing(false)}>cancel</button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="node-detail-intent">{meta.intent}</h2>
            <div className="node-detail-meta">state: {meta.state} · conf: {meta.confidence}</div>
          </>
        )}
        <button type="button" className="node-detail-edit-btn" onClick={startEdit} title="Edit node">edit</button>
        <button type="button" className="node-detail-close" onClick={onClose} aria-label="Close">Close</button>
      </header>

      <section className="node-detail-body">
        {/* Implementer surface — first thing the founder sees in any node
            drawer. Above Plan so it never requires scroll-to-find. */}
        <ImplementerCard
          baseUrl={baseUrl}
          project={project}
          nodeId={nodeId}
          nodeState={meta.state}
          onStateChanged={onSave}
        />

        {/* U4 — reveal-on-demand. Plan open by default (the founder's daily
            need); Discussion collapsed (low-traffic Phase-B surface). */}
        <details className="node-detail-disclosure" open>
          <summary className="node-detail-section-title">Plan</summary>
          {loading && <div className="node-detail-hint">loading plan…</div>}
          {!loading && plan && (
            <div
              className="node-detail-plan"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }}
            />
          )}
          {!loading && !plan && (
            <div className="node-detail-hint">
              {error
                ? `No plan available (${error}). Showing meta only.`
                : "No plan.md for this node yet."}
            </div>
          )}
        </details>

        {/* Discussion flag — Canvas reframe (2026-05-04). When toggled on,
            assigned user's next Drafter session opens with this card's agenda
            as the conversation seed. See docs/CANVAS_REFRAME_DECISIONS.md §3. */}
        <DiscussionFlagSection
          baseUrl={baseUrl}
          project={project}
          nodeId={nodeId}
          mark={meta.mark_for_discussion === true}
          agenda={meta.discussion_agenda ?? ""}
          assignedTo={meta.assigned_to_user_id ?? ""}
          onSaved={onSave}
        />

        {/* Consultation (Pillar B — off-platform expert tracking, Session 4).
            Only on Consultation kind. Persists question/answer; saving with a
            non-empty answer fires the brain ripple on the backend. */}
        {meta.kind === "Consultation" && (
          <ConsultationSection
            baseUrl={baseUrl}
            project={project}
            nodeId={nodeId}
            expertRole={meta.expert_role ?? ""}
            channel={meta.channel ?? ""}
            question={meta.question ?? meta.intent ?? ""}
            answer={meta.answer ?? ""}
            deadline={meta.deadline ?? ""}
            answeredAt={meta.answered_at ?? null}
            onSaved={() => { onSave?.(); setCommentsRefreshKey(k => k + 1); }}
          />
        )}

        {/* Researcher (Pillar A — world-grounding). Decision / Risk / Research
            kinds only — Drafter handles framing/Task surfaces. */}
        {(meta.kind === "Decision" || meta.kind === "Risk" || meta.kind === "Research") && (
          <ResearcherSection
            baseUrl={baseUrl}
            project={project}
            nodeId={nodeId}
            nodeKind={meta.kind}
            nodeIntent={meta.intent}
            onCompleted={() => setCommentsRefreshKey(k => k + 1)}
          />
        )}

        {/* Comments thread — human-readable inter-agent ledger. Founders +
            cofounders + agents (drafter resolution) all post here. */}
        <CommentsSection baseUrl={baseUrl} project={project} nodeId={nodeId} refreshKey={commentsRefreshKey} />

        {/* Activity timeline — last 50 canvas_node_events filtered to this node. */}
        <ActivitySection baseUrl={baseUrl} project={project} nodeId={nodeId} />
      </section>
    </aside>
  );
}

// ── Drawer subsections (Canvas reframe 2026-05-04) ─────────────────────────

interface DiscussionFlagProps {
  baseUrl: string;
  project: string;
  nodeId: string;
  mark: boolean;
  agenda: string;
  assignedTo: string;
  onSaved?: () => void;
}

function DiscussionFlagSection({ baseUrl, project, nodeId, mark, agenda, assignedTo, onSaved }: DiscussionFlagProps) {
  const [m, setM] = useState(mark);
  const [a, setA] = useState(agenda);
  const [u, setU] = useState(assignedTo);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => { setM(mark); setA(agenda); setU(assignedTo); }, [nodeId, mark, agenda, assignedTo]);

  const dirty = m !== mark || a !== agenda || u !== assignedTo;
  const showSaved = savedAt !== null && (Date.now() - savedAt < 2500);

  async function save() {
    setSaving(true);
    try {
      await updateNode(baseUrl, project, nodeId, {
        mark_for_discussion: m,
        discussion_agenda: m ? (a || null) : null,
        assigned_to_user_id: m ? (u || null) : null,
      });
      setSavedAt(Date.now());
      onSaved?.();
      window.setTimeout(() => setSavedAt((v) => v), 2600);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="node-detail-disclosure" open={m}>
      <summary className="node-detail-section-title">
        💬 discussion {m ? "· flagged" : ""}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem" }}>
          <input type="checkbox" checked={m} onChange={e => setM(e.target.checked)} />
          mark for discussion with team
        </label>
        {m && (
          <>
            <label style={{ fontSize: "0.75rem", color: "var(--a-mute)" }}>agenda (Drafter opens with this on assigned user's next session)</label>
            <textarea
              value={a}
              onChange={e => setA(e.target.value)}
              placeholder="What do you want to discuss? (e.g. 'Is the upload size cap right? Compliance implications?')"
              rows={3}
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
            />
            <label style={{ fontSize: "0.75rem", color: "var(--a-mute)" }}>assigned user_id (which cofounder picks this up)</label>
            <input
              value={u}
              onChange={e => setU(e.target.value)}
              placeholder="user uuid (paste from /me)"
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
            />
          </>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={save} disabled={!dirty || saving} className="tweak-chip" style={{ borderColor: dirty ? "var(--sem-blue)" : "var(--a-line)" }}>
            {saving ? "saving…" : "save"}
          </button>
          {showSaved && <span style={{ color: "var(--sem-green)", fontSize: "0.75rem" }}>saved</span>}
        </div>
      </div>
    </details>
  );
}

interface CommentsProps { baseUrl: string; project: string; nodeId: string; refreshKey?: number }

function CommentsSection({ baseUrl, project, nodeId, refreshKey = 0 }: CommentsProps) {
  const [comments, setComments] = useState<NodeComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listNodeComments(baseUrl, project, nodeId);
      setComments(list);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, project, nodeId]);

  // Sibling sections (e.g. ResearcherSection) bump refreshKey to trigger a reload
  // when they post a comment. Avoids exposing imperative load() upward.
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      await postNodeComment(baseUrl, project, nodeId, body, "founder");
      setDraft("");
      await load();
    } finally {
      setPosting(false);
    }
  }

  return (
    <details className="node-detail-disclosure" open>
      <summary className="node-detail-section-title">comments {comments.length > 0 ? `(${comments.length})` : ""}</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
        {loading && <div className="node-detail-hint">loading comments…</div>}
        {!loading && comments.length === 0 && <div className="node-detail-hint">no comments yet.</div>}
        {comments.map(c => (
          <div key={c.id} style={{ borderLeft: `2px solid ${c.author_role === "drafter" || c.author_role === "implementer" || c.author_role === "allocator" ? "var(--sem-blue)" : "var(--a-line)"}`, padding: "4px 8px", background: "var(--a-paper-2)", borderRadius: 4 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--a-mute)", marginBottom: 2 }}>
              {c.author_role} · {new Date(c.created_at).toLocaleString()}
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--a-ink)", whiteSpace: "pre-wrap" }}>{c.body}</div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 6 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="add a comment…"
            rows={2}
            style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
          />
          <button onClick={submit} disabled={posting || !draft.trim()} className="tweak-chip" style={{ borderColor: "var(--sem-blue)" }}>
            {posting ? "…" : "post"}
          </button>
        </div>
      </div>
    </details>
  );
}

interface ActivityProps { baseUrl: string; project: string; nodeId: string; }

function ActivitySection({ baseUrl, project, nodeId }: ActivityProps) {
  const [events, setEvents] = useState<NodeEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listNodeEvents(baseUrl, project, nodeId, 50)
      .then(list => { if (!cancelled) setEvents(list); })
      .catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [baseUrl, project, nodeId]);

  return (
    <details className="node-detail-disclosure">
      <summary className="node-detail-section-title">activity {events.length > 0 ? `(${events.length})` : ""}</summary>
      <div style={{ padding: "8px 0" }}>
        {loading && <div className="node-detail-hint">loading events…</div>}
        {!loading && events.length === 0 && <div className="node-detail-hint">no events yet.</div>}
        {events.map(e => {
          const reason = (e.payload as { reason?: string } | null)?.reason;
          const summary = (e.payload as { summary?: string } | null)?.summary;
          const text = reason || summary || "";
          return (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "120px 90px 1fr", gap: 8, fontFamily: "var(--font-mono)", fontSize: "0.75rem", padding: "3px 0", borderBottom: "1px solid var(--a-line)" }}>
              <span style={{ color: "var(--a-mute)" }}>{new Date(e.ts).toLocaleString()}</span>
              <span style={{ color: "var(--a-ink)" }}>{e.agent}/{e.kind}</span>
              <span style={{ color: "var(--a-mute)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// ── Researcher (Pillar A) section ─────────────────────────────────────────────
// Mirrors Canvas.tsx DrawerResearcher, with the NodeDetail aesthetic
// (node-detail-disclosure / node-detail-section-title / node-detail-hint).
// DRY-by-shape, not by import — the parent file imports differ enough that
// a shared component would carry surface-mode props for marginal payoff.

interface ResearcherProps {
  baseUrl: string;
  project: string;
  nodeId: string;
  nodeKind: string;
  nodeIntent: string;
  onCompleted: () => void;
}

function ResearcherSection({ baseUrl, project, nodeId, nodeKind, nodeIntent, onCompleted }: ResearcherProps) {
  const [question, setQuestion] = useState<string>(nodeIntent ?? "");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "skipped" | "error"; line: string } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setQuestion(nodeIntent ?? "");
    setStatus(null);
    if (ctrlRef.current) {
      ctrlRef.current.abort();
      ctrlRef.current = null;
    }
    setRunning(false);
  }, [nodeId, nodeIntent]);

  async function ask() {
    const q = question.trim();
    if (!q || running) return;
    setRunning(true);
    setStatus(null);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const res: ResearchRunResult = await runResearcher(baseUrl, project, nodeId, q, ctrl.signal);
      if (res.status === "ok") {
        setStatus({
          kind: "ok",
          line: `wrote findings to brain${res.confidence ? ` · confidence: ${res.confidence}` : ""}`,
        });
      } else if (res.status === "skipped") {
        setStatus({ kind: "skipped", line: `skipped — ${res.reason ?? "no reason"}` });
      } else {
        setStatus({ kind: "error", line: `error — ${res.reason ?? "no reason"}` });
      }
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      if (!aborted) setStatus({ kind: "error", line: `error — ${String(e).slice(0, 200)}` });
    } finally {
      setRunning(false);
      ctrlRef.current = null;
      onCompleted();
    }
  }

  // Open by default only when the founder explicitly created a Research node;
  // Decision and Risk get the disclosure but stay collapsed (low-traffic).
  const openByDefault = nodeKind === "Research";
  const statusColor = status?.kind === "ok"
    ? "var(--sem-green)"
    : status?.kind === "error"
      ? "var(--sem-red)"
      : "var(--a-mute)";
  const statusGlyph = status?.kind === "ok" ? "✓" : status?.kind === "skipped" ? "·" : status?.kind === "error" ? "✗" : "";

  return (
    <details className="node-detail-disclosure" open={openByDefault}>
      <summary className="node-detail-section-title">🔎 research</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="What do you want to research? E.g. 'What does the regulation require for advance payments?'"
          rows={3}
          disabled={running}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={ask}
            disabled={running || !question.trim()}
            className="tweak-chip"
            style={{ borderColor: question.trim() ? "var(--sem-blue)" : "var(--a-line)" }}
          >
            {running ? "researching…" : "ask researcher"}
          </button>
          {running && (
            <span style={{ fontStyle: "italic", color: "var(--a-mute)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
              researching…
            </span>
          )}
          {!running && status && (
            <span style={{ color: statusColor, fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
              {statusGlyph} {status.line}
            </span>
          )}
        </div>
        {!running && !status && (
          <div className="node-detail-hint">
            No research yet. Use the box above to ask Researcher.
          </div>
        )}
      </div>
    </details>
  );
}

// ── Consultation (Pillar B — Session 4) section ────────────────────────────
// Mirrors Canvas.tsx DrawerConsultation, with the NodeDetail aesthetic
// (node-detail-disclosure / node-detail-section-title / node-detail-hint).
// Default-open when answer is empty; default-closed once answered.

interface ConsultationProps {
  baseUrl: string;
  project: string;
  nodeId: string;
  expertRole: string;
  channel: string;
  question: string;
  answer: string;
  deadline: string;
  answeredAt: string | null;
  onSaved: () => void;
}

function ConsultationSection({ baseUrl, project, nodeId, expertRole, channel, question, answer, deadline, answeredAt, onSaved }: ConsultationProps) {
  const [er, setEr] = useState(expertRole);
  const [ch, setCh] = useState(channel);
  const [q, setQ] = useState(question);
  const [a, setA] = useState(answer);
  const [dl, setDl] = useState(deadline);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEr(expertRole);
    setCh(channel);
    setQ(question);
    setA(answer);
    setDl(deadline);
    setError(null);
  }, [nodeId, expertRole, channel, question, answer, deadline]);

  const dirty = er !== expertRole || ch !== channel || q !== question || a !== answer || dl !== deadline;
  const showSaved = savedAt !== null && (Date.now() - savedAt < 2500);
  const openByDefault = !answer || answer.trim() === "";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateNode(baseUrl, project, nodeId, {
        expert_role: er || null,
        channel: ch || null,
        question: q || null,
        answer: a || null,
        deadline: dl || null,
      });
      setSavedAt(Date.now());
      onSaved();
      window.setTimeout(() => setSavedAt((v) => v), 2600);
    } catch (e) {
      setError(String(e).slice(0, 200));
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="node-detail-disclosure" open={openByDefault}>
      <summary className="node-detail-section-title">
        👤 consultation {answer ? "· answered" : "· awaiting answer"}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
        <label style={{ fontSize: "0.7rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>expert role</label>
        <input
          value={er}
          onChange={e => setEr(e.target.value)}
          placeholder="legal counsel / tax accountant / UX designer / payments support"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
        />
        <label style={{ fontSize: "0.7rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>channel</label>
        <input
          value={ch}
          onChange={e => setCh(e.target.value)}
          placeholder="email / slack / calendly / phone / in-person"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
        />
        <label style={{ fontSize: "0.7rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>question</label>
        <textarea
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="What you're asking the expert"
          rows={3}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
        />
        <label style={{ fontSize: "0.7rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>answer (filled when conversation completes)</label>
        <textarea
          value={a}
          onChange={e => setA(e.target.value)}
          placeholder="Paste their answer here when the conversation completes"
          rows={4}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
        />
        <label style={{ fontSize: "0.7rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>deadline (optional)</label>
        <input
          type="date"
          value={dl}
          onChange={e => setDl(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, width: 180 }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="tweak-chip"
            style={{ borderColor: dirty ? "var(--sem-blue)" : "var(--a-line)" }}
          >
            {saving ? "saving…" : "save"}
          </button>
          {showSaved && (
            <span style={{ color: "var(--sem-green)", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>saved</span>
          )}
          {error && (
            <span style={{ color: "var(--sem-red)", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>error · {error}</span>
          )}
        </div>
        {answeredAt && (
          <div className="node-detail-hint">
            answered {new Date(answeredAt).toLocaleString()} · brain artifact written to consultations/{nodeId}.md
          </div>
        )}
      </div>
    </details>
  );
}
