/**
 * Fixer orchestrator — closes the loop on allocator hand_back.
 *
 * Polls `state=blocked` nodes that have a recent allocator-authored comment
 * and hands them to the Fixer (headless Drafter, see ~/agent/fixer.ts).
 *
 *   - reshape   → Fixer wrote a new plan.md; we persist it and transition
 *                 the node back to proposed for re-allocation.
 *   - surrender → Fixer judged the fix unsafe; we set
 *                 `mark_for_discussion=true` with Fixer's structured agenda.
 *   - skipped   → Fixer wasn't run (mode=manual, provider unsupported, or
 *                 LM Studio call failed); fall back to a generic
 *                 mark_for_discussion so the founder still gets prompted.
 *
 * No deterministic patching. Every fix goes through drafter.md + fixer.md
 * so plan re-shapes follow Drafter's actual rules.
 *
 * Single-flight, idempotent boot, re-reads agents/config.yaml each tick so
 * a kill-switch toggle is honored without restart. Per-tick gates:
 *   - yaml `fixer.auto_run: false` disables the poller loop entirely
 *     (legacy `drafter.auto_run` honored for one cycle).
 *   - DB agent_configs `fixer.mode = "manual"` keeps the loop running but
 *     skips the Fixer call — every blocked node falls to mark_for_discussion.
 */

