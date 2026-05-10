/**
 * Researcher — Pillar A world-grounding agent.
 *
 * Sibling of Fixer (same headless shape, different role). Founder clicks
 * "ask researcher" inside a Decision / Risk / Research node drawer with a
 * question. The HTTP route at /research/run calls runResearcher() which:
 *
 *   1. Loads researcher.md via loadPrinciple() (Session 1 resolver — picks
 *      compiled XML at og_artifacts/agents/researcher.compiled.xml first,
 *      falls back to agents/principles/researcher.md).
 *   2. Reads agent_configs[researcher] to pick the provider (qwen-code by
 *      default).
 *   3. For provider=qwen-code: posts to LM Studio /chat/completions with
 *      max_tokens >= 8192 (workspace standing rule), temperature 0.3,
 *      AbortController + 90s timeout. Honest behavior: local Qwen has no
 *      native web search, so the note is synthesis-only and the principle
 *      tells the model to self-disclose confidence when the question asks
 *      for current-world facts.
 *   4. For provider=claude / gemini: returns a `skipped` result with an
 *      honest reason. Phase 2 wires the --print path with web search.
 *      Until then the path is reachable but doesn't fabricate.
 *
 * Output is a `{ kind: "ok", markdown }` envelope; the caller is
 * responsible for persisting to og_artifacts/brain/projects/<P>/research/
 * and posting the comment back on the Canvas node.
 */

import { config } from "~/config";
import { getDb } from "~/db";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "~/settings/agents";
import { loadPrinciple } from "~/agent/load-principle";
import {
  firecrawlHealth,
  firecrawlSearch,
  firecrawlScrape,
  type FirecrawlSearchResult,
} from "~/research/firecrawl";

const LM_STUDIO_BASE_URL = process.env.QWEN_BASE_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b";
const RESEARCHER_TIMEOUT_MS = 90_000;

// Web evidence shape (kept here so callers can surface it in the comment trail
// alongside the markdown note).
const WEB_EVIDENCE_TOP_K_SCRAPED = 3;
const WEB_EVIDENCE_SEARCH_LIMIT = 5;
const WEB_EVIDENCE_SCRAPE_CHAR_CAP = 3000;
const WEB_EVIDENCE_DISABLED = process.env.RESEARCHER_USE_WEB === "0";

export interface ResearcherOk {
  kind: "ok";
  markdown: string;
  /** Provider that produced the note — used in the comment trail. */
  provider: string;
  /** Pulled from `## Confidence` heading when the model emits one; null when missing. */
  confidence: string | null;
  /**
   * Web sources the Researcher had access to when composing the note. Empty
   * array means firecrawl was unreachable / disabled / search returned nothing
   * — the model fell back to synthesis-only.
   */
  webSources: string[];
  /** Was firecrawl reachable for this run? Surfaces in the comment trail. */
  webReachable: boolean;
}

export interface ResearcherSkipped {
  kind: "skipped";
  reason: string;
}

export interface ResearcherError {
  kind: "error";
  reason: string;
}

export type ResearcherResult = ResearcherOk | ResearcherSkipped | ResearcherError;

export interface ResearcherNodeContext {
  id?: string;
  kind?: string;
  intent?: string;
  parent_id?: string | null;
  /** Optional surface_kind / project layer hints. Compose layer prepends brain. */
  surface_kind?: string | null;
  project?: string;
}

export interface ResearcherInput {
  question: string;
  nodeContext?: ResearcherNodeContext;
}

/**
 * Read researcher config (mode + provider) from agent_configs DB. Mirrors
 * readFixerConfig's single-founder shape; we do not key on user_id because
 * Phase A is single-founder.
 */
