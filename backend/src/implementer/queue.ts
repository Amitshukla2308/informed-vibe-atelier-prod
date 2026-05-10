/**
 * Implementer run queue — 6-criterion preference order.
 *
 * Source of truth for "what should the Implementer pick up next?". The
 * one-shot HTTP route already takes an explicit nodeId so it doesn't need
 * this; the auto-poller (when it ships) calls `pickNextReadyTask` every tick.
 *
 * Preference order (each tier is a tiebreaker for the next; see
 * docs/PROJECT_SHAPE.md "Locking and the queue"):
 *
 *   1. priority_score          (Drafter-computed, descending)
 *   2. lock_id                 (ascending — fairness across cycles s-1, s-2, …)
 *   3. topological readiness   (every depends_on must be in state: done)
 *   4. Surface heat tiebreaker (least-recently-touched Surface wins, prevents
 *                                one-Surface dominance)
 *   5. smaller first           (fewer Planned artifacts wins ties — small wins
 *                                build founder confidence in the auto-pipeline)
 *   6. author_age              (FIFO at the final tiebreaker — no starvation)
 *
 * `rankReadyTasks` returns the full ranked list with per-tier explanations,
 * which the founder UI can render as "why is this Task ahead of that one?".
 * `pickNextReadyTask` returns just the head.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { listNodes, type NodeMeta } from "~/project/canvas";
import { extractPlannedArtifacts } from "./worker";
import { checkCoherence } from "./coherence";

export interface QueueRanking {
  meta: NodeMeta;
  /** Final composite score; higher = earlier. Pure ordering aid for the UI. */
  score: number;
  /** Per-criterion breakdown so the panel can show "ahead because: priority 0.78, smaller (3 vs 7)". */
  reasons: {
    priority_score: number;
    lock_id: string | null;
    topo_ready: boolean;
    surface_heat: number;       // active touchers on hottest touched Surface; lower wins
    artifact_count: number;     // smaller wins
    author_age_ms: number;      // older wins (higher number)
  };
  /** Human-readable line summarizing why this Task is ranked here. UI-friendly. */
  explanation: string;
  /** Coherence-gate verdict — null when the Task has no cross-artifact violations,
   *  or a one-line summary (e.g. "missing-depends-on:posts.json") when blocked.
   *  The auto-poller skips coherence-blocked Tasks; the founder UI shows them
   *  greyed out with the message so the obstruction is visible. */
  coherenceBlocked: string | null;
}

/**
 * Read the plan.md off disk for the given node. Empty string on missing.
 * The implementer worktree-cache strategy doesn't apply here — queue ranking
 * runs against the canonical canvas store, not a worktree.
 */
function readPlanForNode(project: string, nodeId: string): string {
  const planPath = resolve(config.projectsDir, project, "canvas", "nodes", nodeId, "plan.md");
  if (!existsSync(planPath)) return "";
  try {
    return readFileSync(planPath, "utf-8");
  } catch {
    return "";
  }
}

function lockIdSortKey(id: string | null | undefined): string {
  // Stable sort key: pad numeric segments so "s-2-t-9" < "s-2-t-10".
  // Format expected: s-<cycle>-t-<seq>. Anything else sorts lexicographically as-is.
  if (!id) return "z~unset";
  return id.replace(/(\d+)/g, (m) => m.padStart(6, "0"));
}

/**
 * Topological readiness: every node id in `meta.dependencies` must resolve to
 * a node whose state is "done". A missing dependency is treated as not-ready
 * (safer than assuming completion).
 */
function isTopoReady(meta: NodeMeta, byId: Map<string, NodeMeta>): boolean {
  for (const dep of meta.dependencies ?? []) {
    const d = byId.get(dep);
    if (!d || d.state !== "done") return false;
  }
  return true;
}

/**
 * Surface heat for one node — count of currently-active touchers across every
 * Surface this Task touches. "Active" = state in proposed | approved | in-progress | review.
 * Lower number means the touched Surfaces are quiet and this Task won't compound load.
 */
function surfaceHeat(meta: NodeMeta, all: NodeMeta[]): number {
  let touchIds = Array.isArray(meta.touches) ? meta.touches : [];
  if (touchIds.length === 0 && meta.parent_id) {
    const parent = all.find((n) => n.id === meta.parent_id);
    touchIds = parent?.touches ?? [];
  }
  if (touchIds.length === 0) return Number.MAX_SAFE_INTEGER; // no Surface → max heat penalty (queued last)
  let heat = 0;
  for (const sid of touchIds) {
    for (const n of all) {
      if (n.id === meta.id) continue;
      if (!Array.isArray(n.touches) || !n.touches.includes(sid)) continue;
      if (n.state === "proposed" || n.state === "approved" || n.state === "in-progress" || n.state === "review") {
        heat++;
      }
    }
  }
  return heat;
}

function ageMs(meta: NodeMeta): number {
  if (!meta.created_at) return 0;
  const t = Date.parse(meta.created_at);
  return Number.isFinite(t) ? Date.now() - t : 0;
}

/**
 * Composite score used only for tie-breaking visualisation. The actual sort
 * is multi-key (see compareForQueue). Score is built so higher = earlier; it
 * gives the UI one number to render as a "rank weight" if desired.
 */
