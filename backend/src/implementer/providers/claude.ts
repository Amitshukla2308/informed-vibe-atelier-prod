/**
 * Claude Code Implementer provider — headless single-shot invocation.
 *
 * The reason a GPU-less install can ship code at all: the Drafter already runs
 * on Claude, so the same auth/binary can drive the headless coder. Spawns
 * `claude --print <prompt> --output-format stream-json --verbose
 *  --dangerously-skip-permissions` in the per-node worktree; Claude emits the
 * same Claude-style stream-json events the shared engine already parses.
 *
 * Auth: the founder's own `claude login` (the backend process HOME, or a
 * per-user scoped HOME when userId is supplied). No API key, no LM Studio.
 */

import { resolve } from "node:path";
import type { QwenCodeRunResult } from "../types";
import { runStreamingCoder } from "./_headless-stream";
import { config } from "~/config";
import { userSpawnEnv } from "~/auth/user-home";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? config.claudeBin ?? "claude";

export interface ClaudeCodeRunOptions {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  /** Optional path to a system prompt (the Implementer principle) to append. */
  systemPromptPath?: string;
  /** When set to a non-"default" user, HOME is scoped to data/users/<uid>. */
  userId?: string | null;
}

export async function runClaudeCode(opts: ClaudeCodeRunOptions): Promise<QwenCodeRunResult> {
  // Cloud model — faster than the local 35B, so a tighter 30 min default.
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  // --verbose is required for stream-json under --print; yolo == skip perms.
  const args = ["--print", opts.prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (opts.systemPromptPath) args.push("--append-system-prompt-file", opts.systemPromptPath);

  const userEnv = (opts.userId && opts.userId !== "default") ? userSpawnEnv(opts.userId) : {};
  const env: Record<string, string> = { ...process.env, ...userEnv } as Record<string, string>;

  return runStreamingCoder({
    bin: CLAUDE_BIN,
    args,
    env,
    cwd: opts.cwd,
    timeoutMs,
    // Claude's file-writing tools — reset the no-write loop counter on these.
    writeToolNames: new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]),
    label: "claude",
  });
}