function readResearcherConfig(): { mode: string; provider: string } {
  try {
    const row = getDb()
      .query(
        `SELECT mode, provider FROM agent_configs
         WHERE agent_name = 'researcher'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { mode?: string; provider?: string } | undefined;
    if (row && row.mode && row.provider) {
      return { mode: row.mode, provider: row.provider };
    }
  } catch { /* fall through to defaults */ }
  const d = DEFAULT_AGENT_CONFIG.researcher;
  return { mode: d.mode, provider: d.provider };
}

function readPrinciples(): string {
  // Researcher is its own role — we do NOT layer drafter.md on top. The
  // research note has a different output contract from a Canvas node plan.
  return loadPrinciple("researcher");
}

function buildUserPrompt(input: ResearcherInput, webEvidence: string): string {
  const { question, nodeContext } = input;
  const parts: string[] = [];
  if (nodeContext) {
    parts.push("Context for this question:");
    if (nodeContext.id) parts.push(`- Source node id: ${nodeContext.id}`);
    if (nodeContext.kind) parts.push(`- Node kind: ${nodeContext.kind}`);
    if (nodeContext.intent) parts.push(`- Node intent: ${nodeContext.intent}`);
    if (nodeContext.parent_id) parts.push(`- Parent id: ${nodeContext.parent_id}`);
    if (nodeContext.surface_kind) parts.push(`- Surface kind: ${nodeContext.surface_kind}`);
    if (nodeContext.project) parts.push(`- Project: ${nodeContext.project}`);
    parts.push("");
  }
  if (webEvidence) {
    parts.push(webEvidence);
    parts.push("");
  }
  parts.push("Question:");
  parts.push(question.trim());
  parts.push("");
  parts.push(
    "Emit the markdown research note exactly as your principles describe — " +
    "Question / Findings / Confidence / Open questions / optional Recommendation. " +
    "Nothing else, no preamble, no closing remarks.",
  );
  if (webEvidence) {
    parts.push("");
    parts.push(
      "EVIDENCE RULES: Findings must cite a URL drawn from the Web evidence " +
      "block above (verbatim, no fabrication). If a claim has no supporting " +
      "URL in that block, downgrade Confidence accordingly and surface the " +
      "gap under Open questions instead of guessing.",
    );
  }
  return parts.join("\n");
}

/**
 * Pull live web evidence for the question using the firecrawl Docker stack.
 * Search the top N hits, scrape the top K in parallel for full markdown,
 * compose into a structured block the Researcher cites verbatim.
 *
 * Returns empty evidence + reachable=false when firecrawl is down so the
 * caller can degrade gracefully (Phase 1 synthesis-only behavior is preserved).
 */
async function gatherWebEvidence(
  question: string,
): Promise<{ evidence: string; sources: string[]; reachable: boolean; searchedCount: number }> {
  if (WEB_EVIDENCE_DISABLED) {
    return { evidence: "", sources: [], reachable: false, searchedCount: 0 };
  }
  const health = await firecrawlHealth();
  if (!health.reachable) {
    return { evidence: "", sources: [], reachable: false, searchedCount: 0 };
  }
  const results = await firecrawlSearch(question, WEB_EVIDENCE_SEARCH_LIMIT);
  if (!results || results.length === 0) {
    return { evidence: "", sources: [], reachable: true, searchedCount: 0 };
  }

  // Scrape top K in parallel; the rest are URL-only references the model can
  // mention without committing to claims.
  const top = results.slice(0, WEB_EVIDENCE_TOP_K_SCRAPED);
  const scrapes = await Promise.all(top.map((r) => firecrawlScrape(r.url)));

  const blocks: string[] = [];
  blocks.push("## Web evidence (firecrawl — live fetch)");
  blocks.push("");
  blocks.push(
    "These are real fetches against the live web. Cite the URLs verbatim in your Findings.",
  );
  blocks.push("");

  const sources: string[] = [];
  top.forEach((src: FirecrawlSearchResult, i: number) => {
    const scrape = scrapes[i];
    sources.push(src.url);
    blocks.push(`### Source ${i + 1}: ${src.title || src.url}`);
    blocks.push(`URL: ${src.url}`);
    if (src.description) blocks.push(`Snippet: ${src.description}`);
    blocks.push("");
    if (scrape && scrape.markdown.trim().length > 0) {
      const truncated = scrape.markdown.slice(0, WEB_EVIDENCE_SCRAPE_CHAR_CAP);
      const wasTruncated = scrape.markdown.length > WEB_EVIDENCE_SCRAPE_CHAR_CAP;
      blocks.push(`Content (markdown${wasTruncated ? `, truncated to ${WEB_EVIDENCE_SCRAPE_CHAR_CAP} chars` : ""}):`);
      blocks.push("```markdown");
      blocks.push(truncated);
      blocks.push("```");
    } else {
      blocks.push("_(scrape failed for this URL — only the search snippet above is available)_");
    }
    blocks.push("");
  });

  if (results.length > WEB_EVIDENCE_TOP_K_SCRAPED) {
    blocks.push("### Additional search hits (URL only — no scrape)");
    for (const r of results.slice(WEB_EVIDENCE_TOP_K_SCRAPED)) {
      blocks.push(`- ${r.title || "(untitled)"} — ${r.url}`);
      sources.push(r.url);
    }
    blocks.push("");
  }

  return { evidence: blocks.join("\n"), sources, reachable: true, searchedCount: results.length };
}

