/**
 * ImplementerLiveFeed — collapsed-row WebSocket feed for in-flight Implementer runs.
 *
 * One row per active or recently-completed run, format:
 *   [●] implementing <task-summary> · <phase> · <NN files, NNNB>
 *
 * Click a row → expand inline to show allocator verdict + reason, files
 * touched, full diff (lazy-fetched from /implementer/diff/:project/:nodeId),
 * tsc tail if blocked, mode (local|repo) + branch / run dir.
 *
 * - Auto-expand on `blocked`.
 * - Auto-collapse 8s after `completed`.
 * - Subscribes via `new WebSocket(WS_BASE + "/ws?session=__notifications__")`
 *   to match the existing notification ribbon (App.tsx already opens this
 *   channel; we open a second one rather than coupling to the ribbon's
 *   private state).
 * - Backfills the last 10 completed runs from /implementer/runs on mount.
 *
 * No new deps; native WebSocket + useState + useEffect only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listImplementerRuns,
  getImplementerDiff,
  type ImplementerRunsListEntry,
} from "../lib/api";
import { subscribeNotifications } from "../lib/notifications-socket";

type Phase = "started" | "allocator" | "writing" | "verifying" | "completed" | "blocked";

interface RunState {
  nodeId: string;
  project: string;
  summary: string;
  phase: Phase;
  ts: string;
  files: string[];
  diff_bytes: number;
  mode: "local" | "repo";
  branch: string | null;
  run_dir: string | null;
  commit: string | null;
  allocator: { verdict: string; reason: string; confidence?: number } | null;
  reason: string | null;
  error: string | null;
  /** UI-only: explicit user expand/collapse. null → use phase-driven default. */
  expanded: boolean | null;
  /** Loaded diff text, fetched lazily on first expand. */
  diff: string | null;
  diffLoading: boolean;
  /** Synthetic terminal-state timestamp; drives the 8s auto-collapse. */
  completedAt: number | null;
}

interface ImplementerEventFrame {
  type: "implementer.event";
  payload: {
    phase: Phase;
    nodeId: string;
    project: string;
    ts: string;
    summary?: string;
    verdict?: string;
    reason?: string;
    confidence?: number;
    state?: string;
    files?: string[] | number;
    diff_bytes?: number;
    mode?: "local" | "repo";
    branch?: string | null;
    commit?: string | null;
    run_dir?: string | null;
    error?: string;
    sandbox_mode?: "local" | "repo";
    sandbox_path?: string;
    planned_artifacts?: number;
  };
}

interface Props {
  /** Optional project filter. When set, only runs from this project are shown. */
  project?: string | null;
}

const PHASE_COPY: Record<Phase, string> = {
  started: "starting",
  allocator: "allocator",
  writing: "writing",
  verifying: "verifying",
  completed: "completed",
  blocked: "blocked",
};

function phaseClass(phase: Phase): string {
  return `impl-feed-phase-${phase} is-${phase}`;
}

