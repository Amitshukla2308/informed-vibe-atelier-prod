/**
 * Per-node sandbox management for the Implementer.
 *
 * Two strategies, chosen at runtime from ProjectMeta:
 *
 *   1. **Repo mode** (`projectMeta.repo_path` set) — `createGitWorktree`
 *      spawns a fresh worktree in the founder's repo at
 *      `<repo_path>/.implementer-worktrees/impl-<nodeId>/` on a branch
 *      `impl/<nodeId>` off `repo_branch_base` (default "main").
 *      `commitOrSnapshot` runs `git commit` on completion. `handleApprove`
 *      runs `git merge --no-ff impl/<nodeId>` against the base, then tears
 *      down the worktree + branch.
 *
 *   2. **Local mode** (no repo_path — current AtelierBrief mode) —
 *      `createLocalSandbox` builds a directory at
 *      `<projectRoot>/.implementer-runs/<nodeId>/` with:
 *        before/      — hardlinked snapshot of the project files at run start
 *        after/       — working tree the Implementer writes into
 *        diff.patch   — `diff -urN before after` for forensics
 *        summary.json — files[] (founder-meaningful artifacts only — driven by
 *                       plan.md `Planned artifacts` not `after/`'s full tree),
 *                       diff_bytes, mode = "local"
 *      `handleApprove` (in local mode) reads summary.json and copies each
 *      `after/<rel>` → `<projectRoot>/<rel>` so files actually appear at the
 *      project root. Implementer-runtime scratch (QWEN.md, .qwen/, etc.)
 *      stays inside `after/` for forensics. delivered.json is written
 *      alongside summary.json with the post-approve manifest.
 *      **No git is touched in local mode** — there is no `impl/<nodeId>`
 *      branch and no merge commit; previous docstrings claiming otherwise
 *      were stale.
 *
 * Atelier's own monorepo never receives a worktree from this module —
 * the historical `ATELIER_ROOT` worktree base has been retired.
 *
 * Snapshot rules (local mode):
 *   - Hard-coded gitignore-flavor exclusions: node_modules, .git, dist,
 *     build, data, .implementer-runs, .implementer-worktrees,
 *     .implementer-snapshots. If the project root has a `.gitignore`,
 *     its bare-pattern lines extend the exclude list.
 *   - Hardlinks via `cp -al` for cheap copy. Falls back to `cp -r` only
 *     if `cp -al` errors (e.g. cross-filesystem).
 *   - 100 MB cap on the `before/` snapshot — beyond that we throw, the
 *     worker catches and emits a `blocked` event with `reason="snapshot_too_large"`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync,
  readdirSync,
} from "node:fs";
import { resolve, relative, dirname, join } from "node:path";

import { config } from "~/config";
import { projectMeta } from "~/project/scaffold";

/* -------------------------------------------------------------------------- */
/* Shared types                                                               */
/* -------------------------------------------------------------------------- */

export type SandboxMode = "repo" | "local";

export interface RepoHandle {
  mode: "repo";
  /** Absolute path to the worktree the implementer writes into. */
  path: string;
  /** Branch name created for this run, e.g. "impl/n_abc". */
  branch: string;
  /** Base branch the worktree was forked from. */
  baseBranch: string;
  /** Absolute path to the underlying repo (matches projectMeta.repo_path). */
  repoPath: string;
  /** Same as `path` — historical alias retained so worker doesn't churn. */
  worktreePath: string;
}

export interface LocalHandle {
  mode: "local";
  /** Absolute path the implementer writes into (after/). */
  path: string;
  /** Absolute path to the run dir holding before/, after/, diff.patch, summary.json. */
  runDir: string;
  /** Absolute path to the project root the snapshot was taken from. */
  projectRoot: string;
  /** Synthetic "branch" name used by ledger/UI; matches repo mode for parity. */
  branch: string;
  /** Same shape as RepoHandle.worktreePath — kept for caller parity. */
  worktreePath: string;
}

export type SandboxHandle = RepoHandle | LocalHandle;

export interface CommitResult {
  /** Files actually changed in the run (relative paths). */
  files: string[];
  /** Total byte size of the diff. */
  diff_bytes: number;
  /** "local" or "repo". */
  mode: SandboxMode;
  /** Git branch (repo mode) or null. */
  branch?: string | null;
  /** Git commit sha (repo mode), null in local mode. */
  commit?: string | null;
  /** Absolute run dir (local mode), null in repo mode. */
  run_dir?: string | null;
  /** Path to diff.patch (local mode), null in repo mode. */
  diff_path?: string | null;
}

