/**
 * Qwen-Code Implementer provider — headless single-shot invocation.
 *
 * Spawns `qwen --prompt <text> --output-format stream-json --approval-mode yolo`
 * with cwd set to the per-node worktree, against local LM Studio. The spawn,
 * live loop-detection, and result parsing live in the shared streaming engine
 * (_headless-stream.ts) — this file only supplies qwen's binary/args/env and
 * the worktree settings override.
 *
 * Auth: env-driven, points at local LM Studio.
 *   OPENAI_BASE_URL=http://localhost:1234/v1
 *   OPENAI_API_KEY=lm-studio
 *   OPENAI_MODEL=qwen3.6-35b-a3b
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QwenCodeRunResult } from "../types";
import { runStreamingCoder } from "./_headless-stream";

const QWEN_BIN = process.env.QWEN_BIN ?? "qwen";
const LM_STUDIO_BASE_URL = process.env.QWEN_BASE_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b";
const LM_STUDIO_API_KEY = process.env.QWEN_API_KEY ?? "lm-studio";

/**
 * The Drafter-side qwen-code adapter writes `.qwen/settings.json` with a
 * read-only tools allowlist. qwen-code interprets a subset allowlist as
 * "only these tools" — every write_file call is then denied even under
 * `--approval-mode yolo`. The Implementer's job IS to write, so we override
 * the inherited settings with one that grants the full tool set. Worktree-
 * local; never propagates back to the project root.
 */
function writeImplementerSettings(cwd: string): void {
  try {
    const dir = resolve(cwd, ".qwen");
    mkdirSync(dir, { recursive: true });
    const settings = { tools: {}, $version: 3 };
    writeFileSync(resolve(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[implementer-qwen] could not write .qwen/settings.json in ${cwd}: ${String(e).slice(0, 200)}`);
  }
}

export interface QwenCodeRunOptions {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
}

export async function runQwenCode(opts: QwenCodeRunOptions): Promise<QwenCodeRunResult> {
  // Qwen on local LM Studio is free + thinking-heavy — generous 60 min budget.
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  writeImplementerSettings(opts.cwd);
  return runStreamingCoder({
    bin: QWEN_BIN,
    args: ["--prompt", opts.prompt, "--output-format", "stream-json", "--approval-mode", "yolo"],
    env: {
      ...process.env,
      OPENAI_BASE_URL: LM_STUDIO_BASE_URL,
      OPENAI_API_KEY: LM_STUDIO_API_KEY,
      OPENAI_MODEL: LM_STUDIO_MODEL,
    } as Record<string, string>,
    cwd: opts.cwd,
    timeoutMs,
    writeToolNames: new Set(["write_file"]),
    label: "qwen",
  });
}
