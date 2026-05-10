import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNode as apiCreateNode, deleteNode as apiDeleteNode, getNodeDetail, updateNode, listNodeComments, postNodeComment, listNodeEvents, runResearcher, getRipple, type NodeDetail as ApiNodeDetail, type NodeMeta, type NodeState as ApiNodeState, type NodeBadge as ApiNodeBadge, type Priority as ApiPriority, type NodeComment, type NodeEvent, type ResearchRunResult, type RippleResult, type RippleNeighbor } from "../lib/api";
import { navigate } from "../lib/router";
import { computeRingsAngles } from "../lib/canvas-layout";
import { ImplementerCard } from "../components/ImplementerCard";
import { PlanTreeView } from "../components/PlanTreeView";
import { ActivityView } from "./ActivityView";

interface CanvasNode extends NodeMeta {
  ring: number;
  angle: number;
  pulse?: boolean;
}

interface Edge { from: string; to: string; kind: string; }
interface GraphData { nodes: NodeMeta[]; edges: Edge[]; }

// Canvas reframe (2026-05-04, decisions §2): assignee is auto-derived from
// state. No DB column. Pipeline IS the assignee until multi-agent lands.
// `blocked` shows the resolver (founder) since whoever blocked the node is
// the prose comment, not a normalized field — refine when comment-thread
// auto-posts wire a `blocked_by_role` reason.
function assigneeForState(state: ApiNodeState): string | null {
  switch (state) {
    case "triage":      return "drafter";
    case "proposed":    return "allocator";
    case "approved":    return "implementer";
    case "in-progress": return "implementer";
    case "review":      return "founder";
    case "blocked":     return "founder";
    case "done":        return null;
    case "archived":    return null;
    case "abandoned":   return null;
    default:            return null;
  }
}