/* Backwards-compatible alias — old worker code refers to WorktreeHandle.
 * Still exported because some peripheral helpers import it. */
export type WorktreeHandle = SandboxHandle;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function gitRun(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

const HARD_EXCLUDES = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "build",
  "data",
  ".implementer-runs",
  ".implementer-worktrees",
  ".implementer-snapshots",
  ".next",
  ".turbo",
  "target", // rust
  "__pycache__",
  ".venv",
  "venv",
]);

const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024; // 100 MB

function loadGitignoreSimplePatterns(projectRoot: string): Set<string> {
  const out = new Set<string>(HARD_EXCLUDES);
  const p = resolve(projectRoot, ".gitignore");
  if (!existsSync(p)) return out;
  try {
    for (const raw of readFileSync(p, "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Minimal interpretation: take only bare directory/file names — anything
      // with slashes, globs, or negation is left to the hard exclusion set.
      if (line.startsWith("!")) continue;
      if (line.includes("/")) continue;
      if (line.includes("*") || line.includes("?")) continue;
      out.add(line.replace(/\/$/, ""));
    }
  } catch {
    /* tolerate gitignore parse errors */
  }
  return out;
}

function dirSizeBytes(root: string, excludes: Set<string>): number {
  let total = 0;
  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (excludes.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        try { total += statSync(full).size; } catch { /* ignore */ }
        if (total > MAX_SNAPSHOT_BYTES) return;
      }
      if (total > MAX_SNAPSHOT_BYTES) return;
    }
  }
  walk(root);
  return total;
}

