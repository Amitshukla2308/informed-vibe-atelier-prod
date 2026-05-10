/**
 * Per-user agent settings + provider linking.
 *
 * Seven agents in scope:
 *   drafter          — foreground co-thinker (chat pane, PTY)
 *   fixer            — background headless Drafter. Runs the same drafter.md
 *                      principles but headlessly: reads one blocked node,
 *                      ingests the allocator hand_back reason, writes a
 *                      re-shaped plan.md OR surrenders with a discussion
 *                      agenda. Not a separate set of rules — a separate
 *                      invocation mode of Drafter.
 *   researcher       — headless world-grounding agent. Founder invokes from
 *                      a Decision/Risk/Research node drawer with a question
 *                      ("what does the law say?", "what's the current rate?")
 *                      and a structured markdown research note is written to
 *                      og_artifacts/brain/projects/<P>/research/ + linked
 *                      from a node comment. Closes Pillar A (world-grounding)
 *                      so the founder doesn't have to leave Atelier for
 *                      current-world signal.
 *   allocator        — pre-Implementer classifier (qwen | hand_back)
 *   implementer      — background coder (Qwen-Code or fallback)
 *   senior_reviewer  — opt-in cloud critique pass
 *   reflect          — session-end six-lens crystallization
 *
 * Each agent has:
 *   mode      — manual | semi_auto | auto (escalation autonomy)
 *   provider  — free string keyed to provider_links.provider
 *
 * Providers are not Atelier-internal. They're the founder's choice of CLI /
 * API endpoint. Phase A includes: claude, gemini, qwen-code, openai-api,
 * anthropic-api, lm-studio. The list is data, not code.
 */

import { getDb, newId, nowIso } from "~/db";

export type AgentName = "drafter" | "fixer" | "researcher" | "allocator" | "implementer" | "senior_reviewer" | "reflect";
export type AgentMode = "manual" | "semi_auto" | "auto";
export type ProviderLinkStatus = "linked" | "unlinked" | "expired";

export interface AgentConfig {
  agent_name: AgentName;
  mode: AgentMode;
  provider: string;
  updated_at: string;
}

export interface ProviderLink {
  provider: string;
  status: ProviderLinkStatus;
  bin_path: string | null;
  base_url: string | null;
  model_id: string | null;
  api_key_env: string | null;
  notes: string | null;
  linked_at: string | null;
  updated_at: string;
}

export const AGENT_NAMES: AgentName[] = ["drafter", "fixer", "researcher", "allocator", "implementer", "senior_reviewer", "reflect"];
export const AGENT_MODES: AgentMode[] = ["manual", "semi_auto", "auto"];

/**
 * Default agent configs — surfaced when a user has nothing saved yet. Drafter
 * defaults to claude (cloud, founder-facing); Allocator + Implementer default
 * to qwen-code (local, no cost); Senior reviewer defaults to claude (cloud,
 * opt-in per-node action). Fixer defaults to qwen-code so the background
 * loop closes locally during Phase A — flip to claude (or any other
 * configured provider) when ready for higher-fidelity unblocks.
 */
export const DEFAULT_AGENT_CONFIG: Record<AgentName, { mode: AgentMode; provider: string }> = {
  drafter:         { mode: "manual",    provider: "claude" },
  // Fixer = headless Drafter on background blocked-node duty. Default auto
  // means: when allocator hand_backs, Fixer wakes within ~60s, attempts a
  // re-shape via the configured provider, falls back to mark_for_discussion
  // on surrender. Flip to manual to disable autonomy entirely.
  fixer:           { mode: "auto",      provider: "qwen-code" },
  // Researcher is invoked on-demand from a Canvas node drawer (Decision /
  // Risk / Research kinds). Default auto + qwen-code: founder clicks "ask
  // researcher", local Qwen synthesizes with whatever context is in the
  // prompt + project brain. Phase 2 adds claude / gemini --print path with
  // real web search; until then qwen-code self-discloses confidence in
  // every note when current-world facts are needed.
  researcher:      { mode: "auto",      provider: "qwen-code" },
  allocator:       { mode: "auto",      provider: "qwen-code" },
  implementer:     { mode: "semi_auto", provider: "qwen-code" },
  senior_reviewer: { mode: "manual",    provider: "claude" },
  // Reflect runs at session-end as background pipeline (six-lens
  // crystallization). Default auto + qwen-code: cheap local pass per session,
  // founder doesn't need to approve each reflection. Switch to claude for
  // higher-fidelity reflection on critical sessions.
  reflect:         { mode: "auto",      provider: "qwen-code" },
};

export const KNOWN_PROVIDERS = [
  { id: "claude",         label: "Claude (CLI)",       kind: "cli" },
  { id: "gemini",         label: "Gemini (CLI)",       kind: "cli" },
  { id: "qwen-code",      label: "Qwen-Code (local)",  kind: "cli" },
  { id: "openai-api",     label: "OpenAI API",         kind: "api" },
  { id: "anthropic-api",  label: "Anthropic API",      kind: "api" },
  { id: "lm-studio",      label: "LM Studio (local)",  kind: "api" },
] as const;

