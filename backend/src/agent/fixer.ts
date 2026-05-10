/**
 * Fixer — headless Drafter for the background unblock loop.
 *
 * Invoked by `agent/drafter-background.ts` when a node hits state=blocked
 * with an Allocator hand_back. The orchestrator loads drafter.md +
 * fixer.md as the system prompt, hands over the node + plan + reason, and
 * receives one of two outputs from the configured provider:
 *
 *   1. A complete new plan.md text → caller replaces plan.md, transitions
 *      blocked → proposed so the Allocator re-evaluates.
 *   2. A `<MARK_FOR_DISCUSSION>...</MARK_FOR_DISCUSSION>` block → caller
 *      sets mark_for_discussion=true with the agenda lifted from the
 *      block, posts a comment, and waits for founder.
 *
 * Provider routing follows whatever the founder configured in Settings.
 * Phase 1 implements qwen-code (LM Studio HTTP, same shape as Allocator);
 * other providers (claude, gemini) return null which triggers the
 * mark-for-discussion path. Wire those next.
 */

import { resolve } from "node:path";
import { getDb } from "~/db";
import { config } from "~/config";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "~/settings/agents";
import type { NodeMeta } from "~/project/canvas";
import { loadPrinciple } from "~/agent/load-principle";

const ATELIER_ROOT = resolve(import.meta.dir, "..", "..", "..");
const LM_STUDIO_BASE_URL = process.env.QWEN_BASE_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b";
const FIXER_TIMEOUT_MS = 90_000;

export interface FixerSurrender {
  kind: "surrender";
  reason: string;
  why_not_fixable: string;
  agenda: string;
}

export interface FixerReshape {
  kind: "reshape";
  plan: string;
}

export interface FixerSkipped {
  kind: "skipped";
  reason: string;       // "manual mode" | "provider not implemented" | "provider error"
}

export type FixerResult = FixerReshape | FixerSurrender | FixerSkipped;

interface FixerInput {
  node: NodeMeta;
  plan: string;
  allocatorReason: string;
  parentPlan: string | null;       // if a Story/Epic ancestor exists with a plan.md
}

/**
 * Read fixer config (mode + provider) from agent_configs DB. Falls back
 * to DEFAULT_AGENT_CONFIG.fixer when no user row exists. Phase A is
 * single-founder so we pick the first row regardless of user_id.
 */
