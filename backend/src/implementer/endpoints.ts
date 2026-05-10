/**
 * Implementer HTTP endpoints — wired into routes/http.ts.
 *
 * Routes (POST unless noted):
 *   GET  /implementer/status/:project/:nodeId  — last execution.jsonl entry
 *   GET  /implementer/diff/:project/:nodeId    — unified text diff against base
 *   POST /implementer/approve/:project/:nodeId — merge impl/<id> into base
 *   POST /implementer/reject/:project/:nodeId  — drop worktree + branch, state→proposed
 *   POST /implementer/senior_review/:project/:nodeId — dispatch diff to cloud reviewer
 *
 * /implementer/run is registered in routes/http.ts directly (worker.runImplementerOnce).
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { getNode, updateState } from "~/project/canvas";
import { getDb, newId, nowIso } from "~/db";
import { getAgentConfig } from "~/settings/agents";
import { projectMeta } from "~/project/scaffold";
import { config } from "~/config";

const ATELIER_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PROJECTS_ROOT = resolve(ATELIER_ROOT, "projects");

interface JsonResponseInit { status?: number }
function json(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function gitRun(args: string[], cwd: string = ATELIER_ROOT): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function nodeExecutionLogPath(project: string, nodeId: string): string {
  return resolve(PROJECTS_ROOT, project, "canvas", "nodes", nodeId, "execution.jsonl");
}

function ledgerPath(nodeId: string): string {
  const root = process.env.OG_ARTIFACTS_DIR ?? resolve(ATELIER_ROOT, "og_artifacts");
  return resolve(root, "ledger", `${nodeId}.jsonl`);
}

interface ExecutionLogEntry {
  timestamp: string;
  branch: string;
  worktreePath: string;
  diff_bytes: number;
  files_touched: string[];
  tsc_ok: boolean;
  tsc_tail: string;
  qwen_exit_code: number;
  qwen_response: string;
  tokens_in: number;
  tokens_out: number;
  tools_called: number;
  allocation: {
    verdict: string;
    reason: string;
    confidence: number;
    elapsed_s: number;
    tokens_in: number;
    tokens_out: number;
  };
  /** Sandbox strategy used for this run. Older entries omit it; default "repo". */
  mode?: "local" | "repo";
  /** Local-mode run dir (absolute), null otherwise. */
  run_dir?: string | null;
  /** Repo-mode commit SHA, null otherwise. */
  commit?: string | null;
}

interface SandboxLocation {
  mode: "local" | "repo";
  /** Absolute path that owns the run. For repo mode that's `repo_path`; for local
   *  mode that's the project root containing `.implementer-runs/<nodeId>`. */
  cwd: string;
  /** Local-mode run dir (always under `<projectRoot>/.implementer-runs/<nodeId>`). */
  runDir: string | null;
  /** Repo-mode worktree path. */
  worktreePath: string | null;
}

function resolveSandboxLocation(project: string, nodeId: string): SandboxLocation {
  const meta = projectMeta(project);
  const repoPath = meta?.repo_path ?? null;
  if (repoPath && repoPath.trim().length > 0) {
    return {
      mode: "repo",
      cwd: repoPath,
      runDir: null,
      worktreePath: resolve(repoPath, ".implementer-worktrees", `impl-${nodeId}`),
    };
  }
  const projectRoot = resolve(config.projectsDir, project);
  return {
    mode: "local",
    cwd: projectRoot,
    runDir: resolve(projectRoot, ".implementer-runs", nodeId),
    worktreePath: null,
  };
}

function readLastExecutionEntry(project: string, nodeId: string): ExecutionLogEntry | null {
  const p = nodeExecutionLogPath(project, nodeId);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf-8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as ExecutionLogEntry;
  } catch {
    return null;
  }
}

function readLedger(nodeId: string): unknown[] {
  const p = ledgerPath(nodeId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean) as unknown[];
}

/* -------------------------------------------------------------------------- */
/* GET /implementer/status/:project/:nodeId                                   */
/* -------------------------------------------------------------------------- */

