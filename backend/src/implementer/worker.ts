/**
 * Implementer worker — orchestrator for one node.
 *
 * Synchronous one-shot path: load context → allocate → branch → run qwen-code
 * → tsc → diff → state transition → return result. The HTTP route is the only
 * caller for now; a polling daemon comes later.
 *
 * State machine on the originating canvas node:
 *   doing/approved → in-progress → review (success) | blocked (surrender or hand_back)
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { getNodeFull, listNodes, updateState, type NodeMeta } from "~/project/canvas";
import { postAgentComment, recordVerifierUnverified } from "~/project/canvas-comments";
import { verifyAxioms, summarizeAxioms, type AxiomResult } from "./axioms";
import { loadOmnigraphBrainMarkdown } from "~/session/load-omnigraph-brain";
import { config } from "~/config";

import { allocate } from "./allocator";
import { runQwenCode } from "./providers/qwen-code";
import { runClaudeCode } from "./providers/claude";
import { resolveImplementerProvider } from "./provider-select";
import { createSandbox, diffAgainstBase, commitOrSnapshot, tscOk, type SandboxHandle, type CommitResult } from "./branch";
import { appendLedger, ledgerPathFor } from "./ledger";
import { broadcastImplementerEvent } from "~/ws/implementer-events";
import type { ImplementerResult, NodeContext, LedgerEntry, AllocationResult, QwenCodeRunResult } from "./types";
import { violationsFor } from "./coherence";
import { scanGuardians } from "~/guardians/engine";
import { buildDerivation, renderDerivationForPrompt } from "./derivation";

const ATELIER_ROOT = resolve(import.meta.dir, "..", "..", "..");

/**
 * Architecture-aware pre-flight (see docs/PROJECT_SHAPE.md "Convergence rules").
 *
 * Resolve every Surface this node touches (or inherits via its parent Story/Epic),
 * union their `manifest_globs`. The Implementer's prompt is gated to this set —
 * write_file calls outside it trip the same guard as missing artifacts.
 *
 * Returns:
 *   - allowedGlobs: union of patterns. Empty array means "no manifest gate" (Drafter
 *     hasn't placed this node yet, or the touched Surfaces have no globs). The worker
 *     logs the gap but does NOT hard-block; that's the convergence-rule's job at
 *     state: approved time, not the Implementer's at run time.
 *   - touchedSurfaces: the resolved Surface metas, used in the prompt body so the
 *     model sees Surface names + statuses ("you are working inside Surface 'canvas'").
 */
function loadAllowedGlobs(project: string, meta: NodeMeta): { allowedGlobs: string[]; touchedSurfaces: NodeMeta[] } {
  const all = listNodes(project);
  // Resolve touches: own array first, then inherit from the parent Story/Epic
  // when the Task itself doesn't carry them. Subtasks fall back two hops.
  let touchIds = Array.isArray(meta.touches) ? meta.touches : [];
  if (touchIds.length === 0 && meta.parent_id) {
    const parent = all.find((n) => n.id === meta.parent_id);
    if (parent) {
      touchIds = parent.touches ?? [];
      if (touchIds.length === 0 && parent.parent_id) {
        const grand = all.find((n) => n.id === parent.parent_id);
        touchIds = grand?.touches ?? [];
      }
    }
  }

  const surfaces = touchIds
    .map((id) => all.find((n) => n.id === id))
    .filter((n): n is NodeMeta => !!n && n.kind === "Surface");

  // Union, dedup, drop empties.
  const seen = new Set<string>();
  const allowedGlobs: string[] = [];
  for (const s of surfaces) {
    for (const g of s.manifest_globs ?? []) {
      const trimmed = g.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        allowedGlobs.push(trimmed);
      }
    }
  }
  return { allowedGlobs, touchedSurfaces: surfaces };
}

/**
 * Returns the subset of `relPaths` that fall OUTSIDE every allowed glob.
 * If `allowedGlobs` is empty, returns [] (no gate).
 *
 * Uses Bun.Glob (native, fast, supports `**` and `?`). Each glob pattern is
 * matched against the relative path; a single hit anywhere in the set means
 * the path is allowed.
 */
function pathsOutsideAllowed(relPaths: string[], allowedGlobs: string[]): string[] {
  if (allowedGlobs.length === 0) return [];
  const matchers = allowedGlobs.map((g) => new Bun.Glob(g));
  const out: string[] = [];
  for (const p of relPaths) {
    const allowed = matchers.some((m) => m.match(p));
    if (!allowed) out.push(p);
  }
  return out;
}

