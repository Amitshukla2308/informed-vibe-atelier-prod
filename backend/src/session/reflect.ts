/**
 * Reflection pass — "my signature close" per drafter.md.
 *
 * Spawns a SECOND, short-lived Claude `--print` subprocess with:
 *   identity prompt (soul + drafter + classification + stages + project context)
 *   + reflection directive appendage (six-lens crystallization, structured sections)
 *
 * Captures stdout, writes to projects/<active>/sessions/<ts>.md.
 * Also calls extract-signals.ts to populate brain/personal/<founder>/*.md.
 *
 * Hard-blocker fallback: if the Claude CLI subprocess fails (auth/timeout/
 * binary missing), writes a static-template artifact and parks
 * backend/PHASE_A_BLOCKERS.md. Never stops.
 *
 * Source decisions:
 *   - drafter.md "Reflection pass — my signature close"
 *   - drafter.md "Loading personal brain at session start"
 *   - SESSION_01_REFLECTION.md "Reflection pass" + acceptance criteria
 *   - JOURNAL.md "agreement/disagreement extraction logic"
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { loadAgentConfig, config } from "~/config";
import { composePrompt } from "~/agent/identity";
import { extractAndWriteSignals } from "~/session/extract-signals";
import { getCliAdapter } from "~/agent/providers";
import { loadOmnigraphBrain } from "~/session/load-omnigraph-brain";

/**
 * Where omnigraph lives. Three paths supported (checked in order):
 *   1. `omnigraph` on PATH (pip-installed)
 *   2. `~/informed-vibes/omnigraph/src/omnigraph_cli.py` (canonical sibling layout)
 *   3. `~/projects/omnigraph/src/omnigraph_cli.py` (legacy dev clone path)
 * Returns spawn args ready to use, or null if neither is available.
 */