export function handleStatus(project: string, nodeId: string): Response {
  let meta;
  try { meta = getNode(project, nodeId); } catch { return json({ error: "node not found" }, { status: 404 }); }
  const last = readLastExecutionEntry(project, nodeId);
  const ledger = readLedger(nodeId);
  const sandbox = resolveSandboxLocation(project, nodeId);

  const branch = last?.branch || `impl/${nodeId}`;
  let branchExists = false;
  if (sandbox.mode === "repo") {
    branchExists = gitRun(["rev-parse", "--verify", branch], sandbox.cwd).code === 0;
  }

  // Local-mode: surface summary.json contents (the canonical artifact).
  let localSummary: unknown = null;
  if (sandbox.mode === "local" && sandbox.runDir) {
    const sp = resolve(sandbox.runDir, "summary.json");
    if (existsSync(sp)) {
      try { localSummary = JSON.parse(readFileSync(sp, "utf-8")); }
      catch { localSummary = null; }
    }
  }

  return json({
    nodeId,
    project,
    state: meta.state,
    badge: meta.badge,
    branch: sandbox.mode === "repo" && branchExists ? branch : null,
    last_run: last,
    ledger_entries: ledger.length,
    ledger_tail: ledger.slice(-10),
    mode: sandbox.mode,
    run_dir: sandbox.runDir,
    summary: localSummary,
  });
}

/* -------------------------------------------------------------------------- */
/* GET /implementer/diff/:project/:nodeId                                     */
/* -------------------------------------------------------------------------- */

export function handleDiff(project: string, nodeId: string): Response {
  const sandbox = resolveSandboxLocation(project, nodeId);

  if (sandbox.mode === "local") {
    if (!sandbox.runDir || !existsSync(sandbox.runDir)) {
      return json({ error: "no local run dir", nodeId }, { status: 404 });
    }
    const diffPath = resolve(sandbox.runDir, "diff.patch");
    if (!existsSync(diffPath)) {
      return json({ error: "no diff.patch (run incomplete?)", nodeId }, { status: 404 });
    }
    const summaryPath = resolve(sandbox.runDir, "summary.json");
    let files: string[] = [];
    if (existsSync(summaryPath)) {
      try {
        const s = JSON.parse(readFileSync(summaryPath, "utf-8")) as { files?: string[] };
        if (Array.isArray(s.files)) files = s.files;
      } catch { /* ignore */ }
    }
    const diff = readFileSync(diffPath, "utf-8");
    const stat = `${files.length} file(s) changed; ${diff.length} bytes`;
    return json({
      nodeId,
      mode: "local",
      branch: `impl/${nodeId}`,
      base: "before/",
      files,
      stat,
      diff,
      run_dir: sandbox.runDir,
    });
  }

  const branch = `impl/${nodeId}`;
  const branchExists = gitRun(["rev-parse", "--verify", branch], sandbox.cwd).code === 0;
  if (!branchExists) return json({ error: "no impl branch", nodeId }, { status: 404 });

  // Determine base — last_run captured the worktree base; default to current
  // checked-out branch otherwise.
  const last = readLastExecutionEntry(project, nodeId);
  const headRef = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], sandbox.cwd).stdout.trim() || "main";
  const base = last && last.worktreePath
    ? gitRun(["log", "-1", "--format=%P", branch], sandbox.cwd).stdout.trim().split(" ")[0] || headRef
    : headRef;

  const diff = gitRun(["diff", "--no-color", `${base}..${branch}`], sandbox.cwd).stdout;
  const stat = gitRun(["diff", "--stat", `${base}..${branch}`], sandbox.cwd).stdout;
  const names = gitRun(["diff", "--name-only", `${base}..${branch}`], sandbox.cwd).stdout
    .split("\n").map((s) => s.trim()).filter(Boolean);
  return json({ nodeId, mode: "repo", branch, base, files: names, stat, diff });
}

/* -------------------------------------------------------------------------- */
/* POST /implementer/approve/:project/:nodeId                                 */
/* -------------------------------------------------------------------------- */