function fmtBytes(n: number): string {
  if (!n) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function emptyRunState(p: ImplementerEventFrame["payload"]): RunState {
  return {
    nodeId: p.nodeId,
    project: p.project,
    summary: p.summary ?? p.nodeId,
    phase: p.phase,
    ts: p.ts,
    files: Array.isArray(p.files) ? p.files : [],
    diff_bytes: p.diff_bytes ?? 0,
    mode: (p.mode ?? p.sandbox_mode ?? "local") as "local" | "repo",
    branch: p.branch ?? null,
    run_dir: p.run_dir ?? null,
    commit: p.commit ?? null,
    allocator: null,
    reason: p.reason ?? null,
    error: p.error ?? null,
    expanded: null,
    diff: null,
    diffLoading: false,
    completedAt: null,
  };
}

function applyEvent(prev: RunState | null, p: ImplementerEventFrame["payload"]): RunState {
  const base = prev ?? emptyRunState(p);
  const next: RunState = {
    ...base,
    phase: p.phase,
    ts: p.ts,
  };
  if (typeof p.summary === "string" && p.summary) next.summary = p.summary;
  if (Array.isArray(p.files)) next.files = p.files;
  if (typeof p.diff_bytes === "number") next.diff_bytes = p.diff_bytes;
  if (p.mode) next.mode = p.mode;
  if (p.sandbox_mode) next.mode = p.sandbox_mode;
  if (p.branch !== undefined) next.branch = p.branch;
  if (p.run_dir !== undefined) next.run_dir = p.run_dir;
  if (p.commit !== undefined) next.commit = p.commit;
  if (p.phase === "allocator") {
    next.allocator = {
      verdict: p.verdict ?? "(unknown)",
      reason: p.reason ?? "",
      confidence: p.confidence,
    };
  }
  if (p.phase === "blocked") {
    next.reason = p.reason ?? next.reason;
    next.error = p.error ?? next.error;
    if (next.expanded === null) next.expanded = true; // auto-expand on blocked
  }
  if (p.phase === "completed") {
    next.completedAt = Date.now();
  } else if (p.phase !== "blocked") {
    next.completedAt = null;
  }
  return next;
}

export function ImplementerLiveFeed({ project }: Props) {
  const [runs, setRuns] = useState<Map<string, RunState>>(() => new Map());
  // While subscribed to the shared notifications socket we always render "live".
  // The shared module (./lib/notifications-socket) auto-reconnects with backoff;
  // an exposed-status API isn't worth the surface for a status indicator.
  const [connected, setConnected] = useState(false);

  /* Backfill from /implementer/runs on mount + project switch ---------------- */
  useEffect(() => {
    let cancelled = false;
    listImplementerRuns(project ?? undefined, 10)
      .then((res) => {
        if (cancelled) return;
        setRuns((current) => {
          const next = new Map(current);
          for (const r of res.runs) {
            // Don't clobber a run that's actively reporting via WS.
            if (next.has(r.nodeId)) continue;
            next.set(r.nodeId, hydrateFromList(r));
          }
          return next;
        });
      })
      .catch(() => { /* feed is best-effort */ });
    return () => { cancelled = true; };
  }, [project]);

  /* WebSocket subscription --------------------------------------------------- */
  // Subscribe via the shared notifications-socket module so we don't open a
  // second physical WS to the same channel. App.tsx (ribbon) is the other
  // subscriber. See ../lib/notifications-socket.
  useEffect(() => {
    setConnected(true);
    const unsub = subscribeNotifications((parsed) => {
      if (!parsed || typeof parsed !== "object") return;
      const f = parsed as { type?: string };
      if (f.type !== "implementer.event") return;
      const frame = parsed as ImplementerEventFrame;
      if (project && frame.payload.project !== project) return;
      setRuns((current) => {
        const next = new Map(current);
        const prev = next.get(frame.payload.nodeId) ?? null;
        next.set(frame.payload.nodeId, applyEvent(prev, frame.payload));
        return next;
      });
    });
    return () => {
      setConnected(false);
      unsub();
    };
  }, [project]);

  /* Auto-collapse 8s after completed ---------------------------------------- */
  useEffect(() => {
    const id = window.setInterval(() => {
      setRuns((current) => {
        let mutated = false;
        const next = new Map(current);
        for (const [k, r] of next) {
          if (
            r.phase === "completed" &&
            r.expanded === null &&
            r.completedAt &&
            Date.now() - r.completedAt > 8000
          ) {
            next.set(k, { ...r, expanded: false });
            mutated = true;
          }
        }
        return mutated ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const orderedRuns = useMemo(() => {
    return [...runs.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }, [runs]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setRuns((current) => {
      const next = new Map(current);
      const r = next.get(nodeId);
      if (!r) return current;
      const explicit = r.expanded === null ? !defaultExpanded(r) : !r.expanded;
      next.set(nodeId, { ...r, expanded: explicit });
      // Lazy-load diff on first expand.
      if (explicit && r.diff === null && !r.diffLoading) {
        void loadDiff(nodeId, r.project, setRuns);
      }
      return next;
    });
  }, []);

  if (orderedRuns.length === 0) {
    return (
      <div className="impl-feed">
        <div className="impl-feed-header">
          <span className="impl-feed-title">Implementer activity</span>
          <span className="impl-feed-status" data-connected={connected}>{connected ? "live" : "reconnecting…"}</span>
        </div>
        <div className="impl-feed-empty">no implementer runs yet.</div>
      </div>
    );
  }

  return (
    <div className="impl-feed">
      <div className="impl-feed-header">
        <span className="impl-feed-title">Implementer activity</span>
        <span className="impl-feed-status" data-connected={connected}>{connected ? "live" : "reconnecting…"}</span>
      </div>
      <ul className="impl-feed-list">
        {orderedRuns.map((r) => {
          const expanded = r.expanded === null ? defaultExpanded(r) : r.expanded;
          return (
            <li key={`${r.project}/${r.nodeId}`} className={`impl-feed-row ${phaseClass(r.phase)}`}>
              <button
                type="button"
                className="impl-feed-rowhead"
                onClick={() => toggleExpanded(r.nodeId)}
                aria-expanded={expanded}
              >
                <span className="impl-feed-dot" data-phase={r.phase} />
                <span className="impl-feed-label">implementing {r.summary}</span>
                <span className="impl-feed-pill" data-phase={r.phase}>{PHASE_COPY[r.phase]}</span>
                <span className="impl-feed-meta">
                  {(Array.isArray(r.files) ? r.files.length : 0)} files · {fmtBytes(r.diff_bytes)} · {r.mode}
                </span>
              </button>
              {expanded && (
                <div className="impl-feed-body">
                  {r.allocator && (
                    <div className="impl-feed-section">
                      <div className="impl-feed-section-title">allocator</div>
                      <div className="impl-feed-section-body">
                        <strong>{r.allocator.verdict}</strong>
                        {typeof r.allocator.confidence === "number" && (
                          <span className="impl-feed-conf"> · conf {r.allocator.confidence.toFixed(2)}</span>
                        )}
                        {r.allocator.reason && <div className="impl-feed-reason">{r.allocator.reason}</div>}
                      </div>
                    </div>
                  )}
                  <div className="impl-feed-section">
                    <div className="impl-feed-section-title">where</div>
                    <div className="impl-feed-section-body">
                      mode: <code>{r.mode}</code>
                      {r.branch && <> · branch: <code>{r.branch}</code></>}
                      {r.commit && <> · commit: <code>{r.commit.slice(0, 8)}</code></>}
                      {r.run_dir && <div className="impl-feed-runpath"><code>{r.run_dir}</code></div>}
                    </div>
                  </div>
                  {r.files.length > 0 && (
                    <div className="impl-feed-section">
                      <div className="impl-feed-section-title">files ({r.files.length})</div>
                      <ul className="impl-feed-files">
                        {r.files.slice(0, 30).map((f) => <li key={f}><code>{f}</code></li>)}
                      </ul>
                    </div>
                  )}
                  {(r.phase === "blocked" || r.error) && (r.reason || r.error) && (
                    <div className="impl-feed-section impl-feed-section-blocked">
                      <div className="impl-feed-section-title">why blocked</div>
                      <div className="impl-feed-section-body">
                        {r.reason && <div className="impl-feed-reason"><code>{r.reason}</code></div>}
                        {r.error && <pre className="impl-feed-pre">{r.error.slice(0, 4000)}</pre>}
                      </div>
                    </div>
                  )}
                  <div className="impl-feed-section">
                    <div className="impl-feed-section-title">diff</div>
                    <div className="impl-feed-section-body">
                      {r.diffLoading && <div>loading diff…</div>}
                      {!r.diffLoading && r.diff && (
                        <pre className="impl-feed-pre">{r.diff.slice(0, 60_000)}</pre>
                      )}
                      {!r.diffLoading && !r.diff && <div className="impl-feed-empty">(no diff loaded)</div>}
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function defaultExpanded(r: RunState): boolean {
  if (r.phase === "blocked") return true;
  return false;
}

function hydrateFromList(r: ImplementerRunsListEntry): RunState {
  const phase: Phase =
    r.state === "blocked" ? "blocked"
      : r.state === "review" ? "completed"
        : r.state === "in-progress" ? "writing"
          : "completed";
  return {
    nodeId: r.nodeId,
    project: r.project,
    summary: r.nodeId, // we don't get title in the list response
    phase,
    ts: r.timestamp,
    files: r.files ?? [],
    diff_bytes: r.diff_bytes ?? 0,
    mode: r.mode,
    branch: r.branch,
    run_dir: null,
    commit: null,
    allocator: r.reason ? { verdict: "", reason: r.reason } : null,
    reason: null,
    error: null,
    expanded: null,
    diff: null,
    diffLoading: false,
    completedAt: phase === "completed" ? Date.now() - 9000 : null, // already past auto-collapse window
  };
}

function loadDiff(
  nodeId: string,
  project: string,
  setRuns: React.Dispatch<React.SetStateAction<Map<string, RunState>>>,
): Promise<void> {
  setRuns((current) => {
    const next = new Map(current);
    const r = next.get(nodeId);
    if (r) next.set(nodeId, { ...r, diffLoading: true });
    return next;
  });
  return getImplementerDiff("", project, nodeId)
    .then((d) => {
      setRuns((current) => {
        const next = new Map(current);
        const r = next.get(nodeId);
        if (r) next.set(nodeId, { ...r, diff: d.diff || "(no diff)", diffLoading: false });
        return next;
      });
    })
    .catch((e: unknown) => {
      setRuns((current) => {
        const next = new Map(current);
        const r = next.get(nodeId);
        if (r) next.set(nodeId, { ...r, diff: `(diff fetch error: ${String(e).slice(0, 200)})`, diffLoading: false });
        return next;
      });
    });
}