function readImplementerPrinciple(): string {
  const p = resolve(ATELIER_ROOT, "agents", "principles", "implementer.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : "# Implementer Principles\n_(missing)_\n";
}

/** Dispatch a headless implementer run to the resolved provider. */
async function runImplementer(
  provider: string,
  opts: { cwd: string; prompt: string; timeoutMs?: number; userId?: string; principlePath?: string },
): Promise<QwenCodeRunResult> {
  if (provider === "claude") {
    return runClaudeCode({
      cwd: opts.cwd,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      systemPromptPath: opts.principlePath,
      userId: opts.userId ?? null,
    });
  }
  // qwen-code (and any unrecognized value) → local qwen path
  return runQwenCode({ cwd: opts.cwd, prompt: opts.prompt, timeoutMs: opts.timeoutMs });
}

/** Write the implementer principle to a temp file for Claude's
 *  --append-system-prompt-file (Claude ignores QWEN.md). Returns the path. */
function writePrincipleForClaude(sessionKey: string): string {
  const tmpDir = resolve(config.dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const p = resolve(tmpDir, `implementer_principle_${sessionKey}.md`);
  writeFileSync(p, readImplementerPrinciple(), "utf-8");
  return p;
}

function copyPrincipleAsQwenMd(worktreeRoot: string): void {
  const dst = resolve(worktreeRoot, "QWEN.md");
  // Worktree is a fresh git worktree off the same repo, so the path exists.
  // We overwrite QWEN.md if any exists in the working tree (safe — this is a
  // worktree-only file, never committed because of .gitignore convention).
  writeFileSync(dst, readImplementerPrinciple());
}

function buildRetryPrompt(ctx: NodeContext, missing: string[]): string {
  const missingList = missing.map((m) => `  - ${m}`).join("\n");
  return `RETRY — your previous attempt did NOT create the required files. The
runner verified the worktree filesystem and these paths from the plan's
"Planned artifacts" section are still MISSING:

${missingList}

Your previous response claimed completion. That claim was false; the file is
not on disk. \`todo_write\` does not create files; \`write_file\` does.

Do this NOW, in this exact order, with no preamble:

  1. Your VERY NEXT tool call MUST be \`write_file\` with the absolute path
     and complete contents for one of the missing files above.
  2. After write_file returns success, run \`run_shell_command\` with
     \`ls -la <that_path>\` to confirm the file exists with non-zero size.
  3. Run \`run_shell_command\` with \`cat <that_path>\` to confirm contents.
  4. Repeat 1–3 for each remaining missing file.
  5. Run \`run_shell_command\` with \`cd backend && ./node_modules/.bin/tsc --noEmit\`
     and confirm exit 0.
  6. Final response: list each created file path and the \`ls\` output line as
     proof. No table, no commentary, just paths and sizes.

The original node plan is still valid. Do NOT re-read or re-plan; the read
phase is complete. Go directly to write_file as your next tool_call.

Original plan.md (for reference, do not re-read it from disk):
${ctx.plan}

You have at most 10 tool-call cycles for this retry. If write_file fails for
a real reason (permission, path), report it explicitly with the error string.
Do not silently abandon.`;
}

/**
 * The headless prompt is written for qwen-code (references the `write_file`
 * tool and a QWEN.md principle in cwd). Claude has neither — it writes via the
 * `Write` tool and receives the principle through --append-system-prompt-file.
 * Left unadapted, Claude frequently writes nothing on the first pass and burns
 * a full retry. This swaps the tool name and the principle reference so a
 * non-qwen provider gets an accurate, imperative prompt.
 */
function adaptPromptForProvider(prompt: string, provider: string): string {
  if (provider === "qwen-code") return prompt;
  return prompt
    .replaceAll("write_file", "Write")
    .replace(
      "You are the Implementer. The principles in QWEN.md (cwd) bind you. Read them first.",
      "You are the Implementer. The Implementer principles provided in your system prompt bind you.",
    );
}

function buildHeadlessPrompt(ctx: NodeContext): string {
  // Hardened prompt — designed for non-Coder Qwen reliability. The previous
  // version permitted the model to mark todos "completed" without ever calling
  // write_file. Every loophole that made that possible is closed below.
  const brain = ctx.brainMarkdown
    ? `\n## Founder brain (3-layer, read-only context)\n\n${ctx.brainMarkdown.slice(0, 8000)}\n`
    : "";
  const derivationBlock = renderDerivationForPrompt(ctx.derivation);
  const meta = JSON.stringify(ctx.meta, null, 2);
  // Allowed-paths block. We render it only when Drafter has placed the node —
  // when allowedGlobs is empty the model gets a softer "no manifest gate"
  // notice and falls back to the existing scope rule (stay near Planned artifacts).
  const surfacesLine = (ctx.touchedSurfaces ?? [])
    .map((s) => `${s.surface_kind ?? s.title}${s.surface_status === "deprecated" ? " (deprecated)" : ""}`)
    .join(", ");
  const allowedBlock = (ctx.allowedGlobs ?? []).length > 0
    ? `\n## Allowed paths (manifest gate)\n\n` +
      `This node touches Surface(s): ${surfacesLine}.\n` +
      `Every \`write_file\` call MUST target a path matching one of these globs:\n\n` +
      (ctx.allowedGlobs ?? []).map((g) => `  - ${g}`).join("\n") +
      `\n\nWrites outside this set are rejected post-run as out-of-scope and the node ` +
      `is marked blocked, exactly like a hallucination guard trip. If a Planned artifact ` +
      `path conflicts with the manifest, STOP and surface that as a plan defect — do not ` +
      `silently widen scope.\n`
    : `\n## Allowed paths (manifest gate)\n\n` +
      `(no manifest gate set — Drafter has not placed this node under a Surface). ` +
      `Stay strictly inside the "Planned artifacts" paths and their direct dependencies. ` +
      `If you need a path outside that, surface a scoping question rather than expanding silently.\n`;

  return `You are the Implementer. The principles in QWEN.md (cwd) bind you. Read them first.

You are working on canvas node ${ctx.nodeId} of project ${ctx.project}, on a
fresh git worktree at branch impl/${ctx.nodeId}. Your job is to MAKE THE
"Planned artifacts" SECTION OF THE plan.md TRUE on disk in this worktree.

## Path discipline (CRITICAL — read carefully)

Your current working directory IS the worktree root. Every path in
"Planned artifacts" is relative to cwd. **All write_file calls MUST use
paths relative to cwd, not absolute paths starting with /home or
/projects.** Examples for a Planned artifact \`feed.xml\`:

   ✓  write_file file_path="feed.xml"        ← relative to cwd, lands in worktree
   ✓  write_file file_path="./feed.xml"       ← same thing
   ✗  write_file file_path="/home/.../feed.xml"      ← escapes the sandbox
   ✗  write_file file_path="projects/${ctx.project}/feed.xml"  ← project-root path is OUTSIDE this worktree

If you write to a path that starts with /home or any absolute path NOT
under cwd, the file lands outside the sandbox and the run is treated as
"no artifacts produced" — even though the file technically exists.
Run \`pwd\` first if you need to confirm cwd; never guess.

## Node meta.json
${meta}

## Node plan.md
${ctx.plan}
${derivationBlock}${brain}
${allowedBlock}

## Hard rules — these are not suggestions

1. **You write files via the \`write_file\` tool. There is no other path to
   completion.** Marking a todo as "completed" without a corresponding
   \`write_file\` call for that artifact is a lie. The runner will detect it,
   reject your output, and surrender the node as blocked. Specifically:
   - For every file path in the plan's "Planned artifacts" section, you MUST
     emit at least one successful \`write_file\` tool_call against that exact
     path **relative to cwd** before you may consider the task done.
   - \`todo_write\` does NOT create files. \`todo_write\` does NOT verify
     anything. \`todo_write\` is bookkeeping only and is optional.
   - If you find yourself about to say "the file has been created" or "all
     acceptance criteria verified" without having called \`write_file\` for
     each Planned artifact in this session, STOP. You are wrong. Call
     \`write_file\` first.

2. **Verify with the shell, not with reasoning.** Before you declare done:
   - Run \`run_shell_command\` with: \`ls -la <each_planned_artifact_path>\`
     and confirm the file is listed and non-empty.
   - Run \`run_shell_command\` with: \`cat <each_planned_artifact_path>\` and
     confirm the contents match the plan's Acceptance criteria.
   - If \`tsc --noEmit\` is part of the Acceptance, run it via
     \`run_shell_command\` with cwd \`backend\` (e.g.
     \`cd backend && ./node_modules/.bin/tsc --noEmit\`) and observe exit 0.
   These three shell verifications are mandatory; reasoning about whether
   they would pass does not substitute for running them.

3. **Scope.** Stay inside this worktree. Do not modify files outside the
   paths in "Planned artifacts" plus any imports/types those files
   demonstrably need. Do not delete files. Do not refactor adjacent code.

4. **Branch hygiene.** Do NOT call \`git commit\`, \`git push\`, \`git merge\`,
   or any \`git\` command that mutates state. The runner commits after you
   exit. You may use \`git diff\` and \`git status\` to inspect.

5. **Cycle ceiling.** Soft target: ~60 tool-call cycles for a typical task.
   Hard ceiling: 200 cycles, enforced by the runner. Qwen on local LM Studio
   is free and fast — over-budget is cheap; under-thinking is expensive.
   Spend the cycles on \`read_file\`/\`grep\`/\`glob\` to understand the code,
   not on \`todo_write\` cycles. Better to think long and ship right than
   surrender after a shallow read.

## Required output sequence (you MUST follow this order)

  Step A — read: glob/grep/read_file as needed to understand the relevant
           existing code. Do not skip; understanding is the cheapest insurance
           against bad edits.
  Step B — write_file: create or modify each path in "Planned artifacts".
           One \`write_file\` call per file is enough; multiple are fine.
  Step C — verify: run \`ls -la <path>\` and \`cat <path>\` for each
           artifact. Run \`tsc --noEmit\` if Acceptance demands it.
  Step D — final response: a short summary listing each artifact path with
           its post-Step-C \`ls\` line as evidence, and explicitly stating
           which Acceptance bullet each verification covered.

If Step C reveals a discrepancy (file missing, tsc fail, content wrong), go
back to Step B. Do not proceed to Step D until Step C is clean.

## What "done" actually means

You are done when, and only when, every path in "Planned artifacts" exists
on disk in the worktree, every Acceptance bullet has been observed (not
imagined) to hold, and you have proof in the shell history of this session.

Begin.`;
}

interface RunOptions {
  project: string;
  nodeId: string;
  /** Override default ATELIER_USER_ID for brain loading. */
  userId?: string;
  /** Cap qwen-code wallclock; default 30 min. */
  timeoutMs?: number;
}

export async function runImplementerOnce(opts: RunOptions): Promise<ImplementerResult> {
  const { project, nodeId } = opts;

  const startedAt = new Date().toISOString();

  // 1. Load node context.
  const { meta, plan } = getNodeFull(project, nodeId);

  // Announce the run early so the live feed sees it before allocator latency.
  broadcastImplementerEvent({
    phase: "started",
    nodeId,
    project,
    summary: (meta.title ?? nodeId).toString().slice(0, 120),
    started_at: startedAt,
  });

  // 1b. Coherence gate. Catches the failure mode where atomized Tasks
  //     reference each other's artifacts without a depends-on edge —
  //     each verifies its own files in isolation, but the *whole* ships
  //     incoherent. Fail fast with reason="coherence:..." rather than
  //     spawning qwen-code on a doomed plan.
  // 1c. Guardian scan. block-severity violations halt the run with reason
  //     "guardian:<name>". block-in-mvp violations only halt when the
  //     project is post-mvp; until then they're recorded as warnings on
  //     the run record and the worker proceeds.
  const guardianArtifacts = extractPlannedArtifacts(plan);
  const guardian = scanGuardians(project, plan, guardianArtifacts);
  if (guardian.blocking.length > 0) {
    const reason = guardian.blocking.map(v => `guardian:${v.guardian}`).join(", ");
    const detail = guardian.blocking.map(v => `${v.guardian} (${v.severity}): ${v.reason}${v.matched_text ? ` — matched ${JSON.stringify(v.matched_text)}` : ""}`).join("\n\n");
    const synthAlloc: AllocationResult = {
      verdict: "hand_back",
      reason: reason,
      confidence: 1.0,
      elapsed_s: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
    try { updateState(project, nodeId, "blocked", "blocked"); } catch { /* ignore */ }
    postAgentComment(project, nodeId, "implementer", `guardian-blocked: ${reason}\n\n${detail}`.slice(0, 4000));
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason,
      error: detail,
      files: [],
      diff_bytes: 0,
      mode: "local",
    });
    appendExecutionLog(project, nodeId, {
      timestamp: new Date().toISOString(),
      branch: "",
      worktreePath: "",
      diff_bytes: 0,
      files_touched: [],
      tsc_ok: false,
      tsc_tail: detail,
      qwen_exit_code: 0,
      qwen_response: detail,
      tokens_in: 0,
      tokens_out: 0,
      tools_called: 0,
      allocation: synthAlloc,
      mode: "local",
    });
    return {
      nodeId,
      branch: "",
      worktreePath: "",
      finalState: "blocked",
      reason: reason,
      allocation: synthAlloc,
      run: null,
      diffBytes: 0,
      tscOk: false,
      ledgerPath: ledgerPathFor(nodeId),
    };
  }
  if (guardian.warnings.length > 0) {
    console.warn(`[implementer] node ${nodeId} guardian warnings: ${guardian.warnings.map(v => v.guardian).join(", ")}`);
  }

  const violations = violationsFor(project, nodeId);
  if (violations.length > 0) {
    const reason = violations.map(v => `${v.kind}:${v.artifact}`).join(", ");
    const detail = violations.map(v => v.message).join("\n\n");
    const synthAlloc: AllocationResult = {
      verdict: "hand_back",
      reason: `coherence: ${reason}`,
      confidence: 1.0,
      elapsed_s: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
    try { updateState(project, nodeId, "blocked", "blocked"); } catch { /* ignore */ }
    postAgentComment(project, nodeId, "implementer", `coherence-blocked: ${reason}\n\n${detail}`.slice(0, 4000));
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason: `coherence: ${reason}`,
      error: detail,
      files: [],
      diff_bytes: 0,
      mode: "local",
    });
    appendExecutionLog(project, nodeId, {
      timestamp: new Date().toISOString(),
      branch: "",
      worktreePath: "",
      diff_bytes: 0,
      files_touched: [],
      tsc_ok: false,
      tsc_tail: detail,
      qwen_exit_code: 0,
      qwen_response: detail,
      tokens_in: 0,
      tokens_out: 0,
      tools_called: 0,
      allocation: synthAlloc,
      mode: "local",
    });
    return {
      nodeId,
      branch: "",
      worktreePath: "",
      finalState: "blocked",
      reason: `coherence: ${reason}`,
      allocation: synthAlloc,
      run: null,
      diffBytes: 0,
      tscOk: false,
      ledgerPath: ledgerPathFor(nodeId),
    };
  }

  const userId = opts.userId ?? "default";
  const brainObj = loadOmnigraphBrainMarkdown(userId, project);
  // Architecture-aware pre-flight — touched Surfaces' manifest_globs union
  // becomes the Implementer's write gate. Empty allowedGlobs means "no
  // manifest gate yet" (Drafter still placing this node); we log it but
  // don't hard-block, since the convergence rule already prevents new
  // Stories/Epics from reaching state: approved without touches.
  const { allowedGlobs, touchedSurfaces } = loadAllowedGlobs(project, meta);
  if (allowedGlobs.length === 0) {
    console.warn(
      `[implementer] node ${nodeId} has no allowed_globs — touched Surfaces missing or empty manifest_globs. Implementer will run without scope gate.`
    );
  }
  // A2.2: derivation chain — Story/Epic/Surface ancestors + binding
  // Decisions/Risks. The Implementer reads these as context, not as
  // instructions, and never executes against them.
  const derivation = buildDerivation(project, nodeId);
  const ctx: NodeContext = {
    project,
    nodeId,
    meta: meta as unknown as Record<string, unknown>,
    plan,
    brainMarkdown: brainObj,
    allowedGlobs,
    touchedSurfaces: touchedSurfaces.map((s) => ({
      id: s.id,
      title: s.title,
      surface_kind: s.surface_kind ?? null,
      surface_status: s.surface_status ?? null,
    })),
    derivation,
    userId: opts.userId,
  };

  // Mark in-progress immediately so concurrent runs are visible.
  try {
    updateState(project, nodeId, "in-progress", "in-progress");
  } catch (e) {
    // If the node is in a weird state, log and continue — we still want the run.
    console.warn(`[implementer] state→in-progress failed: ${String(e).slice(0, 200)}`);
  }

  // 2. Allocate.
  const allocation = await allocate(ctx);
  broadcastImplementerEvent({
    phase: "allocator",
    nodeId,
    project,
    verdict: allocation.verdict,
    reason: allocation.reason,
    confidence: allocation.confidence,
  });
  if (allocation.verdict === "hand_back") {
    updateState(project, nodeId, "blocked", "blocked");
    // Leave a human-readable note on the card (DECISIONS.md §7). Drawer's
    // comment thread reads canvas_node_comments; Activity firehose reads the
    // mirrored canvas_node_event. Best-effort — never fails the worker.
    postAgentComment(
      project,
      nodeId,
      "allocator",
      `hand_back (confidence ${allocation.confidence.toFixed(2)}): ${allocation.reason}`,
    );
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason: "allocator_handback",
      error: allocation.reason.slice(0, 800),
      files: [],
      diff_bytes: 0,
      mode: "local",
    });
    // Write hand_back to execution.jsonl so /implementer/status returns it
    // as last_run.allocation. Without this, the founder's UI sees blocked
    // state with last_run=null and no context on WHY — they had to read
    // the HTTP response of the click that triggered this. Persisting it
    // means subsequent panel opens (or page refreshes) still see the
    // hand_back reason.
    appendExecutionLog(project, nodeId, {
      timestamp: new Date().toISOString(),
      branch: "",
      worktreePath: "",
      diff_bytes: 0,
      files_touched: [],
      tsc_ok: false,
      tsc_tail: "(allocator hand_back — no qwen-code run)",
      qwen_exit_code: 0,
      qwen_response: `Allocator declined this node:\n\n${allocation.reason}\n\nTighten the plan (typically the Acceptance section, the Planned artifacts paths, or the dependencies) and click retry.`,
      tokens_in: 0,
      tokens_out: 0,
      tools_called: 0,
      allocation,
    });
    return {
      nodeId,
      branch: "",
      worktreePath: "",
      finalState: "blocked",
      reason: `hand_back: ${allocation.reason}`,
      allocation,
      run: null,
      diffBytes: 0,
      tscOk: false,
      ledgerPath: ledgerPathFor(nodeId),
    };
  }

  // 3. Sandbox — repo worktree if projectMeta.repo_path is set, otherwise
  //    a local hardlinked snapshot under <project>/.implementer-runs/.
  let handle: SandboxHandle;
  try {
    handle = createSandbox({ project, nodeId });
  } catch (e) {
    const msg = String(e).slice(0, 400);
    updateState(project, nodeId, "blocked", "blocked");
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason: msg.startsWith("snapshot_too_large") ? "snapshot_too_large" : "sandbox_create_failed",
      error: msg,
      files: [],
      diff_bytes: 0,
      mode: "local",
    });
    appendExecutionLog(project, nodeId, {
      timestamp: new Date().toISOString(),
      branch: "",
      worktreePath: "",
      diff_bytes: 0,
      files_touched: [],
      tsc_ok: false,
      tsc_tail: msg,
      qwen_exit_code: 0,
      qwen_response: msg,
      tokens_in: 0,
      tokens_out: 0,
      tools_called: 0,
      allocation,
      mode: "local",
    });
    return {
      nodeId,
      branch: "",
      worktreePath: "",
      finalState: "blocked",
      reason: msg,
      allocation,
      run: null,
      diffBytes: 0,
      tscOk: false,
      ledgerPath: ledgerPathFor(nodeId),
    };
  }
  copyPrincipleAsQwenMd(handle.path);

  // 4. Run the headless coder. Retry once with a corrective prompt if the
  //    hallucination guard would trip (planned artifacts missing on disk).
  const provider = resolveImplementerProvider(opts.userId);
  // Claude ignores QWEN.md and has no `write_file` tool, so hand it the
  // principle via --append-system-prompt-file and adapt the prompt's tool
  // name / principle reference — otherwise Claude often writes nothing on the
  // first pass and burns a full retry.
  const principlePath = provider === "claude" ? writePrincipleForClaude(nodeId) : undefined;
  console.log(`[implementer] node ${nodeId.slice(0, 8)} → provider=${provider}`);

  const plannedArtifactsForPrompt = extractPlannedArtifacts(plan);
  const prompt = adaptPromptForProvider(buildHeadlessPrompt(ctx), provider);

  broadcastImplementerEvent({
    phase: "writing",
    nodeId,
    project,
    sandbox_mode: handle.mode,
    sandbox_path: handle.path,
    planned_artifacts: plannedArtifactsForPrompt.length,
  });

  let runResult: QwenCodeRunResult;
  let attempt = 1;
  try {
    runResult = await runImplementer(provider, {
      cwd: handle.path,
      prompt,
      timeoutMs: opts.timeoutMs,
      userId: opts.userId,
      principlePath,
    });

    // Pre-flight check: did a write actually happen for missing artifacts?
    // If not, immediately re-run with an unambiguous corrective.
    const stillMissing = plannedArtifactsForPrompt.filter(
      (rel) => !existsSync(resolve(handle.path, rel)),
    );
    if (plannedArtifactsForPrompt.length > 0 && stillMissing.length > 0) {
      attempt = 2;
      console.warn(
        `[implementer] retry: ${stillMissing.length}/${plannedArtifactsForPrompt.length} planned artifacts missing after attempt 1`,
      );
      const retryPrompt = adaptPromptForProvider(buildRetryPrompt(ctx, stillMissing), provider);
      runResult = await runImplementer(provider, {
        cwd: handle.path,
        prompt: retryPrompt,
        timeoutMs: opts.timeoutMs,
        userId: opts.userId,
        principlePath,
      });
    }
  } catch (e) {
    const msg = String(e).slice(0, 300);
    const ledger: LedgerEntry = {
      ts: new Date().toISOString(),
      agent: "qwen-code",
      model: process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b",
      tokens_in: 0,
      tokens_out: 0,
      tools_called: 0,
      elapsed_s: 0,
      exit_code: -1,
      note: `spawn/timeout error: ${msg}`,
    };
    try { appendLedger(nodeId, ledger); } catch { /* ignore */ }
    updateState(project, nodeId, "blocked", "blocked");
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason: "qwen_error",
      error: msg,
      files: [],
      diff_bytes: 0,
      mode: handle.mode,
    });
    return {
      nodeId,
      branch: handle.branch,
      worktreePath: handle.path,
      finalState: "blocked",
      reason: `qwen-code error: ${msg}`,
      allocation,
      run: null,
      diffBytes: 0,
      tscOk: false,
      ledgerPath: ledgerPathFor(nodeId),
    };
  }

  // 5. Diff & files touched.
  const { diff, filesTouched } = diffAgainstBase(handle);
  runResult.diff = diff;
  runResult.files_touched = filesTouched;

  // 5b. Hallucination guard — verify every "Planned artifacts" path in the
  // plan actually exists in the worktree. This catches the failure mode where
  // qwen-code self-completes via todo_write without invoking write_file.
  const plannedArtifacts = extractPlannedArtifacts(plan);
  const missingArtifacts: string[] = [];
  for (const rel of plannedArtifacts) {
    const abs = resolve(handle.path, rel);
    if (!existsSync(abs)) missingArtifacts.push(rel);
  }
  if (plannedArtifacts.length === 0) {
    // Empty Planned artifacts means there's nothing to verify on disk.
    // Previously this short-circuited both the hallucination guard AND the
    // manifest scope guard, letting vacuous "success" through. Treat it as
    // a hard failure: a Task without concrete artifact paths should not
    // have reached qwen-code (the allocator stub-guard catches most cases),
    // and if it did, the run cannot be claimed done. Exit 121 matches the
    // hallucination-guard convention so callers handle it the same way.
    runResult.exit_code = runResult.exit_code === 0 ? 121 : runResult.exit_code;
    runResult.response =
      `[planned-artifacts guard tripped] plan.md "Planned artifacts" section is empty or only contains stubs — nothing to verify on disk. ` +
      `Tighten the plan with concrete relative paths under atelier/{projects/<active>,backend,frontend} before retrying.\n\n` +
      `--- Original model response ---\n${runResult.response}`;
  } else if (missingArtifacts.length > 0) {
    // Force a blocked outcome — model lied about completion.
    runResult.exit_code = runResult.exit_code === 0 ? 121 : runResult.exit_code;
    runResult.response =
      `[hallucination guard tripped] Plan declared ${plannedArtifacts.length} artifact(s); ${missingArtifacts.length} missing on disk: ${missingArtifacts.join(", ")}. Model claimed completion without writing the file.\n\n--- Original model response ---\n${runResult.response}`;
  }

  // 5c. Manifest scope guard — every file the worktree mutated must fall inside
  //     at least one of the touched Surfaces' manifest_globs. If the node
  //     touches no Surfaces (or all touched Surfaces have empty manifests),
  //     allowedGlobs is empty and this guard is a no-op (the convergence rule
  //     already kept this node out of state: approved if Drafter forgot to place it).
  const outOfScope = pathsOutsideAllowed(filesTouched, ctx.allowedGlobs ?? []);
  if (outOfScope.length > 0) {
    runResult.exit_code = runResult.exit_code === 0 ? 122 : runResult.exit_code;
    const surfacesLine = (ctx.touchedSurfaces ?? []).map((s) => s.title).join(", ") || "(none)";
    const manifestMsg =
      `[manifest scope guard tripped] Implementer wrote ${outOfScope.length} file(s) outside the touched Surfaces' manifest_globs.\n` +
      `  Touched Surfaces: ${surfacesLine}\n` +
      `  Out-of-scope paths:\n${outOfScope.map((p) => `    - ${p}`).join("\n")}\n` +
      `Either expand the Surface manifest (founder edits the Surface, the cascade re-broadcasts) or revise this node's plan to stay inside scope.`;
    // Order: prior diagnosis first (hallucination/empty-artifacts is more
    // actionable than scope), then the manifest detail, then qwen-code's
    // raw output. Previously the manifest message was prepended and buried
    // every other message under it, making the audit log misleading.
    runResult.response =
      `${runResult.response}\n\n--- Manifest scope guard ---\n${manifestMsg}`;
  }

  // 5d. Finalize sandbox — git commit (repo mode) or write diff.patch +
  //     summary.json (local mode). Returns the canonical files/byte/mode shape
  //     consumed by the live feed.
  let commitResult: CommitResult = {
    files: filesTouched,
    diff_bytes: diff.length,
    mode: handle.mode,
    branch: handle.branch,
    commit: null,
    run_dir: handle.mode === "local" ? handle.runDir : null,
    diff_path: handle.mode === "local" ? resolve(handle.runDir, "diff.patch") : null,
  };
  if (diff.length > 0) {
    try {
      commitResult = commitOrSnapshot(handle, {
        message: `impl(${nodeId}): ${(meta.title ?? nodeId).toString().slice(0, 60)}`,
      });
    } catch (e) {
      console.warn(`[implementer] commitOrSnapshot failed: ${String(e).slice(0, 200)}`);
    }
  }

  // 6. tsc invariant scan. Backend mode runs only if a backend/ file was
  //    touched (cheap fast path); local mode runs whenever the sandbox
  //    actually has a tsc binary near the touched files.
  const touchedBackend = filesTouched.some((f) => f.startsWith("backend/"));
  broadcastImplementerEvent({
    phase: "verifying",
    nodeId,
    project,
    files: filesTouched.length,
    diff_bytes: diff.length,
    mode: handle.mode,
  });
  let tscResult: { ok: boolean; output: string };
  if (touchedBackend || handle.mode === "local") {
    tscResult = tscOk(handle);
  } else {
    tscResult = { ok: true, output: "(skipped — no backend files touched)" };
  }

  // 7. Ledger.
  const ledger: LedgerEntry = {
    ts: new Date().toISOString(),
    agent: "qwen-code",
    model: process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b",
    tokens_in: runResult.tokens_in,
    tokens_out: runResult.tokens_out,
    tools_called: runResult.tools_called,
    elapsed_s: runResult.elapsed_s,
    exit_code: runResult.exit_code,
    note: `attempt=${attempt}; ${tscResult.ok ? "ok" : `tsc failed: ${tscResult.output.slice(-300)}`}`,
  };
  try { appendLedger(nodeId, ledger); } catch { /* ignore */ }

  // 7.5. Axiom verification (Phase 1 deterministic). Drafter writes ≤5
  // verifiable claims in `## Axioms`; we mechanically check each against
  // the worktree. Failed axioms surrender as blocked with the specific
  // claim in the comment, so Drafter can re-shape the plan rather than
  // rerunning blind. `unverified` lines (no known pattern) surface to
  // the founder but don't block.
  let axiomResults: AxiomResult[] = [];
  try {
    const planAtRunTime = getNodeFull(project, nodeId).plan;
    axiomResults = verifyAxioms(planAtRunTime, handle.path, tscResult.ok);
  } catch (e) {
    console.warn(`[implementer] axiom verification skipped: ${String(e).slice(0, 200)}`);
  }
  const axiomSummary = summarizeAxioms(axiomResults);

  // 8. State transition.
  const ok = runResult.exit_code === 0 && tscResult.ok && diff.length > 0 && axiomSummary.ok;
  if (ok) {
    updateState(project, nodeId, "review", "review");
    if (axiomSummary.unverified.length > 0) {
      // All hard axioms passed but some lines weren't pattern-matched —
      // surface to the founder but don't block. They're judgment calls.
      postAgentComment(
        project, nodeId, "implementer",
        `axioms: ${axiomSummary.passed.length} passed, ${axiomSummary.unverified.length} unverified (no matching pattern):\n` +
        axiomSummary.unverified.map(r => `  · ${r.axiom}`).join("\n"),
      );
    }

    // 8b. Ripple awareness (Session 5, TODO #30). For every file in the
    // node's "Planned artifacts", check the co-change graph: if a strongly
    // coupled neighbour (confidence > 0.7) was NOT touched in this run,
    // post a `system` comment so the founder can decide whether to follow
    // up. Diagnostic only — does not flip the node back to blocked.
    try {
      const planForRipple = getNodeFull(project, nodeId).plan;
      const planned = extractPlannedArtifacts(planForRipple);
      const touchedSet = new Set(filesTouched.map((p) => p.replace(/^\.\//, "")));
      const { computeRipple } = await import("~/ripple/ripple");
      const warnings: string[] = [];
      const seenWarn = new Set<string>();
      for (const planFile of planned) {
        const r = await computeRipple(planFile, 1, ATELIER_ROOT, { limit: 8 });
        for (const n of r.affected_files) {
          if (n.confidence <= 0.7) continue;
          if (touchedSet.has(n.path)) continue;
          if (seenWarn.has(`${planFile}\t${n.path}`)) continue;
          seenWarn.add(`${planFile}\t${n.path}`);
          const pct = Math.round(n.confidence * 100);
          const dist = n.last_change_distance < 0 ? "?" : `${n.last_change_distance}d ago`;
          warnings.push(`Ripple warning: \`${planFile}\` historically co-changes with \`${n.path}\` (confidence ${pct}%, last together ${dist}). Verify \`${n.path}\` doesn't need an update.`);
        }
      }
      if (warnings.length > 0) {
        postAgentComment(
          project, nodeId, "system",
          warnings.slice(0, 8).join("\n\n").slice(0, 4000),
        );
      }
    } catch (e) {
      console.warn(`[implementer] ripple awareness skipped: ${String(e).slice(0, 200)}`);
    }
  } else {
    updateState(project, nodeId, "blocked", "blocked");
    // Summarize why the run failed onto the comment thread (DECISIONS.md §7).
    const why =
      runResult.exit_code !== 0
        ? `qwen exit ${runResult.exit_code}`
        : !tscResult.ok
        ? `tsc failed: ${tscResult.output.slice(-500)}`
        : !axiomSummary.ok
        ? `axiom_failed: ${axiomSummary.failed.length}/${axiomResults.length}\n` +
          axiomSummary.failed.map(r => `  · ${r.axiom} — ${r.detail}`).join("\n")
        : "no diff produced";
    postAgentComment(project, nodeId, "implementer", `surrendered: ${why}`.slice(0, 4000));
    // Record one verifier_unverified event per failed axiom so the
    // flywheel can teach Drafter to write claims that hold under
    // verification. Stable templated phrasing for compiler dedup.
    if (!axiomSummary.ok) {
      for (const r of axiomSummary.failed) {
        recordVerifierUnverified(
          project,
          nodeId,
          "drafter",
          r.axiom,
          r.detail,
          `Drafter must only emit \`## Axioms\` claims that hold post-Implementer; the claim \`${r.axiom}\` failed verification with: ${r.detail.slice(0, 160)}`,
        );
      }
    }
  }

  // Append a tail-of-execution log to the node meta extras for founder visibility.
  appendExecutionLog(project, nodeId, {
    timestamp: new Date().toISOString(),
    branch: handle.branch,
    worktreePath: handle.path,
    diff_bytes: diff.length,
    files_touched: filesTouched,
    tsc_ok: tscResult.ok,
    tsc_tail: tscResult.output.slice(-1500),
    qwen_exit_code: runResult.exit_code,
    qwen_response: runResult.response.slice(0, 4000),
    tokens_in: runResult.tokens_in,
    tokens_out: runResult.tokens_out,
    tools_called: runResult.tools_called,
    allocation,
    mode: handle.mode,
    run_dir: handle.mode === "local" ? handle.runDir : null,
    commit: commitResult.commit ?? null,
  });

  // Final phase event — live feed flips the row to its terminal state.
  if (ok) {
    broadcastImplementerEvent({
      phase: "completed",
      nodeId,
      project,
      state: "review",
      files: filesTouched,
      diff_bytes: diff.length,
      mode: handle.mode,
      branch: handle.branch,
      commit: commitResult.commit ?? null,
      run_dir: handle.mode === "local" ? handle.runDir : null,
    });
  } else {
    broadcastImplementerEvent({
      phase: "blocked",
      nodeId,
      project,
      state: "blocked",
      reason: !tscResult.ok
        ? "tsc_failed"
        : diff.length === 0
          ? "no_diff"
          : `qwen_exit_${runResult.exit_code}`,
      error: !tscResult.ok
        ? tscResult.output.slice(-800)
        : runResult.response.slice(0, 800),
      files: filesTouched,
      diff_bytes: diff.length,
      mode: handle.mode,
    });
  }

  return {
    nodeId,
    branch: handle.branch,
    worktreePath: handle.path,
    finalState: ok ? "review" : "blocked",
    reason: ok ? "ok" : (!tscResult.ok ? "tsc failed" : (diff.length === 0 ? "no diff produced" : `qwen exit ${runResult.exit_code}`)),
    allocation,
    run: runResult,
    diffBytes: diff.length,
    tscOk: tscResult.ok,
    ledgerPath: ledgerPathFor(nodeId),
  };
}

/**
 * Parse the "Planned artifacts" section of a plan.md and return relative paths
 * of every artifact mentioned. Looks for a heading line containing "Planned
 * artifacts" (case-insensitive) and pulls every backtick-delimited path or
 * leading-list-item path from that section until the next heading.
 */
export function extractPlannedArtifacts(planMd: string): string[] {
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
    // Backticked path: `path/to/file.ts`
    const backtickMatch = [...line.matchAll(/`([^`]+)`/g)];
    for (const m of backtickMatch) {
      const candidate = m[1].trim();
      if (looksLikePath(candidate)) out.push(candidate);
    }
    // Leading list item without backticks: "- path/to/file.ts (new)"
    if (backtickMatch.length === 0) {
      const listMatch = line.match(/^[-*]\s+([^\s(]+)/);
      if (listMatch && looksLikePath(listMatch[1])) out.push(listMatch[1]);
    }
  }
  // Dedup, normalize.
  return [...new Set(out)].map((p) => p.replace(/^\.\//, ""));
}

function looksLikePath(s: string): boolean {
  // Heuristic: contains a slash OR a recognized source extension, no spaces,
  // and isn't an obvious URL or fenced code marker.
  // Extension list expanded 2026-04-28: xml/svg/txt/sh/toml/sql were missing,
  // so plans containing only those extensions parsed as 0 artifacts and the
  // hallucination guard didn't fire. RSS Feed task hit this exact case.
  if (!s || s.length > 200) return false;
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;
  return /\//.test(s) || /\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|css|html|xml|svg|txt|sh|toml|sql|env|gitignore|lock)$/i.test(s);
}

/**
 * Append a JSONL line to <project>/canvas/nodes/<id>/execution.jsonl.
 * One line per implementer run; founder UI tails this to see history.
 */
function appendExecutionLog(project: string, nodeId: string, entry: object): void {
  const projectsRoot = resolve(ATELIER_ROOT, "projects");
  const p = resolve(projectsRoot, project, "canvas", "nodes", nodeId, "execution.jsonl");
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.warn(`[implementer] execution log write failed: ${String(e).slice(0, 200)}`);
  }
}