export function handleApprove(project: string, nodeId: string): Response {
  const sandbox = resolveSandboxLocation(project, nodeId);

  if (sandbox.mode === "local") {
    // Local-mode delivery: the run's summary.json enumerates the
    // founder-meaningful artifacts (extracted from plan.md `Planned
    // artifacts`). Copy each `after/<rel>` → `<projectRoot>/<rel>` so the
    // approval is what the founder actually expects ("approve" → files
    // appear at the project root). Implementer-runtime scratch (QWEN.md,
    // .qwen/, etc.) stays inside .implementer-runs/<id>/after/ for
    // forensics — only the explicitly-planned artifacts ship.
    //
    // Skips delivery if summary.json is missing or files[] is empty;
    // logs the patch path in that case so the founder can inspect manually.
    const runDir = sandbox.runDir!; // local mode guarantees runDir
    const projectRoot = sandbox.cwd; // local mode: cwd is the project root
    const summaryPath = resolve(runDir, "summary.json");
    const delivered: string[] = [];
    const failed: { file: string; error: string }[] = [];
    let summaryParsed = false;
    if (existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as { files?: string[] };
        summaryParsed = true;
        const afterDir = resolve(runDir, "after");
        for (const rel of summary.files ?? []) {
          // Reject anything that climbs out of the project root.
          if (rel.includes("..") || rel.startsWith("/")) {
            failed.push({ file: rel, error: "rejected: path escapes project root" });
            continue;
          }
          const src = join(afterDir, rel);
          const dst = join(projectRoot, rel);
          if (!existsSync(src)) {
            failed.push({ file: rel, error: "missing in after/" });
            continue;
          }
          try {
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst);
            delivered.push(rel);
          } catch (e) {
            failed.push({ file: rel, error: String(e).slice(0, 160) });
          }
        }
        // Persist a forensic log of the delivery for diffing/auditing.
        writeFileSync(
          resolve(runDir, "delivered.json"),
          JSON.stringify({ at: new Date().toISOString(), delivered, failed }, null, 2),
        );
      } catch (e) {
        failed.push({ file: "(summary.json)", error: String(e).slice(0, 160) });
      }
    }

    let meta;
    try { meta = updateState(project, nodeId, "done", "done"); } catch { meta = null; }
    return json({
      ok: failed.length === 0,
      mode: "local",
      run_dir: runDir,
      delivered,
      failed,
      hint: !summaryParsed
        ? "summary.json missing — apply diff.patch manually (`cd <project> && patch -p1 < diff.patch`)"
        : `delivered ${delivered.length} artifact(s) to ${projectRoot}`,
      nodeState: meta?.state ?? "done",
    });
  }

  const branch = `impl/${nodeId}`;
  const branchExists = gitRun(["rev-parse", "--verify", branch], sandbox.cwd).code === 0;
  if (!branchExists) return json({ error: "no impl branch to merge" }, { status: 404 });

  // Refuse if working tree is dirty — founder must commit/stash first.
  const dirty = gitRun(["status", "--porcelain"], sandbox.cwd).stdout.trim();
  if (dirty) return json({ error: "founder working tree is dirty; commit/stash before approving", dirty }, { status: 409 });

  const headRef = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], sandbox.cwd).stdout.trim() || "main";
  // Merge --no-ff so the impl branch is preserved in history.
  const merge = gitRun(
    ["merge", "--no-ff", branch, "-m", `merge: impl(${nodeId}) approved by founder`],
    sandbox.cwd,
  );
  if (merge.code !== 0) {
    return json({ error: "merge failed", stderr: merge.stderr.slice(-500) }, { status: 500 });
  }

  // Tear down worktree + branch.
  if (sandbox.worktreePath && existsSync(sandbox.worktreePath)) {
    gitRun(["worktree", "remove", "--force", sandbox.worktreePath], sandbox.cwd);
  }
  gitRun(["branch", "-D", branch], sandbox.cwd);

  // Transition canvas node to done.
  let meta;
  try { meta = updateState(project, nodeId, "done", "done"); } catch { meta = null; }

  return json({ ok: true, mode: "repo", mergedInto: headRef, nodeState: meta?.state ?? "done" });
}

/* -------------------------------------------------------------------------- */
/* POST /implementer/reject/:project/:nodeId                                  */
/* -------------------------------------------------------------------------- */

