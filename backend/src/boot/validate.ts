/**
 * Boot-time validation.
 * From v1's Apr 17 post-mortem: config/env drift caused silent failures.
 * Fail loudly with actionable errors rather than degrade.
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { config } from "~/config";
import { loadOmnigraphBrain, brainLayerFlagsFromEnv } from "~/session/load-omnigraph-brain";

interface Check {
  name: string;
  run: () => string | null; // return null = pass; return string = fail reason
}

const checks: Check[] = [
  {
    name: "Configured CLI installed",
    run: () => {
      const provider = config.agent.provider ?? "claude";
      if (provider === "gemini") {
        const bin = process.env.GEMINI_BIN ?? `${process.env.HOME}/.npm-global/bin/gemini`;
        return existsSync(bin) ? null : `Gemini CLI not found at ${bin}. Install or set GEMINI_BIN.`;
      }
      return existsSync(config.claudeBin) ? null : `Claude CLI not found at ${config.claudeBin}. Install or set CLAUDE_BIN.`;
    }
  },
  {
    name: "Configured CLI authenticated",
    run: () => {
      const provider = config.agent.provider ?? "claude";
      try {
        if (provider === "gemini") {
          const bin = process.env.GEMINI_BIN ?? `${process.env.HOME}/.npm-global/bin/gemini`;
          execSync(`${bin} --version`, { stdio: "pipe" });
          return null;
        }
        execSync(`${config.claudeBin} --version`, { stdio: "pipe" });
        // --version exits 0 even when unauthenticated; check credentials file.
        const creds = `${process.env.HOME}/.claude/.credentials.json`;
        if (!existsSync(creds)) {
          return "Claude CLI not authenticated — run: claude login";
        }
        return null;
      } catch {
        return `${provider} CLI not responding to --version. Is it installed and authenticated?`;
      }
    },
  },
  {
    name: "ttyd available",
    run: () => {
      const bin = process.env.TTYD_BIN ?? "ttyd";
      try {
        execSync(`${bin} --version`, { stdio: "pipe" });
        return null;
      } catch {
        return (
          "ttyd not found — the default terminal engine requires it.\n" +
          "  Universal (Linux static binary):\n" +
          "    curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \\\n" +
          "      -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd\n" +
          "  Mac:    brew install ttyd\n" +
          "  Ubuntu (universe repo only — NOT Debian): sudo apt install ttyd\n" +
          "  Custom: set TTYD_BIN=/path/to/ttyd"
        );
      }
    },
  },
  {
    name: "Agents directory exists",
    run: () => (existsSync(config.agentsDir) ? null : `agents/ dir missing at ${config.agentsDir}`),
  },
  {
    name: "soul.md exists",
    run: () => (existsSync(`${config.agentsDir}/soul.md`) ? null : "agents/soul.md missing"),
  },
  {
    name: "drafter.md exists",
    run: () => (existsSync(`${config.agentsDir}/principles/drafter.md`) ? null : "agents/principles/drafter.md missing"),
  },
  {
    name: "Data dirs exist",
    run: () => {
      for (const d of [config.dataDir, `${config.dataDir}/sessions`, `${config.dataDir}/tmp`]) {
        if (!existsSync(d)) return `${d} missing`;
      }
      return null;
    },
  },
  {
    // Soft check — Atelier reads CLI per-session JSON(L) to build
    // structured reflection data. Only warn.
    name: "CLI projects/chats dir reachable (soft)",
    run: () => {
      const provider = config.agent.provider ?? "claude";
      if (provider === "gemini") {
         const d = `${process.env.HOME}/.gemini/tmp`;
         if (!existsSync(d)) console.warn(`  ⚠ ${d} not found — Reflect will use raw.log fallback until Gemini CLI writes its first chat here.`);
      } else {
         if (!existsSync(config.claudeProjectsDir)) {
           console.warn(`  ⚠ ${config.claudeProjectsDir} not found — Reflect will use raw.log fallback until Claude Code writes its first JSONL here (override via CLAUDE_PROJECTS_DIR).`);
         }
      }
      return null;
    },
  },
  {
    name: "Agent config loads",
    run: () => {
      try {
        // Fields can be blank (triggers onboarding); just ensure the file parses.
        const a = config.agent;
        if (typeof a !== "object") return "config.yaml did not parse to object";
        return null;
      } catch (e) {
        return `config.yaml parse failed: ${e}`;
      }
    },
  },
  {
    // OmniGraph brain-contract validation. Per founder JOURNAL hard-no
    // ("3-layer split must hold"); per failed/0005 + drafter_a2/1777540410:
    // the consumer (atelier) validates its own contract assumptions on
    // every boot rather than trusting the producer (omnigraph compile)
    // to have run. Soft-passes when artifacts are absent (founder is
    // brand-new) — same shape as the CLI projects/chats soft check.
    name: "OmniGraph brain artifacts parse (soft if absent)",
    run: () => {
      try {
        const flags = brainLayerFlagsFromEnv();
        const project = config.agent.active_project ?? "default";
        // "default" matches the single-founder userId convention used
        // throughout the backend.
        const brain = loadOmnigraphBrain("default", project, flags);
        if (brain === null) {
          console.warn(`  ⚠ OmniGraph brain not loaded (user="default", project="${project}") — fine if OmniGraph hasn't compiled yet for this founder.`);
          return null;
        }
        if (!brain.markdown || brain.markdown.length === 0) {
          return `loaded brain has empty markdown despite layers=${JSON.stringify(brain.layersLoaded)}`;
        }
        if (brain.bytes <= 0) {
          return `loaded brain reports bytes=${brain.bytes}; expected > 0`;
        }
        // Sanity: assert at least one layer matches the requested flags.
        const lf = brain.layersLoaded;
        const anyLoadedAsRequested =
          (flags.includeGlobal && lf.global) ||
          (flags.includePersonal && lf.personal) ||
          (flags.includeProject && lf.project !== null);
        if (!anyLoadedAsRequested) {
          return `no requested layer loaded: flags=${JSON.stringify(flags)} layersLoaded=${JSON.stringify(lf)}`;
        }
        console.log(`  brain: ${brain.bytes}B (G=${lf.global ? "Y" : "N"} P=${lf.personal ? "Y" : "N"} J=${lf.project ?? "—"})`);
        return null;
      } catch (e) {
        return `OmniGraph brain load threw: ${String(e).slice(0, 200)}`;
      }
    },
  },
];

export function runBootValidation(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const check of checks) {
    const result = check.run();
    if (result) failures.push(`[${check.name}] ${result}`);
    else console.log(`✓ ${check.name}`);
  }
  // Orphan sweep — ttyd subprocesses + legacy tmux atelier-* sessions left
  // behind by a previous backend run that died abruptly. Idempotent; runs
  // even on first boot (safe no-op if nothing matches).
  try {
    // Lazy require to avoid pulling node:child_process at module-import for
    // any boot path that doesn't end up running validate.
    const mod = require("~/agent/terminal-server") as { sweepTerminalV2Orphans: () => { killed_ttyd: number; killed_tmux: number } };
    const swept = mod.sweepTerminalV2Orphans();
    if (swept.killed_ttyd > 0 || swept.killed_tmux > 0) {
      console.log(`✓ Terminal v2 orphan sweep: ttyd=${swept.killed_ttyd}, tmux=${swept.killed_tmux}`);
    } else {
      console.log("✓ Terminal v2 orphan sweep: nothing to clean");
    }
  } catch (e) {
    failures.push(`[orphan-sweep] ${String(e).slice(0, 200)}`);
  }
  return { ok: failures.length === 0, failures };
}

if (import.meta.main) {
  const { ok, failures } = runBootValidation();
  if (!ok) {
    console.error("\n✗ Boot validation failed:\n");
    failures.forEach((f) => console.error(`  ${f}`));
    process.exit(1);
  }
  console.log("\n✓ All boot checks passed.");
}
