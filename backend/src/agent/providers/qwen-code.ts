/**
 * Qwen-Code provider — CLI auth (uses qwen's own login state) + interactive
 * spawn for Now sessions + headless --prompt mode for Implementer / Reflect.
 *
 * Local model server (LM Studio / vLLM / Ollama) is configured via env vars
 * the qwen binary reads at startup:
 *   OPENAI_BASE_URL · OPENAI_API_KEY · OPENAI_MODEL
 * (qwen-code v0.15+ uses authType=openai for OpenAI-compatible endpoints.)
 *
 * No conversation reading from disk yet — qwen-code session JSONL lives at
 * ~/.qwen/projects/<sanitized-cwd>/chats/<sid>.jsonl, but we currently let
 * Reflect read raw.log via the Now-PTY pipeline. readConversation returns
 * null until we wire that path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AgentProvider, ConversationMeta, CliAdapter, CliSpawnOptions } from "./types";

/**
 * Defensively patch ~/.qwen/settings.json with a valid 2-stop ui.gradient.
 *
 * qwen-code 0.15.3 has a bug where its theme resolver (cli.js:449198) reads
 *    GradientColors: customTheme.ui?.gradient ?? customTheme.GradientColors
 * and the consumer (cli.js:508345) only checks `length > 0` instead of
 * `>= 2`. TinyGradient's constructor throws on stops.length < 2, killing
 * the React-Ink tree. This affects WSL/Linux installs whose user-level
 * settings.json doesn't have ui.gradient set; built-in themes can supply
 * a single-color brand gradient that triggers the bug.
 *
 * On WSL specifically, the founder's PowerShell-side ~/.qwen/ works fine
 * because the Windows install has different default config. The Linux-
 * side install needs the fix.
 *
 * We patch user-level ~/.qwen/settings.json (not project-level) because
 * qwen-code's merge order treats user-level as base + project as override
 * for object FIELDS, but the theme resolver pulls from the merged
 * customTheme — and project-only `ui.gradient` was being overshadowed by
 * the active built-in theme's broken gradient. Patching the user-level
 * settings.json gets it merged into the active customTheme properly.
 *
 * Idempotent: only writes if ui.gradient is missing or invalid (< 2
 * colors). Preserves all other fields in the user's settings.
 */
function ensureQwenUiGradient(): void {
  const home = process.env.HOME ?? "/root";
  const path = resolve(home, ".qwen", "settings.json");
  if (!existsSync(path)) return; // user hasn't run qwen-code yet; nothing to patch
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const ui = (data.ui ?? {}) as Record<string, unknown>;
    const grad = ui.gradient;
    if (Array.isArray(grad) && grad.length >= 2) return; // already valid
    ui.gradient = ["#4796E4", "#847ACE"];
    data.ui = ui;
    writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`[qwen-code] patched ${path} with valid ui.gradient (theme system bug workaround)`);
  } catch (e) {
    console.warn(`[qwen-code] could not patch ${path}: ${String(e).slice(0, 200)}`);
  }
}

function getQwenBin(): string {
  return process.env.QWEN_BIN ?? resolve(process.env.HOME ?? "/", ".npm-global/bin/qwen");
}

function envForQwen(): Record<string, string> {
  // qwen-code 0.15.x reads the OpenAI-compatible auth key from the env var
  // NAMED in settings.json's `modelProviders.openai[].envKey`. The user's
  // ~/.qwen/settings.json sets `envKey: "lmstudio"`, so the literal env var
  // `lmstudio` must hold the key. When unset, qwen-code's auth flow falls
  // into a degraded UI render path that constructs a Gradient with < 2
  // color stops → crash:
  //    ERROR Invalid number of stops (< 2) at TinyGradient
  //
  // We set every common LM-Studio-style env key name to a sentinel value;
  // LM Studio doesn't validate the key string, so any non-empty value works.
  // Whichever name the founder's settings.json references will be found.
  const sentinelKey = process.env.QWEN_API_KEY ?? process.env.OPENAI_API_KEY ?? "lm-studio";
  // ACTIVELY STRIP NO_COLOR / FORCE_COLOR_OFF / etc. from the inherited env.
  // NO_COLOR=1 makes qwen-code's theme system switch to a minimal/monochrome
  // path whose `ui.gradient` has < 2 stops → TinyGradient crash. The user's
  // working PowerShell-WSL session has NO_COLOR unset, so we mirror that.
  // Spreading process.env can leak NO_COLOR if the parent shell or restart
  // script set it; explicit delete after spread guarantees it's gone.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR_OFF;
  delete env.NODE_DISABLE_COLORS;
  env.OPENAI_BASE_URL    = process.env.QWEN_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1";
  env.OPENAI_API_KEY     = sentinelKey;
  env.OPENAI_MODEL       = process.env.QWEN_MODEL    ?? process.env.OPENAI_MODEL    ?? "qwen/qwen3.6-35b-a3b";
  env.lmstudio           = sentinelKey;
  env.LM_STUDIO_API_KEY  = sentinelKey;
  env.LMSTUDIO_API_KEY   = sentinelKey;
  env.TERM               = process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color";
  // Force color ON so the React-Ink Gradient takes the full-palette path
  // (where ui.gradient has its 2+ stops) rather than the monochrome path.
  env.FORCE_COLOR        = "1";
  // Silences the cosmetic Node startup warning "NO_COLOR is ignored due to
  // FORCE_COLOR" that qwen-code's child Node tools emit when they inherit a
  // stray NO_COLOR from upstream WSL/login shell config we can't always strip.
  env.NODE_NO_WARNINGS   = "1";
  return env;
}

