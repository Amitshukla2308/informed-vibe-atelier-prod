/**
 * Which provider ships a node's code. Shared by the worker (runs the coder)
 * and the allocator (its LLM gate is a qwen-specific "can the weak local model
 * handle this" check — skipped for high-fidelity providers).
 *
 * Resolution order:
 *   1. ATELIER_IMPLEMENTER_PROVIDER env — explicit operator override
 *   2. the founder's implementer agent config (Settings → Agents)
 *   3. "qwen-code" — Phase-A local default
 *
 * "claude" runs the founder's Claude CLI: no local GPU / LM Studio required,
 * which is what lets a normal install ship real code.
 */

import { getAgentConfig } from "~/settings/agents";

export function resolveImplementerProvider(userId?: string): string {
  const envOverride = process.env.ATELIER_IMPLEMENTER_PROVIDER?.trim();
  if (envOverride) return envOverride;
  try {
    const cfg = getAgentConfig(userId ?? "default", "implementer");
    if (cfg?.provider) return cfg.provider;
  } catch { /* no per-user config — fall through */ }
  return "qwen-code";
}

/** True when the provider is the local qwen/LM-Studio path (the only one the
 *  allocator's LLM gate and the qwen loop-detector are tuned for). */
export function isQwenImplementer(userId?: string): boolean {
  return resolveImplementerProvider(userId) === "qwen-code";
}