export function handleReject(project: string, nodeId: string, reason?: string): Response {
  const sandbox = resolveSandboxLocation(project, nodeId);
  if (sandbox.mode === "repo") {
    const branch = `impl/${nodeId}`;
    if (sandbox.worktreePath && existsSync(sandbox.worktreePath)) {
      gitRun(["worktree", "remove", "--force", sandbox.worktreePath], sandbox.cwd);
    }
    gitRun(["branch", "-D", branch], sandbox.cwd);
  }
  // Local mode: leave the run dir on disk — founder may want to inspect.
  let meta;
  try { meta = updateState(project, nodeId, "proposed", "proposed"); } catch { meta = null; }
  // Append rejection note to execution.jsonl
  const p = nodeExecutionLogPath(project, nodeId);
  if (existsSync(p)) {
    const note = JSON.stringify({
      timestamp: nowIso(),
      event: "founder_reject",
      reason: reason ?? "(no reason given)",
    });
    try { Bun.write(p, readFileSync(p, "utf-8") + note + "\n"); } catch { /* best-effort */ }
  }
  return json({ ok: true, nodeState: meta?.state ?? "proposed" });
}

/* -------------------------------------------------------------------------- */
/* POST /implementer/senior_review/:project/:nodeId                           */
/* -------------------------------------------------------------------------- */
/*
 * Dispatches the impl branch's diff to the senior_reviewer agent's configured
 * provider for a critique pass. The reviewer is read-only — it produces a
 * report appended to the node's execution.jsonl and does NOT mutate the diff.
 *
 * Phase A implementation: spawns a CLI provider with stdin = diff + a critique
 * prompt, captures stdout. For now supports `claude --print` and `gemini -p`
 * style invocations; other providers degrade to "unsupported" message.
 */
