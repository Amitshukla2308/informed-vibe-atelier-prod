/**
 * Cross-artifact coherence gate.
 *
 * Catches the failure mode that produced AtelierBrief's first 4-node static-
 * site batch: each Task verified its own files in isolation, but together
 * they referenced files only one of them produced — and there were no
 * `depends-on` edges declaring that relationship. Each acceptance contract
 * passed; the *whole* shipped 404'ing.
 *
 * The detector runs against a project's canvas and returns one violation
 * per (consumer-Task, referenced-path) pair where:
 *
 *   - some other Task produces that path (its `Planned artifacts`), AND
 *   - the consumer's plan body mentions that path (Intent, Acceptance,
 *     Non-goals, anywhere), AND
 *   - the producer is not yet `state: done`, AND
 *   - the canvas has no `depends-on` edge from producer → consumer.
 *
 * Same-path collisions (≥2 non-done Tasks both claim the same artifact in
 * their `Planned artifacts`) are also returned as a separate violation
 * `kind: "duplicate-producer"`.
 *
 * The gate is consulted by:
 *   1. `worker.runImplementerOnce` pre-flight — fails fast with
 *      `finalState: "blocked"`, `reason: "coherence:..."` rather than
 *      spawning qwen-code on a doomed plan.
 *   2. `queue.rankReadyTasks` filtering — coherence-blocked nodes drop
 *      out of the auto-poller's candidate set.
 *   3. `allocator` — verdict flips to `hand_back` when violations exist
 *      so the founder is told why instead of a silent skip.
 *
 * The detector is intentionally conservative: prose-matching uses exact
 * filename strings as they appear in `Planned artifacts`, so a typo in
 * either side hides the relationship. That's a feature — Drafter must
 * spell paths the same way it ships them, which is already the
 * filesystem-truth contract.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { config } from "~/config";
import { getGraph, type NodeMeta, type Edge } from "~/project/canvas";
import { extractPlannedArtifacts } from "./worker";

export type ViolationKind = "missing-depends-on" | "duplicate-producer";

export interface CoherenceViolation {
  kind: ViolationKind;
  /** The Task whose run is unsafe. */
  consumerNodeId: string;
  /** The path that triggered the violation. */
  artifact: string;
  /** Producers that own this path (own it in `Planned artifacts`). */
  producerNodeIds: string[];
  /** Human-readable line for ledger / UI. */
  message: string;
}

function planText(project: string, nodeId: string): string {
  const p = resolve(config.projectsDir, project, "canvas", "nodes", nodeId, "plan.md");
  if (!existsSync(p)) return "";
  try { return readFileSync(p, "utf-8"); } catch { return ""; }
}

function hasDependsOnEdge(edges: Edge[], producer: string, consumer: string): boolean {
  // Edge schema (canvas.ts:392): { from: dependency, to: dependent, kind: "depends-on" }
  return edges.some(e => e.kind === "depends-on" && e.from === producer && e.to === consumer);
}

const RX_META = /[.*+?^${}()|[\]\\]/g;
function escapeForRegex(s: string): string { return s.replace(RX_META, "\\$&"); }

/**
 * Match `artifact` in plan text by:
 *   1. backtick-wrapped form `path/to/foo.ext` (Drafter's contract canonical),
 *   2. or word-boundary form (path/to/foo.ext) preceded/followed by non-path
 *      characters — rejects "post" matching "posts.json" because there's no
 *      word boundary between "post" and "s".
 */
function referencesArtifact(plan: string, artifact: string): boolean {
  const esc = escapeForRegex(artifact);
  if (new RegExp("`" + esc + "`").test(plan)) return true;
  // Word-boundary fallback. Boundaries are any non-word char, so path
  // separators (/), dots between basename and ext (already inside artifact),
  // and whitespace all count as valid edges. The check rejects extending
  // letters/digits/underscores: "posts.json" doesn't match "posts.jsonx",
  // and "index.html" doesn't match "myindex.html".
  if (new RegExp(`(?:^|\\W)${esc}(?:$|\\W)`).test(plan)) return true;
  return false;
}