export const qwenCodeProvider: AgentProvider = {
  id: "qwen-code",
  isAvailable() {
    try { return existsSync(getQwenBin()); } catch { return false; }
  },
  async readConversation(_sessionId: string, _projectCwd: string): Promise<ConversationMeta | null> {
    // Phase A: Reflect uses raw.log path; structured qwen-code chat JSONL
    // reading lands when we move Reflect off the PTY stream.
    return null;
  },
};

export const qwenCodeAdapter: CliAdapter = {
  id: "qwen-code",

  isAvailable() {
    try { return existsSync(getQwenBin()); } catch { return false; }
  },

  /**
   * Interactive spawn for the Now session terminal.
   *
   * qwen-code auto-discovers context from `QWEN.md` at cwd up to .git, and
   * `.qwen/settings.json` for MCP servers + model providers. We translate
   * Atelier's MCP config (mcpConfigPath) into the .qwen/settings.json shape.
   *
   * The system prompt path is folded into a QWEN.md prepended block so
   * qwen-code reads our composed identity prompt at startup. (qwen-code has
   * no first-class --system flag like Claude; QWEN.md is the supported
   * surface for static instructions.)
   */
  getInteractiveCommand(opts: CliSpawnOptions) {
    // Defensive: patch ~/.qwen/settings.json if its ui.gradient is missing
    // or invalid (< 2 stops). This is the actual fix for the recurring
    // TinyGradient crash; project-scoped settings alone don't override
    // the active built-in theme's broken gradient.
    ensureQwenUiGradient();

    // Project-scoped Settings.json: mcpServers + a redundant ui.gradient
    // (belt-and-suspenders if user-level patch ever lapses).
    //
    // qwen-code 0.15.3's theme resolution at cli.js:449198 reads:
    //    GradientColors: customTheme.ui?.gradient ?? customTheme.GradientColors
    // and the consumer at cli.js:508345 only checks `length > 0` instead
    // of `>= 2`. TinyGradient's constructor throws when stops.length < 2,
    // crashing the whole React-Ink tree:
    //    ERROR  Invalid number of stops (< 2)
    //    at TinyGradient (qwen-code/cli.js:426308:17)
    //
    // Many built-in qwen-code themes ship with a single-color brand
    // gradient (or empty array) — the bug fires regardless of the user's
    // own config. Writing `ui.gradient` with ≥2 colors in the project-
    // scoped settings.json overrides the merge and gives TinyGradient a
    // valid input. Sage palette anchors so the in-app theme stays in
    // family with Atelier's UI tokens.
    const settings: Record<string, unknown> = {
      ui: {
        gradient: ["#4796E4", "#847ACE"],
      },
    };
    // Translate Atelier MCP config → qwen-code's mcpServers schema.
    if (opts.mcpConfigPath && existsSync(opts.mcpConfigPath)) {
      try {
        const parsed = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
        if (parsed.mcpServers) settings.mcpServers = parsed.mcpServers;
      } catch { /* ignore malformed mcp config */ }
    }
    // Tool allowlist — qwen-code's coreTools setting accepts a list of
    // built-in tool names; pass through if Atelier's tool surface includes any.
    if (opts.tools.length > 0) {
      (settings as { coreTools?: string[] }).coreTools = opts.tools;
    }

    // qwen-code 0.15.6 supports --system-prompt / --append-system-prompt as CLI
    // flags. We use --append-system-prompt so qwen's own tool-use protocol stays
    // intact and the Atelier Drafter persona / agent identity / project context layers
    // on top. Earlier `.qwen/system.md` placement was a wrong-mechanism dead end —
    // qwen-code reads user-level ~/.qwen/projects/<sanitized-cwd>/memory/MEMORY.md
    // for memory, not project-scoped .qwen/system.md.
    const systemPrompt = existsSync(opts.systemPromptPath)
      ? readFileSync(opts.systemPromptPath, "utf-8")
      : "";

    const args: string[] = ["--approval-mode", "yolo"];   // founder-supervised; Atelier owns the trust gate
    if (systemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", systemPrompt);
    }

    return {
      bin: getQwenBin(),
      args,
      env: envForQwen(),
      preSpawnWrites: [
        { path: ".qwen/settings.json", contents: JSON.stringify(settings, null, 2) },
      ],
    };
  },

  /**
   * Headless single-shot — Implementer / Reflect. Captures stdout (which is
   * an event-stream JSON array under -o json) for the caller to parse.
   * timeoutMs default 30 min to match Implementer worker default.
   */
  runPrint(opts: CliSpawnOptions, userMessage: string, timeoutMs = 30 * 60 * 1000): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const bin = getQwenBin();
      if (!existsSync(bin)) {
        rejectPromise(new Error(`qwen binary not found at ${bin}`));
        return;
      }
      // Pre-spawn writes: identical to interactive — gives the headless run
      // the same context (QWEN.md / system.md / .qwen/settings.json).
      try {
        const interactive = qwenCodeAdapter.getInteractiveCommand(opts);
        for (const w of interactive.preSpawnWrites ?? []) {
          const abs = resolve(opts.cwd, w.path);
          mkdirSync(resolve(abs, ".."), { recursive: true });
          writeFileSync(abs, w.contents);
        }
      } catch { /* best-effort context priming */ }

      const args = [
        "--prompt", userMessage,
        "--output-format", "json",
        "--approval-mode", "yolo",
      ];

      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env: envForQwen(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      const t = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`qwen --prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(t);
        rejectPromise(new Error(`qwen spawn failed: ${err.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        if (code !== 0) {
          rejectPromise(new Error(`qwen --prompt exited ${code}: ${stderr.slice(-500)}`));
          return;
        }
        resolvePromise(stdout);
      });
    });
  },
};
