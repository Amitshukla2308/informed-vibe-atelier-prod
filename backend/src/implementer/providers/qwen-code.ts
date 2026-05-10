/**
 * Qwen-Code provider — headless single-shot invocation.
 *
 * Spawns: `qwen --prompt <text> --output-format json` with cwd set to the
 * per-node worktree. Qwen-Code auto-discovers `QWEN.md` (the implementer
 * principle) and any project-level `CLAUDE.md` from cwd up to `.git`.
 *
 * Returns the parsed JSON payload plus the post-run git diff and files
 * touched. Diff is computed by `branch.diffAgainstBase(handle)` from the
 * caller, not here — this file only owns the spawn.
 *
 * Auth: env-driven, points at local LM Studio.
 *   OPENAI_BASE_URL=http://localhost:1234/v1
 *   OPENAI_API_KEY=lm-studio
 *   OPENAI_MODEL=qwen3.6-35b-a3b
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QwenCodeRunResult } from "../types";

const QWEN_BIN = process.env.QWEN_BIN ?? "qwen";
const LM_STUDIO_BASE_URL = process.env.QWEN_BASE_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b";
const LM_STUDIO_API_KEY = process.env.QWEN_API_KEY ?? "lm-studio";

/**
 * Loop-detection thresholds. Qwen-code on the local 35B model is known to
 * fall into tight cycles: same tool, same input, ad infinitum; or
 * read/grep/list forever without writing. We watch the live event stream
 * and SIGTERM the run when these patterns trip — that's the difference
 * between a 30-second wasted cycle and a 30-minute one.
 */
const LOOP_REPEAT_THRESHOLD = 3;     // same tool+input ≥3× in last ≤5 calls
const LOOP_WINDOW = 5;
const NO_WRITE_THRESHOLD = 25;        // >25 consecutive non-write tool calls = exploration without output
const ASSISTANT_REPEAT_THRESHOLD = 3; // same assistant text 3× in a row
const HARD_CYCLE_CEILING = 200;       // matches the principle's hard ceiling

