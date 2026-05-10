/**
 * opencode provider — TUI default + headless `run` mode.
 *
 * Auth model is opencode's own (`opencode providers login` writes credentials
 * to ~/.local/share/opencode/auth.json). For local LM Studio backed sessions:
 *   opencode providers login custom \
 *     --base-url http://localhost:1234/v1 \
 *     --model qwen/qwen3.6-35b-a3b
 * Atelier does not manage opencode's auth — that's a one-time founder setup.
 *
 * System-prompt injection mechanism: opencode auto-discovers `AGENTS.md` from
 * cwd up to the workspace root and treats it as the active agent's preamble.
 * We pre-spawn-write the composed Drafter prompt there so opencode's TUI boots
 * with the Drafter persona + project context. Mirrors the QWEN.md
 * pattern from qwen-code's adapter.
 *
 * Both interactive and headless paths are handled. Interactive = `opencode`
 * (TUI default in cwd). Headless = `opencode run -m provider/model "msg"`.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AgentProvider, ConversationMeta, CliAdapter, CliSpawnOptions } from "./types";
import { readFileSync } from "node:fs";

function getOpencodeBin(): string {
  return process.env.OPENCODE_BIN ?? "opencode";
}

function envForOpencode(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Opencode reads its provider config from disk; we don't inject API keys here.
  // What we do pass through is the standard openai-compat env in case the
  // founder configured a `custom` provider that reads them at runtime.
  if (process.env.OPENCODE_BASE_URL ?? process.env.OPENAI_BASE_URL) {
    env.OPENAI_BASE_URL = process.env.OPENCODE_BASE_URL ?? process.env.OPENAI_BASE_URL!;
  }
  if (process.env.OPENCODE_API_KEY ?? process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENCODE_API_KEY ?? process.env.OPENAI_API_KEY!;
  }
  return env;
}

export const opencodeProvider: AgentProvider = {
  id: "opencode",
  isAvailable() {
    // Best-effort — `which opencode`-style check would block; we trust env or
    // documented install paths. ttyd-engine fallback also works without an
    // adapter, so a missing binary surfaces at spawn time.
    return true;
  },
  async readConversation(_sessionId: string, _projectCwd: string): Promise<ConversationMeta | null> {
    // opencode persists sessions under ~/.local/share/opencode/sessions/<id>/
    // (db-backed). Reading them back into NormalizedTurn is a separate concern
    // we'll wire when Reflect needs it. Returns null until then; Reflect's
    // raw.log fallback handles the gap.
    return null;
  },
};

export const opencodeAdapter: CliAdapter = {
  id: "opencode",
  isAvailable() {
    return true;
  },

  /**
   * Interactive spawn for the Now-session terminal.
   *
   * Pre-writes <cwd>/AGENTS.md with the composed Drafter prompt; opencode
   * auto-discovers AGENTS.md from cwd at boot and uses it as the active
   * agent's instructions. We don't pass --agent — opencode's "default" agent
   * picks up AGENTS.md transparently.
   */
  getInteractiveCommand(opts: CliSpawnOptions) {
    const systemPromptContents = existsSync(opts.systemPromptPath)
      ? readFileSync(opts.systemPromptPath, "utf-8")
      : "";

    return {
      bin: getOpencodeBin(),
      args: [
        // Default subcommand `[project]` boots the TUI in cwd. We pass cwd
        // explicitly via the spawn opts; no positional arg needed.
        // --pure skips external plugins so a co-founder's machine state
        // can't hijack the session.
        "--pure",
      ],
      env: envForOpencode(),
      preSpawnWrites: [
        // AGENTS.md = opencode's auto-discovered system-prompt slot.
        { path: "AGENTS.md", contents: systemPromptContents },
      ],
    };
  },

  /**
   * Headless single-shot — `opencode run` with -m provider/model + the user
   * message. Used by Implementer / Reflect when not driving the TUI.
   */
  runPrint(opts: CliSpawnOptions, userMessage: string, timeoutMs = 30 * 60 * 1000): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const bin = getOpencodeBin();
      const model = process.env.OPENCODE_MODEL ?? "openrouter/qwen/qwen-2.5-coder-32b-instruct";
      const args = ["run", "--format", "json", "--pure", "-m", model, userMessage];

      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env: envForOpencode(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));

      const t = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`opencode run timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (e) => { clearTimeout(t); rejectPromise(e); });
      child.on("close", (code) => {
        clearTimeout(t);
        if (code === 0) resolvePromise(stdout);
        else rejectPromise(new Error(`opencode run exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  },
};
