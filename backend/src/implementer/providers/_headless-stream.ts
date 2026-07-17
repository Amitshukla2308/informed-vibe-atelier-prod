/**
 * Shared headless-coder engine for Implementer providers.
 *
 * Both qwen-code and Claude Code emit the SAME Claude-style stream-json event
 * shape (`{type:"assistant", message:{content:[...], usage}}` … `{type:"result"}`),
 * so one spawn-and-watch loop serves both. A provider file just supplies the
 * binary, args, env, and which tool names count as "writes" (qwen: write_file;
 * Claude: Write/Edit/MultiEdit/NotebookEdit).
 *
 * This owns the spawn, live loop-detection, and result parsing. The caller
 * (worker.ts) fills in `diff` and `files_touched` from the git worktree.
 *
 * Extracted from the original qwen-code.ts so a GPU-less install can ship code
 * on the founder's cloud provider instead of requiring local LM Studio.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { QwenCodeRunResult } from "../types";

const LOOP_REPEAT_THRESHOLD = 3;     // same tool+input ≥3× in last ≤5 calls
const LOOP_WINDOW = 5;
const NO_WRITE_THRESHOLD = 25;        // >25 consecutive non-write tool calls = exploration without output
const ASSISTANT_REPEAT_THRESHOLD = 3; // same assistant text 3× in a row
const HARD_CYCLE_CEILING = 200;       // matches the principle's hard ceiling

interface ToolCallSig { name: string; inputHash: string; }
function hashInput(input: unknown): string {
  return createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

export interface StreamingCoderOptions {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /** Tool names that count as a "write" — resets the no-write loop counter. */
  writeToolNames: Set<string>;
  /** Short label for log lines, e.g. "qwen" | "claude". */
  label: string;
}

export function runStreamingCoder(opts: StreamingCoderOptions): Promise<QwenCodeRunResult> {
  const t0 = Date.now();
  const { bin, args, env, cwd, timeoutMs, writeToolNames, label } = opts;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    const events: unknown[] = [];
    const recentToolCalls: ToolCallSig[] = [];
    const recentAssistantTexts: string[] = [];
    let consecNonWriteCalls = 0;
    let totalToolCalls = 0;
    let writeSeen = false;
    let killReason: string | null = null;

    function killForLoop(reason: string) {
      if (killReason) return;
      killReason = reason;
      console.warn(`[implementer-${label}] loop detected: ${reason} — sending SIGTERM`);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
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
          if (cc.name && writeToolNames.has(cc.name)) {
            writeSeen = true;
            consecNonWriteCalls = 0;
          } else {
            consecNonWriteCalls++;
          }

          const sig: ToolCallSig = { name: cc.name ?? "?", inputHash: hashInput(cc.input ?? null) };
          recentToolCalls.push(sig);
          if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();

          const repeats = recentToolCalls.filter(
            (s) => s.name === sig.name && s.inputHash === sig.inputHash,
          ).length;
          if (repeats >= LOOP_REPEAT_THRESHOLD) {
            killForLoop(`same tool call repeated ${repeats}× in last ${recentToolCalls.length} (${sig.name} ${sig.inputHash})`);
            return;
          }
          if (consecNonWriteCalls > NO_WRITE_THRESHOLD) {
            killForLoop(`${consecNonWriteCalls} consecutive tool calls with no write — exploration without output`);
            return;
          }
          if (totalToolCalls > HARD_CYCLE_CEILING) {
            killForLoop(`exceeded hard cycle ceiling of ${HARD_CYCLE_CEILING} tool calls`);
            return;
          }
        }

        if (cc.type === "text" && typeof cc.text === "string" && cc.text.trim().length > 20) {
          recentAssistantTexts.push(cc.text.trim());
          if (recentAssistantTexts.length > ASSISTANT_REPEAT_THRESHOLD) recentAssistantTexts.shift();
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
        try { onEvent(JSON.parse(line)); } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timeout = setTimeout(() => killForLoop(`${label} timed out after ${timeoutMs}ms`), timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`${label} spawn failed: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      const elapsed_s = (Date.now() - t0) / 1000;
      const rawParsed = events;
      let response = "";
      const tokens = { in: 0, out: 0, total: 0 };

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

      if (killReason) {
        response = `[loop-detected] ${killReason}\n\n--- Last few tool calls ---\n` +
          recentToolCalls.map((s) => `  - ${s.name} (${s.inputHash})`).join("\n") +
          (response ? `\n\n--- Original model response ---\n${response}` : "");
      }
      if (!response && events.length === 0) {
        response = `${label}: no events received. stderr: ${stderr.slice(-1500)}`;
      }
      if (!response) {
        for (let i = rawParsed.length - 1; i >= 0; i--) {
          const e = rawParsed[i] as Record<string, unknown>;
          const msg = e?.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
          const text = msg?.content?.find((c) => c.type === "text")?.text;
          if (typeof text === "string" && text.length > 20) { response = text; break; }
        }
      }
      void writeSeen;

      resolvePromise({
        exit_code: killReason ? 124 : (code ?? -1),
        response,
        diff: "",
        files_touched: [],
        tokens_in: tokens.in,
        tokens_out: tokens.out,
        tools_called: totalToolCalls,
        elapsed_s,
        raw_json: rawParsed,
      });
    });
  });
}