function hardlinkCopy(srcDir: string, dstDir: string, excludes: Set<string>): void {
  // `cp -al` does recursive hardlink-copy on Linux and is dramatically cheaper
  // than reading + writing every file. We exclude the hard-coded set up front
  // by listing top-level entries and only linking the ones not excluded.
  mkdirSync(dstDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (excludes.has(ent.name)) continue;
    const src = join(srcDir, ent.name);
    const dst = join(dstDir, ent.name);
    const r = spawnSync("cp", ["-al", src, dst], { encoding: "utf-8" });
    if (r.status !== 0) {
      // Cross-FS or permission — fall back to a plain recursive copy.
      const r2 = spawnSync("cp", ["-r", src, dst], { encoding: "utf-8" });
      if (r2.status !== 0) {
        throw new Error(
          `snapshot copy failed for ${ent.name}: cp -al → ${r.stderr.slice(0, 200)}; cp -r → ${r2.stderr.slice(0, 200)}`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Strategy: repo mode (real git worktree in the founder's repo)              */
/* -------------------------------------------------------------------------- */

export function createGitWorktree(
  repoPath: string,
  baseBranch: string,
  branchName: string,
  nodeId: string,
): RepoHandle {
  if (!existsSync(resolve(repoPath, ".git"))) {
    throw new Error(`createGitWorktree: ${repoPath} is not a git repo`);
  }
  const worktreeBase = resolve(repoPath, ".implementer-worktrees");
  const path = resolve(worktreeBase, `impl-${nodeId}`);

  if (!existsSync(worktreeBase)) mkdirSync(worktreeBase, { recursive: true });

  // Stale worktree → prune cleanly.
  if (existsSync(path)) gitRun(["worktree", "remove", "--force", path], repoPath);
  // Stale branch with same name → drop.
  gitRun(["branch", "-D", branchName], repoPath);

  const create = gitRun(
    ["worktree", "add", "-b", branchName, path, baseBranch],
    repoPath,
  );
  if (create.code !== 0) {
    throw new Error(
      `git worktree add failed (code=${create.code}): ${create.stderr.slice(0, 400)}`,
    );
  }

  return {
    mode: "repo",
    path,
    worktreePath: path,
    branch: branchName,
    baseBranch,
    repoPath,
  };
}

/* -------------------------------------------------------------------------- */
/* Strategy: local sandbox (no git, hardlinked snapshot + after/ working dir) */
/* -------------------------------------------------------------------------- */

export function createLocalSandbox(
  projectRoot: string,
  nodeId: string,
): LocalHandle {
  if (!existsSync(projectRoot)) {
    throw new Error(`createLocalSandbox: project root missing: ${projectRoot}`);
  }
  const runsRoot = resolve(projectRoot, ".implementer-runs");
  const runDir = resolve(runsRoot, nodeId);
  const beforeDir = resolve(runDir, "before");
  const afterDir = resolve(runDir, "after");

  // Wipe any prior run for this node — caller wants a fresh sandbox.
  if (existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
  }
  mkdirSync(beforeDir, { recursive: true });
  mkdirSync(afterDir, { recursive: true });

  const excludes = loadGitignoreSimplePatterns(projectRoot);

  // Cheap pre-flight size check so we abort fast on a bloated project tree
  // before attempting the copy.
  const sz = dirSizeBytes(projectRoot, excludes);
  if (sz > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `snapshot_too_large: project tree at ${projectRoot} is ${(sz / 1024 / 1024).toFixed(1)} MB after exclusions; cap is ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`,
    );
  }

  hardlinkCopy(projectRoot, beforeDir, excludes);
  // after/ starts as a copy of before/ so the implementer can edit-in-place
  // and we diff after vs before at the end. Hardlinks again — cheap.
  hardlinkCopy(beforeDir, afterDir, new Set<string>());

  return {
    mode: "local",
    path: afterDir,
    worktreePath: afterDir,
    runDir,
    projectRoot,
    branch: `impl/${nodeId}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Strategy router — picks repo vs local based on project meta                */
/* -------------------------------------------------------------------------- */

export interface CreateSandboxOptions {
  project: string;
  nodeId: string;
}

export function createSandbox(opts: CreateSandboxOptions): SandboxHandle {
  const meta = projectMeta(opts.project);
  const projectRoot = resolve(config.projectsDir, opts.project);
  const repoPath = meta?.repo_path ?? null;

  if (repoPath && repoPath.trim().length > 0) {
    const baseBranch = meta?.repo_branch_base?.trim() || "main";
    return createGitWorktree(repoPath, baseBranch, `impl/${opts.nodeId}`, opts.nodeId);
  }
  return createLocalSandbox(projectRoot, opts.nodeId);
}

/* -------------------------------------------------------------------------- */
/* Diff + commit/snapshot                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Repo mode: stage everything (incl. untracked) and capture diff vs base.
 * Local mode: walk after/ and produce `diff -urN before after`.
 */
export function diffAgainstBase(
  handle: SandboxHandle,
): { diff: string; filesTouched: string[] } {
  if (handle.mode === "repo") {
    gitRun(["add", "-A"], handle.path);
    const diff = gitRun(
      ["diff", "--cached", "--no-color", handle.baseBranch, "--", "."],
      handle.path,
    ).stdout;
    const namesRaw = gitRun(
      ["diff", "--cached", "--name-only", handle.baseBranch, "--", "."],
      handle.path,
    ).stdout;
    const filesTouched = filterScaffold(namesRaw.split("\n").map((s) => s.trim()).filter(Boolean));
    return { diff, filesTouched };
  }

  // Local mode — diff before/ vs after/, both relative.
  const r = spawnSync(
    "diff",
    ["-urN", "before", "after"],
    { cwd: handle.runDir, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  const diff = r.stdout ?? "";

  // Files touched: parse `diff -urN` headers ("--- before/path/...").
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    let m = line.match(/^\+\+\+ after\/(.+?)(?:\t.*)?$/);
    if (m) { files.add(m[1].trim()); continue; }
    m = line.match(/^--- before\/(.+?)(?:\t.*)?$/);
    if (m) { files.add(m[1].trim()); continue; }
  }
  return { diff, filesTouched: filterScaffold([...files].filter(Boolean)) };
}

/**
 * Strip Atelier-injected scaffold paths from filesTouched. The runner copies
 * QWEN.md (provider principles) and per-provider settings dirs into the
 * worktree BEFORE the model runs — those show up in the diff as new files,
 * but they're Atelier's responsibility, not the model's. Without this filter
 * the manifest scope guard tripped on every local-mode run because QWEN.md is
 * never inside any Surface's manifest_globs.
 */
function filterScaffold(paths: string[]): string[] {
  return paths.filter((p) => {
    if (p === "QWEN.md" || p === "GEMINI.md" || p === "CLAUDE.md") return false;
    if (p.startsWith(".qwen/") || p.startsWith(".gemini/") || p.startsWith(".claude/")) return false;
    return true;
  });
}

export interface CommitOrSnapshotOptions {
  /** Commit message (repo mode) — ignored in local mode. */
  message: string;
}

/**
 * Finalize a run. Returns a CommitResult the worker uses for state-transition
 * + WS broadcast. In repo mode, commits onto impl/<id>; in local mode, writes
 * diff.patch + summary.json into the runDir.
 */
export function commitOrSnapshot(
  handle: SandboxHandle,
  opts: CommitOrSnapshotOptions,
): CommitResult {
  const { diff, filesTouched } = diffAgainstBase(handle);
  const diff_bytes = Buffer.byteLength(diff, "utf-8");

  if (handle.mode === "repo") {
    let commit: string | null = null;
    // diffAgainstBase already staged. If nothing's staged, skip the commit.
    const staged = gitRun(["diff", "--cached", "--name-only"], handle.path);
    if (staged.stdout.trim()) {
      gitRun(["commit", "-m", opts.message, "--no-verify"], handle.path);
      const sha = gitRun(["rev-parse", "HEAD"], handle.path).stdout.trim();
      if (sha) commit = sha;
    }
    return {
      files: filesTouched,
      diff_bytes,
      mode: "repo",
      branch: handle.branch,
      commit,
      run_dir: null,
      diff_path: null,
    };
  }

  // Local mode → write diff.patch + summary.json.
  const diffPath = resolve(handle.runDir, "diff.patch");
  writeFileSync(diffPath, diff, "utf-8");
  const summary = {
    files: filesTouched,
    diff_bytes,
    mode: "local" as const,
    run_dir: handle.runDir,
    project_root: handle.projectRoot,
    branch: handle.branch,
    finished_at: new Date().toISOString(),
  };
  writeFileSync(
    resolve(handle.runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  return {
    files: filesTouched,
    diff_bytes,
    mode: "local",
    branch: handle.branch,
    commit: null,
    run_dir: handle.runDir,
    diff_path: diffPath,
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle helpers                                                          */
/* -------------------------------------------------------------------------- */

export function dropSandbox(handle: SandboxHandle, deleteBranch: boolean): void {
  if (handle.mode === "repo") {
    gitRun(["worktree", "remove", "--force", handle.path], handle.repoPath);
    if (deleteBranch) gitRun(["branch", "-D", handle.branch], handle.repoPath);
    return;
  }
  // Local mode — leave artifacts on disk so founder can inspect later.
  // Caller can rmSync the runDir explicitly if they want a true tear-down.
}

/**
 * Run `tsc --noEmit` against the sandbox. Best-effort — if neither
 * `backend/node_modules/.bin/tsc` nor `node_modules/.bin/tsc` exists,
 * we report "skipped" rather than fail.
 */
export function tscOk(handle: SandboxHandle): { ok: boolean; output: string } {
  const candidates = [
    resolve(handle.path, "backend", "node_modules", ".bin", "tsc"),
    resolve(handle.path, "node_modules", ".bin", "tsc"),
  ];
  let bin: string | null = null;
  let cwd: string = handle.path;
  for (const c of candidates) {
    if (existsSync(c)) {
      bin = c;
      cwd = dirname(dirname(dirname(c))); // back to <root>/<scope>/
      // For backend candidate the cwd is .../backend; for plain node_modules it's .../<root>.
      cwd = relative("", dirname(dirname(dirname(c))));
      cwd = resolve(cwd);
      break;
    }
  }
  if (!bin) {
    return { ok: true, output: "(skipped — no local tsc binary in sandbox)" };
  }
  const r = spawnSync(bin, ["--noEmit"], { cwd, encoding: "utf-8" });
  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return { ok: r.status === 0, output: output.slice(-3000) };
}

/* -------------------------------------------------------------------------- */
/* Backward-compat shims — kept for any caller still using the old names.     */
/* -------------------------------------------------------------------------- */

/** @deprecated use createSandbox(...) which routes to repo or local. */
export function createWorktree(nodeId: string, project?: string): SandboxHandle {
  if (!project) {
    throw new Error(
      "createWorktree without project is no longer supported — pass project so we can route to repo/local sandbox via projectMeta.",
    );
  }
  return createSandbox({ project, nodeId });
}

/** @deprecated use commitOrSnapshot(handle, { message }). */
export function commitWorktreeChanges(handle: SandboxHandle, message: string): void {
  commitOrSnapshot(handle, { message });
}

/** @deprecated use dropSandbox(handle, deleteBranch). */
export function dropWorktree(handle: SandboxHandle, deleteBranch: boolean): void {
  dropSandbox(handle, deleteBranch);
}