import { config, loadAgentConfig } from "~/config";
import { listNodes, getNodeFull, updateState, type NodeMeta } from "~/project/canvas";
import { postAgentComment, recordNodeEvent, recordVerifierUnverified } from "~/project/canvas-comments";
import { runFixer, readFixerConfig } from "~/agent/fixer";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface AutoPollerSettings {
  enabled: boolean;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

// Per (project, nodeId) cooldown so we don't re-process the same blocked
// node every tick. Keyed by node-id; value is timestamp of last action.
// 5-minute cooldown per node — long enough that the founder has time to
// see the change without the worker re-firing on the same comment.
const COOLDOWN_MS = 5 * 60 * 1000;
const lastAction = new Map<string, number>();

/**
 * Background-poller kill-switch. Reads `fixer.auto_run` (default ON) from
 * agents/config.yaml. The legacy `drafter.auto_run` key (used pre-2026-05-05
 * when this loop was deterministic) is still honored for one cycle so an
 * older yaml doesn't surprise-enable autonomy after upgrade. New writes
 * should use `fixer.auto_run`.
 *
 * Per-action gating (provider, mode=manual/semi_auto/auto) lives separately
 * in the DB-backed agent_configs row for `agent_name = 'fixer'` — the
 * Settings UI writes that. This yaml gate only controls whether the tick
 * loop runs at all.
 */
function readSettings(): AutoPollerSettings {
  try {
    const cfg = loadAgentConfig() as unknown as {
      fixer?: { auto_run?: boolean; interval_ms?: number };
      drafter?: { auto_run?: boolean; interval_ms?: number }; // legacy
    };
    const fx = cfg.fixer ?? {};
    const legacy = cfg.drafter ?? {};
    // Prefer fixer.* keys; fall through to drafter.* if fixer is absent.
    const autoRun = fx.auto_run !== undefined ? fx.auto_run : legacy.auto_run;
    const intervalRaw = fx.interval_ms !== undefined ? fx.interval_ms : legacy.interval_ms;
    return {
      enabled: autoRun !== false,    // default ON
      intervalMs: Math.max(MIN_INTERVAL_MS, Number(intervalRaw) || DEFAULT_INTERVAL_MS),
    };
  } catch {
    return { enabled: true, intervalMs: DEFAULT_INTERVAL_MS };
  }
}

interface CommentRow {
  id: number;
  author_role: string;
  body: string;
  created_at: string;
}

function readCommentsForNode(project: string, nodeId: string): CommentRow[] {
  // Local require to avoid pulling the DB at module-load time before db init.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("~/db") as { getDb: () => { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } };
  try {
    return getDb()
      .query(
        `SELECT id, author_role, body, created_at
         FROM canvas_node_comments
         WHERE project = ? AND node_id = ?
         ORDER BY id DESC
         LIMIT 50`,
      )
      .all(project, nodeId) as CommentRow[];
  } catch {
    return [];
  }
}

function findParentWithKind(node: NodeMeta, all: NodeMeta[], kinds: string[]): NodeMeta | null {
  let cur: NodeMeta | null = node;
  while (cur && cur.parent_id) {
    const next = all.find((n) => n.id === cur!.parent_id) ?? null;
    if (!next) return null;
    if (kinds.includes(next.kind)) return next;
    cur = next;
  }
  return null;
}

/**
 * Hand a blocked node to the Fixer (headless Drafter operating under
 * drafter.md + fixer.md). Returns:
 *   - "reshape": Fixer wrote a new plan.md; we persisted it and
 *                transitioned the node back to proposed for re-allocation.
 *   - "surrender": Fixer judged the fix unsafe; caller should mark for
 *                  discussion using the supplied agenda.
 *   - "skipped": Fixer wasn't run (mode=manual, provider unsupported,
 *                or LM Studio call failed); caller falls back to its
 *                own mark-for-discussion path.
 *
 * No deterministic patching anywhere. The shape of the fix is whatever
 * Drafter would have written had the founder been driving the chat — see
 * agents/principles/fixer.md for the headless contract.
 */
async function runFixerOnNode(
  project: string,
  node: NodeMeta,
  allocatorReason: string,
): Promise<
  | { kind: "reshape" }
  | { kind: "surrender"; agenda: string; reason: string; why: string }
  | { kind: "skipped"; reason: string }
> {
  let plan: string;
  try { plan = getNodeFull(project, node.id).plan; } catch (e) {
    return { kind: "skipped", reason: `cannot read plan: ${String(e).slice(0, 120)}` };
  }
  // Best-effort parent context for inheritance hints.
  let parentPlan: string | null = null;
  try {
    const all = listNodes(project);
    const parent = findParentWithKind(node, all, ["Story", "Epic"]);
    if (parent) parentPlan = getNodeFull(project, parent.id).plan;
  } catch { /* ignore */ }

  const result = await runFixer({ node, plan, allocatorReason, parentPlan });

  if (result.kind === "skipped") {
    return { kind: "skipped", reason: result.reason };
  }
  if (result.kind === "surrender") {
    // Record a verifier_unverified event for the flywheel. The "axiom"
    // here is the meta-claim that Fixer should have been able to fix
    // *this* allocator hand_back; the suggested constraint is a
    // Drafter-side rule (not Fixer-side — Fixer is just a re-shape
    // of Drafter's plan, so the lesson always applies to Drafter).
    recordVerifierUnverified(
      project,
      node.id,
      "drafter",
      `Fixer should be able to fix: ${result.reason}`,
      result.why_not_fixable,
      `Drafter must avoid plans whose Allocator hand_back reason matches \`${result.reason.slice(0, 120)}\` because Fixer cannot auto-recover from this shape (why_not_fixable: ${result.why_not_fixable.slice(0, 160)}).`,
    );
    return {
      kind: "surrender",
      agenda: result.agenda,
      reason: result.reason,
      why: result.why_not_fixable,
    };
  }
  // Reshape — write the new plan.md verbatim, transition state, log.
  const planPath = resolve(config.projectsDir, project, "canvas", "nodes", node.id, "plan.md");
  try {
    writeFileSync(planPath, result.plan, "utf-8");
  } catch (e) {
    console.warn(`[drafter-bg] plan write failed for ${node.id}: ${String(e).slice(0, 200)}`);
    return { kind: "skipped", reason: `plan write failed: ${String(e).slice(0, 120)}` };
  }
  try { updateState(project, node.id, "proposed", "proposed"); } catch (e) {
    console.warn(`[drafter-bg] state transition failed for ${node.id}: ${String(e).slice(0, 200)}`);
    return { kind: "skipped", reason: `state transition failed: ${String(e).slice(0, 120)}` };
  }
  const cfg = readFixerConfig();
  postAgentComment(
    project,
    node.id,
    "drafter",
    `fixer (headless · ${cfg.provider}): re-shaped plan.md to address allocator hand_back. Re-routing to allocator.`,
  );
  recordNodeEvent(project, node.id, "drafter", "fixer-reshape", {
    provider: cfg.provider,
    allocator_reason: allocatorReason.slice(0, 240),
    summary: `fixer · re-shaped plan via ${cfg.provider}`,
  });
  return { kind: "reshape" };
}

/**
 * Mark the node for founder discussion when no auto-fix path applies.
 * Sets mark_for_discussion + writes a drafter agenda + posts a comment.
 * Boot-prompts.ts surfaces these on the founder's next Drafter session.
 */
function markForDiscussion(project: string, node: NodeMeta, allocatorReason: string, why: string): void {
  // Read the meta.json directly to flip the flag — updateNodeMeta is the
  // formal path but it pulls more dependencies; for a background worker
  // a direct write keeps the dependency surface small.
  const metaPath = resolve(config.projectsDir, project, "canvas", "nodes", node.id, "meta.json");
  let raw: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as { readFileSync: (p: string, enc: string) => string };
    raw = readFileSync(metaPath, "utf-8");
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  if (parsed.mark_for_discussion === true) return; // already flagged

  parsed.mark_for_discussion = true;
  const agenda = `Allocator hand_back: ${allocatorReason.slice(0, 240)}.\n\nDrafter could not auto-fix: ${why}.\n\nDecide: tighten the plan, drop the node, or override the allocator gate.`;
  parsed.discussion_agenda = agenda;
  // Don't auto-assign — leaves it visible to whoever opens Drafter next.
  parsed.updated_at = new Date().toISOString();
  try {
    writeFileSync(metaPath, JSON.stringify(parsed, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[drafter-bg] meta write failed for ${node.id}: ${String(e).slice(0, 200)}`);
    return;
  }

  // Session 4 (Pillar B — Consultations): when the surrender's allocator
  // reason or fixer "why" mentions an external-expert pattern, suggest the
  // founder create a Consultation node so the eventual answer can ripple
  // back through the brain. Detection is regex-only (cheap; no LLM). We
  // do NOT auto-create the Consultation — the founder owns the choice of
  // who to ask and how. Atelier surfaces the suggestion in the same comment
  // that announces the discussion flag, so it's discoverable in one place.
  const externalExpertHaystack = `${allocatorReason}\n${why}\n${node.intent ?? ""}`;
  const isExternalExpert = /\b(lawyer|legal|regulator|accountant|tax|designer|government|expert|consultation|persona|advoc|notary|CA\b|chartered)\b/i.test(externalExpertHaystack);
  const expertHint = isExternalExpert
    ? ` Suggested: create a Consultation node — assign to <expert_role> via <channel> (email / slack / calendly / phone). Atelier will track the question and ripple the answer into the brain when the off-platform conversation completes.`
    : "";

  postAgentComment(
    project,
    node.id,
    "drafter",
    `marked for discussion. Allocator hand_back: ${allocatorReason.slice(0, 200)}. I couldn't auto-fix because ${why}. Founder, please advise on the next Drafter session.${expertHint}`,
  );
  recordNodeEvent(project, node.id, "drafter", "discuss", {
    reason: allocatorReason.slice(0, 240),
    why,
    summary: "marked for discussion (drafter background)",
  });
}

async function tick(): Promise<number> {
  if (running) return 0;
  const { enabled } = readSettings();
  if (!enabled) return 0;
  running = true;
  let actions = 0;
  try {
    // Phase A is single-founder: only the active_project has live work.
    // When multi-project lands, swap this for a real listProjects() walk.
    const projectNames: string[] = config.agent.active_project ? [config.agent.active_project] : [];
    for (const project of projectNames) {
      let nodes: NodeMeta[] = [];
      try { nodes = listNodes(project); } catch { continue; }
      const blocked = nodes.filter((n) => n.state === "blocked");
      for (const node of blocked) {
        const cooldownKey = `${project}:${node.id}`;
        const last = lastAction.get(cooldownKey) ?? 0;
        if (Date.now() - last < COOLDOWN_MS) continue;

        const comments = readCommentsForNode(project, node.id);
        // Find the most recent allocator-authored comment (top of DESC list).
        const allocatorComment = comments.find((c) => c.author_role === "allocator");
        if (!allocatorComment) continue;
        // Skip if a drafter comment is already newer (we already handled this).
        const drafterAfter = comments.find((c) => c.author_role === "drafter" && c.id > allocatorComment.id);
        if (drafterAfter) {
          lastAction.set(cooldownKey, Date.now());
          continue;
        }

        const reason = allocatorComment.body;
        const fixerResult = await runFixerOnNode(project, node, reason);
        if (fixerResult.kind === "reshape") {
          lastAction.set(cooldownKey, Date.now());
          actions += 1;
          continue;
        }
        // Surrender or skipped — fall through to mark-for-discussion using
        // either Fixer's structured agenda (preferred) or a generic stub.
        if (fixerResult.kind === "surrender") {
          markForDiscussion(project, node, fixerResult.reason || reason, fixerResult.why);
          // Surrender already carries Fixer's own agenda; overwrite the
          // generic one written by markForDiscussion so the founder sees
          // Fixer's actual reasoning instead of a templated message.
          try {
            const metaPath = resolve(config.projectsDir, project, "canvas", "nodes", node.id, "meta.json");
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { readFileSync: rf } = require("node:fs") as { readFileSync: (p: string, enc: string) => string };
            const parsed = JSON.parse(rf(metaPath, "utf-8")) as Record<string, unknown>;
            parsed.discussion_agenda = fixerResult.agenda;
            parsed.updated_at = new Date().toISOString();
            writeFileSync(metaPath, JSON.stringify(parsed, null, 2), "utf-8");
          } catch { /* best-effort */ }
        } else {
          markForDiscussion(project, node, reason, fixerResult.reason);
        }
        lastAction.set(cooldownKey, Date.now());
        actions += 1;
        lastAction.set(cooldownKey, Date.now());
        actions += 1;
      }
    }
  } finally {
    running = false;
  }
  return actions;
}

export async function tickDrafterAutoPoller(): Promise<{ actions: number }> {
  return { actions: await tick() };
}

export function startDrafterAutoPoller(): void {
  if (timer) return;
  const { intervalMs } = readSettings();
  console.log(`[drafter-bg] starting · interval=${intervalMs}ms`);
  void tick();
  timer = setInterval(() => { void tick(); }, intervalMs);
}

export function stopDrafterAutoPoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
