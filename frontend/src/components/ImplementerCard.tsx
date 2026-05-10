/**
 * ImplementerCard — state-aware section embedded in NodeDetail.
 *
 * Reads /implementer/status/:project/:nodeId and surfaces:
 *   - allocator verdict + confidence + reason (last run)
 *   - tool count, tokens in/out, elapsed, attempt
 *   - branch name, diff size, tsc ok/fail
 *   - state-conditional actions:
 *       approved → "Run Implementer"  (POST /implementer/run)
 *       in-progress → spinner + elapsed timer
 *       review → "Approve & merge" / "Reject" / "Request senior review"
 *       blocked → "Show last error" / "Retry"
 *
 * Diff preview opens inline (collapsed by default) when state=review or blocked.
 *
 * Visual: monospace tokens + sage palette, three CSS classes from
 * atelier-components.css: .impl-stats, .impl-btn-primary, .impl-diff-preview.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getImplementerStatus, getImplementerDiff, runImplementer,
  approveImplementer, rejectImplementer, seniorReviewImplementer,
  getCoherence,
  type ImplementerStatusResponse, type ImplementerRunResult, type CoherenceViolation,
} from "../lib/api";

interface Props {
  baseUrl: string;
  project: string;
  nodeId: string;
  nodeState: string;
  onStateChanged?: () => void;
}

export function ImplementerCard({ baseUrl, project, nodeId, nodeState, onStateChanged }: Props) {
  const [status, setStatus] = useState<ImplementerStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStartAt, setRunStartAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reviewReport, setReviewReport] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [coherence, setCoherence] = useState<CoherenceViolation[]>([]);

  // Refresh coherence violations when the node id changes or after a state
  // transition. Same gate as the worker pre-flight, surfaced here so the
  // founder sees the obstruction at the card without first hitting "run".
  useEffect(() => {
    let cancelled = false;
    getCoherence(project).then(({ violations }) => {
      if (cancelled) return;
      setCoherence(violations.filter(v => v.consumerNodeId === nodeId));
    }).catch(() => { if (!cancelled) setCoherence([]); });
    return () => { cancelled = true; };
  }, [project, nodeId, nodeState]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getImplementerStatus(baseUrl, project, nodeId);
      setStatus(s);
    } catch (e) {
      setErrorMsg(String(e).slice(0, 240));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, project, nodeId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Tick the elapsed timer once a second while running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Polling fallback — while a run is active, refresh status every 3s. The
  // live feed reads WS frames first; this catches the case where a tab missed
  // a frame (reconnect race, page just opened mid-run).
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => { loadStatus(); }, 3000);
    return () => clearInterval(id);
  }, [running, loadStatus]);

  // Also poll while node is in-progress according to backend state.
  useEffect(() => {
    if (status?.state !== "in-progress") return;
    const id = setInterval(() => { loadStatus(); }, 3000);
    return () => clearInterval(id);
  }, [status?.state, loadStatus]);

  const stateLive = status?.state ?? nodeState;
  const last = status?.last_run ?? null;

  const handleRun = async () => {
    setErrorMsg(null);
    setRunning(true);
    setRunStartAt(Date.now());
    try {
      const result: ImplementerRunResult = await runImplementer(baseUrl, project, nodeId);
      if (result.finalState === "blocked") {
        setErrorMsg(result.reason || "blocked");
      }
      await loadStatus();
      onStateChanged?.();
    } catch (e) {
      setErrorMsg(String(e).slice(0, 240));
    } finally {
      setRunning(false);
      setRunStartAt(null);
    }
  };

  const handleApprove = async () => {
    setErrorMsg(null);
    try {
      await approveImplementer(baseUrl, project, nodeId);
      await loadStatus();
      onStateChanged?.();
    } catch (e) {
      setErrorMsg(String(e).slice(0, 240));
    }
  };

  const handleReject = async () => {
    if (!confirm("Reject the Implementer's diff? This drops the impl branch.")) return;
    setErrorMsg(null);
    try {
      await rejectImplementer(baseUrl, project, nodeId);
      await loadStatus();
      onStateChanged?.();
    } catch (e) {
      setErrorMsg(String(e).slice(0, 240));
    }
  };

  const handleSeniorReview = async () => {
    setErrorMsg(null);
    setReviewing(true);
    setReviewReport(null);
    try {
      const r = await seniorReviewImplementer(baseUrl, project, nodeId);
      setReviewReport(r.report ?? "(empty review)");
      await loadStatus();
    } catch (e) {
      setErrorMsg(String(e).slice(0, 240));
    } finally {
      setReviewing(false);
    }
  };

  const handleToggleDiff = useCallback(async () => {
    if (diffOpen) { setDiffOpen(false); return; }
    setDiffOpen(true);
    if (diffText !== null) return;
    setDiffLoading(true);
    try {
      const d = await getImplementerDiff(baseUrl, project, nodeId);
      setDiffText(d.diff || "(no diff)");
    } catch (e) {
      setDiffText(`(diff fetch error: ${String(e).slice(0, 200)})`);
    } finally {
      setDiffLoading(false);
    }
  }, [baseUrl, project, nodeId, diffOpen, diffText]);

  // Auto-open the diff once when we land in blocked with bytes on disk —
  // founder shouldn't have to click "view diff" to learn what landed before
  // the run surrendered. We synchronize against the rendered state by setting
  // a small derived flag rather than calling setState directly in the effect.
  const autoShownRef = useRef(false);
  const shouldAutoShowDiff =
    status?.state === "blocked" &&
    !!status?.last_run &&
    (status.last_run?.diff_bytes ?? 0) > 0;
  useEffect(() => {
    if (autoShownRef.current) return;
    if (!shouldAutoShowDiff) return;
    autoShownRef.current = true;
    // Synchronizing UI to a derived "we just landed in blocked" trigger;
    // toggling diff state inside the effect is the intended behavior.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void handleToggleDiff();
  }, [shouldAutoShowDiff, handleToggleDiff]);

  const elapsedSec = runStartAt ? Math.floor((Date.now() - runStartAt) / 1000 + tick * 0) : 0;

  return (
    <div className="impl-card">
      <div className="impl-card-head">
        <h3 className="node-detail-section-title">Implementer</h3>
        <span className="badge" data-b={mapStateToBadge(stateLive)}>
          <span className="dot" /> {stateLive}
        </span>
      </div>

      {loading && <div className="node-detail-hint">loading run history…</div>}
      {/* Empty card — shown when there's no run history yet AND state isn't
          actively running. Copy varies per state so the founder always knows
          the next move. */}
      {!loading && !last && stateLive !== "in-progress" && (
        <div className="impl-card-empty">
          {stateLive === "approved" || stateLive === "proposed"
            ? "No run yet. The plan is ready — click “run implementer” below to start."
            : stateLive === "done"
              ? "Node shipped. The Implementer's diff was approved and merged into your wip branch."
              : stateLive === "blocked"
                ? "Node is blocked. Edit the plan below (or run again) to retry."
                : `Node is ${stateLive}.`}
        </div>
      )}

      {/* State-specific banners with last_run context — surface the actionable
          info up-top so the founder doesn't have to scroll a stat grid to
          understand WHY a node is in its current state. */}
      {!loading && last && stateLive === "done" && (
        <div className="impl-card-empty" style={{ borderLeftColor: "var(--a-accent)", color: "var(--a-ink-2)" }}>
          ✓ Shipped — diff approved + merged. The history below shows what the Implementer did.
        </div>
      )}

      {!loading && last && stateLive === "blocked" && last.allocation?.verdict === "hand_back" && (
        <div className="impl-card-empty" style={{ borderLeftColor: "var(--sem-orange, #E8A86A)", color: "var(--a-ink-2)" }}>
          <strong>Allocator declined this node.</strong>
          <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
            {last.allocation?.reason}
          </div>
          <div style={{ marginTop: 6, fontSize: "var(--t-1)", color: "var(--a-ink-2)" }}>
            Edit the plan below — typically tighten the <strong>Acceptance</strong> section to filesystem-/shell-checkable bullets, ensure every <strong>Planned artifact</strong> is a concrete relative path, and capture build order via <strong>depends-on</strong> edges. Then click <strong>retry</strong>.
          </div>
        </div>
      )}

      {!loading && last && stateLive === "blocked" && last.allocation?.verdict !== "hand_back" && (
        <div className="impl-card-empty" style={{ borderLeftColor: "var(--sem-orange, #E8A86A)", color: "var(--a-ink-2)" }}>
          <strong>Implementer surrendered.</strong>
          <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
            {last.qwen_exit_code !== 0
              ? `qwen-code exit ${last.qwen_exit_code}`
              : !last.tsc_ok
                ? "tsc --noEmit failed after the run"
                : last.diff_bytes === 0
                  ? "no diff produced (worker ran but didn't write files)"
                  : "see qwen output below"}
          </div>
          <div style={{ marginTop: 6, fontSize: "var(--t-1)", color: "var(--a-ink-2)" }}>
            Inspect the worker's last response below, fix the underlying issue (often the plan needs sharpening or the model needs a different approach), then click <strong>retry</strong>.
          </div>
        </div>
      )}

      {last && (
        <>
          {/* Allocator card renders only when the run record actually carries an
              allocation. Older execution-log entries (pre-allocator-field) and
              non-qwen flows (e.g. local-mode auto-delivery) leave allocation
              unset — guard explicitly rather than crash the card. */}
          {last.allocation && (
            <div className="impl-allocator np-section-withaction">
              <div>
                <div className="impl-stat-label">allocator</div>
                <div className="impl-allocator-text">
                  <strong>{last.allocation.verdict}</strong>
                  {" — "}{last.allocation.reason}
                </div>
              </div>
              <span className="badge" data-b={last.allocation.confidence >= 0.7 ? "done" : "review"}>
                <span className="dot" /> conf {last.allocation.confidence.toFixed(2)}
              </span>
            </div>
          )}

          <div className="impl-stats">
            <div>
              <div className="impl-stat-label">tools</div>
              <div className="impl-stat-value">{last.tools_called}</div>
            </div>
            <div>
              <div className="impl-stat-label">tokens in / out</div>
              <div className="impl-stat-value">{last.tokens_in.toLocaleString()} / {last.tokens_out.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">qwen exit</div>
              <div className="impl-stat-value">{last.qwen_exit_code}</div>
            </div>
            <div>
              <div className="impl-stat-label">tsc</div>
              <div className="impl-stat-value">{last.tsc_ok ? "ok" : "fail"}</div>
            </div>
            <div>
              <div className="impl-stat-label">diff bytes</div>
              <div className="impl-stat-value">{last.diff_bytes.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">files</div>
              <div className="impl-stat-value">{last.files_touched.length}</div>
            </div>
          </div>

          {status?.branch && (
            <div className="impl-branch-line">
              <span className="impl-stat-label">branch</span>
              <code className="impl-branch-code">{status.branch}</code>
            </div>
          )}
          {status?.mode && (
            <div className="impl-branch-line">
              <span className="impl-stat-label">mode</span>
              <code className="impl-branch-code">{status.mode}</code>
              {status.mode === "local" && status.run_dir && (
                <code className="impl-branch-code" style={{ marginLeft: 8, opacity: 0.7 }}>{status.run_dir}</code>
              )}
            </div>
          )}
        </>
      )}

      {/* Coherence gate banner — shows when the cross-artifact gate has
          flagged this node. Run button disabled while present (the worker
          would fail-fast anyway, but disabling avoids the wasted round-trip
          and makes the obstruction visible). One concrete remediation per
          violation: add a depends-on edge or split the duplicate producer. */}
      {coherence.length > 0 && (
        <div
          className="impl-card-empty"
          role="alert"
          style={{ borderLeftColor: "var(--sem-orange, #E8A86A)", color: "var(--a-ink-2)" }}
        >
          <strong>Coherence gate — {coherence.length} cross-artifact violation{coherence.length === 1 ? "" : "s"}.</strong>
          <ul style={{ margin: "6px 0 0 0", padding: "0 0 0 18px", fontSize: "var(--t-1)", lineHeight: 1.5 }}>
            {coherence.map((v, i) => (
              <li key={i} style={{ fontFamily: "var(--font-mono)" }}>
                <strong>{v.kind}</strong>: <code>{v.artifact}</code>
                {v.kind === "missing-depends-on" && (
                  <> — add a depends-on edge from <code>{v.producerNodeIds.join(" / ")}</code> to this node, or fold both into a Decision contract.</>
                )}
                {v.kind === "duplicate-producer" && (
                  <> — also claimed by <code>{v.producerNodeIds.join(", ")}</code>. Consolidate or split.</>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action row — primary trigger ALWAYS visible (except while a run is
          actively in progress). State only changes the label. Founder can
          always force a fresh run regardless of mode (manual / semi-auto /
          auto) — agent mode controls auto-promotion behavior, not whether
          the founder can manually trigger. */}
      <div className="impl-actions">
        {(stateLive === "in-progress" || running) ? (
          <div className="impl-running">
            <span className="now-start-dot" /> agent active · {elapsedSec}s
          </div>
        ) : (
          <button
            className="impl-btn-primary"
            onClick={stateLive === "review" ? handleApprove : handleRun}
            disabled={coherence.length > 0 && stateLive !== "review" && stateLive !== "done"}
            title={
              coherence.length > 0 && stateLive !== "review" && stateLive !== "done"
                ? "Coherence gate would fail-fast — resolve the violations above first" :
              stateLive === "review"  ? "git merge --no-ff impl/<id> into your wip branch" :
              stateLive === "blocked" ? "Re-run the Implementer worker after a previous failure" :
              stateLive === "done"    ? "Spawn a fresh Implementer run on this node" :
              "Spawn the Implementer worker on this node"
            }
          >
            {stateLive === "review"  ? "approve & merge" :
             stateLive === "blocked" ? "retry after editing plan" :
             stateLive === "done"    ? "re-run implementer" :
             coherence.length > 0    ? "blocked by coherence gate" :
             "run implementer"}
          </button>
        )}

        {/* SECONDARY actions — always present when there's a last run; some
            state-specific extras for review state. */}
        {last && (
          <button className="impl-btn-secondary" onClick={handleToggleDiff}>
            {diffOpen ? "hide diff" : "view diff"}
          </button>
        )}
        {stateLive === "review" && (
          <>
            <button className="impl-btn-secondary" onClick={handleSeniorReview} disabled={reviewing}>
              {reviewing ? "asking senior…" : "request senior review"}
            </button>
            <button className="impl-btn-tertiary" onClick={handleReject}>reject</button>
          </>
        )}
      </div>

      {errorMsg && (
        <div className="impl-error">{errorMsg}</div>
      )}

      {last && stateLive === "blocked" && last.qwen_response && (
        <details className="impl-collapsible" open>
          <summary>last response (truncated)</summary>
          <pre className="impl-pre">{last.qwen_response.slice(0, 4000)}</pre>
        </details>
      )}

      {diffOpen && (
        <div className="impl-diff-preview">
          {diffLoading && <div>loading diff…</div>}
          {!diffLoading && diffText && <pre className="impl-pre">{diffText.slice(0, 60_000)}</pre>}
        </div>
      )}

      {reviewReport && (
        <details className="impl-collapsible" open>
          <summary>senior review report</summary>
          <pre className="impl-pre">{reviewReport.slice(0, 16_000)}</pre>
        </details>
      )}
    </div>
  );
}

function mapStateToBadge(state: string): string {
  switch (state) {
    case "approved":     return "in-progress";
    case "in-progress":  return "in-progress";
    case "review":       return "review";
    case "done":         return "done";
    case "blocked":      return "blocked";
    case "abandoned":    return "blocked";
    default:             return "proposed";
  }
}