export async function handleSeniorReview(
  project: string,
  nodeId: string,
  userId: string,
): Promise<Response> {
  const sandbox = resolveSandboxLocation(project, nodeId);
  let diff = "";
  if (sandbox.mode === "local") {
    if (!sandbox.runDir) return json({ error: "no local run dir" }, { status: 404 });
    const dp = resolve(sandbox.runDir, "diff.patch");
    if (!existsSync(dp)) return json({ error: "no diff.patch" }, { status: 404 });
    diff = readFileSync(dp, "utf-8");
  } else {
    const branch = `impl/${nodeId}`;
    const branchExists = gitRun(["rev-parse", "--verify", branch], sandbox.cwd).code === 0;
    if (!branchExists) return json({ error: "no impl branch to review" }, { status: 404 });
    const headRef = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], sandbox.cwd).stdout.trim() || "main";
    diff = gitRun(["diff", "--no-color", `${headRef}..${branch}`], sandbox.cwd).stdout;
  }
  if (!diff.trim()) return json({ error: "diff is empty" }, { status: 400 });

  const cfg = getAgentConfig(userId, "senior_reviewer");
  const provider = cfg.provider;

  let nodePlan = "";
  try {
    const planPath = resolve(PROJECTS_ROOT, project, "canvas", "nodes", nodeId, "plan.md");
    nodePlan = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
  } catch { /* ignore */ }

  const prompt = buildSeniorReviewPrompt(nodePlan, diff);

  let report: string;
  let exitCode = 0;
  let providerUsed = provider;
  const t0 = Date.now();

  try {
    if (provider === "claude") {
      const claudeBin = process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`;
      report = runCli(claudeBin, ["--print"], prompt);
    } else if (provider === "gemini") {
      const geminiBin = process.env.GEMINI_BIN ?? "gemini";
      report = runCli(geminiBin, ["-p", prompt], "");
    } else if (provider === "qwen-code") {
      const qwenBin = process.env.QWEN_BIN ?? "qwen";
      report = runCli(qwenBin, ["--prompt", prompt, "--output-format", "json", "--approval-mode", "yolo"], "");
    } else {
      report = `[unsupported provider for senior_reviewer: ${provider}]`;
      exitCode = 2;
    }
  } catch (e) {
    report = `[provider error: ${String(e).slice(0, 300)}]`;
    exitCode = 1;
  }

  const elapsed_s = (Date.now() - t0) / 1000;
  // Append review report to execution log.
  const p = nodeExecutionLogPath(project, nodeId);
  const entry = {
    timestamp: nowIso(),
    event: "senior_review",
    provider: providerUsed,
    elapsed_s,
    exit_code: exitCode,
    report: report.slice(0, 16000),
  };
  try {
    const prev = existsSync(p) ? readFileSync(p, "utf-8") : "";
    Bun.write(p, prev + JSON.stringify(entry) + "\n");
  } catch { /* best-effort */ }

  // Audit log.
  try {
    getDb().query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), userId, "implementer.senior_review", "node", nodeId,
      JSON.stringify({ project, provider: providerUsed, elapsed_s, exit_code: exitCode }), nowIso());
  } catch { /* ignore */ }

  return json({ ok: exitCode === 0, provider: providerUsed, elapsed_s, exit_code: exitCode, report });
}

function runCli(bin: string, args: string[], stdin: string): string {
  const r = spawnSync(bin, args, { input: stdin, encoding: "utf-8", timeout: 5 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`${bin} exit ${r.status}: ${(r.stderr ?? "").slice(-300)}`);
  return r.stdout ?? "";
}

/* -------------------------------------------------------------------------- */
/* GET /implementer/runs[?project=:project][&limit=:N]                        */
/* -------------------------------------------------------------------------- */
/*
 * Returns the most recent N implementer runs across all (or one) project,
 * scanned from each node's execution.jsonl tail. Used by the live feed on
 * mount to backfill rows after a tab refresh / WS reconnect.
 */

interface RunListEntry {
  nodeId: string;
  project: string;
  timestamp: string;
  state: "review" | "blocked" | "in-progress" | "done" | "proposed" | "approved" | string;
  mode: "local" | "repo";
  diff_bytes: number;
  files: string[];
  branch: string | null;
  reason: string | null;
}

export function handleListRuns(projectFilter: string | null, limit: number): Response {
  const out: RunListEntry[] = [];
  const root = PROJECTS_ROOT;
  if (!existsSync(root)) return json({ runs: [] });
  const projectDirs = projectFilter
    ? [projectFilter]
    : readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  for (const proj of projectDirs) {
    const nodesDir = resolve(root, proj, "canvas", "nodes");
    if (!existsSync(nodesDir)) continue;
    let nodeIds: string[];
    try { nodeIds = readdirSync(nodesDir); } catch { continue; }
    for (const nodeId of nodeIds) {
      const execPath = resolve(nodesDir, nodeId, "execution.jsonl");
      if (!existsSync(execPath)) continue;
      let mtime = 0;
      try { mtime = statSync(execPath).mtimeMs; } catch { /* ignore */ }
      const last = readLastExecutionEntry(proj, nodeId);
      if (!last) continue;
      let nodeState = "";
      try { nodeState = getNode(proj, nodeId).state; } catch { /* ignore */ }
      out.push({
        nodeId,
        project: proj,
        timestamp: last.timestamp ?? new Date(mtime).toISOString(),
        state: nodeState,
        mode: (last.mode ?? "repo") as "local" | "repo",
        diff_bytes: last.diff_bytes ?? 0,
        files: Array.isArray(last.files_touched) ? last.files_touched.slice(0, 20) : [],
        branch: last.branch || null,
        reason: last.allocation?.reason ? last.allocation.reason.slice(0, 200) : null,
      });
    }
  }

  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return json({ runs: out.slice(0, Math.max(1, Math.min(limit, 200))) });
}

function buildSeniorReviewPrompt(plan: string, diff: string): string {
  return `You are a senior code reviewer. The Implementer agent produced the diff below
to satisfy the plan. Critique it.

Output structure:
1. Single verdict: APPROVE / NEEDS_CHANGES / REJECT
2. Specific concerns (≤5 bullets, each citing a file:line)
3. Adherence to plan acceptance (one bullet per Acceptance line: pass/fail/unverifiable)

Do NOT propose alternative implementations. Critique only.

## Plan
${plan}

## Diff
${diff.slice(0, 100000)}`;
}
