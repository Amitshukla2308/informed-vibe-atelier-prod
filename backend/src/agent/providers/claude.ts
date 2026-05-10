/**
 * Claude provider — reads Claude Code's per-session JSONL at
 * `<CLAUDE_PROJECTS_DIR>/<cwd-hash>/<sessionId>.jsonl`.
 *
 * Claude Code writes this file whenever it runs (via `--session-id <id>`) so
 * our Atelier session id maps 1:1 to Claude's conversation file. Each line is
 * a JSON record — user messages, assistant messages (text / thinking / tool_use),
 * tool_result, system events, device info, etc. We skip housekeeping records
 * and keep only the conversational turns.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { config } from "~/config";
import type { AgentProvider, ConversationMeta, ContentBlock, NormalizedTurn, CliAdapter, CliSpawnOptions } from "./types";

/**
 * Claude Code path-hashing: cwd `/a/b/c` → dir name `-a-b-c` (every `/` becomes `-`,
 * leading slash yields leading dash). Dots in path stay; no other escaping.
 */
function cwdToClaudeDirName(cwd: string): string {
  return cwd.replace(/[/\\]/g, "-");
}

function claudeProjectsRoot(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ??
    resolve(process.env.HOME ?? "/", ".claude/projects")
  );
}

function jsonlPathFor(sessionId: string, projectCwd: string): string {
  return resolve(claudeProjectsRoot(), cwdToClaudeDirName(projectCwd), `${sessionId}.jsonl`);
}

/**
 * Parse one JSONL line into a NormalizedTurn, or null if it's not a conversational
 * record (permission-mode headers, file-history-snapshots, attachments, etc.).
 */
interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUserRecord {
  type: "user";
  uuid?: string;
  timestamp?: string;
  message?: { role: "user"; content: string | RawBlock[] };
}

interface RawAssistantRecord {
  type: "assistant";
  uuid?: string;
  timestamp?: string;
  message?: {
    role: "assistant";
    model?: string;
    content?: RawBlock[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    stop_reason?: string;
  };
}

function recordToTurn(rec: unknown): NormalizedTurn | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as RawUserRecord | RawAssistantRecord;

  if (r.type === "user" && r.message?.role === "user") {
    const blocks: ContentBlock[] = [];
    const content = r.message.content;
    if (typeof content === "string") {
      const cleaned = stripInternalWrappers(content);
      if (cleaned) blocks.push({ type: "text", text: cleaned });
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "text" && typeof c.text === "string") {
          const cleaned = stripInternalWrappers(c.text);
          if (cleaned) blocks.push({ type: "text", text: cleaned });
        } else if (c.type === "tool_result") {
          const out = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
          blocks.push({ type: "tool_result", toolUseId: c.tool_use_id, output: out, isError: !!c.is_error });
        }
      }
    }
    if (blocks.length === 0) return null;
    return { turnId: r.uuid ?? crypto.randomUUID(), role: "user", ts: r.timestamp ?? "", blocks };
  }

  if (r.type === "assistant" && r.message?.role === "assistant") {
    const blocks: ContentBlock[] = [];
    for (const c of r.message.content ?? []) {
      if (c.type === "text" && typeof c.text === "string") {
        const cleaned = stripInternalWrappers(c.text);
        if (cleaned) blocks.push({ type: "text", text: cleaned });
      } else if (c.type === "thinking" && typeof c.thinking === "string") {
        blocks.push({ type: "thinking", text: c.thinking });
      } else if (c.type === "tool_use") {
        blocks.push({ type: "tool_use", name: c.name ?? "", input: c.input ?? {}, toolUseId: c.id });
      }
    }
    if (blocks.length === 0) return null;
    return {
      turnId: r.uuid ?? crypto.randomUUID(),
      role: "assistant",
      ts: r.timestamp ?? "",
      blocks,
      usage: r.message.usage
        ? {
            inputTokens: r.message.usage.input_tokens,
            outputTokens: r.message.usage.output_tokens,
            cacheReadTokens: r.message.usage.cache_read_input_tokens,
            cacheCreationTokens: r.message.usage.cache_creation_input_tokens,
          }
        : undefined,
      model: r.message.model,
      stopReason: r.message.stop_reason,
    };
  }

  return null;
}

/**
 * Strip wrapper markup that Claude Code / Atelier embed in text blocks for
 * internal orchestration purposes. These were meant for the agent to read
 * but never to surface in the founder's UI. Run on every text block before
 * it enters a NormalizedTurn so the whole pipeline (display, reflection,
 * extract-signals) sees only the founder-visible content.
 */