function readFixerConfig(): { mode: string; provider: string } {
  try {
    const row = getDb()
      .query(
        `SELECT mode, provider FROM agent_configs
         WHERE agent_name = 'fixer'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { mode?: string; provider?: string } | undefined;
    if (row && row.mode && row.provider) {
      return { mode: row.mode, provider: row.provider };
    }
  } catch { /* fall through to defaults */ }
  const d = DEFAULT_AGENT_CONFIG.fixer;
  return { mode: d.mode, provider: d.provider };
}

function readPrinciples(): string {
  // Drafter rules + headless contract. Order matters: drafter principles
  // first (the substantive content), fixer second (the operating contract
  // override). The model reads them in order. Both flow through
  // loadPrinciple() so compiled XML at og_artifacts/agents/<name>.compiled.xml
  // wins over the markdown source when present (per TODO #29). Falls back
  // to markdown cleanly when the compiled artifact is absent.
  const drafter = loadPrinciple("drafter");
  const fixer = loadPrinciple("fixer");
  return [drafter, "\n\n---\n\n", fixer].join("");
}

function buildUserPrompt(input: FixerInput): string {
  const { node, plan, allocatorReason, parentPlan } = input;
  const parts: string[] = [];
  parts.push(`Node id: ${node.id}`);
  parts.push(`Kind: ${node.kind}`);
  if (node.title) parts.push(`Title: ${node.title}`);
  if (node.parent_id) parts.push(`Parent: ${node.parent_id}`);
  parts.push("");
  parts.push("Allocator hand_back reason:");
  parts.push(allocatorReason);
  parts.push("");
  if (parentPlan) {
    parts.push("Parent Story/Epic plan.md (for inheritance context):");
    parts.push("```md");
    parts.push(parentPlan.slice(0, 8000));
    parts.push("```");
    parts.push("");
  }
  parts.push("Current plan.md to fix:");
  parts.push("```md");
  parts.push(plan.slice(0, 12000));
  parts.push("```");
  parts.push("");
  parts.push("Emit option A (full new plan.md, plain markdown, no fences) or option B (a single <MARK_FOR_DISCUSSION> block). Nothing else.");
  return parts.join("\n");
}

const RE_SURRENDER = /<MARK_FOR_DISCUSSION>([\s\S]*?)<\/MARK_FOR_DISCUSSION>/i;

function parseResponse(text: string): FixerReshape | FixerSurrender {
  const trimmed = text.trim();
  const m = trimmed.match(RE_SURRENDER);
  if (m) {
    const body = m[1] ?? "";
    const reason = (body.match(/reason:\s*(.+)/i)?.[1] ?? "").trim();
    const why = (body.match(/why_not_fixable:\s*(.+)/i)?.[1] ?? "").trim();
    const agenda = (body.match(/agenda:\s*(.+)/i)?.[1] ?? "").trim();
    return {
      kind: "surrender",
      reason: reason || "(no reason given)",
      why_not_fixable: why || "(no explanation given)",
      agenda: agenda || "Fixer surrendered without an agenda. Founder, decide what to do.",
    };
  }
  // Strip an opening ```md fence if the model added one despite instructions.
  let plan = trimmed.replace(/^```(?:md|markdown)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  // Defense-in-depth: if it doesn't look like a plan.md (no `# ` heading
  // or `## ` section), surrender so we don't write garbage.
  if (!/^#\s+\S/m.test(plan) || !/^##\s+\S/m.test(plan)) {
    return {
      kind: "surrender",
      reason: "model output did not parse as plan.md",
      why_not_fixable: "Fixer's response did not contain a valid # heading + ## sections. The runtime refuses to overwrite plan.md with this.",
      agenda: "Founder, the auto-fix returned malformed output. Inspect the comment thread for the raw response and decide manually.",
    };
  }
  return { kind: "reshape", plan };
}

async function callQwen(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const body = {
    model: LM_STUDIO_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 8192, // Workspace standing rule for thinking models — under 8192 risks empty content.
  };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FIXER_TIMEOUT_MS);
  try {
    const resp = await fetch(`${LM_STUDIO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run Fixer on a single blocked node. Returns one of:
 *   - reshape: caller writes the new plan.md and transitions to proposed
 *   - surrender: caller marks for discussion with the supplied agenda
 *   - skipped: mode=manual, provider unsupported, or provider error
 */
export async function runFixer(input: FixerInput): Promise<FixerResult> {
  const cfg = readFixerConfig();
  if (cfg.mode === "manual") {
    return { kind: "skipped", reason: "fixer mode=manual (founder must drive Drafter manually)" };
  }
  // Phase 1: only qwen-code is wired. Other providers fall through to
  // surrender so the founder still gets prompted via mark_for_discussion.
  if (cfg.provider !== "qwen-code") {
    return { kind: "skipped", reason: `provider "${cfg.provider}" headless adapter not yet implemented (Phase 1 supports qwen-code only)` };
  }

  const systemPrompt = readPrinciples();
  const userPrompt = buildUserPrompt(input);
  const raw = await callQwen(systemPrompt, userPrompt);
  if (!raw) {
    return { kind: "skipped", reason: "qwen-code (LM Studio) call failed or empty" };
  }
  return parseResponse(raw);
}

// Re-export config helper for callers that want to surface provider in
// comments/logs without re-reading the DB.
export { readFixerConfig };

// Avoid the unused-import warning while keeping the type re-exportable.
export type { AgentConfig };
// Suppress: config import is intentionally available for future use (e.g. cwd resolution).
void config;