interface ToolCallSig { name: string; inputHash: string; }
function hashInput(input: unknown): string {
  return createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

/**
 * The Drafter-side qwen-code adapter writes `.qwen/settings.json` with a
 * read-only `tools.core` allowlist (Read/Grep/Glob/WebSearch). When the
 * local sandbox is created, it copies this file into the worktree.
 * qwen-code interprets the allowlist as "only these tools are permitted"
 * — every write_file call is denied with
 *   "Qwen Code requires permission to use 'write_file', but that permission was declined."
 * even though `--approval-mode yolo` is on.
 *
 * The Implementer's job IS to write files, so we override the inherited
 * settings with one that grants the full tool set. This file is local to
 * the worktree and never propagates back to the project root.
 */
function writeImplementerSettings(cwd: string): void {
  try {
    const dir = resolve(cwd, ".qwen");
    mkdirSync(dir, { recursive: true });
    const settings = {
      tools: {
        // Empty / omitted core means "all tools available". Listing the
        // tools we explicitly want is fine but listing a subset acts as an
        // allowlist that EXCLUDES write_file — the Drafter-adapter trap.
      },
      $version: 3,
    };
    writeFileSync(resolve(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[implementer-qwen] could not write .qwen/settings.json in ${cwd}: ${String(e).slice(0, 200)}`);
  }
}

interface QwenJsonOutput {
  response?: string;
  stats?: {
    models?: Array<{ name?: string; tokens?: { total?: number; input?: number; output?: number } }>;
    tools?: { totalCalls?: number; byName?: Record<string, number> };
  };
}

export interface QwenCodeRunOptions {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
}

export async function runQwenCode(opts: QwenCodeRunOptions): Promise<QwenCodeRunResult> {
  const t0 = Date.now();
  // Qwen on local LM Studio is free + thinking-heavy — generous budget.
  // 60 min default; raised from the prior 30 min Claude-era cap.
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;

  // Override any read-only `.qwen/settings.json` the worktree inherited from
  // the Drafter-side adapter. Without this, write_file calls are denied
  // even with --approval-mode yolo.
  writeImplementerSettings(opts.cwd);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      QWEN_BIN,
      // stream-json gives us line-delimited NDJSON events as the run unfolds —
      // that's what makes live loop detection possible.
      ["--prompt", opts.prompt, "--output-format", "stream-json", "--approval-mode", "yolo"],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          OPENAI_BASE_URL: LM_STUDIO_BASE_URL,
          OPENAI_API_KEY: LM_STUDIO_API_KEY,
          OPENAI_MODEL: LM_STUDIO_MODEL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    const events: unknown[] = [];
    const recentToolCalls: ToolCallSig[] = [];
    const recentAssistantTexts: string[] = [];
    let consecNonWriteCalls = 0;
    let totalToolCalls = 0;
    let writeFileSeen = false;
    let killReason: string | null = null;

    function killForLoop(reason: string) {
      if (killReason) return;
      killReason = reason;
      console.warn(`[implementer-qwen] loop detected: ${reason} — sending SIGTERM`);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // SIGKILL backstop in case qwen-code doesn't exit promptly.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 3000);
    }

    function onEvent(evt: unknown) {
      events.push(evt);
      if (!evt || typeof evt !== "object") return;
      const e = evt as { type?: string; message?: { content?: unknown[] } };
      if (e.type !== "assistant") return;
      const content = Array.isArray(e.message?.content) ? e.message!.content : [];

      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        const cc = c as { type?: string; name?: string; input?: unknown; text?: string };

        if (cc.type === "tool_use") {
          totalToolCalls++;
          if (cc.name === "write_file") {
            writeFileSeen = true;
            consecNonWriteCalls = 0;
          } else {
            consecNonWriteCalls++;
          }

          const sig: ToolCallSig = { name: cc.name ?? "?", inputHash: hashInput(cc.input ?? null) };
          recentToolCalls.push(sig);
          if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();

          // Detection 1: same call repeated ≥3× in last LOOP_WINDOW
          const repeats = recentToolCalls.filter(
            (s) => s.name === sig.name && s.inputHash === sig.inputHash,
          ).length;
          if (repeats >= LOOP_REPEAT_THRESHOLD) {
            killForLoop(
              `same tool call repeated ${repeats}× in last ${recentToolCalls.length} (${sig.name} ${sig.inputHash})`,
            );
            return;
          }

          // Detection 3: too many consecutive non-write calls when plan needs writes
          if (consecNonWriteCalls > NO_WRITE_THRESHOLD) {
            killForLoop(
              `${consecNonWriteCalls} consecutive tool calls with no write_file — exploration without output`,
            );
            return;
          }

          // Hard cycle ceiling
          if (totalToolCalls > HARD_CYCLE_CEILING) {
            killForLoop(`exceeded hard cycle ceiling of ${HARD_CYCLE_CEILING} tool calls`);
            return;
          }
        }

        if (cc.type === "text" && typeof cc.text === "string" && cc.text.trim().length > 20) {
          recentAssistantTexts.push(cc.text.trim());
          if (recentAssistantTexts.length > ASSISTANT_REPEAT_THRESHOLD) recentAssistantTexts.shift();
          // Detection 2: same assistant text three in a row
          if (recentAssistantTexts.length === ASSISTANT_REPEAT_THRESHOLD &&
              recentAssistantTexts.every((t) => t === recentAssistantTexts[0])) {
            killForLoop(`identical assistant text ${ASSISTANT_REPEAT_THRESHOLD}× in a row`);
            return;
          }
        }
      }
    }

    let lineBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      lineBuf += d.toString();
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          // non-JSON line; keep for diagnostics in stderr fallback
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      killForLoop(`qwen-code timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`qwen-code spawn failed: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      const elapsed_s = (Date.now() - t0) / 1000;

      // Walk the buffered event stream for stats/final response — same logic
      // as before, just sourced from the live-collected `events` array.
      const rawParsed = events;
      let response = "";
      const tokens = { in: 0, out: 0, total: 0 };
      let tools_called = 0;

      for (const evt of rawParsed) {
        if (!evt || typeof evt !== "object") continue;
        const e = evt as Record<string, unknown>;
        if (e.type === "result" || e.subtype === "final" || e.type === "response") {
          const r = (e.result ?? e.response ?? e.text ?? e.content);
          if (typeof r === "string" && r.length > 0) response = r;
        }
        const usage = (e.message as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } | undefined)?.usage;
        if (usage) {
          tokens.in += usage.input_tokens ?? 0;
          tokens.out += usage.output_tokens ?? 0;
          tokens.total += usage.total_tokens ?? 0;
        }
      }
      tools_called = totalToolCalls;

      // Loop kill: surface the detection reason in the response so the
      // founder UI shows WHY the run was cut short instead of hiding it.
      if (killReason) {
        response = `[loop-detected] ${killReason}\n\n--- Last few tool calls ---\n` +
          recentToolCalls.map((s) => `  - ${s.name} (${s.inputHash})`).join("\n") +
          (response ? `\n\n--- Original model response ---\n${response}` : "");
      }

      // Fallback for true non-JSON crash output
      if (!response && events.length === 0) {
        response = `qwen-code: no events received. stderr: ${stderr.slice(-1500)}`;
      }
      // If no result event surfaced, take the last assistant-message text we saw
      if (!response) {
        for (let i = rawParsed.length - 1; i >= 0; i--) {
          const e = rawParsed[i] as Record<string, unknown>;
          const msg = e?.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
          const text = msg?.content?.find((c) => c.type === "text")?.text;
          if (typeof text === "string" && text.length > 20) { response = text; break; }
        }
      }
      // Suppress `parsed` unused-var noise from the prior implementation
      void writeFileSeen;

      const result: QwenCodeRunResult = {
        // exit 124 by convention = "killed by loop-detector". 0 = clean.
        // Anything else = qwen-code's own exit code (signal-killed often shows -1).
        exit_code: killReason ? 124 : (code ?? -1),
        response,
        diff: "", // caller fills in via branch.diffAgainstBase
        files_touched: [], // caller fills in
        tokens_in: tokens.in,
        tokens_out: tokens.out,
        tools_called,
        elapsed_s,
        raw_json: rawParsed,
      };
      resolvePromise(result);
    });
  });
}
