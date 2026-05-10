/**
 * Smoke test for Session 4 — Consultation node end-to-end.
 *
 * Runs in-process (no HTTP). Exercises:
 *   1. proposeNode creates a Consultation with the right plan.md template
 *   2. updateNodeMeta accepts the six Consultation fields
 *   3. The HTTP-route ripple (we replicate it inline here since smoke-tests
 *      shouldn't spin up the server) writes the brain artifact, posts a
 *      comment, and records a `consultation_answered` event.
 *   4. Boot prompt surfaces unanswered Consultations (and stops once answered).
 *
 * Usage:
 *   cd backend
 *   bun src/agent/smoke-consultation.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { proposeNode, updateNodeMeta, getNode, listNodes, ensureCanvas } from "~/project/canvas";
import { resumeBootPrompt } from "~/agent/boot-prompts";
import { postAgentComment, recordNodeEvent } from "~/project/canvas-comments";
import { getDb } from "~/db";

const PROJECT = "_smoke_consultation";

function setup(): void {
  const dir = resolve(config.projectsDir, PROJECT);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // minimal project meta so projectMeta() returns a stage
  writeFileSync(
    resolve(dir, "meta.json"),
    JSON.stringify({ name: PROJECT, description: "smoke", stage: "pre-mvp" }, null, 2),
  );
  ensureCanvas(PROJECT);
}

function ok(label: string, cond: boolean, detail?: string): void {
  const tag = cond ? "✓" : "✗";
  console.log(`  ${tag} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log("[smoke-consultation] setup");
  setup();

  // 1. Create a Consultation node ───────────────────────────────────────────
  console.log("[smoke-consultation] step 1 — propose Consultation");
  const node = proposeNode({
    project: PROJECT,
    kind: "Consultation",
    intent: "Verify whether the regulation permits collecting an advance payment before contract finalization.",
    title: "advance payment legality",
    confidence: "medium",
    proposed_by: "founder",
    priority: "P1-soon",
  });
  ok("Consultation node created", node.kind === "Consultation");
  const planMd = readFileSync(resolve(config.projectsDir, PROJECT, "canvas", "nodes", node.id, "plan.md"), "utf-8");
  ok("plan.md uses Consultation template", planMd.includes("# Consultation:") && planMd.includes("## Question") && planMd.includes("## Answer (filled when conversation completes)"));

  // 2. Patch in the six fields (no answer yet — boot prompt should surface) ─
  console.log("[smoke-consultation] step 2 — patch initial fields");
  const before = updateNodeMeta(PROJECT, node.id, {
    expert_role: "Legal counsel",
    channel: "email",
    question: "Does the regulation permit a 10% advance pre-contract for verified-vendor scenarios?",
    deadline: "2026-05-12",
  });
  ok("expert_role saved", before.expert_role === "Legal counsel");
  ok("channel saved", before.channel === "email");
  ok("deadline saved", before.deadline === "2026-05-12");
  ok("answer still empty", !before.answer);

  // 3. Boot prompt surfaces this Consultation ──────────────────────────────
  console.log("[smoke-consultation] step 3 — boot prompt mentions pending consultation");
  // resumeBootPrompt requires nodes.length > 1 for resume mode, but we only
  // have 1 node. The function still composes the discussion lines block
  // regardless of mode, so we call it directly.
  const boot = resumeBootPrompt(PROJECT, "founder", "drafter");
  ok("boot prompt mentions consultations block", boot.includes("Pending: discussions and consultations"));
  ok("boot prompt mentions expert role", boot.toLowerCase().includes("legal counsel"));
  ok("boot prompt mentions deadline", boot.includes("2026-05-12"));

  // 4. Founder pastes the answer — replicate the route's ripple. The
  // smoke test isn't a server boot, so we PATCH meta and then run the
  // ripple block manually (mirrors the http.ts route handler).
  console.log("[smoke-consultation] step 4 — paste answer + run ripple");
  const priorMeta = getNode(PROJECT, node.id);
  const ANSWER_TEXT = "The regulation caps pre-contract advance at 10% of total value. Above that requires a registered agreement. 10% is safe.";
  const answeredAt = new Date().toISOString();
  const after = updateNodeMeta(PROJECT, node.id, {
    answer: ANSWER_TEXT,
    answered_at: answeredAt,
  });
  ok("answer persisted", after.answer === ANSWER_TEXT);
  ok("answered_at stamped", after.answered_at === answeredAt);

  // Brain artifact write (mirrors the route).
  const brainDir = resolve(config.atelierRoot, "og_artifacts/brain/projects", PROJECT, "consultations");
  mkdirSync(brainDir, { recursive: true });
  const brainPath = resolve(brainDir, `${node.id}.md`);
  const md = [
    `# ${after.expert_role}: ${(after.question ?? "").slice(0, 60)}`,
    ``,
    `**Asked:** ${after.created_at}`,
    `**Channel:** ${after.channel}`,
    `**Answered:** ${after.answered_at}`,
    ``,
    `## Question`,
    after.question ?? "",
    ``,
    `## Answer`,
    after.answer ?? "",
    ``,
  ].join("\n");
  writeFileSync(brainPath, md, "utf-8");
  postAgentComment(PROJECT, node.id, "system", `answer recorded — written to brain at consultations/${node.id}.md.`);
  recordNodeEvent(PROJECT, node.id, "founder", "consultation_answered", {
    expert_role: after.expert_role,
    channel: after.channel,
    brain_path: `og_artifacts/brain/projects/${PROJECT}/consultations/${node.id}.md`,
    summary: `consultation answered · ${after.expert_role} via ${after.channel}`,
  });

  ok("brain artifact written", existsSync(brainPath));
  const brainContent = readFileSync(brainPath, "utf-8");
  ok("brain artifact contains answer", brainContent.includes("The regulation caps pre-contract advance at 10%"));

  // 5. Verify comment + event landed ─────────────────────────────────────────
  console.log("[smoke-consultation] step 5 — verify comment + event");
  const db = getDb();
  const comments = db.query(
    `SELECT author_role, body FROM canvas_node_comments WHERE project = ? AND node_id = ? ORDER BY id`,
  ).all(PROJECT, node.id) as Array<{ author_role: string; body: string }>;
  const sysComment = comments.find(c => c.author_role === "system" && c.body.includes("answer recorded"));
  ok("system comment posted on answer", !!sysComment);

  const events = db.query(
    `SELECT kind, payload FROM canvas_node_events WHERE project = ? AND node_id = ? ORDER BY id`,
  ).all(PROJECT, node.id) as Array<{ kind: string; payload: string | null }>;
  const answerEvent = events.find(e => e.kind === "consultation_answered");
  ok("consultation_answered event recorded", !!answerEvent);

  // 6. Boot prompt no longer surfaces this Consultation (answer is set) ─────
  console.log("[smoke-consultation] step 6 — boot prompt drops answered consultation");
  // Need ≥2 nodes for resume mode. Add a sibling so the path runs.
  proposeNode({
    project: PROJECT,
    kind: "Decision",
    intent: "Lock pricing tier model",
    title: "pricing lock",
    confidence: "high",
    proposed_by: "founder",
  });
  const bootAfter = resumeBootPrompt(PROJECT, "founder", "drafter");
  // The Consultation should no longer appear because answer is non-empty.
  // (mark_for_discussion was never set, so no discussion entry either.)
  ok(
    "boot prompt no longer mentions answered consultation",
    !bootAfter.includes("Legal counsel") || !bootAfter.includes("Pending: discussions and consultations"),
  );

  console.log(`[smoke-consultation] done · project=${PROJECT} node=${node.id}`);
  console.log(`[smoke-consultation] brain artifact: ${brainPath}`);
  console.log(`[smoke-consultation] nodes: ${listNodes(PROJECT).length}`);
  if (process.exitCode === 1) {
    console.error("[smoke-consultation] FAILED");
  } else {
    console.log("[smoke-consultation] PASS");
  }
}

void main();
