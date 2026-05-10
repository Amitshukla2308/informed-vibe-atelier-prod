/**
 * Backlog — the "what should I do right now" surface.
 *
 * Lists ranked Tasks/Subtasks the Implementer can pick up, in the canonical
 * 6-criterion order (priority → lock_id → topo readiness → surface heat →
 * smaller diff → author age). Coherence-blocked Tasks render greyed out
 * with the violation summary so the obstruction is visible.
 *
 * Click a row → Canvas with that node selected in the drawer. The Backlog
 * does NOT trigger runs itself — that lives on the node's ImplementerCard.
 * This view is the orientation surface; Canvas is where decisions happen.
 */

import { useEffect, useState } from "react";
import { getImplementerQueue, type QueueRow } from "../lib/api";

interface BacklogProps {
  project: string;
  onOpenInCanvas: (nodeId: string) => void;
}

export function Backlog({ project, onOpenInCanvas }: BacklogProps) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getImplementerQueue(project)
      .then(({ queue }) => { if (!cancelled) setRows(queue); })
      .catch(e => { if (!cancelled) setError(String(e).slice(0, 240)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project]);

  // Quick refresh hook — when the founder navigates back from Canvas after
  // approving / editing, the queue should re-rank. Re-fetches on focus.
  useEffect(() => {
    const onFocus = () => {
      getImplementerQueue(project)
        .then(({ queue }) => setRows(queue))
        .catch(() => { /* keep last-known */ });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [project]);

  const ready = rows ? rows.filter(r => r.coherence_blocked === null && r.topo_ready) : [];
  const blocked = rows ? rows.filter(r => r.coherence_blocked !== null) : [];
  const waitingDeps = rows ? rows.filter(r => r.coherence_blocked === null && !r.topo_ready) : [];

  const openInCanvas = (id: string) => onOpenInCanvas(id);

  return (
    <div className="implementer-view">
      <header className="implementer-view-head">
        <div className="implementer-view-titles">
          <h1 className="implementer-view-h">Backlog</h1>
          <p className="implementer-view-sub">
            ranked by priority · lock · readiness · heat · size · age
          </p>
        </div>
        <div className="implementer-view-meta">
          <span className="implementer-view-proj">
            <span className="implementer-view-proj-k">project</span>
            <span className="implementer-view-proj-v">{project || "—"}</span>
          </span>
        </div>
      </header>

      {loading && <div className="node-detail-hint" style={{ padding: 24 }}>loading queue…</div>}
      {error && <div className="impl-error" style={{ margin: 24 }}>{error}</div>}
      {!loading && !error && rows && rows.length === 0 && (
        <div className="impl-card-empty" style={{ margin: 24, borderLeftColor: "var(--a-accent)" }}>
          No Tasks in the queue. Open Canvas to draft a Task or move a proposed Task to <code>approved</code>.
        </div>
      )}

      {ready.length > 0 && (
        <BacklogSection title={`Ready · ${ready.length}`} subtitle="Implementer can pick up the head of this list.">
          {ready.map((r, i) => (
            <BacklogRow key={r.id} row={r} rank={i + 1} onClick={() => openInCanvas(r.id)} />
          ))}
        </BacklogSection>
      )}

      {waitingDeps.length > 0 && (
        <BacklogSection title={`Waiting on dependencies · ${waitingDeps.length}`} subtitle="Topologically blocked by upstream Tasks.">
          {waitingDeps.map((r) => (
            <BacklogRow key={r.id} row={r} dim onClick={() => openInCanvas(r.id)} />
          ))}
        </BacklogSection>
      )}

      {blocked.length > 0 && (
        <BacklogSection title={`Coherence-blocked · ${blocked.length}`} subtitle="Cross-artifact violations — resolve in Canvas before running.">
          {blocked.map((r) => (
            <BacklogRow key={r.id} row={r} blockedReason={r.coherence_blocked!} onClick={() => openInCanvas(r.id)} />
          ))}
        </BacklogSection>
      )}
    </div>
  );
}

function BacklogSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: "16px 24px", borderTop: "1px solid var(--a-paper-3)" }}>
      <header style={{ marginBottom: 12 }}>
        <h2 className="node-detail-section-title" style={{ marginBottom: 2 }}>{title}</h2>
        <div className="agent-row-purpose" style={{ marginTop: 0 }}>{subtitle}</div>
      </header>
      <ol className="backlog-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {children}
      </ol>
    </section>
  );
}

function BacklogRow({ row, rank, dim, blockedReason, onClick }: {
  row: QueueRow;
  rank?: number;
  dim?: boolean;
  blockedReason?: string;
  onClick: () => void;
}) {
  const opacity = blockedReason ? 0.55 : dim ? 0.7 : 1;
  return (
    <li
      style={{
        padding: "10px 12px",
        marginBottom: 6,
        borderRadius: 6,
        background: "var(--a-paper-2)",
        border: "1px solid var(--a-paper-3)",
        cursor: "pointer",
        opacity,
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 12,
      }}
      onClick={onClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", minWidth: 28, textAlign: "right" }}>
        {rank ? `#${rank}` : ""}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: "var(--a-ink-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.title || row.id}
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginTop: 2 }}>
          {row.kind} · {row.state} · {row.explanation}
        </div>
        {blockedReason && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--sem-orange, #E8A86A)", marginTop: 4 }}>
            ⚠ {blockedReason}
          </div>
        )}
      </div>
      <span className="badge" data-b={row.state}>
        <span className="dot" /> {row.state}
      </span>
    </li>
  );
}
