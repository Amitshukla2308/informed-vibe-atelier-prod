/**
 * Allocator — single-shot LM Studio HTTP call returning {verdict, reason, confidence}.
 *
 * Direct fetch (no PTY, no qwen-code overhead) because the allocator is a small
 * fast classifier. Inputs are: node plan + brain summary. Output is structured
 * JSON the worker uses to decide whether to spawn Qwen-Code or surrender.
 *
 * Refusal criteria (hand_back) per agents/principles/implementer.md:
 *   - plan.md missing Acceptance section or untestable
 *   - "Who benefits" hand-wavy or implies multiple unrelated changes
 *   - Acceptance contradicts a Decision in the project brain
 *   - Touches files outside atelier/{projects/<active>,backend,frontend}
 *   - Requires model swap, GPU lock at high priority, or operator-level action
 */

import type { NodeContext, AllocationResult, LedgerEntry } from "./types";
import { appendLedger } from "./ledger";
import { recordVerifierUnverified } from "~/project/canvas-comments";

const LM_STUDIO_BASE_URL = process.env.QWEN_BASE_URL ?? "http://localhost:1234/v1";
const LM_STUDIO_MODEL = process.env.QWEN_MODEL ?? "qwen/qwen3.6-35b-a3b";

const ALLOCATOR_SYSTEM = `You are the Allocator. You classify a single Atelier Canvas node as either runnable by the local Qwen Implementer ("qwen") or requiring founder attention ("hand_back").

You return STRICT JSON, no prose, no markdown fence:
{"verdict": "qwen" | "hand_back", "reason": "<≤120 chars>", "confidence": 0.0-1.0}

Refuse (verdict="hand_back") if ANY of:
- plan.md is missing an Acceptance section, or Acceptance is untestable / vague
- "Who benefits / What changes for them" is hand-wavy or implies multiple unrelated changes
- The Acceptance criteria contradicts a locked Decision visible in the project brain
- The intent touches files outside atelier/projects/<active>/, atelier/backend/, atelier/frontend/
- The intent requires a model swap on LM Studio, high-priority GPU lock acquisition, or other operator-level action
- The plan is missing the Dependencies section and the intent clearly has external blockers
- The intent is research-only (investigation/benchmarking) with no concrete artifact to ship

Otherwise: verdict="qwen". Confidence floor 0.7 — below that, return hand_back with reason "low confidence".`;

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function buildUserPrompt(ctx: NodeContext): string {
  const metaCompact = JSON.stringify(ctx.meta, null, 2);
  const brainBlock = ctx.brainMarkdown ? `\n## Brain context (compressed)\n${ctx.brainMarkdown.slice(0, 4000)}\n` : "";
  return `Project: ${ctx.project}
Node ID: ${ctx.nodeId}

## meta.json
${metaCompact}

## plan.md
${ctx.plan}
${brainBlock}
Classify this node now. Return JSON only.`;
}

/**
 * Deterministic pre-flight: if plan.md still has stub `(to fill)` markers
 * in load-bearing sections, hand_back without calling the LLM. The LLM gets
 * this right ~70% of the time but the false-positive runs are wasted Qwen
 * cycles AND occasionally end up with a vacuous "completed" run because
 * downstream guards short-circuit on empty Planned artifacts. Cheaper to
 * gate the obvious case here.
 */
