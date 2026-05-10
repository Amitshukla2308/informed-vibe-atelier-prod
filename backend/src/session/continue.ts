/**
 * Multi-session continuation handler.
 *
 * The moat. Founder picks 1-5 past sessions; we either:
 *  - `resume`   — single session, pick up its Claude session_id via the CLI (phase 2)
 *  - `summarize` — spawn `claude -p` with the multi-session-summary prompt to fuse
 *                  N artifacts into one continuation.md block the next Now session
 *                  will inject via silent-context.
 *
 * Writes artifacts to: `data/continuations/<continuationId>.md` (the brief) and
 * `data/continuations/<continuationId>.json` (pointer metadata).
 * silent-context checks for an active continuation on session open.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, loadAgentConfig } from "~/config";
import { getSessionArtifact, getSessionRawExcerpt, listProjectSessions } from "~/session/session-index";

export type ContinueMode = "resume" | "summarize";

export interface ContinueInput {
  project: string;
  sessionIds: string[];
  mode: ContinueMode;
}

export interface ContinueOutput {
  continuationId: string;
  mode: ContinueMode;
  briefMarkdown: string;
  /** For resume mode: the Claude session id to pass to `claude -r`. Absent for summarize. */
  resumeSessionId?: string;
  /** For summarize mode: source sessions whose artifacts were pooled. */
  sourceSessionIds: string[];
  /** Pending continuation id the next Now session will consume. */
  pendingPath: string;
}

function continuationsDir(): string {
  const d = resolve(config.dataDir, "continuations");
  mkdirSync(d, { recursive: true });
  return d;
}

function pendingPointerPath(project: string): string {
  return resolve(config.projectsDir, project, "pending_continuation.json");
}

/**
 * Write the "pending continuation" pointer into the project. silent-context.ts reads
 * this on session open and, if present, loads the brief into the system prompt and
 * then deletes the pointer (single-shot consumption).
 */
function writePendingPointer(project: string, continuationId: string, mode: ContinueMode, sourceIds: string[]) {
  const dir = resolve(config.projectsDir, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    pendingPointerPath(project),
    JSON.stringify({ continuationId, mode, sourceIds, createdAt: new Date().toISOString() }, null, 2),
  );
}

function loadPrompt(name: string): string {
  const path = resolve(config.agentsDir, "prompts", name);
  return readFileSync(path, "utf-8");
}

async function gatherArtifacts(project: string, sessionIds: string[]): Promise<string> {
  const all = await listProjectSessions(project);
  const byId = new Map(all.map(e => [e.sessionId, e]));
  const blocks: string[] = [];
  for (const id of sessionIds) {
    const entry = byId.get(id);
    const artifact = (await getSessionArtifact(project, id)) ?? null;
    const excerpt = artifact ? null : getSessionRawExcerpt(id, 80);
    const header = `--- SESSION ${id.slice(0, 8)} · ${entry?.startedAt?.slice(0, 10) ?? "unknown-date"} ---`;
    if (artifact) {
      blocks.push(`${header}\n\n${artifact}\n`);
    } else {
      blocks.push(
        `${header}\n\n_(no reflection artifact — raw log excerpt follows)_\n\n\`\`\`\n${excerpt}\n\`\`\`\n`,
      );
    }
  }
  return blocks.join("\n");
}

async function runSummarizer(
  project: string,
  agent: string,
  founder: string,
  sessionIds: string[],
): Promise<string> {
  const raw = loadPrompt("multi-session-summary.md");
  const selectedArtifacts = await gatherArtifacts(project, sessionIds);
  const plural = sessionIds.length === 1 ? "" : "s";

  const hydrated = raw
    .replaceAll("{{AGENT_NAME}}", agent)
    .replaceAll("{{FOUNDER_NAME}}", founder)
    .replaceAll("{{PROJECT_NAME}}", project)
    .replaceAll("{{N_SESSIONS}}", String(sessionIds.length))
    .replaceAll("{{PLURAL}}", plural)
    .replaceAll("{{SELECTED_ARTIFACTS}}", selectedArtifacts);

  const tmpPath = resolve(config.dataDir, "tmp", `summary_prompt_${Date.now()}.md`);
  writeFileSync(tmpPath, hydrated, "utf-8");

  const { getCliAdapter } = require("~/agent/providers");
  const { loadAgentConfig } = require("~/config");
  const agentConf = loadAgentConfig();
  const provider = agentConf.provider ?? "claude";
  const adapter = getCliAdapter(provider);
  
  const spawnOpts = {
    sessionId: "summary_" + Date.now(),
    systemPromptPath: tmpPath,
    cwd: resolve(config.projectsDir, project),
    mcpConfigPath: "",
    tools: []
  };

  try {
    return await adapter.runPrint(spawnOpts, "Provide the multi-session summary according to the directive in the system prompt.", 90_000);
  } catch (e) {
    throw new Error(`claude summarize failed: ${String(e)}`);
  }
}