function stripInternalWrappers(text: string): string {
  if (!text) return "";
  let out = text;
  // Claude Code's own XML-ish scaffolding blocks
  out = out.replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/gi, "");
  out = out.replace(/<command-(?:name|message|args|stdout|stderr)>[\s\S]*?<\/command-(?:name|message|args|stdout|stderr)>/gi, "");
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  out = out.replace(/<bash-(?:input|stdout|stderr)>[\s\S]*?<\/bash-(?:input|stdout|stderr)>/gi, "");
  out = out.replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, "");
  // Atelier's historical boot-prompt injections (kept for old sessions; new
  // sessions no longer write these — boot context is in system prompt now).
  out = out.replace(/\[atelier orchestration[\s\S]*?\(press Enter (?:to continue|to begin)\)/gi, "");
  out = out.replace(/\[atelier orchestration[\s\S]*?Don'?t echo this message\.?/gi, "");
  // Collapse runs of blank lines produced by the stripping
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function firstUserLineFromTurns(turns: NormalizedTurn[]): string | undefined {
  const first = turns.find(t => t.role === "user");
  if (!first) return undefined;
  const text = first.blocks
    .filter(b => b.type === "text")
    .map(b => (b as { text: string }).text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.slice(0, 140);
}

export const claudeProvider: AgentProvider = {
  id: "claude",

  isAvailable() {
    try {
      return existsSync(claudeProjectsRoot());
    } catch {
      return false;
    }
  },

  async readConversation(sessionId: string, projectCwd: string): Promise<ConversationMeta | null> {
    const path = jsonlPathFor(sessionId, projectCwd);
    if (!existsSync(path)) return null;

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }

    const lines = raw.split("\n");
    const turns: NormalizedTurn[] = [];
    const toolCalls: NonNullable<ConversationMeta["toolCalls"]> = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: unknown;
      try { rec = JSON.parse(line); } catch { continue; }
      const t = recordToTurn(rec);
      if (!t) continue;
      turns.push(t);
      for (const b of t.blocks) {
        if (b.type === "tool_use") {
          toolCalls.push({ name: b.name, turnId: t.turnId, ts: t.ts });
        }
      }
    }

    if (turns.length === 0) return null;

    const userTurnCount = turns.filter(t => t.role === "user").length;
    const startedAt = turns[0]?.ts || "";
    const endedAt = turns[turns.length - 1]?.ts || "";

    return {
      sessionId,
      provider: "claude",
      startedAt,
      endedAt,
      turns,
      userTurnCount,
      firstUserLine: firstUserLineFromTurns(turns),
      toolCalls,
    };
  },
};

export const claudeAdapter: CliAdapter = {
  id: "claude",
  isAvailable() {
    try {
      return existsSync(config.claudeBin);
    } catch {
      return false;
    }
  },
  getInteractiveCommand(opts: CliSpawnOptions) {
    return {
      bin: config.claudeBin,
      args: [
        "--append-system-prompt-file",
        opts.systemPromptPath,
        "--tools",
        opts.tools.join(","),
        "--mcp-config",
        opts.mcpConfigPath,
        "--strict-mcp-config",
        "--session-id",
        opts.sessionId,
        "--dangerously-skip-permissions",
      ],
      env: { ...process.env } as Record<string, string>,
    };
  },
  runPrint(opts: CliSpawnOptions, userMessage: string, timeoutMs = 90_000): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const bin = config.claudeBin;
      if (!existsSync(bin)) {
        rejectPromise(new Error(`claude binary not found at ${bin}`));
        return;
      }
      const args = ["--print"];
      if (opts.systemPromptPath) {
        args.push("--append-system-prompt-file", opts.systemPromptPath);
      }
      if (opts.tools && opts.tools.length > 0) {
        args.push("--tools", opts.tools.join(","));
      }
      if (opts.mcpConfigPath) {
        args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
      }
      args.push("--dangerously-skip-permissions");
      if (userMessage) {
        args.push(userMessage);
      }

      const child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`claude --print timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          resolvePromise(stdout.trim());
        } else {
          rejectPromise(new Error(`claude --print exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  }
};

// Exposed for boot validation + debug.
export function claudeJsonlPathFor(sessionId: string, projectCwd: string): string {
  return jsonlPathFor(sessionId, projectCwd);
}

export function claudeProjectsRootPath(): string {
  return claudeProjectsRoot();
}

// Silence unused import warning from config — kept for future use.
void config;