function findOmnigraphRunner(): { bin: string; argsPrefix: string[] } | null {
  // pip-installed binary
  const which = spawnSync("which", ["omnigraph"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) {
    return { bin: which.stdout.trim(), argsPrefix: [] };
  }
  // dev clone — canonical first, then legacy
  const candidates = [
    resolve(process.env.HOME ?? "/root", "informed-vibes/active/omnigraph/src/omnigraph_cli.py"),
    resolve(process.env.HOME ?? "/root", "projects/omnigraph/src/omnigraph_cli.py"),
  ];
  for (const cliPy of candidates) {
    if (existsSync(cliPy)) {
      return { bin: "python3", argsPrefix: [cliPy] };
    }
  }
  return null;
}

/**
 * Derive Claude Code's per-session JSONL path from project + sid.
 * Convention: ~/.claude/projects/<slugified-project-cwd>/<sid>.jsonl
 * where slugified = the absolute project path with `/` → `-` and no
 * leading slash. (Same convention OmniGraph adapters use.)
 */
function claudeJsonlPathFor(projectName: string, sessionId: string): string | null {
  const cwd = resolve(config.projectsDir, projectName);
  const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-");
  const p = resolve(process.env.HOME ?? "/root", ".claude/projects", `-${slug}`, `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}

interface OmnigraphReflectOk {
  ok: true;
  exit_code: 0 | 3 | 4; // 0=full, 3=partial-aggregate-failed, 4=canonicalize-only
  session_id: string;
  project: string;
  user_id: string;
  lens_count: number;
  events_written: number;
  artifacts: string[];
}
interface OmnigraphReflectFail {
  ok: false;
  exit_code: number; // 1=qwen unreachable, 2=session malformed, other=unexpected
  reason: string;
  raw_stderr?: string;
}

function tryOmnigraphReflect(input: {
  sessionId: string;
  projectName: string;
  userId: string;
  jsonlPath: string;
}): OmnigraphReflectOk | OmnigraphReflectFail | null {
  const runner = findOmnigraphRunner();
  if (!runner) return null; // not installed → caller falls back

  const args = [
    ...runner.argsPrefix,
    "reflect",
    "--session-id", input.sessionId,
    "--claude-jsonl", input.jsonlPath,
    "--atelier-root", config.atelierRoot,
    "--user-id", input.userId,
    "--project", input.projectName,
  ];

  console.log(`[reflect] omnigraph: ${runner.bin} ${args.slice(0, 4).join(" ")} …`);
  const result = spawnSync(runner.bin, args, {
    encoding: "utf-8",
    timeout: 10 * 60_000, // 10 min — extraction + 6-lens synthesis on Qwen
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, exit_code: -1, reason: `spawn failed: ${result.error.message}` };
  }
  // Parse last line of stdout as the JSON summary (per OG contract).
  const stdoutLines = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  const lastLine = stdoutLines[stdoutLines.length - 1] ?? "";
  let parsed: any = {};
  try { parsed = JSON.parse(lastLine); } catch { /* not JSON */ }

  const code = result.status ?? -1;
  if (code === 0 || code === 3 || code === 4) {
    return {
      ok: true,
      exit_code: code as 0 | 3 | 4,
      session_id: parsed.session_id ?? input.sessionId,
      project: parsed.project ?? input.projectName,
      user_id: parsed.user_id ?? input.userId,
      lens_count: parsed.lens_count ?? 0,
      events_written: parsed.events_written ?? 0,
      artifacts: parsed.artifacts ?? [],
    };
  }
  // Failure path. stderr per OG contract is single-line JSON like
  // {"error":"...","phase":"..."} — pass through raw if not parseable.
  const stderr = (result.stderr ?? "").trim();
  let reason = stderr;
  try {
    const parsedErr = JSON.parse(stderr.split(/\r?\n/).pop() ?? "");
    if (parsedErr.error) reason = `${parsedErr.phase ?? "unknown"}: ${parsedErr.error}`;
  } catch { /* leave as raw */ }
  return { ok: false, exit_code: code, reason, raw_stderr: stderr };
}

const REFLECTION_DIRECTIVE = `
---

# SESSION-END REFLECTION DIRECTIVE (this turn only)

You are closing this session. Perform your signature reflection pass.

**Six-lens crystallization**: ONE thought process, SIX perspectives. No role-play. Speak as one mind surveying the session through Engineer, Architect, Strategist, Economist, Scientist, and Product lenses in turn — each lens contributes to the crystallization, none dominates.

Produce a markdown artifact with EXACTLY these sections, in this order:

## Flavor
A single line (<= 20 words) capturing the shape/feel of this session. This line will greet the founder next session as "Picking up from <flavor>…" — so make it specific and evocative, not generic.

## Decisions made
Concrete decisions that landed this session. Bullet list. Each bullet: one sentence, the decision + why.

## Open threads
Questions parked, topics flagged for later, things we didn't finish. Bullet list. Each bullet: the thread + what would unblock it.

## Patterns observed
What you noticed about how the founder thinks, redirects, prefers, or resists. Bullet list. Be specific — name the move, not just the category. These feed the personal-brain layers.

## Next actions
The 3-5 things that should happen next session, ranked. Bullet list.

## Session stats
- session id: {{SESSION_ID}}
- approximate duration: {{DURATION}}
- raw log: {{RAW_LOG_SIZE}}

**Length**: ~600-1000 words of structured markdown. Tight, scannable, no throat-clearing. Do not add sections beyond the six above. Do not include a preamble before \`## Flavor\`. Begin your output with \`## Flavor\` and end with the session stats footer.
`.trim();

export interface ReflectInput {
  sessionId: string;
}

export interface ReflectOutput {
  artifact_path: string;
  signals_extracted: number;
  used_fallback: boolean;
}

function sessionDir(sessionId: string): string {
  return resolve(config.dataDir, "sessions", sessionId);
}

function approxDurationFromRawLog(rawLogPath: string): string {
  try {
    const raw = readFileSync(rawLogPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    let first = "";
    let last = "";
    for (const l of lines) {
      const m = /^\[(?:in|out)\]\s+(\S+)/.exec(l);
      if (m) {
        if (!first) first = m[1];
        last = m[1];
      }
    }
    if (!first || !last) return "unknown";
    const ms = Date.parse(last) - Date.parse(first);
    if (!isFinite(ms) || ms <= 0) return "unknown";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const hrs = (mins / 60).toFixed(1);
    return `${hrs} h`;
  } catch {
    return "unknown";
  }
}

// Build the full appendable prompt: identity composition + reflection directive
// (with template placeholders filled for this specific session).
function buildReflectionPrompt(sessionId: string, rawLogPath: string): {
  composedPath: string;
  userMessage: string;
  projectName: string;
} {
  const agent = loadAgentConfig();
  const projectName = agent.active_project;

  // Project context snapshot: minimal — reflection pass only needs to know
  // which project it's closing a session for.
  const projectContextMarkdown = [
    `Project: **${projectName}**`,
    `Founder: **${agent.founder_name}**`,
    `Stage: pre-mvp`,
    `Mode: session-end reflection (one-shot; output markdown artifact only).`,
  ].join("\n");

  // Pull OmniGraph brain for the founder. We re-read meta.json here rather
  // than threading userId through the signature — buildReflectionPrompt only
  // needs the sessionId and the meta is the source of truth set at boot.
  let omnigraphBrainMarkdown: string | undefined;
  try {
    const metaPath = resolve(config.dataDir, "sessions", sessionId, "meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        atelier_user_id?: string;
      };
      if (meta.atelier_user_id) {
        const brain = loadOmnigraphBrain(meta.atelier_user_id, projectName);
        if (brain) omnigraphBrainMarkdown = brain.markdown;
      }
    }
  } catch { /* brain is best-effort */ }

  let identityPrompt = composePrompt({
    sessionId,
    mode: "drafter",
    stage: "pre-mvp",
    projectName,
    projectContextMarkdown,
    omnigraphBrainMarkdown,
  });

  // Fill reflection directive template
  const duration = approxDurationFromRawLog(rawLogPath);
  let rawSize = "(missing)";
  try {
    if (existsSync(rawLogPath)) {
      const bytes = statSync(rawLogPath).size;
      rawSize = bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
    }
  } catch { /* noop */ }

  const directive = REFLECTION_DIRECTIVE
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("{{DURATION}}", duration)
    .replaceAll("{{RAW_LOG_SIZE}}", rawSize);

  const fullSystemPrompt = identityPrompt + "\n\n" + directive;

  // Write composed prompt to a tmp file (same pattern as identity.writeComposedPrompt)
  const tmpDir = resolve(config.dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const composedPath = resolve(tmpDir, `reflect_prompt_${sessionId}.md`);
  writeFileSync(composedPath, fullSystemPrompt, "utf-8");

  // User message for --print: a small nudge. The system prompt does all the work.
  const userMessage = `Produce the session-end reflection artifact now. Follow the directive exactly.`;

  return { composedPath, userMessage, projectName };
}

// (runClaudePrint removed)

// Static template fallback — used when Claude CLI is unavailable/fails.
function staticFallbackArtifact(
  sessionId: string,
  rawLogPath: string,
  signalsCount: number
): string {
  const duration = approxDurationFromRawLog(rawLogPath);
  return [
    `## Flavor`,
    `Session ${sessionId.slice(0, 8)} — fallback reflection (Claude CLI unavailable).`,
    ``,
    `## Decisions made`,
    `- (Auto-generated fallback; Claude --print subprocess failed or missing. See backend/PHASE_A_BLOCKERS.md.)`,
    ``,
    `## Open threads`,
    `- Claude CLI reflection subprocess was not available at session close; re-run reflection once CLI is reachable.`,
    ``,
    `## Patterns observed`,
    `- Signal extraction parsed ${signalsCount} founder signals from raw.log.`,
    `- See brain/personal/<founder>/*.md for per-category entries.`,
    ``,
    `## Next actions`,
    `- Ensure \`CLAUDE_BIN\` env var points to a working Claude CLI.`,
    `- Re-run \`POST /session/reflect\` with sessionId=\`${sessionId}\` to regenerate.`,
    ``,
    `## Session stats`,
    `- session id: ${sessionId}`,
    `- approximate duration: ${duration}`,
    `- signals extracted: ${signalsCount}`,
    `- mode: fallback (static template)`,
    ``,
  ].join("\n");
}

// Park a blocker note once, describing reason + fallback. Idempotent (appends dated entry).
function parkBlocker(reason: string): void {
  const p = resolve(config.atelierRoot, "backend/PHASE_A_BLOCKERS.md");
  const stamp = new Date().toISOString();
  const entry =
    `\n---\n## ${stamp} — reflection Claude CLI unavailable\n\n` +
    `**Reason**: ${reason}\n\n` +
    `**Fallback in use**: static-template artifact written to \`projects/<active>/sessions/<ts>.md\`.\n` +
    `Signals are still extracted from raw.log and written to \`brain/personal/<founder>/\`.\n\n` +
    `**Unblock**: set \`CLAUDE_BIN\` env var to a valid Claude CLI binary and re-run \`POST /session/reflect\`.\n`;
  if (!existsSync(p)) {
    writeFileSync(
      p,
      `# Phase A blockers\n\nLog of runtime issues that were downgraded to fallback behavior.\n${entry}`
    );
  } else {
    appendFileSync(p, entry);
  }
}

// Main entry — used by /session/reflect route AND by the MCP session_end_with_reflection tool.
export async function reflectSession(input: ReflectInput): Promise<ReflectOutput> {
  const { sessionId } = input;
  const agent = loadAgentConfig();
  const projectName = agent.active_project;

  if (!projectName) throw new Error("no active project");

  const rawLogPath = resolve(sessionDir(sessionId), "raw.log");

  // 1. Extract agreement/disagreement signals from raw.log → personal brain.
  // (Cheap regex; runs regardless of which engine produces the reflection.)
  const { signals } = extractAndWriteSignals(rawLogPath);

  // Read provider + atelier_user_id from meta.json
  const metaPath = resolve(config.dataDir, "sessions", sessionId, "meta.json");
  let provider: any = "claude";
  let atelierUserId = "default";
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (meta.provider) provider = meta.provider;
      if (meta.atelier_user_id) atelierUserId = meta.atelier_user_id;
    } catch {}
  }

  // 2a. Preferred path — OmniGraph `reflect` over the structured Claude
  // Code JSONL. Produces a 6-lens markdown at projects/<P>/sessions/<sid>.md
  // + writes mention events to data/users/<uid>/data/events/<YYYY-MM>.jsonl.
  // Falls back to claude --print only if OG isn't installed OR reports
  // exit_code=1 (Qwen unreachable / LM-Studio down).
  const jsonlPath = claudeJsonlPathFor(projectName, sessionId);
  if (jsonlPath) {
    const og = tryOmnigraphReflect({
      sessionId,
      projectName,
      userId: atelierUserId,
      jsonlPath,
    });
    if (og && og.ok) {
      const ogArtifact = og.artifacts[0];
      console.log(`[reflect] omnigraph ok · lenses=${og.lens_count} · events=${og.events_written} · ${ogArtifact}`);
      // Update last_session.json from the OG-produced markdown so the next
      // boot's pickup-flavor still works.
      try {
        if (existsSync(ogArtifact)) {
          const md = readFileSync(ogArtifact, "utf-8");
          const flavorMatch = /^## Flavor\s*\n(.+)/m.exec(md);
          const flavor = flavorMatch ? flavorMatch[1].trim() : null;
          if (flavor) {
            writeFileSync(
              resolve(config.projectsDir, projectName, "last_session.json"),
              JSON.stringify({ flavor, session_id: sessionId, ts: new Date().toISOString() }, null, 2)
            );
          }
        }
      } catch (e) {
        console.warn(`[reflect] omnigraph flavor extract failed: ${e}`);
      }
      return {
        artifact_path: ogArtifact,
        signals_extracted: signals.length,
        used_fallback: false,
      };
    }
    if (og && !og.ok && og.exit_code !== 1) {
      // Hard failure (malformed input, etc.) — log and STILL try claude
      // fallback below; don't drop the session entirely.
      console.warn(`[reflect] omnigraph failed code=${og.exit_code} reason=${og.reason} — falling back to claude --print`);
    }
    // exit_code === 1 (Qwen unreachable) → fall through to claude --print as
    // a graceful retry on a different engine.
  }

  // 2b. Fallback path — claude --print + 6-lens directive (existing). Used
  // when OmniGraph isn't installed, no JSONL exists, or OG reported Qwen
  // unreachable. Final fallback (static template) lives below this.
  const { composedPath, userMessage } = buildReflectionPrompt(sessionId, rawLogPath);
  const adapter = getCliAdapter(provider);
  const spawnOpts = {
    sessionId,
    systemPromptPath: composedPath,
    cwd: resolve(config.projectsDir, projectName),
    mcpConfigPath: "", // not used by reflect
    tools: [], // not used by reflect
  };

  let artifact: string;
  let usedFallback = false;
  try {
    artifact = await adapter.runPrint(spawnOpts, userMessage, 90_000);
  } catch (e) {
    usedFallback = true;
    parkBlocker(String(e).slice(0, 300));
    artifact = staticFallbackArtifact(sessionId, rawLogPath, signals.length);
  }

  // 3. Write artifact to projects/<active>/sessions/<ts>.md
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionsOut = resolve(config.projectsDir, projectName, "sessions");
  mkdirSync(sessionsOut, { recursive: true });
  const artifactPath = resolve(sessionsOut, `${ts}.md`);
  // Prepend a machine-readable HTML comment with the session id so the session
  // index can map this artifact back to the exact session (filename is time-only).
  const stamped = `<!-- atelier:session-id: ${sessionId} -->\n${artifact}`;
  writeFileSync(artifactPath, stamped, "utf-8");

  // Extract flavor → last_session.json for resume greeting
  const flavorMatch = /^## Flavor\s*\n(.+)/m.exec(artifact);
  const flavor = flavorMatch ? flavorMatch[1].trim() : null;
  if (flavor) {
    writeFileSync(
      resolve(config.projectsDir, projectName, "last_session.json"),
      JSON.stringify({ flavor, session_id: sessionId, ts: new Date().toISOString() }, null, 2)
    );
  }

  return {
    artifact_path: artifactPath,
    signals_extracted: signals.length,
    used_fallback: usedFallback,
  };
}