function compositeScore(r: QueueRanking["reasons"]): number {
  // priority_score dominates (weight 100), lock_id stays in the secondary key
  // path (handled by sort), surface heat is a small inverse adjustment, smaller
  // diff a smaller bonus, age a tiny tail bonus.
  const ps = Math.max(0, Math.min(1, r.priority_score)) * 100;
  const heatPenalty = Math.min(20, r.surface_heat); // cap so a runaway Surface doesn't dominate
  const sizeBonus = Math.max(0, 10 - r.artifact_count);
  const ageBonus = Math.min(5, r.author_age_ms / (24 * 60 * 60 * 1000)); // 1 point per day, cap 5
  return ps - heatPenalty + sizeBonus + ageBonus;
}

function buildExplanation(r: QueueRanking["reasons"]): string {
  const parts: string[] = [];
  parts.push(`priority ${r.priority_score.toFixed(2)}`);
  if (r.lock_id) parts.push(`lock ${r.lock_id}`);
  if (!r.topo_ready) parts.push(`waiting on deps`);
  if (r.surface_heat > 0 && r.surface_heat < Number.MAX_SAFE_INTEGER) parts.push(`heat ${r.surface_heat}`);
  parts.push(`${r.artifact_count} artifact${r.artifact_count === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Compute the ranked list of Implementer-eligible Tasks/Subtasks.
 *
 * "Eligible" = state is approved (auto-mode) OR review (after human
 * approval); kind is Task or Subtask; not superseded; topologically ready.
 *
 * The function returns ALL eligible Tasks ordered by the 6-criterion
 * preference. Callers that only want the head can take rankings[0].
 */
export function rankReadyTasks(project: string): QueueRanking[] {
  const all = listNodes(project);
  const byId = new Map(all.map((n) => [n.id, n]));

  // Run the coherence gate once per call and index by node — cheap (no IO
  // beyond plan reads which the ranker already does). The auto-poller and
  // founder UI both need to see which Tasks are blocked and why.
  const violations = checkCoherence(project);
  const blockedById = new Map<string, string[]>();
  for (const v of violations) {
    const list = blockedById.get(v.consumerNodeId) ?? [];
    list.push(`${v.kind}:${v.artifact}`);
    blockedById.set(v.consumerNodeId, list);
  }

  const candidates = all.filter((n) => {
    if (n.kind !== "Task" && n.kind !== "Subtask") return false;
    if (n.state !== "approved" && n.state !== "review") return false;
    // Skip Tasks that have a successor pointing back at them — Drafter has
    // pivoted to a replacement and the original is dead-on-the-vine. The
    // successor itself stays in the candidate set if it's eligible.
    const hasSuccessor = all.some((other) => other.supersedes === n.id);
    if (hasSuccessor) return false;
    return true;
  });

  const ranked: QueueRanking[] = candidates.map((meta) => {
    const reasons: QueueRanking["reasons"] = {
      priority_score: typeof meta.priority_score === "number" ? meta.priority_score : 0.5,
      lock_id: meta.lock_id ?? null,
      topo_ready: isTopoReady(meta, byId),
      surface_heat: surfaceHeat(meta, all),
      artifact_count: extractPlannedArtifacts(readPlanForNode(project, meta.id)).length,
      author_age_ms: ageMs(meta),
    };
    const nodeViolations = blockedById.get(meta.id);
    return {
      meta,
      score: compositeScore(reasons),
      reasons,
      explanation: buildExplanation(reasons),
      coherenceBlocked: nodeViolations ? nodeViolations.join(" · ") : null,
    };
  });

  ranked.sort(compareForQueue);
  return ranked;
}

function compareForQueue(a: QueueRanking, b: QueueRanking): number {
  // 1. Topological readiness gates everything: if one is not ready and the other is, ready wins.
  if (a.reasons.topo_ready !== b.reasons.topo_ready) {
    return a.reasons.topo_ready ? -1 : 1;
  }
  // 2. priority_score descending
  if (a.reasons.priority_score !== b.reasons.priority_score) {
    return b.reasons.priority_score - a.reasons.priority_score;
  }
  // 3. lock_id ascending (older cycle first; fair across s-1, s-2, …)
  const lockCmp = lockIdSortKey(a.reasons.lock_id).localeCompare(lockIdSortKey(b.reasons.lock_id));
  if (lockCmp !== 0) return lockCmp;
  // 4. Surface heat ascending (cooler Surface first)
  if (a.reasons.surface_heat !== b.reasons.surface_heat) {
    return a.reasons.surface_heat - b.reasons.surface_heat;
  }
  // 5. Smaller diff first (fewer Planned artifacts)
  if (a.reasons.artifact_count !== b.reasons.artifact_count) {
    return a.reasons.artifact_count - b.reasons.artifact_count;
  }
  // 6. Older first (FIFO — no starvation)
  return b.reasons.author_age_ms - a.reasons.author_age_ms;
}

/**
 * Convenience for callers who just want the next Task to run.
 * Returns null if the queue is empty.
 */
export function pickNextReadyTask(project: string): QueueRanking | null {
  // Auto-poller calls this — never hand it a coherence-blocked Task. The
  // founder still sees the blocked Task in the queue (rankReadyTasks
  // returns it with `coherenceBlocked` populated); the runner just skips.
  const ranked = rankReadyTasks(project);
  return ranked.find(r => r.coherenceBlocked === null) ?? null;
}
