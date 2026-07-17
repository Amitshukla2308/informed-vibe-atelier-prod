/**
 * Atelier backend config loader.
 * Reads env vars + agents/config.yaml; provides typed access to the rest of the app.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const ATELIER_ROOT = resolve(import.meta.dir, "../..");

export interface AgentConfig {
  agent_name: string;
  founder_name: string;
  founder_email: string;
  org_name: string;
  /**
   * Default provider for new Drafter sessions. Generic — accepts any provider
   * id (claude, gemini, qwen-code, openai-api, anthropic-api, lm-studio, ...).
   * Per-agent overrides live in the agent_configs DB table; this YAML field
   * is just the bootstrap default for the Drafter on a fresh install.
   */
  provider?: string;
  locale: string;
  timezone: string;
  tone_preference: "direct" | "warm" | "formal";
  response_density: "terse" | "balanced" | "thorough";
  confidence_thresholds: {
    auto_write: "high" | "medium" | "low";
    review_queue: "high" | "medium" | "low";
    suppress: "high" | "medium" | "low";
  };
  fatigue: {
    enabled: boolean;
    soft_warn_after_minutes: number;
    hard_nudge_after_minutes: number;
    track_in_personal_brain: boolean;
  };
  active_project: string;
  usage_tracking: {
    enabled: boolean;
    endpoint: string;
    inject_script_path: string;
  };
}

export function loadAgentConfig(): AgentConfig {
  const path = resolve(ATELIER_ROOT, "agents/config.yaml");
  const raw = readFileSync(path, "utf-8");
  return YAML.parse(raw) as AgentConfig;
}

export const config = {
  atelierRoot: ATELIER_ROOT,
  port: Number(process.env.ATELIER_PORT ?? 3001),
  /** Bind address. Loopback by default — exposure is the tunnel's job, and
   *  boot validation refuses a non-loopback bind outside secure mode. */
  bindHost: process.env.ATELIER_BIND ?? "127.0.0.1",
  baseUrl: process.env.ATELIER_BASE_URL ?? `http://localhost:${process.env.ATELIER_PORT ?? 3001}`,
  // Provider binary paths — symmetrical across CLI providers. Atelier resolves
  // a provider's binary from this map keyed by provider id; the per-agent
  // configured provider chooses the bin. claudeBin is kept for legacy code
  // paths (reflection fallback, boot validate); new code reads providerBins.
  claudeBin: process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`,
  providerBins: {
    claude:      process.env.CLAUDE_BIN  ?? `${process.env.HOME}/.local/bin/claude`,
    gemini:      process.env.GEMINI_BIN  ?? "gemini",
    "qwen-code": process.env.QWEN_BIN    ?? "qwen",
  } as Record<string, string>,
  /**
   * Where Claude Code persists per-session conversation JSONL. Atelier reads
   * this directory (never writes) to reconstruct structured turns for Reflect.
   * Override with env var CLAUDE_PROJECTS_DIR when running Atelier on a host
   * where Claude Code stores its projects elsewhere.
   */
  claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? `${process.env.HOME}/.claude/projects`,
  dataDir: resolve(ATELIER_ROOT, "data"),
  projectsDir: resolve(ATELIER_ROOT, "projects"),
  agentsDir: resolve(ATELIER_ROOT, "agents"),
  docsDir: resolve(ATELIER_ROOT, "docs"),
  /** @deprecated use loadAgentConfig() for fresh reads (config changes during onboarding) */
  get agent(): AgentConfig {
    return loadAgentConfig();
  },
};

export type Config = typeof config;