export async function continueSessions(input: ContinueInput): Promise<ContinueOutput> {
  if (input.sessionIds.length === 0) throw new Error("no sessions selected");
  if (input.sessionIds.length > 5) throw new Error("max 5 sessions may be pooled");
  if (input.mode === "resume" && input.sessionIds.length !== 1) {
    throw new Error("resume mode requires exactly one session");
  }

  const agent = loadAgentConfig();
  const continuationId = `cont_${Date.now().toString(36)}`;
  const dir = continuationsDir();

  if (input.mode === "resume") {
    const [sid] = input.sessionIds;
    // Resume brief just tells the next Now session we're resuming a specific id.
    const brief = [
      `## Continuation brief — resume`,
      ``,
      `Founder chose to resume session \`${sid}\` directly. The next Claude session should continue`,
      `the same conversation context via Claude CLI's \`-r ${sid}\` flag (backend wires this through`,
      `the PTY spawn). No summary pooled.`,
      ``,
      `**One-line flavor**: resuming session ${sid.slice(0, 8)}`,
    ].join("\n");
    writeFileSync(resolve(dir, `${continuationId}.md`), brief);
    writeFileSync(resolve(dir, `${continuationId}.json`), JSON.stringify({
      continuationId, mode: input.mode, sourceSessionIds: input.sessionIds, resumeSessionId: sid,
      createdAt: new Date().toISOString(),
    }, null, 2));
    writePendingPointer(input.project, continuationId, input.mode, input.sessionIds);
    return {
      continuationId, mode: input.mode, briefMarkdown: brief,
      resumeSessionId: sid, sourceSessionIds: input.sessionIds,
      pendingPath: pendingPointerPath(input.project),
    };
  }

  // summarize mode — call claude -p with multi-session-summary prompt
  const briefMarkdown = await runSummarizer(input.project, agent.agent_name, agent.founder_name, input.sessionIds);
  writeFileSync(resolve(dir, `${continuationId}.md`), briefMarkdown);
  writeFileSync(resolve(dir, `${continuationId}.json`), JSON.stringify({
    continuationId, mode: input.mode, sourceSessionIds: input.sessionIds,
    createdAt: new Date().toISOString(),
  }, null, 2));
  writePendingPointer(input.project, continuationId, input.mode, input.sessionIds);

  return {
    continuationId, mode: input.mode, briefMarkdown,
    sourceSessionIds: input.sessionIds,
    pendingPath: pendingPointerPath(input.project),
  };
}

/**
 * Called by silent-context.ts when a new Now session opens. If a pending
 * continuation exists for the project, reads the brief, deletes the pointer
 * (single-shot), and returns the brief text to be appended to the system prompt.
 */
export function consumePendingContinuation(project: string): { briefMarkdown: string; mode: ContinueMode; sourceIds: string[]; resumeSessionId?: string } | null {
  const pointerPath = pendingPointerPath(project);
  if (!existsSync(pointerPath)) return null;
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as {
      continuationId: string; mode: ContinueMode; sourceIds: string[];
    };
    const briefPath = resolve(continuationsDir(), `${pointer.continuationId}.md`);
    const metaPath = resolve(continuationsDir(), `${pointer.continuationId}.json`);
    const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf-8") : "";
    let resumeSessionId: string | undefined;
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { resumeSessionId?: string };
      resumeSessionId = meta.resumeSessionId;
    }
    // Single-shot: remove the pointer so the brief is consumed exactly once.
    try { writeFileSync(pointerPath, ""); } catch { /* ignore */ }
    try {
      // delete pointer fully
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(pointerPath);
    } catch { /* already gone */ }
    return { briefMarkdown: brief, mode: pointer.mode, sourceIds: pointer.sourceIds, resumeSessionId };
  } catch {
    return null;
  }
}