function detectStubSections(plan: string): string[] {
  const stubMarker = "(to fill)";
  const checks: Array<{ heading: string; label: string }> = [
    { heading: "## Acceptance", label: "Acceptance" },
    { heading: "## Planned artifacts", label: "Planned artifacts" },
    { heading: "## Who benefits", label: "Who benefits" },
    // Axioms — required for Task/Subtask. Verified mechanically by the
    // Implementer post-Qwen. Stub-empty here means Drafter never wrote
    // the verification contract; Implementer would have nothing to check.
    { heading: "## Axioms", label: "Axioms" },
  ];
  const stubbed: string[] = [];
  for (const { heading, label } of checks) {
    const start = plan.indexOf(heading);
    if (start < 0) {
      // Section missing entirely — also counts as stub for our purposes.
      stubbed.push(`${label} (section missing)`);
      continue;
    }
    // Slice from this heading to the next ## heading (or EOF).
    const after = plan.slice(start + heading.length);
    const nextHeading = after.search(/\n##\s/);
    const body = (nextHeading >= 0 ? after.slice(0, nextHeading) : after).trim();
    if (body.length === 0 || body.includes(stubMarker)) {
      stubbed.push(label);
    }
  }
  return stubbed;
}

export async function allocate(ctx: NodeContext): Promise<AllocationResult> {
  const t0 = Date.now();

  // Kind guard — Project / Plane / Surface / Decision / Risk / Research /
  // Milestone / Artifact are framing nodes, not units of work. The route
  // already rejects these with a clear message, but allocator is also
  // called from other paths (auto-runner, retries) so we hard-stop here too.
  const kind = (ctx.meta as { kind?: string } | undefined)?.kind;
  if (kind && kind !== "Task" && kind !== "Subtask") {
    const elapsed_s = (Date.now() - t0) / 1000;
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: `${kind} is a brief/framing node — Implementer only runs Task or Subtask`,
      confidence: 1.0,
      elapsed_s,
      tokens_in: 0,
      tokens_out: 0,
    };
    logAllocator(ctx.nodeId, result, 0, "kind-guard");
    return result;
  }

  // Pre-LLM stub guard. Returns confidence 1.0 because the check is exact.
  const stubbed = detectStubSections(ctx.plan);
  if (stubbed.length > 0) {
    const elapsed_s = (Date.now() - t0) / 1000;
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: `plan.md has unfilled stub sections: ${stubbed.join(", ")}`,
      confidence: 1.0,
      elapsed_s,
      tokens_in: 0,
      tokens_out: 0,
    };
    logAllocator(ctx.nodeId, result, 0, "stub-guard");
    // Record one verifier_unverified event per stubbed section so the
    // flywheel can compile a Drafter-side rule for each. Stable templated
    // phrasing — the OG compiler dedupes by exact string match.
    for (const label of stubbed) {
      const cleanLabel = label.replace(/\s+\(section missing\)$/, "");
      recordVerifierUnverified(
        ctx.project,
        ctx.nodeId,
        "drafter",
        cleanLabel,
        `plan.md has unfilled stub sections: ${label}`,
        `Tasks proposed by Drafter must contain a non-empty \`## ${cleanLabel}\` section before being marked proposed.`,
      );
    }
    return result;
  }

  // Note: LM Studio rejects response_format.type="json_object" (only "json_schema"
  // or "text" allowed). max_tokens=8192 is the workspace standing rule for thinking
  // models — under that, finish_reason=length leaves content empty. We rely on
  // prompt discipline + a fence-stripping JSON parser instead of structured-output.
  const body = {
    model: LM_STUDIO_MODEL,
    messages: [
      { role: "system", content: ALLOCATOR_SYSTEM },
      { role: "user", content: buildUserPrompt(ctx) },
    ],
    temperature: 0.1,
    max_tokens: 8192,
  };

  let resp: Response;
  try {
    resp = await fetch(`${LM_STUDIO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const elapsed_s = (Date.now() - t0) / 1000;
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: `allocator network error: ${String(e).slice(0, 80)}`,
      confidence: 1.0,
      elapsed_s,
      tokens_in: 0,
      tokens_out: 0,
    };
    logAllocator(ctx.nodeId, result, 1, "network error");
    return result;
  }

  if (!resp.ok) {
    const elapsed_s = (Date.now() - t0) / 1000;
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: `allocator HTTP ${resp.status}`,
      confidence: 1.0,
      elapsed_s,
      tokens_in: 0,
      tokens_out: 0,
    };
    logAllocator(ctx.nodeId, result, resp.status, `HTTP ${resp.status}`);
    return result;
  }

  const data = (await resp.json()) as ChatResponse;
  const elapsed_s = (Date.now() - t0) / 1000;
  const tokens_in = data.usage?.prompt_tokens ?? 0;
  const tokens_out = data.usage?.completion_tokens ?? 0;

  // Strip ```json fences and any leading/trailing prose the model adds despite
  // the system prompt. Then parse. Empty content means thinking-budget overran.
  let raw = (data.choices[0]?.message?.content ?? "").trim();
  if (!raw) {
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: "allocator returned empty content (thinking-budget overrun)",
      confidence: 1.0,
      elapsed_s,
      tokens_in,
      tokens_out,
    };
    logAllocator(ctx.nodeId, result, 0, "empty content");
    return result;
  }
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // If the model wrapped JSON in prose, slice from first { to last }.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  let parsed: { verdict?: string; reason?: string; confidence?: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const result: AllocationResult = {
      verdict: "hand_back",
      reason: `allocator returned invalid JSON: ${raw.slice(0, 80)}`,
      confidence: 1.0,
      elapsed_s,
      tokens_in,
      tokens_out,
    };
    logAllocator(ctx.nodeId, result, 0, "json parse failed");
    return result;
  }

  const verdict: "qwen" | "hand_back" = parsed.verdict === "qwen" ? "qwen" : "hand_back";
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "no reason given";

  // Confidence floor: <0.7 → hand_back regardless of verdict.
  const finalVerdict: "qwen" | "hand_back" = confidence >= 0.7 ? verdict : "hand_back";
  const finalReason = confidence >= 0.7 ? reason : `low confidence (${confidence.toFixed(2)}): ${reason}`;

  const result: AllocationResult = {
    verdict: finalVerdict,
    reason: finalReason,
    confidence,
    elapsed_s,
    tokens_in,
    tokens_out,
  };
  logAllocator(ctx.nodeId, result, 0, "ok");
  return result;
}

function logAllocator(nodeId: string, result: AllocationResult, exit_code: number, note: string): void {
  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    agent: "allocator",
    model: LM_STUDIO_MODEL,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    tools_called: 0,
    elapsed_s: result.elapsed_s,
    exit_code,
    note: `${result.verdict} — ${note}`,
  };
  try {
    appendLedger(nodeId, entry);
  } catch {
    // Ledger write must never block allocation.
  }
}