/**
 * Pull the confidence verdict (high|medium|low) out of a Researcher note so
 * the comment trail can lead with it. Returns null when missing.
 */
function extractConfidence(markdown: string): string | null {
  // Match the line right after a "## Confidence" heading. The principle
  // lays out `<high | medium | low> — <rationale>`, so we lift the first
  // word.
  const m = markdown.match(/##\s+Confidence\s*\n\s*(\S+)/i);
  if (!m) return null;
  const word = m[1].toLowerCase().replace(/[^a-z]/g, "");
  if (word === "high" || word === "medium" || word === "low") return word;
  return null;
}

async function callQwen(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const body = {
    model: LM_STUDIO_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // Slightly looser than Fixer (0.2). Research synthesis benefits from
    // a touch more creativity but we still want sourceable claims.
    temperature: 0.3,
    max_tokens: 8192, // Workspace standing rule — Qwen3 thinking-model floor.
  };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), RESEARCHER_TIMEOUT_MS);
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
 * Run Researcher on a single question. Returns one of:
 *   - ok       : caller writes markdown to og_artifacts/brain/projects/<P>/research/
 *                and posts a comment on the source node.
 *   - skipped  : mode=manual or provider not yet wired (claude/gemini).
 *                Caller surfaces the reason in the comment trail so the
 *                founder knows to switch provider in Settings.
 *   - error    : provider returned but the response was empty / unparseable.
 */
export async function runResearcher(input: ResearcherInput): Promise<ResearcherResult> {
  const cfg = readResearcherConfig();
  if (cfg.mode === "manual") {
    return {
      kind: "skipped",
      reason: "researcher mode=manual — flip to auto in Settings → Agents to enable on-demand runs.",
    };
  }

  const trimmed = input.question.trim();
  if (!trimmed) {
    return { kind: "error", reason: "empty question — type something to ask Researcher." };
  }

  // qwen-code is the only Phase 1 path. claude / gemini stubs return a
  // skipped envelope with an honest reason so the path is reachable but
  // doesn't fabricate world-knowledge.
  if (cfg.provider === "claude" || cfg.provider === "gemini") {
    return {
      kind: "skipped",
      reason:
        `provider "${cfg.provider}" researcher adapter not yet wired (Phase 2 will add ` +
        `the --print path with web search). Switch to qwen-code in Settings → Agents to ` +
        `run a synthesis pass against the local model + project brain.`,
    };
  }
  if (cfg.provider !== "qwen-code") {
    return {
      kind: "skipped",
      reason: `provider "${cfg.provider}" not supported by Researcher. Phase 1 supports qwen-code only.`,
    };
  }

  const systemPrompt = readPrinciples();
  if (!systemPrompt.trim()) {
    return {
      kind: "error",
      reason:
        "researcher principle missing — agents/principles/researcher.md and " +
        "og_artifacts/agents/researcher.compiled.xml are both unreadable.",
    };
  }

  // Pull live web evidence first so the prompt carries citations the model
  // can lift verbatim. Soft failure: if firecrawl is down, evidence is empty
  // and the model degrades to synthesis-only (Phase 1 behavior preserved).
  const web = await gatherWebEvidence(trimmed);

  const userPrompt = buildUserPrompt(input, web.evidence);
  const raw = await callQwen(systemPrompt, userPrompt);
  if (!raw) {
    return {
      kind: "skipped",
      reason: "qwen-code (LM Studio) call failed or empty — is the model loaded at " + LM_STUDIO_BASE_URL + "?",
    };
  }

  const markdown = raw.trim();
  if (!markdown) {
    return { kind: "error", reason: "qwen-code returned an empty completion." };
  }

  return {
    kind: "ok",
    markdown,
    provider: cfg.provider,
    confidence: extractConfidence(markdown),
    webSources: web.sources,
    webReachable: web.reachable,
  };
}

// Re-export config helper for callers that want to surface provider in
// comments/logs without re-reading the DB.
export { readResearcherConfig };

// Avoid the unused-import warning while keeping the type re-exportable.
export type { AgentConfig };
// Suppress: config import is intentionally available for future use (e.g. cwd resolution).
void config;