function MdMini({ src }: { src: string }) {
  const lines = src.split("\n");
  const out: React.ReactNode[] = [];
  let items: React.ReactNode[] = [];
  function flush() { if (items.length) { out.push(<ul key={`ul${out.length}`}>{items}</ul>); items = []; } }
  lines.forEach((ln, i) => {
    const m1 = ln.match(/^# (.+)/); const m2 = ln.match(/^## (.+)/); const m3 = ln.match(/^### (.+)/); const li = ln.match(/^- (.+)/);
    if (m1) { flush(); out.push(<h1 key={i}>{m1[1]}</h1>); return; }
    if (m2) { flush(); out.push(<h2 key={i}>{m2[1]}</h2>); return; }
    if (m3) { flush(); out.push(<h3 key={i}>{m3[1]}</h3>); return; }
    if (li) { items.push(<li key={i} dangerouslySetInnerHTML={{ __html: li[1].replace(/`([^`]+)`/g, "<code>$1</code>") }} />); return; }
    flush();
    if (ln.trim()) out.push(<p key={i} dangerouslySetInnerHTML={{ __html: ln.replace(/`([^`]+)`/g, "<code>$1</code>") }} />);
  });
  flush();
  return <div className="plan">{out}</div>;
}

/**
 * Surface impact banner — renders cascade entries written by the backend
 * (canvas.ts: cascadeSurfaceEdit) when a Surface this node touches is edited
 * or retired. Founder reads what changed + the action_required, then clicks
 * "acknowledge" to clear the drift badge. Retired Surfaces don't auto-unblock
 * — that requires the founder to re-place this node, which is a separate flow.
 */
interface CascadeEntry {
  ts: string;
  from?: string;
  kind: string;
  surface_id?: string;
  surface_title?: string;
  summary?: string;
  action_required?: string;
}

function SurfaceImpactBanner({
  node,
  detail,
  baseUrl,
  project,
  onAcknowledged,
}: {
  node: CanvasNode;
  detail: ApiNodeDetail | null;
  baseUrl: string;
  project: string;
  onAcknowledged?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const cascade = detail?.discussions?.find((d) => d.file === "surface-cascade.jsonl");
  const entries = (cascade?.entries ?? []) as CascadeEntry[];
  if (entries.length === 0) return null;

  // Show the most recent 3 entries — earlier ones are usually stale.
  const recent = entries.slice(-3).reverse();
  const isRetired = recent.some((e) => e.kind === "surface-retired");
  const showAcknowledge = node.badge === "drift" && !isRetired;

  async function acknowledge() {
    setBusy(true);
    try {
      await updateNode(baseUrl, project, node.id, { badge: "auto" });
      onAcknowledged?.();
    } catch {
      /* swallow — banner stays, founder can retry */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginBottom: 12,
        padding: "10px 12px",
        background: isRetired ? "color-mix(in srgb, var(--sem-orange, #E8A86A) 12%, var(--a-paper))" : "color-mix(in srgb, var(--a-accent) 6%, var(--a-paper))",
        borderLeft: `3px solid ${isRetired ? "var(--sem-orange, #E8A86A)" : "var(--a-accent)"}`,
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, textTransform: "lowercase", letterSpacing: "0.04em" }}>
          {isRetired ? "surface retired — re-place this work" : "surface impact — review"}
        </span>
        {showAcknowledge && (
          <button
            type="button"
            className="np-btn np-btn-small"
            onClick={acknowledge}
            disabled={busy}
            title="Clear the drift badge once you've reviewed the impact"
          >
            {busy ? "…" : "acknowledge"}
          </button>
        )}
      </div>
      <ul style={{ margin: 0, padding: "0 0 0 16px", listStyle: "none" }}>
        {recent.map((e, i) => (
          <li key={`${e.ts}-${i}`} style={{ marginBottom: 4 }}>
            <span style={{ color: "var(--a-mute)", fontSize: "var(--t-1)" }}>
              {new Date(e.ts).toLocaleString()}
            </span>
            <span style={{ marginLeft: 6, color: "var(--a-ink)" }}>
              {e.summary ?? `${e.kind} on Surface ${e.surface_title ?? e.surface_id ?? "?"}`}
            </span>
            {e.action_required && (
              <div style={{ marginLeft: 12, color: "var(--a-mute-2)", fontSize: "var(--t-1)" }}>
                ↳ {e.action_required}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Build the Layer › Plane › Surface › <kind> "<title>" chain for a node.
// Resolves whichever slots it can: a Plane shows Layer › <plane>; a Story shows
// Layer › Plane › Surface › Story; a bare Decision shows just <kind>.
// Returns [] if nothing meaningful is resolvable, in which case the breadcrumb
// chip simply doesn't render.
function buildBreadcrumb(node: CanvasNode, allNodes: CanvasNode[]): { label: string }[] {
  const crumbs: { label: string }[] = [];
  const project = allNodes.find((n) => n.kind === "Project") ?? null;
  const layer = project?.layer ?? null;

  if (node.kind === "Project") {
    if (layer) crumbs.push({ label: layer });
    crumbs.push({ label: `project "${node.title}"` });
    return crumbs;
  }

  if (node.kind === "Plane") {
    if (layer) crumbs.push({ label: layer });
    crumbs.push({ label: `${node.plane_kind ?? "plane"}` });
    return crumbs;
  }

  if (node.kind === "Surface") {
    const plane = node.parent_plane_id ? allNodes.find((n) => n.id === node.parent_plane_id) : null;
    if (layer) crumbs.push({ label: layer });
    if (plane?.plane_kind) crumbs.push({ label: plane.plane_kind });
    crumbs.push({ label: node.surface_kind ?? node.title });
    return crumbs;
  }

  // Story | Epic | Task | Subtask — walk via touches[0] (representative Surface)
  // or, for Tasks without their own touches, via parent_id → parent's touches.
  if (node.kind === "Story" || node.kind === "Epic" || node.kind === "Task" || node.kind === "Subtask") {
    let touched = node.touches ?? [];
    if (touched.length === 0 && node.parent_id) {
      const parent = allNodes.find((n) => n.id === node.parent_id);
      touched = parent?.touches ?? [];
    }
    const surface = touched[0] ? allNodes.find((n) => n.id === touched[0]) : null;
    const plane = surface?.parent_plane_id ? allNodes.find((n) => n.id === surface.parent_plane_id) : null;
    if (layer) crumbs.push({ label: layer });
    if (plane?.plane_kind) crumbs.push({ label: plane.plane_kind });
    if (surface) crumbs.push({ label: surface.surface_kind ?? surface.title });
    crumbs.push({ label: `${node.kind.toLowerCase()} "${node.title}"` });
    return crumbs;
  }

  // Decision / Risk / Research / Artifact / Milestone / deprecated kinds — minimal chip.
  if (layer) crumbs.push({ label: layer });
  crumbs.push({ label: `${node.kind.toLowerCase()} "${node.title}"` });
  return crumbs;
}

/**
 * Read-only brief view for a Project node. Replaces the plan-editor that's
 * shown for Tasks/Subtasks. A Project is a frame, not a unit of work — it
 * has an outcome and a layer, not Acceptance criteria. Showing the plan
 * editor here invited founders (and Drafter) to fill it with task-shaped
 * content that the Implementer would then refuse to act on.
 */
function ProjectBriefView({ node, graph }: { node: CanvasNode; graph: CanvasNode[] }) {
  const counts = {
    plane: graph.filter((n) => n.kind === "Plane").length,
    surface: graph.filter((n) => n.kind === "Surface").length,
    story: graph.filter((n) => n.kind === "Story" || n.kind === "Epic").length,
    task: graph.filter((n) => n.kind === "Task" || n.kind === "Subtask").length,
    decision: graph.filter((n) => n.kind === "Decision").length,
  };
  const taskState = (s: string) => graph.filter((n) => (n.kind === "Task" || n.kind === "Subtask") && n.state === s).length;
  const monoMute: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" };
  return (
    <>
      <div className="np-section">brief</div>
      <div style={{ padding: "8px 0 12px", lineHeight: 1.55 }}>
        {node.outcome ? (
          <div style={{ marginBottom: 12, fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", color: "var(--a-ink)" }}>
            {node.outcome}
          </div>
        ) : (
          <div className="ph-empty" style={{ marginBottom: 12 }}>
            no outcome yet · click "edit meta" above to set one ("first real user completes the audit")
          </div>
        )}
        <div style={{ ...monoMute, fontFamily: "var(--font-serif)", fontSize: "var(--t-2)", color: "var(--a-ink)", textTransform: "none" }}>
          {node.intent}
        </div>
      </div>

      <div className="np-section">project meta</div>
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 14px" }}>
        <li style={monoMute}>kind · <strong style={{ color: "var(--a-ink)" }}>Project</strong> <span style={{ opacity: 0.55 }}>(non-runnable — pick a Task to run)</span></li>
        {node.layer && <li style={monoMute}>layer · <strong style={{ color: "var(--a-ink)" }}>{node.layer}</strong></li>}
        <li style={monoMute}>state · <strong style={{ color: "var(--a-ink)" }}>{node.state}</strong></li>
        <li style={monoMute}>confidence · <strong style={{ color: "var(--a-ink)" }}>{node.confidence}</strong></li>
        {node.priority && <li style={monoMute}>priority · <strong style={{ color: "var(--a-ink)" }}>{node.priority}</strong></li>}
      </ul>

      <div className="np-section">structure</div>
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 14px" }}>
        <li style={monoMute}>planes · <strong style={{ color: "var(--a-ink)" }}>{counts.plane}</strong></li>
        <li style={monoMute}>surfaces · <strong style={{ color: "var(--a-ink)" }}>{counts.surface}</strong></li>
        <li style={monoMute}>stories / epics · <strong style={{ color: "var(--a-ink)" }}>{counts.story}</strong></li>
        <li style={monoMute}>tasks / subtasks · <strong style={{ color: "var(--a-ink)" }}>{counts.task}</strong> <span style={{ opacity: 0.55 }}>(approved {taskState("approved")} · in-progress {taskState("in-progress")} · done {taskState("done")} · blocked {taskState("blocked")})</span></li>
        <li style={monoMute}>decisions · <strong style={{ color: "var(--a-ink)" }}>{counts.decision}</strong></li>
      </ul>

      <div className="np-hint" style={{ ...monoMute, fontStyle: "italic", marginTop: 4 }}>
        the project brief is read-only. open a task on the canvas to see its plan, or use "edit meta" above to update outcome / layer.
      </div>
    </>
  );
}

function NodeDrawer({ node, project, baseUrl, onClose, onDeleted, onUpdated, allNodes }: {
  node: CanvasNode | null;
  project: string;
  baseUrl: string;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onUpdated?: () => void;
  // Used to derive the Layer › Plane › Surface › kind breadcrumb at the top of the panel.
  // Optional — when omitted (e.g. legacy mount), the breadcrumb chip simply doesn't render.
  allNodes?: CanvasNode[];
}) {
  const [detail, setDetail] = useState<ApiNodeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Inline edit state — toggled by the "edit" button in the head.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editIntent, setEditIntent] = useState("");
  const [editState, setEditState] = useState<ApiNodeState>("proposed");
  const [editBadge, setEditBadge] = useState<ApiNodeBadge>("proposed");
  const [editPriority, setEditPriority] = useState<ApiPriority>("P2-later");
  const [editCycle, setEditCycle] = useState<string>("");
  const [editOutcome, setEditOutcome] = useState<string>("");
  const [editTargetDate, setEditTargetDate] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Plan.md inline editor — separate from the meta edit form because plans are
  // long, and founders want to iterate on them without touching the other fields.
  const [editingPlan, setEditingPlan] = useState(false);
  const [planDraft, setPlanDraft] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Researcher → Comments fan-out. The DrawerResearcher subsection bumps this
  // counter when a research run completes; DrawerComments reads it via
  // `refreshKey` and reloads so the new comment appears without manual click.
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);

  useEffect(() => {
    if (!node) { setDetail(null); return; }
    setLoading(true);
    setConfirmDelete(false);
    setDeleteError(null);
    setEditing(false);
    setSaveError(null);
    setEditingPlan(false);
    setPlanError(null);
    getNodeDetail(baseUrl, project, node.id)
      .then(d => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [node, baseUrl, project]);

  function startEditPlan() {
    setPlanDraft(detail?.plan ?? "");
    setPlanError(null);
    setEditingPlan(true);
  }

  async function savePlan() {
    if (!node) return;
    setSavingPlan(true);
    setPlanError(null);
    try {
      await updateNode(baseUrl, project, node.id, { plan: planDraft });
      // Re-fetch detail so the rendered plan reflects saved content.
      const fresh = await getNodeDetail(baseUrl, project, node.id);
      setDetail(fresh);
      setEditingPlan(false);
      onUpdated?.();
    } catch (e) {
      setPlanError(String(e));
    } finally {
      setSavingPlan(false);
    }
  }

  function startEdit() {
    if (!node) return;
    setEditTitle(node.title || "");
    setEditIntent(node.intent);
    setEditState(node.state as ApiNodeState);
    setEditBadge(node.badge as ApiNodeBadge);
    setEditPriority((node.priority as ApiPriority | undefined) ?? "P2-later");
    setEditCycle(node.cycle ?? "");
    setEditOutcome(node.outcome ?? "");
    setEditTargetDate(node.target_date ?? "");
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!node) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateNode(baseUrl, project, node.id, {
        title: editTitle.trim(),
        intent: editIntent.trim(),
        state: editState,
        badge: editBadge,
        priority: editPriority,
        cycle: editCycle.trim() || null,
        // Kind-gated: outcome only relevant on Project; target_date only on Milestone.
        // Send in both cases — backend ignores on wrong kind so this is safe.
        outcome: node.kind === "Project" ? (editOutcome.trim() || null) : undefined,
        target_date: node.kind === "Milestone" ? (editTargetDate.trim() || null) : undefined,
      });
      setEditing(false);
      onUpdated?.();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!node) return null;

  async function handleDelete() {
    if (!node) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiDeleteNode(baseUrl, project, node.id);
      onDeleted(node.id);
      if (res.orphanedChildren > 0) {
        console.warn(`[canvas] deleted ${node.id} · ${res.orphanedChildren} orphaned children`);
      }
    } catch (e) {
      setDeleteError(String(e));
      setDeleting(false);
    }
  }

  const createdAt = node.created_at ? new Date(node.created_at).toLocaleString() : "—";
  const updatedAt = node.updated_at ? new Date(node.updated_at).toLocaleString() : "—";

  // Layer › Plane › Surface › kind breadcrumb. Walks the touched-Surface chain
  // for Story/Epic/Task/Subtask, and the parent_plane chain for Plane/Surface.
  // Renders only the slots we can resolve so a partially-set node still shows
  // useful context. "Fruits don't grow in air" — every node gets a chain.
  const breadcrumb = allNodes ? buildBreadcrumb(node, allNodes) : null;

  return (
    <div className="np">
      <div className="np-head">
        {breadcrumb && breadcrumb.length > 0 && (
          <div
            className="np-breadcrumb"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 4,
              marginBottom: 8,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-1)",
              color: "var(--a-mute)",
              textTransform: "lowercase",
            }}
            title="layer › plane › surface › this node"
          >
            {breadcrumb.map((seg, idx) => (
              <span key={`${seg.label}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {idx > 0 && <span style={{ opacity: 0.4 }}>›</span>}
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: idx === breadcrumb.length - 1 ? "var(--a-accent)" : "var(--a-paper-2)",
                    color: idx === breadcrumb.length - 1 ? "var(--a-page)" : "var(--a-ink-2)",
                    border: "1px solid var(--a-line-2)",
                  }}
                >
                  {seg.label}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="np-head-top">
          <div className="np-head-chips">
            <span className="kind-pill">{node.kind}</span>
            <span className="badge" data-b={node.badge}><span className="dot" />{node.badge}</span>
            <span className="badge" style={{ background: "var(--a-paper-2)", color: "var(--a-mute)" }}>
              <span className="dot" style={{ background: "var(--a-mute)" }} />{node.state}
            </span>
          </div>
          <div className="np-head-actions">
            {!editing && (
              <button className="np-btn np-btn-accent" onClick={startEdit} title="edit intent / state / badge">edit</button>
            )}
            <button className="np-btn" onClick={onClose}>close</button>
          </div>
        </div>
        {!editing ? (
          <>
            <h2 className="np-title">{node.title || node.kind}</h2>
            <div className="np-intent">{node.intent}</div>
            {node.kind === "Project" && node.outcome && (
              <div style={{ marginTop: 8, padding: "8px 12px", background: "color-mix(in srgb, var(--a-accent) 6%, var(--a-paper))", borderLeft: "2px solid var(--a-accent)", fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", fontWeight: 500, color: "var(--a-ink)", fontStyle: "italic" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", letterSpacing: "0.1em", marginBottom: 4, fontStyle: "normal" }}>outcome</div>
                {node.outcome}
              </div>
            )}
            {node.kind === "Milestone" && node.target_date && (
              <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-ink)" }}>
                <span style={{ color: "var(--a-mute)" }}>target ship date · </span>
                <strong>{node.target_date}</strong>
              </div>
            )}
            <div className="np-sub">
              <span>id · <code>{node.id}</code></span>
              {(() => {
                const who = assigneeForState(node.state as ApiNodeState);
                return who ? (
                  <span title="Auto-derived from state. Read-only — pipeline IS the assignee in Phase A.">
                    assignee · <strong>{who}</strong>
                  </span>
                ) : null;
              })()}
              <span>conf · {node.confidence}</span>
              {node.priority && (
                <span>priority · <strong style={{ color: node.priority === "P0-now" ? "var(--sem-red)" : node.priority === "P1-soon" ? "var(--sem-orange)" : "var(--a-ink)" }}>{node.priority}</strong></span>
              )}
              {node.cycle && <span>cycle · <strong>{node.cycle}</strong></span>}
              <span>ring · {node.ring}</span>
              {node.parent_id && <span>parent · <code>{node.parent_id.slice(0, 16)}…</code></span>}
              <span>created · {createdAt}</span>
              {updatedAt !== createdAt && <span>updated · {updatedAt}</span>}
            </div>
          </>
        ) : (
          <div className="np-edit-form">
            <label>title <span className="np-hint">(2 words, ≤ 40 chars)</span></label>
            <input
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              maxLength={40}
              placeholder="e.g. Parse Pipeline"
              className="np-input np-input-title"
            />
            <label>intent</label>
            <textarea
              value={editIntent}
              onChange={e => setEditIntent(e.target.value)}
              rows={3}
              style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: "6px 8px", border: "1px solid var(--a-line)", borderRadius: 3, background: "var(--a-paper)", color: "var(--a-ink)", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                state
                <select value={editState} onChange={e => setEditState(e.target.value as ApiNodeState)} style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", border: "1px solid var(--a-line)", background: "var(--a-paper)", color: "var(--a-ink)", borderRadius: 3 }}>
                  {(["triage","proposed","approved","in-progress","review","done","blocked","archived"] as const).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                badge
                <select value={editBadge} onChange={e => setEditBadge(e.target.value as ApiNodeBadge)} style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", border: "1px solid var(--a-line)", background: "var(--a-paper)", color: "var(--a-ink)", borderRadius: 3 }}>
                  {(["auto","proposed","in-progress","blocked","review","done","drift"] as const).map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                priority
                <select value={editPriority} onChange={e => setEditPriority(e.target.value as ApiPriority)} style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", border: "1px solid var(--a-line)", background: "var(--a-paper)", color: "var(--a-ink)", borderRadius: 3 }}>
                  {(["P0-now","P1-soon","P2-later","P3-backlog"] as const).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                cycle
                <input value={editCycle} onChange={e => setEditCycle(e.target.value)} placeholder="e.g. c1" style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", border: "1px solid var(--a-line)", background: "var(--a-paper)", color: "var(--a-ink)", borderRadius: 3, width: 80 }} />
              </label>
            </div>
            {node.kind === "Project" && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                outcome <span style={{ opacity: 0.6 }}>(one sentence — what "shipped" means for this project)</span>
                <textarea value={editOutcome} onChange={e => setEditOutcome(e.target.value)} rows={2} placeholder="e.g. first real user completes the audit flow" style={{ width: "100%", fontFamily: "var(--font-serif)", fontSize: "var(--t-2)", padding: "6px 8px", border: "1px solid var(--a-line)", borderRadius: 3, background: "var(--a-paper)", color: "var(--a-ink)", resize: "vertical" }} />
              </label>
            )}
            {node.kind === "Milestone" && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                target ship date <span style={{ opacity: 0.6 }}>(YYYY-MM-DD)</span>
                <input type="date" value={editTargetDate} onChange={e => setEditTargetDate(e.target.value)} style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", border: "1px solid var(--a-line)", background: "var(--a-paper)", color: "var(--a-ink)", borderRadius: 3, width: 160 }} />
              </label>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={saveEdit}
                disabled={saving || !editIntent.trim()}
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: "6px 14px", background: "var(--a-accent)", color: "var(--a-paper)", border: "1px solid var(--a-accent)", borderRadius: 3, cursor: saving ? "wait" : "pointer", textTransform: "lowercase" }}
              >{saving ? "saving…" : "save"}</button>
              <button
                onClick={() => { setEditing(false); setSaveError(null); }}
                disabled={saving}
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: "6px 14px", background: "transparent", color: "var(--a-mute)", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", textTransform: "lowercase" }}
              >cancel</button>
            </div>
            {saveError && <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>{saveError}</div>}
          </div>
        )}
      </div>
      <div className="np-body">
        {/* Surface impact banner — shown when this node touches a Surface that
            was edited/retired. Backend writes the entries during the cascade
            (see canvas.ts cascadeSurfaceEdit); we read them off `detail.discussions`
            and render the latest few. Clicking "acknowledge" clears the drift
            badge so the founder can move on once they've reviewed. Doesn't
            unblock retired-Surface nodes — they wait for re-placement. */}
        <SurfaceImpactBanner
          node={node}
          detail={detail}
          baseUrl={baseUrl}
          project={project}
          onAcknowledged={onUpdated}
        />

        {/* Implementer surface — first thing in the panel so the founder
            can run / approve / reject without scrolling past plan.md.
            (Canvas.tsx renders its own NodeDrawer, separate from
            views/NodeDetail.tsx; the same ImplementerCard component lives
            in both surfaces.) */}
        <ImplementerCard
          baseUrl={baseUrl}
          project={project}
          nodeId={node.id}
          nodeState={node.state}
          onStateChanged={onUpdated}
        />

        {/*
          Project nodes are a brief view, not runnable work. They hold
          framing — outcome, layer, target ship date, parent counts — and
          point at the Planes/Surfaces/Tasks where actual work lives.
          Hiding the plan-editor here removes the suggestion that a Project
          has Acceptance / Planned-artifacts (those concepts only make
          sense for a Task).
        */}
        {node.kind === "Project" ? (
          <ProjectBriefView node={node} graph={allNodes ?? []} />
        ) : (
          <>
            <div className="np-section np-section-withaction">
              <span>plan.md</span>
              {!editingPlan && !loading && (
                <button className="np-btn np-btn-small" onClick={startEditPlan}>edit</button>
              )}
            </div>
            {loading && <div className="ph-empty">loading…</div>}
            {!loading && editingPlan ? (
              <div className="np-plan-editor">
                <textarea
                  value={planDraft}
                  onChange={e => setPlanDraft(e.target.value)}
                  rows={16}
                  spellCheck={false}
                  className="np-plan-textarea"
                  placeholder={"# Plan: …\n\n## Intent\n…\n\n## Non-goals\n…\n\n## Acceptance\n…\n\n## Dependencies\n…\n\n## Budget\n…\n\n## Planned artifacts\n…"}
                />
                <div className="np-plan-editor-foot">
                  <span className="np-hint">{planDraft.length} chars · markdown renders in view mode</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="np-btn np-btn-accent" onClick={savePlan} disabled={savingPlan}>
                      {savingPlan ? "saving…" : "save plan"}
                    </button>
                    <button className="np-btn" onClick={() => setEditingPlan(false)} disabled={savingPlan}>cancel</button>
                  </div>
                </div>
                {planError && <div className="np-error">{planError}</div>}
              </div>
            ) : !loading && detail?.plan?.trim() ? (
              <MdMini src={detail.plan} />
            ) : !loading ? (
              <div className="ph-empty">
                <div>no plan.md yet</div>
                <button className="np-btn np-btn-accent" style={{ marginTop: 10 }} onClick={startEditPlan}>write one</button>
              </div>
            ) : null}
          </>
        )}

        <div className="np-section">dependencies</div>
        {node.dependencies && node.dependencies.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {node.dependencies.map(d => (
              <li key={d} style={{ padding: "4px 0", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)" }}>
                → <code>{d}</code>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ph-empty">none</div>
        )}

        {/* Canvas reframe (2026-05-04): three new founder/cofounder surfaces.
            Replaces the static discussion file-list placeholder. */}
        <DrawerDiscussionFlag node={node} baseUrl={baseUrl} project={project} onSaved={onUpdated} />
        {/* Consultation (Pillar B — off-platform expert tracking, Session 4).
            Only on Consultation kind. The disclosure is open-by-default when
            the answer is empty so the founder sees the form first. Saving with
            a non-empty answer triggers the brain-ripple on the backend. */}
        {node.kind === "Consultation" && (
          <DrawerConsultation
            node={node}
            baseUrl={baseUrl}
            project={project}
            onSaved={() => { onUpdated?.(); setCommentsRefreshKey(k => k + 1); }}
          />
        )}
        {/* Researcher (Pillar A — world-grounding). Only on Decision / Risk /
            Research kinds. The disclosure sits between discussion and
            comments; results land as comments below, no separate history UI. */}
        {(node.kind === "Decision" || node.kind === "Risk" || node.kind === "Research") && (
          <DrawerResearcher
            node={node}
            baseUrl={baseUrl}
            project={project}
            onCompleted={() => setCommentsRefreshKey(k => k + 1)}
          />
        )}
        {/* Ripple awareness (Session 5, TODO #30). Only on Task / Subtask
            kinds AND only when the node has a non-empty `touches` set. The
            disclosure surfaces co-change neighbours of files in the plan's
            "Planned artifacts". Default-collapsed; founder opens when they
            care. No-op / silent when ripple has no signal. */}
        {(node.kind === "Task" || node.kind === "Subtask") && (node.touches?.length ?? 0) > 0 && (
          <DrawerRipple
            node={node}
            baseUrl={baseUrl}
            project={project}
          />
        )}
        <DrawerComments baseUrl={baseUrl} project={project} nodeId={node.id} refreshKey={commentsRefreshKey} />
        <DrawerActivity baseUrl={baseUrl} project={project} nodeId={node.id} />

        <div className="np-section np-section-danger">danger zone</div>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
              padding: "8px 14px",
              background: "transparent",
              color: "var(--sem-red)",
              border: "1px solid var(--sem-red)",
              borderRadius: "var(--radius-2)",
              cursor: "pointer",
              textTransform: "lowercase",
            }}
          >
            delete this node
          </button>
        ) : (
          <div style={{ padding: 12, background: "var(--a-paper-2)", border: "1px solid var(--sem-red)", borderRadius: "var(--radius-2)" }}>
            <div style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", marginBottom: 8 }}>
              Delete <strong>{node.kind}</strong> · <em>{node.intent.slice(0, 60)}{node.intent.length > 60 ? "…" : ""}</em>?
              <br />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
                Removes meta.json + plan.md + discussions, and any edges connected to this node.
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                  padding: "6px 14px",
                  background: "var(--sem-red)",
                  color: "var(--a-paper)",
                  border: "1px solid var(--sem-red)",
                  borderRadius: "var(--radius-2)",
                  cursor: deleting ? "wait" : "pointer",
                  textTransform: "lowercase",
                }}
              >
                {deleting ? "deleting…" : "yes, delete"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                  padding: "6px 14px",
                  background: "transparent",
                  color: "var(--a-ink)",
                  border: "1px solid var(--a-line)",
                  borderRadius: "var(--radius-2)",
                  cursor: "pointer",
                  textTransform: "lowercase",
                }}
              >
                cancel
              </button>
            </div>
            {deleteError && <div style={{ marginTop: 8, color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>{deleteError}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// Kanban view — columns by workflow STATE (not ring). Cards are draggable
// between columns; drop triggers a state transition via onStateChange.
// "review" folds into Done with a "needs accept" banner (per DECISIONS.md §1).
// "archived" (and legacy "abandoned") render in a hidden Archive column behind
// a "show archive" toggle.
function KanbanView({ nodes, hovered, setHovered, selected, onNodeClick, onStateChange, onClearFocus, onCreateInColumn }: {
  nodes: CanvasNode[];
  hovered: string | null;
  setHovered: (id: string | null) => void;
  selected: string | null;
  onNodeClick: (id: string) => void;
  onStateChange: (id: string, newState: ApiNodeState) => void;
  onClearFocus: () => void;
  onCreateInColumn: (state: ApiNodeState) => void;
}) {
  const [dragOverCol, setDragOverCol] = useState<ApiNodeState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Canvas reframe (decisions §1): kanban-shaped semantic columns.
  // proposed + approved merge into "Up Next"; in-progress alone is "Now";
  // review folds into Done with a "needs accept" banner; archived (+ legacy
  // abandoned) live in an optional Archive column toggled via showArchive.
  const [showArchive, setShowArchive] = useState(false);
  // Session 4 (Pillar B — Consultations). The cofounder column lists pending
  // off-platform expert questions. Special key "consultations" identifies it
  // as the non-state column — drag-drop targets compare via `match`, but this
  // column has empty match so drops short-circuit (no state transition).
  type KanbanColKey = ApiNodeState | "consultations";
  const baseCols: Array<{ key: KanbanColKey; label: string; sub: string; match: ApiNodeState[] }> = [
    { key: "triage" as ApiNodeState, label: "triage",   sub: "rough ideas",            match: ["triage" as ApiNodeState] },
    { key: "approved",    label: "up next",     sub: "ready to work",          match: ["proposed", "approved"] },
    { key: "in-progress", label: "now",         sub: "being built",            match: ["in-progress"] },
    { key: "blocked",     label: "blocked",     sub: "stuck · needs help",     match: ["blocked"] },
    { key: "done",        label: "done",        sub: "shipped + needs accept", match: ["review", "done"] },
  ];
  // Cofounder column rendered ONLY when ≥1 Consultation exists. We don't
  // pollute the kanban for solo founders who haven't asked an expert yet.
  // Drafter can't propose Consultations autonomously, so this stays hidden
  // until the founder creates one (or Fixer surrender suggests one and the
  // founder accepts).
  const hasConsultations = nodes.some(n => n.kind === "Consultation");
  const cofounderCol: { key: KanbanColKey; label: string; sub: string; match: ApiNodeState[] } = {
    key: "consultations",
    label: "cofounder",
    sub: "expert · awaiting answer",
    match: [],
  };
  const archiveCol = {
    key: "archived" as ApiNodeState,
    label: "archive",
    sub: "out of sight",
    match: ["archived" as ApiNodeState, "abandoned" as ApiNodeState],
  };
  const cols: Array<{ key: KanbanColKey; label: string; sub: string; match: ApiNodeState[] }> = [
    ...baseCols,
    ...(hasConsultations ? [cofounderCol] : []),
    ...(showArchive ? [archiveCol] : []),
  ];

  function onBgClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest(".kan-card")) return;
    onClearFocus();
  }

  function handleDragStart(e: React.DragEvent, id: string, fromState: ApiNodeState) {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.setData("application/x-from-state", fromState);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  }
  function handleDragEnd() {
    setDraggingId(null);
    setDragOverCol(null);
  }
  function handleDragOver(e: React.DragEvent, col: KanbanColKey) {
    if (col === "consultations") return; // cofounder col doesn't accept drops
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== col) setDragOverCol(col as ApiNodeState);
  }
  function handleDragLeave(e: React.DragEvent) {
    // only clear when leaving the column entirely, not on inner-element crossings
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as Element).contains(related)) {
      setDragOverCol(null);
    }
  }
  function handleDrop(e: React.DragEvent, col: KanbanColKey) {
    if (col === "consultations") return; // cofounder col doesn't accept drops
    e.preventDefault();
    setDragOverCol(null);
    setDraggingId(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    // No-op if dropping into the same column as current state.
    if (cols.find(c => c.key === col)?.match.includes(node.state as ApiNodeState)) return;
    onStateChange(id, col as ApiNodeState);
  }

  return (
    <div
      onClick={onBgClick}
      style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "10px 20px 0 20px",
        }}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowArchive(v => !v); }}
          title="Toggle the Archive column (out-of-sight nodes)"
          style={{
            fontFamily: "var(--font-mono)", fontSize: "0.72rem",
            padding: "3px 10px", borderRadius: 3,
            background: showArchive ? "var(--a-paper-2)" : "transparent",
            color: "var(--a-mute)", border: "1px solid var(--a-line)",
            cursor: "pointer", textTransform: "lowercase",
          }}
        >{showArchive ? "hide archive" : "show archive"}</button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`,
          gap: 14,
          padding: 20,
          flex: 1,
          alignItems: "start",
        }}
      >
      {cols.map(col => {
        // Work tab filter: only Task/Subtask are runnable; framing nodes
        // (Project/Plane/Surface/Decision/Risk/Story/Epic/Milestone) live on
        // the Plan view and don't progress through states.
        // Session 4: the "cofounder" column lists Consultations whose answer
        // is still empty. State doesn't apply; we filter on kind + answer.
        const colNodes = col.key === "consultations"
          ? nodes.filter(n => n.kind === "Consultation" && (!n.answer || n.answer.trim() === ""))
          : nodes.filter(n =>
              (n.kind === "Task" || n.kind === "Subtask") &&
              col.match.includes(n.state as ApiNodeState)
            );
        const isCofounder = col.key === "consultations";
        const isOver = !isCofounder && dragOverCol === (col.key as ApiNodeState);
        return (
          <div
            key={col.key}
            className={`kan-col-v2 kan-col-${col.key}${isOver ? " drag-over" : ""}`}
            onDragOver={e => handleDragOver(e, col.key)}
            onDragLeave={handleDragLeave}
            onDrop={e => handleDrop(e, col.key)}
          >
            <div className="kan-col-head" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="kan-col-label">{col.label}</div>
                <div className="kan-col-sub">{col.sub}</div>
              </div>
              <span className="kan-col-count">{colNodes.length}</span>
              {!isCofounder && (
                <button
                  type="button"
                  className="kan-col-add"
                  title={`Create a Task in ${col.label}`}
                  onClick={(e) => { e.stopPropagation(); onCreateInColumn(col.key as ApiNodeState); }}
                  style={{
                    width: 22, height: 22, borderRadius: 4,
                    background: "transparent", color: "var(--a-mute)",
                    border: "1px solid var(--a-line)", cursor: "pointer",
                    fontFamily: "var(--font-mono)", fontSize: "0.85rem", lineHeight: 1,
                    padding: 0,
                  }}
                >+</button>
              )}
            </div>
            <div className="kan-col-body" style={{ overflowY: "auto", paddingRight: 2 }}>
              {colNodes.length === 0 && (
                isCofounder ? (
                  <div className="kan-col-empty" style={{ fontStyle: "italic", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
                    no pending consultations. when you ask an expert, create a consultation node here to track the answer.
                  </div>
                ) : (
                  <div className="kan-col-empty">— no {col.label} —</div>
                )
              )}
              {colNodes.map(n => {
                const isSel = selected === n.id;
                const isHover = hovered === n.id;
                const isDragging = draggingId === n.id;
                // Cofounder column renders Consultation cards with a different
                // face: kind chip "consultation", expert role strong, question
                // truncated to 80, deadline chip (orange if past, gray else).
                if (isCofounder && n.kind === "Consultation") {
                  const deadline = n.deadline ?? null;
                  let deadlinePast = false;
                  if (deadline) {
                    try { deadlinePast = new Date(deadline) < new Date(new Date().toDateString()); }
                    catch { deadlinePast = false; }
                  }
                  const q = n.question ?? n.intent ?? "";
                  return (
                    <div
                      key={n.id}
                      className={`kan-card${isSel ? " selected" : ""}${isHover ? " hovered" : ""}`}
                      data-b={n.badge}
                      data-runnable="0"
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => onNodeClick(n.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="kan-card-head">
                        <span className="kan-card-kind" style={{ color: "var(--sem-purple)" }}>consultation</span>
                      </div>
                      <div className="kan-card-title" style={{ fontWeight: 600 }}>
                        {n.expert_role || n.title || "(unspecified expert)"}
                      </div>
                      <div className="kan-card-intent" style={{ color: "var(--a-ink)" }}>
                        {q.slice(0, 80)}{q.length > 80 ? "…" : ""}
                      </div>
                      <div className="kan-card-meta">
                        {n.channel && (
                          <span style={{ padding: "1px 6px", borderRadius: 3, background: "var(--a-paper-2)", color: "var(--a-mute)" }}>
                            via {n.channel}
                          </span>
                        )}
                        {deadline && (
                          <span style={{
                            padding: "1px 6px", borderRadius: 3,
                            background: deadlinePast
                              ? "color-mix(in srgb, var(--sem-orange) 14%, transparent)"
                              : "var(--a-paper-2)",
                            color: deadlinePast ? "var(--sem-orange)" : "var(--a-mute)",
                          }}>
                            {deadlinePast ? "overdue · " : "due "}{deadline}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={n.id}
                    className={`kan-card${isSel ? " selected" : ""}${isHover ? " hovered" : ""}${isDragging ? " dragging" : ""}`}
                    data-b={n.badge}
                    data-demoted={isDemotedKind(n.kind) ? "1" : "0"}
                    data-runnable={RUNNABLE_KINDS.has(n.kind) ? "1" : "0"}
                    data-placeholder={n.placeholder ? "1" : "0"}
                    draggable
                    onDragStart={e => handleDragStart(e, n.id, n.state as ApiNodeState)}
                    onDragEnd={handleDragEnd}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => onNodeClick(n.id)}
                  >
                    <div className="kan-card-head">
                      <span className="kan-card-kind">{n.kind}</span>
                      {n.placeholder && (
                        <span
                          className="placeholder-pill"
                          title="Placeholder — Drafter renames or replaces this slot"
                        >slot</span>
                      )}
                      {(() => {
                        const who = assigneeForState(n.state as ApiNodeState);
                        return who ? (
                          <span
                            title={`Auto-derived assignee for state="${n.state}"`}
                            style={{
                              marginLeft: "auto", padding: "1px 6px", borderRadius: 3,
                              fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                              letterSpacing: "0.04em", textTransform: "lowercase",
                              background: "transparent", color: "var(--a-mute)",
                              border: "1px solid var(--a-line)", whiteSpace: "nowrap",
                            }}
                          >→ {who}</span>
                        ) : null;
                      })()}
                    </div>
                    <div className="kan-card-title">{n.title || n.kind}</div>
                    <div className="kan-card-intent">{n.intent}</div>
                    {n.state === "review" && (
                      <div style={{
                        marginTop: 4, padding: "2px 6px", borderRadius: 3,
                        background: "color-mix(in srgb, var(--sem-orange) 14%, transparent)",
                        color: "var(--sem-orange)", fontFamily: "var(--font-mono)",
                        fontSize: "0.7rem", letterSpacing: "0.02em",
                      }}>needs accept</div>
                    )}
                    {n.mark_for_discussion && (
                      <div style={{
                        marginTop: 4, padding: "2px 6px", borderRadius: 3,
                        background: "color-mix(in srgb, var(--sem-blue) 12%, transparent)",
                        color: "var(--sem-blue)", fontFamily: "var(--font-mono)",
                        fontSize: "0.7rem", letterSpacing: "0.02em",
                      }}>💬 mark for discussion</div>
                    )}
                    <div className="kan-card-meta">
                      {n.priority && (
                        <span style={{
                          padding: "1px 6px",
                          borderRadius: 3,
                          fontWeight: 600,
                          background: n.priority === "P0-now" ? "color-mix(in srgb, var(--sem-red) 14%, transparent)" : n.priority === "P1-soon" ? "color-mix(in srgb, var(--sem-orange) 14%, transparent)" : "var(--a-paper-2)",
                          color: n.priority === "P0-now" ? "var(--sem-red)" : n.priority === "P1-soon" ? "var(--sem-orange)" : n.priority === "P2-later" ? "var(--a-mute)" : "var(--a-faint, var(--a-mute-2))",
                        }}>{n.priority.split("-")[0]}</span>
                      )}
                      {n.cycle && <span style={{ padding: "1px 6px", borderRadius: 3, background: "var(--a-paper-2)" }}>{n.cycle}</span>}
                      <span>conf · {n.confidence}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function RadialView({ nodes, edges, hovered, setHovered, selected, onNodeClick, onClearFocus }: {
  nodes: CanvasNode[];
  edges: Edge[];
  hovered: string | null;
  setHovered: (id: string | null) => void;
  selected: string | null;       // = pinned; drives accent border
  onNodeClick: (id: string) => void;
  onClearFocus: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    function fit() { if (!wrapRef.current) return; const r = wrapRef.current.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); }
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;

  const pos = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    const cx = w / 2, cy = h / 2;
    const R = { 0:{rx:0,ry:0}, 1:{rx:w*.45*.22,ry:h*.40*.30}, 2:{rx:w*.45*.52,ry:h*.40*.62}, 3:{rx:w*.45*.88,ry:h*.40*.92} };
    nodes.forEach(n => {
      if (n.ring === 0) { out[n.id] = { x: cx, y: cy }; return; }
      const ring = R[n.ring as keyof typeof R] ?? R[3];
      const a = (n.angle ?? 0) * Math.PI / 180;
      out[n.id] = { x: cx + ring.rx * Math.cos(a - Math.PI / 2), y: cy + ring.ry * Math.sin(a - Math.PI / 2) };
    });
    return out;
  }, [nodes, w, h]);

  const wasDrag = useRef(false);
  function onDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest(".kg-node,.n-card-inner,.n-card-pop,.n-expand")) return;
    wasDrag.current = false;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (!wasDrag.current && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) wasDrag.current = true;
    setView(v => ({ ...v, x: drag.current!.vx + dx, y: drag.current!.vy + dy }));
  }
  function onUp() { drag.current = null; }
  function onBackgroundClick(e: React.MouseEvent) {
    // Ignore if the click ended a pan drag (mouse moved meaningfully between down/up)
    if (wasDrag.current) { wasDrag.current = false; return; }
    // Ignore if click originated inside a node or its interactive children
    if ((e.target as HTMLElement).closest(".kg-node,.kg-controls,.kg-hint")) return;
    onClearFocus();
  }
  function onWheel(e: React.WheelEvent) { if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 20) return; e.preventDefault(); setView(v => ({ ...v, k: Math.max(0.4, Math.min(2.2, v.k * (e.deltaY > 0 ? 0.92 : 1.08))) })); }
  function zoom(d: number) { setView(v => ({ ...v, k: Math.max(0.4, Math.min(2.2, v.k * d)) })); }

  const ringGuides = [
    { r:1, lbl:"themes",  rx:w*.45*.22, ry:h*.40*.30 },
    { r:2, lbl:"stories", rx:w*.45*.52, ry:h*.40*.62 },
    { r:3, lbl:"tasks",   rx:w*.45*.88, ry:h*.40*.92 },
  ];

  return (
    <div ref={wrapRef} className="kg-wrap" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel} onClick={onBackgroundClick}
      style={{ position:"absolute", inset:0, cursor:drag.current ? "grabbing" : "grab", overflow:"hidden" }}>
      <div className="kg-stage" style={{ transform:`translate(${view.x}px,${view.y}px) scale(${view.k})`, transformOrigin:"0 0", width:w, height:h, position:"absolute" }}>
        {ringGuides.map(({ r, lbl, rx, ry }) => (
          <div key={r}>
            <div className="ring-guide" style={{ left:w/2, top:h/2, width:rx*2, height:ry*2, transform:"translate(-50%,-50%)" }} />
            <div className="ring-label" style={{ left:w/2+rx+6, top:h/2-8 }}>{lbl}</div>
          </div>
        ))}
        <svg className="edge-layer" width={w} height={h} style={{ position:"absolute", left:0, top:0, overflow:"visible", pointerEvents:"none" }}>
          <defs>
            {/* All markers muted to match default edge color. Hot edges convey
                emphasis via stroke + opacity, not marker color, so highlighted
                arrows don't shout when nothing is selected. */}
            {["arr-parent","arr-depends","arr-blocks","arr-produces"].map(id => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--a-line-2)" />
              </marker>
            ))}
          </defs>
          {edges.map((e, i) => {
            const a = pos[e.from], b = pos[e.to]; if (!a || !b) return null;
            const dx = b.x-a.x, dy = b.y-a.y, mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
            const c = e.kind === "parent-child" ? 0.08 : 0.18;
            const d = `M${a.x},${a.y} Q${mx-dy*c},${my+dx*c} ${b.x},${b.y}`;
            // Hot if either endpoint is selected OR being hovered. Selection
            // sticks; hover is a transient preview.
            const focusId = selected ?? hovered;
            const isHot = !!focusId && (e.from === focusId || e.to === focusId);
            const mk = e.kind==="depends-on"?"depends":e.kind==="blocks"?"blocks":e.kind==="produces"?"produces":"parent";
            return <path key={i} className={`edge${isHot?" hot":""}`} data-k={e.kind} d={d} markerEnd={`url(#arr-${mk})`} />;
          })}
        </svg>
        {nodes.map(n => {
          const p = pos[n.id]; if (!p) return null;
          const isSel = selected === n.id;      // pinned
          const isHover = hovered === n.id;
          const showLabel = isHover || isSel;
          // Keep .collapsed className — it's what the existing CSS sizes and
          // colors the dot with. We just drop the old .cube-peek / .n-card-inner
          // children; hover info now lives in the Canvas header, not per-node.
          return (
            <div
              key={n.id}
              className={`kg-node collapsed${n.pulse ? " pulse" : ""}${isSel ? " pinned" : ""}${isHover ? " hovered" : ""}`}
              data-ring={n.ring}
              data-b={n.badge}
              style={{ left: p.x, top: p.y }}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={e => { e.stopPropagation(); onNodeClick(n.id); }}
            >
              <span className="cube-dot" />
              {showLabel && (
                <div className="kg-name-label">
                  {n.title || n.kind}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="kg-controls">
        <button onClick={() => zoom(1.15)}>+</button>
        <button onClick={() => zoom(0.87)}>−</button>
        <button onClick={() => setView({ x:0, y:0, k:1 })}>reset</button>
        <span className="zoom-readout">{Math.round(view.k*100)}%</span>
      </div>
      <div className="kg-hint">drag to pan · scroll to zoom · click cube → card · click again → details</div>
    </div>
  );
}

interface Props { project: string; baseUrl: string; layout: "shape" | "radial" | "kanban" | "activity"; initialSelectedId?: string | null; }

type ViewTab = "build" | "decisions" | "risks" | "discovery" | "docs";

interface TabDef {
  key: ViewTab;
  label: string;
  kinds: CanvasNode["kind"][];
}

const VIEW_TABS: readonly TabDef[] = [
  // "Build" surfaces the runnable spine plus the structural anchors that
  // contain it. Story/Epic appear here as containers (their child Tasks
  // are the work); they're rendered demoted (dashed border, italic kind
  // label) per A2-Option-A. Theme/Track/Module are deprecated back-compat
  // aliases — visible only when localStorage `atelier.canvas.showDeprecated=1`.
  { key: "build",      label: "build",      kinds: ["Project", "Plane", "Surface", "Story", "Epic", "Task", "Subtask", "Milestone"] },
  { key: "decisions",  label: "decisions",  kinds: ["Decision"] },
  { key: "risks",      label: "risks",      kinds: ["Risk"] },
  { key: "discovery",  label: "discovery",  kinds: ["Research"] },
  { key: "docs",       label: "docs",       kinds: ["Artifact"] },
];

// Kinds the Implementer can actually run. Per A2: Epic/Story are not
// executable — they are containers. Their state rolls up from child Tasks
// (see auto-rollup in canvas.updateState).
const RUNNABLE_KINDS = new Set(["Task", "Subtask"]);
function isDemotedKind(kind: string): boolean {
  return !RUNNABLE_KINDS.has(kind);
}

const PANEL_MIN_W = 320;
const PANEL_MAX_VW = 0.6; // don't let the panel eat more than 60% of viewport width

export function Canvas({ project, baseUrl, layout, initialSelectedId }: Props) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // selected = the pinned node (shown in header); expanded = right panel open; hovered = transient preview
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
  const [expanded, setExpanded] = useState<string | null>(initialSelectedId ?? null);
  const [hovered, setHovered] = useState<string | null>(null);
  // Inline + new task modal (Canvas reframe 2026-05-04, decisions §6).
  // Open with the column's state; user picks kind + parent.
  const [createModal, setCreateModal] = useState<{ state: ApiNodeState } | null>(null);
  // Plan sub-view (decisions §5): Tree default, Radial as the connectome,
  // 3D placeholder for a future spatial view. Persisted across reloads.
  const [planSub, setPlanSub] = useState<"tree" | "radial" | "3d">(() => {
    const saved = localStorage.getItem("atelier.canvas.planSub");
    return saved === "tree" || saved === "radial" || saved === "3d" ? saved : "tree";
  });
  useEffect(() => { localStorage.setItem("atelier.canvas.planSub", planSub); }, [planSub]);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("atelier.canvas.panelWidth"));
    return Number.isFinite(saved) && saved >= PANEL_MIN_W ? saved : 460;
  });

  // View tabs — one Canvas graph underneath, five filtered surfaces on top.
  // Persists across page reloads so the founder keeps their context.
  // viewTab persists only as a no-op compat shim after the kind-facet tabbar
  // retired on the Plan-tab redesign (2026-05-05). Default "build" exposes
  // every kind to the empty-state copy + KanbanView's secondary filter.
  const [viewTab] = useState<ViewTab>("build");

  // When the tab changes, if the pinned node is no longer in the new tab's
  // filter (e.g. switched from Build → Decisions while a Task was pinned),
  // clear focus. Avoids the "panel shows a hidden-from-this-tab node" bug.
  useEffect(() => {
    const activeKinds = (VIEW_TABS.find(t => t.key === viewTab) ?? VIEW_TABS[0]).kinds;
    if (selected) {
      const sel = (graph?.nodes ?? []).find(n => n.id === selected);
      if (sel && !activeKinds.includes(sel.kind)) {
        setSelected(null);
        setExpanded(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewTab]);

  // Click a node: first click pins (shows in header); click same node again
  // opens the right detail panel. Click a different node while pinned:
  //   - if panel is OPEN, swap selected + expanded to the new node (so the
  //     panel always reflects the latest click; previously this was a 2-click
  //     bug — pin first, click again to open).
  //   - if panel is CLOSED, pin only (founder is just navigating; explicit
  //     second click opens detail).
  const onNodeClick = useCallback((id: string) => {
    if (selected === id) {
      setExpanded(id);
    } else {
      setSelected(id);
      setExpanded(prev => (prev !== null ? id : null));
    }
  }, [selected]);

  const clearFocus = useCallback(() => {
    setSelected(null);
    setExpanded(null);
    setHovered(null);
  }, []);

  // Kanban drag-drop: change a node's state via PATCH, then refetch the graph
  // so the card relocates on the next poll/frame.
  const onStateChange = useCallback(async (id: string, newState: ApiNodeState) => {
    try {
      await updateNode(baseUrl, project, id, { state: newState });
      fetchGraphRef.current?.();
    } catch (e) {
      console.error("[kanban] state change failed:", e);
    }
  }, [baseUrl, project]);

  // fetchGraph is defined below via useCallback; hold a ref so onStateChange
  // (declared earlier in the component) can call the latest version.
  const fetchGraphRef = useRef<(() => void) | null>(null);

  // Esc: close panel first, then unpin on subsequent press.
  useEffect(() => {
    if (!selected && !expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (expanded) setExpanded(null);
      else if (selected) setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, expanded]);

  // Track initialSelectedId changes — when Now dispatches "open in canvas" for
  // a specific node, we want to pop it open on mount *and* subsequent rehits.
  useEffect(() => {
    if (initialSelectedId) {
      setSelected(initialSelectedId);
      setExpanded(initialSelectedId);
    }
  }, [initialSelectedId]);

  // First landing on Canvas with nothing pre-selected → auto-open the root
  // project node so founders see context immediately. One-shot: if they close
  // it, we don't reopen on poll or on revisit within the same mount.
  const didAutoOpenRef = useRef(false);
  useEffect(() => {
    if (didAutoOpenRef.current) return;
    if (initialSelectedId) { didAutoOpenRef.current = true; return; }
    if (!graph?.nodes?.length) return;
    const root =
      graph.nodes.find(n => n.parent_id === null && n.kind === "Project") ??
      graph.nodes.find(n => n.parent_id === null) ??
      graph.nodes[0];
    if (!root) return;
    didAutoOpenRef.current = true;
    setSelected(root.id);
    setExpanded(root.id);
  }, [graph, initialSelectedId]);

  // Drag-to-resize the right-side panel. Dragging the divider left widens the
  // panel; right narrows it. Pushes the graph (does not overlay it).
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    function move(ev: MouseEvent) {
      const maxW = window.innerWidth * PANEL_MAX_VW;
      const next = Math.max(PANEL_MIN_W, Math.min(maxW, startW + (startX - ev.clientX)));
      setPanelWidth(next);
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      // Persist on release, not during drag — avoids thrashing localStorage.
      setPanelWidth(w => { localStorage.setItem("atelier.canvas.panelWidth", String(w)); return w; });
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [panelWidth]);

  // Polling note: every 4s we refetch graph. Two traps we avoid here:
  //   1. `setLoading(true)` on each poll replaces the mounted canvas with the
  //      "loading canvas…" placeholder for the duration of the fetch — that's
  //      the visible flicker/layout-reset every few seconds. Only set loading
  //      on the first fetch; on polls, stay mounted and just swap data.
  //   2. `setGraph(data)` with a fresh object every poll invalidates the
  //      `canvasNodes` useMemo (ring/angle recompute) and the downstream
  //      radial layout even when the graph hasn't changed. Compare a cheap
  //      structural hash and skip the setState if the graph is identical.
  const graphHashRef = useRef<string>("");
  const fetchGraph = useCallback(() => {
    fetch(`${baseUrl}/canvas/graph?project=${encodeURIComponent(project)}`)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(data => {
        const hash = JSON.stringify(data);
        if (hash !== graphHashRef.current) {
          graphHashRef.current = hash;
          setGraph(data);
        }
        setError(null);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [baseUrl, project]);

  useEffect(() => {
    fetchGraph();
    // Poll while the full Canvas is focused so nodes Claude creates mid-session
    // appear here too (same cadence as LiveGraph in Now)
    const poll = setInterval(fetchGraph, 4000);
    return () => clearInterval(poll);
  }, [fetchGraph]);

  // Keep the ref current so onStateChange (declared earlier) can call the
  // latest fetchGraph to refresh cards immediately after a drop.
  useEffect(() => { fetchGraphRef.current = fetchGraph; }, [fetchGraph]);

  const canvasNodes: CanvasNode[] = useMemo(() => {
    if (!graph?.nodes) return [];
    const ra = computeRingsAngles(graph.nodes);
    const now = Date.now();
    return graph.nodes.map(n => {
      const r = ra.get(n.id) ?? { ring: 3, angle: 0 };
      const updatedMs = n.updated_at ? new Date(n.updated_at).getTime() : 0;
      const pulse = updatedMs > 0 && (now - updatedMs) < 30_000;
      return { ...n, ...r, pulse };
    });
  }, [graph]);

  const edges: Edge[] = graph?.edges ?? [];

  // viewTab is locked to "build"; the per-layout components (KanbanView,
  // PlanTreeView) consume canvasNodes directly and do their own kind-filtering.
  // The old activeTab/filteredNodes derivations were retired when the kind-tab
  // empty-state was removed (Consultation-only graphs were being hidden).

  const expandedNode = expanded ? canvasNodes.find(n => n.id === expanded) ?? null : null;

  if (loading) return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", color:"var(--a-mute)", textTransform:"lowercase" }}>loading canvas…</div>;
  if (error) return <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:12, fontFamily:"var(--font-mono)", fontSize:"var(--t-2)" }}><span style={{ color:"var(--sem-red)" }}>canvas error · {error}</span><button onClick={fetchGraph} style={{ cursor:"pointer" }}>retry</button></div>;
  if (!canvasNodes.length) return (
    // Empty-state CTA: name what's missing, what creates a node, and link to that surface.
    // The drafter is the only thing that proposes nodes today, and you talk to it from /now.
    <div style={{ display:"flex", flexDirection: "column", alignItems:"center", justifyContent:"center", height:"100%", gap: 14, padding: 32, textAlign: "center" }}>
      <div style={{ fontFamily:"var(--font-mono)", fontSize:"var(--t-3)", color:"var(--a-ink)", textTransform:"lowercase" }}>
        no canvas nodes yet.
      </div>
      <div style={{ fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", color:"var(--a-mute)", textTransform:"lowercase", maxWidth: 460, lineHeight: 1.6 }}>
        canvas nodes are the agent's plan — one node per discrete piece of work. the drafter creates them when you talk to it in a session.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => navigate("/now")}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", padding: "8px 16px", background: "var(--a-accent)", border: "1px solid var(--a-accent)", borderRadius: 3, color: "var(--a-paper)", cursor: "pointer" }}
        >start a session</button>
        <button
          type="button"
          onClick={() => navigate("/brain")}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", padding: "8px 16px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, color: "var(--a-ink)", cursor: "pointer" }}
        >view brain</button>
      </div>
    </div>
  );

  // Header peek content — pinned takes priority over hover so clicking doesn't
  // flicker when the cursor drifts. Derived on every render; no extra state.
  const focusId = selected ?? hovered;
  const focusNode = focusId ? canvasNodes.find(n => n.id === focusId) ?? null : null;
  const focusIsPinned = !!selected && focusId === selected;

  return (
    <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column" }}>
      <div style={{ flex:"0 0 auto", padding:"18px 28px 14px", borderBottom:"1px solid var(--a-line)", background:"var(--a-page)", display:"flex", alignItems:"flex-end", gap:28, zIndex:2 }}>
        <div style={{ flex: "0 0 auto", maxWidth: 320 }}>
          <div className="micro">{project} · knowledge graph</div>
          <h2 style={{ margin:"4px 0 0", fontFamily:"var(--font-serif)", fontWeight:600, letterSpacing:"-0.02em", fontSize:"var(--t-5)", lineHeight: 1.2 }}>The project, as we understand it today</h2>
        </div>
        <div className="canvas-header-peek" style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 4, alignSelf: "stretch", justifyContent: "flex-end", paddingLeft: 20, borderLeft: "1px solid var(--a-line)" }}>
          {focusNode ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                <span>{focusNode.kind.toLowerCase()}</span>
                <span style={{ color: "var(--a-line-2)" }}>·</span>
                <span className="badge" data-b={focusNode.badge}><span className="dot" />{focusNode.badge}</span>
                <span style={{ color: "var(--a-line-2)" }}>·</span>
                <span>{focusNode.state}</span>
                <span style={{ color: "var(--a-line-2)" }}>·</span>
                <span>conf · {focusNode.confidence}</span>
                {focusIsPinned && (
                  <span style={{ color: "var(--a-accent)", marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>● pinned</span>
                )}
                <span style={{ flex: 1 }} />
                {focusIsPinned && (
                  <button
                    onClick={() => setExpanded(focusNode.id)}
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "3px 10px", border: "1px solid var(--a-accent)", borderRadius: 3, background: "transparent", color: "var(--a-accent)", cursor: "pointer", textTransform: "lowercase" }}
                  >
                    open detailed view →
                  </button>
                )}
              </div>
              <div style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: "var(--t-4)", color: "var(--a-ink)", lineHeight: 1.2, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {focusNode.title || focusNode.kind}
              </div>
              <div style={{ fontSize: "var(--t-2)", color: "var(--a-mute)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {focusNode.intent}
              </div>
            </>
          ) : (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-faint, var(--a-line-2))", textTransform: "lowercase", fontStyle: "italic", opacity: 0.7 }}>
              hover a node to preview · click to pin
            </div>
          )}
        </div>
      </div>
      {/* The kind-facet tabbar (build/decisions/risks/discovery/docs) was
          retired 2026-05-05 with the Plan-tab redesign. PlanTreeView now
          surfaces Decisions / Risks / Research / Artifacts as inline
          annotation chips on the Surface or Story they're parented to;
          Work + Activity filter their own kinds. The viewTab state stays
          (default "build") only as a no-op compatibility shim — the rest
          of this file still references it for the empty-state copy. */}
      <div style={{ display:"flex", flexDirection:"row", flex:"1 1 auto", minHeight:0 }}>
        <div style={{ position:"relative", flex:"1 1 auto", minWidth:0 }}>
          {/* Per-layout empty UX is handled inside KanbanView (per-column empty)
              and PlanTreeView. The canvas-wide empty state lives at the top of
              this component (`!canvasNodes.length`). The old kind-tabbar empty
              branch was retired with VIEW_TABS — Consultation-only graphs were
              wrongly hidden behind "no build nodes yet". */}
          {layout === "shape"
            ? <div style={{ position:"absolute", inset:0, overflow:"auto", background:"var(--a-page)", display:"flex", flexDirection:"column" }}>
                <PlanSubToggle current={planSub} onChange={setPlanSub} />
                {planSub === "tree" && (
                  <PlanTreeView nodes={canvasNodes} selected={selected} onNodeClick={onNodeClick} />
                )}
                {planSub === "radial" && (
                  <div style={{ position:"relative", flex:"1 1 auto", minHeight:0 }}>
                    <RadialView
                      nodes={canvasNodes}
                      edges={edges}
                      hovered={hovered}
                      setHovered={setHovered}
                      selected={selected}
                      onNodeClick={onNodeClick}
                      onClearFocus={clearFocus}
                    />
                  </div>
                )}
                {planSub === "3d" && (
                  <div style={{ flex:"1 1 auto", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--a-mute)", fontFamily:"var(--font-mono)", fontSize:"var(--t-2)", textTransform:"lowercase" }}>
                    3d view — reserved future slot
                  </div>
                )}
              </div>
            : layout === "activity"
            ? <ActivityView project={project} onOpenNode={(id) => onNodeClick(id)} />
            : layout === "kanban"
            ? <div style={{ position:"absolute", inset:0, overflow:"auto", background:"var(--a-page)" }}>
                <KanbanView
                  nodes={canvasNodes}
                  hovered={hovered}
                  setHovered={setHovered}
                  selected={selected}
                  onNodeClick={onNodeClick}
                  onStateChange={onStateChange}
                  onClearFocus={clearFocus}
                  onCreateInColumn={(state) => setCreateModal({ state })}
                />
              </div>
            : <RadialView
                nodes={canvasNodes}
                edges={edges}
                hovered={hovered}
                setHovered={setHovered}
                selected={selected}
                onNodeClick={onNodeClick}
                onClearFocus={clearFocus}
              />
          }
          <div style={{ position:"absolute", bottom:18, left:28, zIndex:5, background:"var(--a-paper)", border:"1px solid var(--a-line)", borderRadius:6, padding:"8px 14px", display:"flex", gap:14, fontFamily:"var(--font-mono)", fontSize:10, color:"var(--a-mute)", textTransform:"lowercase" }}>
            <span><span style={{ display:"inline-block", width:14, height:2, background:"var(--a-line-2)", verticalAlign:"middle", marginRight:4 }}/>parent</span>
            <span><span style={{ display:"inline-block", width:14, height:2, background:"var(--a-accent)", verticalAlign:"middle", marginRight:4 }}/>depends-on (on hover/select)</span>
            <span>{canvasNodes.length} nodes · {edges.length} edges</span>
          </div>
        </div>
        {expanded && (
          <>
            <div
              className="canvas-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="resize node panel"
              onMouseDown={onDividerMouseDown}
              title="drag to resize"
            />
            <div
              className="canvas-node-panel-wrap"
              style={{ flex: `0 0 ${panelWidth}px`, minWidth: PANEL_MIN_W }}
            >
              <NodeDrawer
                node={expandedNode}
                project={project}
                baseUrl={baseUrl}
                allNodes={canvasNodes}
                onClose={() => setExpanded(null)}
                onUpdated={() => { fetchGraph(); }}
                onDeleted={(id) => {
                  setExpanded(null);
                  setSelected(s => s === id ? null : s);
                  fetchGraph();
                }}
              />
            </div>
          </>
        )}
      </div>
      {createModal && (
        <CreateTaskModal
          baseUrl={baseUrl}
          project={project}
          allNodes={canvasNodes}
          initialState={createModal.state}
          selectedId={selected}
          onClose={() => setCreateModal(null)}
          onCreated={() => { setCreateModal(null); fetchGraph(); }}
        />
      )}
    </div>
  );
}

// ── Plan sub-toggle (decisions §5) — Tree/Radial/3D inside Plan ──────────

function PlanSubToggle({ current, onChange }: {
  current: "tree" | "radial" | "3d";
  onChange: (v: "tree" | "radial" | "3d") => void;
}) {
  const opts: ReadonlyArray<{ key: "tree" | "radial" | "3d"; label: string; disabled?: boolean }> = [
    { key: "tree", label: "tree" },
    { key: "radial", label: "radial" },
    { key: "3d", label: "3d · soon", disabled: true },
  ];
  return (
    <div style={{
      flex: "0 0 auto", display: "flex", gap: 4,
      padding: "10px 20px 0 20px",
      borderBottom: "1px solid var(--a-line)",
      background: "var(--a-page)",
    }}>
      {opts.map(o => {
        const on = current === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.key)}
            style={{
              background: "transparent", border: 0,
              borderBottom: `2px solid ${on ? "var(--a-accent)" : "transparent"}`,
              padding: "6px 12px",
              fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
              letterSpacing: "0.08em", textTransform: "lowercase",
              color: on ? "var(--a-ink)" : o.disabled ? "var(--a-mute-2)" : "var(--a-mute)",
              fontWeight: on ? 600 : 400,
              cursor: o.disabled ? "default" : "pointer",
              opacity: o.disabled ? 0.5 : 1,
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

// ── Inline + new task modal (Canvas reframe 2026-05-04, decisions §6) ────
// Per-column "+" button opens this. Pre-fills state from the column header,
// kind defaults to Task (Subtask if a Task is currently selected). Parent
// picker enumerates altitude-valid candidates: Task→Story|Epic, Subtask→Task.
// Reuses POST /canvas/node which already enforces altitude — no new endpoint
// or new validation. State PATCH only fires for non-default landing columns.

function CreateTaskModal({ baseUrl, project, allNodes, initialState, selectedId, onClose, onCreated }: {
  baseUrl: string;
  project: string;
  allNodes: CanvasNode[];
  initialState: ApiNodeState;
  selectedId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  type CreateKind = "Task" | "Subtask";
  // If a Task is selected, default to Subtask under it; else Task.
  const selectedNode = selectedId ? allNodes.find(n => n.id === selectedId) : null;
  const initialKind: CreateKind = selectedNode?.kind === "Task" ? "Subtask" : "Task";
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Altitude-valid parents per kind. Task takes Story or Epic; Subtask takes Task.
  const parentCandidates = useMemo(() => {
    const validKinds = kind === "Task" ? ["Story", "Epic"] : ["Task"];
    return allNodes
      .filter(n => validKinds.includes(n.kind))
      .sort((a, b) => (a.title || a.intent || "").localeCompare(b.title || b.intent || ""));
  }, [allNodes, kind]);

  // Reasonable default: if a node is selected, prefer its nearest valid
  // ancestor (or itself if it's already a valid parent kind); else first.
  useEffect(() => {
    if (parentCandidates.length === 0) { setParentId(""); return; }
    if (selectedNode) {
      if (parentCandidates.some(p => p.id === selectedNode.id)) {
        setParentId(selectedNode.id);
        return;
      }
      // climb parents
      let cur = selectedNode;
      while (cur.parent_id) {
        const p = allNodes.find(n => n.id === cur.parent_id);
        if (!p) break;
        if (parentCandidates.some(c => c.id === p.id)) { setParentId(p.id); return; }
        cur = p as CanvasNode;
      }
    }
    setParentId(parentCandidates[0].id);
  }, [parentCandidates, selectedNode, allNodes]);

  async function submit() {
    setErr(null);
    const t = title.trim();
    if (!t) { setErr("title required"); return; }
    if (!parentId) { setErr(`no ${kind === "Task" ? "Story or Epic" : "Task"} exists yet to attach to — Drafter must propose one first.`); return; }
    setBusy(true);
    try {
      const created = await apiCreateNode(baseUrl, project, {
        kind,
        title: t.split(/\s+/).slice(0, 2).join(" "),
        intent: intent.trim() || t,
        parent_id: parentId,
        confidence: "medium",
      });
      // Backend lands new nodes in proposed by default. If founder dropped
      // into Triage or Up-Next, transition. Skip for proposed (already there).
      if (initialState !== "proposed" && initialState !== created.state) {
        try { await updateNode(baseUrl, project, created.id, { state: initialState }); }
        catch (e) { console.warn("[+ new task] state set failed:", e); }
      }
      onCreated();
    } catch (e) {
      setErr((e as Error).message || "create failed");
    } finally {
      setBusy(false);
    }
  }

  function onBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  return (
    <div
      onClick={onBackdrop}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "color-mix(in srgb, var(--a-paper) 70%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 460, maxWidth: "92vw", padding: 18,
          background: "var(--a-paper)", border: "1px solid var(--a-line)",
          borderRadius: 6, fontFamily: "var(--font-mono)",
          display: "flex", flexDirection: "column", gap: 10,
        }}
      >
        <div style={{ fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", letterSpacing: "0.04em" }}>
          + new task → <strong style={{ color: "var(--a-ink)" }}>{initialState}</strong>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
          kind
          <select
            value={kind}
            onChange={e => setKind(e.target.value as CreateKind)}
            style={{ padding: "4px 6px", background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 3, fontFamily: "var(--font-mono)" }}
          >
            <option value="Task">Task (parent: Story or Epic)</option>
            <option value="Subtask">Subtask (parent: Task)</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
          parent {parentCandidates.length === 0 && <span style={{ color: "var(--sem-orange)" }}>· none available</span>}
          <select
            value={parentId}
            onChange={e => setParentId(e.target.value)}
            disabled={parentCandidates.length === 0}
            style={{ padding: "4px 6px", background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 3, fontFamily: "var(--font-mono)" }}
          >
            {parentCandidates.length === 0 && <option value="">— no valid parent —</option>}
            {parentCandidates.map(p => (
              <option key={p.id} value={p.id}>{p.kind} · {p.title || p.intent.slice(0, 40)}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
          title <span style={{ opacity: 0.7 }}>(2 words, ≤ 40 chars)</span>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={40}
            autoFocus
            placeholder="e.g. Parse Pipeline"
            style={{ padding: "4px 6px", background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 3, fontFamily: "var(--font-mono)" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
          intent
          <textarea
            value={intent}
            onChange={e => setIntent(e.target.value)}
            placeholder="One sentence — what this builds and why."
            rows={3}
            style={{ padding: "6px 8px", background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", resize: "vertical" }}
          />
        </label>
        {err && <div style={{ color: "var(--sem-red)", fontSize: "var(--t-1)" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} disabled={busy} className="np-btn np-btn-small">cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim() || !parentId}
            className="np-btn np-btn-small"
            style={{ borderColor: "var(--sem-blue)" }}
          >{busy ? "creating…" : `create ${kind.toLowerCase()}`}</button>
        </div>
      </div>
    </div>
  );
}

// ── Drawer subsections (Canvas reframe 2026-05-04) ────────────────────────
// Placed in Canvas.tsx because the inline NodeDrawer above renders for
// kanban-card clicks; the alternate views/NodeDetail.tsx renders elsewhere
// but we keep symmetry by mirroring the same three sections in both.

function DrawerDiscussionFlag({ node, baseUrl, project, onSaved }: {
  node: NodeMeta;
  baseUrl: string;
  project: string;
  onSaved?: () => void;
}) {
  const [m, setM] = useState(node.mark_for_discussion === true);
  const [a, setA] = useState(node.discussion_agenda ?? "");
  const [u, setU] = useState(node.assigned_to_user_id ?? "");
  const [saving, setSaving] = useState(false);
  // savedAt holds the ms-timestamp of the last successful save; the "saved"
  // badge shows for 2.5s and then fades. Decoupled from `dirty` because the
  // parent refetch lags the local PATCH response by 100-300ms, leaving the
  // user briefly looking at a still-dirty form with no feedback.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    setM(node.mark_for_discussion === true);
    setA(node.discussion_agenda ?? "");
    setU(node.assigned_to_user_id ?? "");
  }, [node.id, node.mark_for_discussion, node.discussion_agenda, node.assigned_to_user_id]);

  const dirty = m !== (node.mark_for_discussion === true) || a !== (node.discussion_agenda ?? "") || u !== (node.assigned_to_user_id ?? "");
  const showSaved = savedAt !== null && (Date.now() - savedAt < 2500);

  async function save() {
    setSaving(true);
    try {
      await updateNode(baseUrl, project, node.id, {
        mark_for_discussion: m,
        discussion_agenda: m ? (a || null) : null,
        assigned_to_user_id: m ? (u || null) : null,
      });
      setSavedAt(Date.now());
      onSaved?.();
      // Trigger a re-render after the fade window so the badge actually disappears.
      window.setTimeout(() => setSavedAt((v) => v), 2600);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="np-section">💬 discussion {m ? "· flagged" : ""}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 0 12px 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--t-2)", fontFamily: "var(--font-mono)" }}>
          <input type="checkbox" checked={m} onChange={e => setM(e.target.checked)} />
          mark for discussion with team
        </label>
        {m && (
          <>
            <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
              agenda — Drafter opens with this on assigned user's next session
            </label>
            <textarea
              value={a}
              onChange={e => setA(e.target.value)}
              placeholder="What do you want to discuss?"
              rows={3}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
            />
            <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
              assigned user_id — which cofounder picks this up
            </label>
            <input
              value={u}
              onChange={e => setU(e.target.value)}
              placeholder="user uuid (paste from Settings → Account)"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
            />
          </>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={save} disabled={!dirty || saving} className="np-btn np-btn-small" style={{ borderColor: dirty ? "var(--sem-blue)" : "var(--a-line)" }}>
            {saving ? "saving…" : "save"}
          </button>
          {showSaved && <span style={{ color: "var(--sem-green)", fontSize: "var(--t-1)", fontFamily: "var(--font-mono)" }}>saved</span>}
        </div>
      </div>
    </>
  );
}

function DrawerComments({ baseUrl, project, nodeId, refreshKey = 0 }: { baseUrl: string; project: string; nodeId: string; refreshKey?: number }) {
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

  // refreshKey is bumped by sibling subsections (e.g. DrawerResearcher) when
  // they post a new comment; this re-runs `load()` without remounting.
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
    <>
      <div className="np-section">comments {comments.length > 0 ? `(${comments.length})` : ""}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 0 12px 0" }}>
        {loading && <div className="ph-empty">loading comments…</div>}
        {!loading && comments.length === 0 && <div className="ph-empty">no comments yet.</div>}
        {comments.map(c => {
          const accent = (c.author_role === "drafter" || c.author_role === "implementer" || c.author_role === "allocator")
            ? "var(--sem-blue)" : "var(--a-line)";
          return (
            <div key={c.id} style={{ borderLeft: `2px solid ${accent}`, padding: "4px 8px", background: "var(--a-paper-2)", borderRadius: 4 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginBottom: 2 }}>
                {c.author_role} · {new Date(c.created_at).toLocaleString()}
              </div>
              <div style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{c.body}</div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 6 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="add a comment…"
            rows={2}
            style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
          />
          <button onClick={submit} disabled={posting || !draft.trim()} className="np-btn np-btn-small" style={{ borderColor: "var(--sem-blue)" }}>
            {posting ? "…" : "post"}
          </button>
        </div>
      </div>
    </>
  );
}

function DrawerActivity({ baseUrl, project, nodeId }: { baseUrl: string; project: string; nodeId: string }) {
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
    <>
      <div className="np-section">activity {events.length > 0 ? `(${events.length})` : ""}</div>
      <div style={{ padding: "0 0 12px 0" }}>
        {loading && <div className="ph-empty">loading events…</div>}
        {!loading && events.length === 0 && <div className="ph-empty">no events yet.</div>}
        {events.map(e => {
          const reason = (e.payload as { reason?: string } | null)?.reason;
          const summary = (e.payload as { summary?: string } | null)?.summary;
          const text = reason || summary || "";
          return (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "120px 110px 1fr", gap: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "3px 0", borderBottom: "1px solid var(--a-line)" }}>
              <span style={{ color: "var(--a-mute)" }}>{new Date(e.ts).toLocaleString()}</span>
              <span style={{ color: "var(--a-ink)" }}>{e.agent}/{e.kind}</span>
              <span style={{ color: "var(--a-mute)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Researcher (Pillar A — world-grounding) inline drawer subsection.
//
// Sits between DrawerDiscussionFlag and DrawerComments. Renders only on
// Decision / Risk / Research kinds (caller decides — see NodeDrawer JSX).
// Disclosure pattern uses <details> like DiscussionFlagSection in
// NodeDetail.tsx; open-by-default only when node.kind === "Research".
// Past runs accumulate as comments below — no custom history UI here.
// ──────────────────────────────────────────────────────────────────────────────

function DrawerResearcher({ node, baseUrl, project, onCompleted }: {
  node: CanvasNode;
  baseUrl: string;
  project: string;
  onCompleted: () => void;
}) {
  const [question, setQuestion] = useState<string>(node.intent ?? "");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "skipped" | "error"; line: string } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // Reset prefill + status when the drawer swaps to a different node.
  useEffect(() => {
    setQuestion(node.intent ?? "");
    setStatus(null);
    if (ctrlRef.current) {
      ctrlRef.current.abort();
      ctrlRef.current = null;
    }
    setRunning(false);
  }, [node.id, node.intent]);

  async function ask() {
    const q = question.trim();
    if (!q || running) return;
    setRunning(true);
    setStatus(null);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const res: ResearchRunResult = await runResearcher(baseUrl, project, node.id, q, ctrl.signal);
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
      // Always refresh comments — backend posts a comment for every outcome
      // (ok, skipped, error) so the founder sees what happened without
      // re-clicking.
      onCompleted();
    }
  }

  const openByDefault = node.kind === "Research";
  const statusColor = status?.kind === "ok"
    ? "var(--sem-green)"
    : status?.kind === "skipped"
      ? "var(--a-mute)"
      : status?.kind === "error"
        ? "var(--sem-red)"
        : "var(--a-mute)";
  const statusGlyph = status?.kind === "ok" ? "✓" : status?.kind === "skipped" ? "·" : status?.kind === "error" ? "✗" : "";

  return (
    <details open={openByDefault} style={{ padding: "0 0 12px 0" }}>
      <summary
        className="np-section"
        style={{ cursor: "pointer", listStyle: "revert" }}
      >
        🔎 research
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0 0 0" }}>
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="What do you want to research? E.g. 'What does the regulation require for advance payments?'"
          rows={3}
          disabled={running}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-2)",
            padding: 6,
            background: "var(--a-paper-2)",
            color: "var(--a-ink)",
            border: "1px solid var(--a-line)",
            borderRadius: 4,
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={ask}
            disabled={running || !question.trim()}
            className="np-btn np-btn-small"
            style={{ borderColor: question.trim() ? "var(--sem-blue)" : "var(--a-line)" }}
          >
            {running ? "researching…" : "ask researcher"}
          </button>
          {running && (
            <span style={{ fontStyle: "italic", color: "var(--a-mute)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
              researching…
            </span>
          )}
          {!running && status && (
            <span style={{ color: statusColor, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
              {statusGlyph} {status.line}
            </span>
          )}
        </div>
        {!running && !status && (
          <div className="ph-empty" style={{ padding: 0, fontSize: "var(--t-1)" }}>
            No research yet. Use the box above to ask Researcher.
          </div>
        )}
      </div>
    </details>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Consultation (Pillar B — off-platform expert tracking, Session 4).
//
// Atelier doesn't host the conversation. The founder talks to the lawyer /
// accountant / designer / etc. via email, slack, calendly, phone, or in
// person. This subsection just persists the question + answer, and triggers
// a brain ripple when the answer arrives so dependent nodes pick up the new
// context at next session boot.
//
// Disclosure default-open when the answer is empty (founder needs to see
// the form), default-closed once answered (the form has done its job).
// ──────────────────────────────────────────────────────────────────────────────

function DrawerConsultation({ node, baseUrl, project, onSaved }: {
  node: NodeMeta;
  baseUrl: string;
  project: string;
  onSaved: () => void;
}) {
  const [expertRole, setExpertRole] = useState<string>(node.expert_role ?? "");
  const [channel, setChannel] = useState<string>(node.channel ?? "");
  const [question, setQuestion] = useState<string>(node.question ?? node.intent ?? "");
  const [answer, setAnswer] = useState<string>(node.answer ?? "");
  const [deadline, setDeadline] = useState<string>(node.deadline ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExpertRole(node.expert_role ?? "");
    setChannel(node.channel ?? "");
    setQuestion(node.question ?? node.intent ?? "");
    setAnswer(node.answer ?? "");
    setDeadline(node.deadline ?? "");
    setError(null);
  }, [node.id, node.expert_role, node.channel, node.question, node.answer, node.deadline, node.intent]);

  const dirty =
    expertRole !== (node.expert_role ?? "") ||
    channel !== (node.channel ?? "") ||
    question !== (node.question ?? node.intent ?? "") ||
    answer !== (node.answer ?? "") ||
    deadline !== (node.deadline ?? "");

  const showSaved = savedAt !== null && (Date.now() - savedAt < 2500);
  const openByDefault = !node.answer || node.answer.trim() === "";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateNode(baseUrl, project, node.id, {
        expert_role: expertRole || null,
        channel: channel || null,
        question: question || null,
        answer: answer || null,
        deadline: deadline || null,
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
    <details open={openByDefault} style={{ padding: "0 0 12px 0" }}>
      <summary className="np-section" style={{ cursor: "pointer", listStyle: "revert" }}>
        👤 consultation {node.answer ? "· answered" : "· awaiting answer"}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0 0 0" }}>
        <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
          expert role
        </label>
        <input
          value={expertRole}
          onChange={e => setExpertRole(e.target.value)}
          placeholder="legal counsel / tax accountant / UX designer / payments support"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
        />
        <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
          channel
        </label>
        <input
          value={channel}
          onChange={e => setChannel(e.target.value)}
          placeholder="email / slack / calendly / phone / in-person"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4 }}
        />
        <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
          question
        </label>
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="What you're asking the expert"
          rows={3}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
        />
        <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
          answer (filled when conversation completes)
        </label>
        <textarea
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          placeholder="Paste their answer here when the conversation completes"
          rows={4}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, resize: "vertical" }}
        />
        <label style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
          deadline (optional)
        </label>
        <input
          type="date"
          value={deadline}
          onChange={e => setDeadline(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 6, background: "var(--a-paper-2)", color: "var(--a-ink)", border: "1px solid var(--a-line)", borderRadius: 4, width: 180 }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="np-btn np-btn-small"
            style={{ borderColor: dirty ? "var(--sem-blue)" : "var(--a-line)" }}
          >
            {saving ? "saving…" : "save"}
          </button>
          {showSaved && (
            <span style={{ color: "var(--sem-green)", fontSize: "var(--t-1)", fontFamily: "var(--font-mono)" }}>
              saved
            </span>
          )}
          {error && (
            <span style={{ color: "var(--sem-red)", fontSize: "var(--t-1)", fontFamily: "var(--font-mono)" }}>
              error · {error}
            </span>
          )}
        </div>
        {node.answered_at && (
          <div style={{ fontSize: "var(--t-1)", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
            answered {new Date(node.answered_at).toLocaleString()} · brain artifact written
          </div>
        )}
      </div>
    </details>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Ripple awareness (Session 5 — TODO #30) inline drawer subsection.
//
// Sits between Researcher and Comments. Renders only on Task / Subtask kinds
// when node.touches is non-empty. Default-collapsed — most founders won't
// need this every glance. Loads NodeDetail to extract Planned artifacts
// from plan.md, then queries /ripple per file (depth=1) and surfaces a flat
// neighbour list with confidence chips. Aesthetic: mono font, lowercase,
// existing var(--a-mute) tokens, no new color.
// ──────────────────────────────────────────────────────────────────────────────

function DrawerRipple({ node, baseUrl, project }: {
  node: CanvasNode;
  baseUrl: string;
  project: string;
}) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [neighbours, setNeighbours] = useState<RippleNeighbor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [graphBuiltAt, setGraphBuiltAt] = useState<string | null>(null);

  // Lazy-load: only fetch when the founder opens the disclosure.
  useEffect(() => {
    if (!opened) return;
    if (neighbours !== null) return; // already loaded once
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const detail = await getNodeDetail(baseUrl, project, node.id);
        const planned = extractPlannedArtifactsFromPlan(detail.plan ?? "");
        if (planned.length === 0) {
          if (!cancelled) {
            setNeighbours([]);
            setGraphBuiltAt(null);
          }
          return;
        }
        // Aggregate ripple across all planned artifacts. Dedup by neighbour
        // path; keep the highest confidence + nearest distance.
        const merged = new Map<string, RippleNeighbor>();
        let latestGraph: string | null = null;
        const plannedSet = new Set(planned);
        for (const f of planned.slice(0, 6)) {
          try {
            const r: RippleResult = await getRipple(baseUrl, f, 1, 8);
            latestGraph = r.graph_built_at;
            for (const n of r.affected_files) {
              if (plannedSet.has(n.path)) continue; // already in scope; not a ripple
              const prev = merged.get(n.path);
              if (!prev || n.confidence > prev.confidence) merged.set(n.path, n);
            }
          } catch { /* per-file failure is non-fatal */ }
        }
        const list = [...merged.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 12);
        if (!cancelled) {
          setNeighbours(list);
          setGraphBuiltAt(latestGraph);
        }
      } catch (e) {
        if (!cancelled) setError(String(e).slice(0, 200));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opened, baseUrl, project, node.id, neighbours]);

  return (
    <details
      style={{ padding: "0 0 12px 0" }}
      onToggle={(e) => setOpened((e.target as HTMLDetailsElement).open)}
    >
      <summary
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--t-2)",
          color: "var(--a-mute)",
          cursor: "pointer",
          textTransform: "lowercase",
          padding: "4px 0",
        }}
      >
        🌊 ripple awareness
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0 0 12px" }}>
        {loading && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", fontStyle: "italic" }}>
            checking co-change graph…
          </div>
        )}
        {!loading && error && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
            ripple unavailable · {error}
          </div>
        )}
        {!loading && !error && neighbours && neighbours.length === 0 && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", fontStyle: "italic" }}>
            no co-change signal for this task's planned artifacts
          </div>
        )}
        {!loading && !error && neighbours && neighbours.length > 0 && (
          <>
            {neighbours.map((n) => {
              // Confidence chip color: 0.0–0.4 grey (a-mute), 0.4–0.7 blue, 0.7–1.0 orange.
              const c = n.confidence;
              const chipColor = c >= 0.7 ? "var(--sem-orange, #b54a2a)" : c >= 0.4 ? "var(--sem-blue, #3a6d9c)" : "var(--a-mute)";
              const pct = Math.round(c * 100);
              const dist = n.last_change_distance < 0 ? "?" : `${n.last_change_distance}d`;
              return (
                <div
                  key={n.path}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--t-1)",
                    color: "var(--a-ink)",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      minWidth: 38,
                      textAlign: "center",
                      padding: "1px 6px",
                      border: `1px solid ${chipColor}`,
                      color: chipColor,
                      borderRadius: 3,
                      fontSize: "var(--t-0, 10px)",
                    }}
                  >
                    {pct}%
                  </span>
                  <span style={{ flex: 1 }}>{n.path}</span>
                  <span style={{ color: "var(--a-mute)" }}>{dist}{n.depth > 1 ? ` · d${n.depth}` : ""}</span>
                </div>
              );
            })}
            {graphBuiltAt && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-0, 10px)", color: "var(--a-mute)", marginTop: 4 }}>
                graph built {new Date(graphBuiltAt).toLocaleString()} · git fallback
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * Extract relative file paths from the "Planned artifacts" section of a
 * plan.md. Mirrors the backend's extractPlannedArtifacts() behaviour.
 */
function extractPlannedArtifactsFromPlan(planMd: string): string[] {
  if (!planMd) return [];
  const lines = planMd.split(/\r?\n/);
  let inSection = false;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      if (/planned\s+artifacts/i.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection) break;
      continue;
    }
    if (!inSection) continue;
    const backticks = [...line.matchAll(/`([^`]+)`/g)];
    for (const m of backticks) {
      const cand = m[1].trim();
      if (looksLikePathClient(cand)) out.push(cand);
    }
    if (backticks.length === 0) {
      const list = line.match(/^[-*]\s+([^\s(]+)/);
      if (list && looksLikePathClient(list[1])) out.push(list[1]);
    }
  }
  return [...new Set(out)].map((p) => p.replace(/^\.\//, ""));
}

function looksLikePathClient(s: string): boolean {
  if (!s || s.length > 200) return false;
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;
  return /\//.test(s) || /\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|css|html|xml|svg|txt|sh|toml|sql|env|gitignore|lock)$/i.test(s);
}