/* -------------------------------------------------------------------------- */

export function getAgentConfigs(userId: string): AgentConfig[] {
  const db = getDb();
  const rows = db.query(
    `SELECT agent_name, mode, provider, updated_at
       FROM agent_configs WHERE user_id = ?`,
  ).all(userId) as AgentConfig[];

  // Fill in defaults for any agent the user hasn't customized yet.
  const seen = new Set(rows.map((r) => r.agent_name));
  const out: AgentConfig[] = [...rows];
  for (const a of AGENT_NAMES) {
    if (!seen.has(a)) {
      out.push({
        agent_name: a,
        mode: DEFAULT_AGENT_CONFIG[a].mode,
        provider: DEFAULT_AGENT_CONFIG[a].provider,
        updated_at: nowIso(),
      });
    }
  }
  // Sort to match AGENT_NAMES order for stable UI rendering.
  out.sort((a, b) => AGENT_NAMES.indexOf(a.agent_name) - AGENT_NAMES.indexOf(b.agent_name));
  return out;
}

export function getAgentConfig(userId: string, agent: AgentName): AgentConfig {
  return getAgentConfigs(userId).find((c) => c.agent_name === agent)!;
}

export function setAgentConfig(
  userId: string,
  agent: AgentName,
  mode: AgentMode,
  provider: string,
): AgentConfig {
  if (!AGENT_NAMES.includes(agent)) throw new Error(`unknown agent: ${agent}`);
  if (!AGENT_MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const db = getDb();
  const now = nowIso();
  const existing = db.query(
    `SELECT id FROM agent_configs WHERE user_id = ? AND agent_name = ?`,
  ).get(userId, agent) as { id: string } | undefined;
  if (existing) {
    db.query(
      `UPDATE agent_configs SET mode = ?, provider = ?, updated_at = ? WHERE id = ?`,
    ).run(mode, provider, now, existing.id);
  } else {
    db.query(
      `INSERT INTO agent_configs (id, user_id, agent_name, mode, provider, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId(), userId, agent, mode, provider, now);
  }
  return { agent_name: agent, mode, provider, updated_at: now };
}

/* -------------------------------------------------------------------------- */

export function getProviderLinks(userId: string): ProviderLink[] {
  const db = getDb();
  const rows = db.query(
    `SELECT provider, status, bin_path, base_url, model_id, api_key_env, notes, linked_at, updated_at
       FROM provider_links WHERE user_id = ?`,
  ).all(userId) as ProviderLink[];
  // Auto-detect "linked" for CLI providers whose binary is on disk and exec-able.
  // (read-only inference; doesn't write to the DB)
  return rows;
}

export function getProviderLink(userId: string, provider: string): ProviderLink | null {
  const db = getDb();
  const row = db.query(
    `SELECT provider, status, bin_path, base_url, model_id, api_key_env, notes, linked_at, updated_at
       FROM provider_links WHERE user_id = ? AND provider = ?`,
  ).get(userId, provider) as ProviderLink | undefined;
  return row ?? null;
}

export function upsertProviderLink(
  userId: string,
  provider: string,
  fields: Partial<Omit<ProviderLink, "provider" | "updated_at">>,
): ProviderLink {
  const db = getDb();
  const now = nowIso();
  const existing = getProviderLink(userId, provider);
  const merged: ProviderLink = {
    provider,
    status: fields.status ?? existing?.status ?? "unlinked",
    bin_path: fields.bin_path ?? existing?.bin_path ?? null,
    base_url: fields.base_url ?? existing?.base_url ?? null,
    model_id: fields.model_id ?? existing?.model_id ?? null,
    api_key_env: fields.api_key_env ?? existing?.api_key_env ?? null,
    notes: fields.notes ?? existing?.notes ?? null,
    linked_at: fields.linked_at ?? existing?.linked_at ?? (fields.status === "linked" ? now : null),
    updated_at: now,
  };
  if (existing) {
    db.query(
      `UPDATE provider_links SET status = ?, bin_path = ?, base_url = ?, model_id = ?,
              api_key_env = ?, notes = ?, linked_at = ?, updated_at = ?
        WHERE user_id = ? AND provider = ?`,
    ).run(
      merged.status, merged.bin_path, merged.base_url, merged.model_id,
      merged.api_key_env, merged.notes, merged.linked_at, merged.updated_at,
      userId, provider,
    );
  } else {
    db.query(
      `INSERT INTO provider_links (id, user_id, provider, status, bin_path, base_url, model_id, api_key_env, notes, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(), userId, provider,
      merged.status, merged.bin_path, merged.base_url, merged.model_id,
      merged.api_key_env, merged.notes, merged.linked_at, merged.updated_at,
    );
  }
  return merged;
}