function isRunnable(meta: NodeMeta): boolean {
  return meta.kind === "Task" || meta.kind === "Subtask";
}

/**
 * Find all coherence violations across the project's runnable nodes.
 * Pure: no side effects, no canvas writes. Cheap enough to run on every
 * worker spawn and every queue rank.
 */
export function checkCoherence(project: string): CoherenceViolation[] {
  const { nodes, edges } = getGraph(project);
  const violations: CoherenceViolation[] = [];

  // Step 1: build producer map { artifactPath → producerNodeIds[] } for
  // runnable nodes that haven't shipped yet. Done nodes are out — their
  // artifacts are on disk, so consuming Tasks don't need an edge.
  const producers = new Map<string, string[]>();
  for (const n of nodes) {
    if (!isRunnable(n)) continue;
    if (n.state === "done") continue;
    const plan = planText(project, n.id);
    const artifacts = extractPlannedArtifacts(plan);
    for (const a of artifacts) {
      const list = producers.get(a) ?? [];
      list.push(n.id);
      producers.set(a, list);
    }
  }

  // Step 2: emit duplicate-producer violations (≥2 producers for same path).
  for (const [artifact, ids] of producers) {
    if (ids.length < 2) continue;
    for (const consumerNodeId of ids) {
      violations.push({
        kind: "duplicate-producer",
        consumerNodeId,
        artifact,
        producerNodeIds: ids.filter(x => x !== consumerNodeId),
        message: `${artifact} is claimed by ${ids.length} non-done Tasks (${ids.join(", ")}). Consolidate into one producer or split the path; only one Task may own a given artifact.`,
      });
    }
  }

  // Step 3: missing-depends-on. For each runnable consumer, scan its plan
  // body for any artifact path owned by another Task; require an explicit
  // `depends-on` edge from producer → consumer.
  for (const consumer of nodes) {
    if (!isRunnable(consumer)) continue;
    if (consumer.state === "done") continue;
    const consumerPlan = planText(project, consumer.id);
    if (!consumerPlan) continue;
    const ownArtifacts = new Set(extractPlannedArtifacts(consumerPlan));

    for (const [artifact, producerIds] of producers) {
      if (ownArtifacts.has(artifact)) continue;            // self-production
      const upstream = producerIds.filter(p => p !== consumer.id);
      if (upstream.length === 0) continue;
      // Bounded textual reference check. The Drafter's filesystem-truth
      // contract requires `backtick-wrapped` relative paths in plans, so we
      // first prefer the backtick form (zero false positives). Failing that,
      // we fall back to a word-boundary match — this catches looser prose
      // ("loads styles.css") while rejecting "/posts" matching "posts.json"
      // or "post" matching "posts.json".
      if (!referencesArtifact(consumerPlan, artifact)) continue;
      // Edge present from any producer? If so, this consumer is OK for that
      // artifact (it has *one* declared upstream; coherence doesn't demand
      // edges to every shadow producer in a duplicate-producer state).
      const hasEdge = upstream.some(p => hasDependsOnEdge(edges, p, consumer.id));
      if (hasEdge) continue;
      violations.push({
        kind: "missing-depends-on",
        consumerNodeId: consumer.id,
        artifact,
        producerNodeIds: upstream,
        message: `Plan references '${artifact}' which is produced by ${upstream.join(", ")}. Add a depends-on edge from the producer to this Task, or fold both into a contract Decision node first.`,
      });
    }
  }

  return violations;
}

/**
 * Returns the violations attached to one node — the slice the worker /
 * allocator / queue use to decide whether to spawn or block.
 */
export function violationsFor(project: string, nodeId: string): CoherenceViolation[] {
  return checkCoherence(project).filter(v => v.consumerNodeId === nodeId);
}
