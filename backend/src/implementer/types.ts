/**
 * Implementer types — shared across allocator, worker, providers, branch, ledger.
 * Phase A scope: see ../../agents/principles/implementer.md "Runtime adapter".
 */

export type Verdict = "qwen" | "hand_back";

export interface AllocationResult {
  verdict: Verdict;
  reason: string;
  confidence: number;            // 0.0–1.0; <0.7 is treated as hand_back
  elapsed_s: number;
  tokens_in: number;
  tokens_out: number;
}

/** A reference to a sibling/ancestor/related node, slimmed for prompt context. */
export interface NodeRef {
  id: string;
  kind: string;
  title: string;
  intent?: string;
  state: string;
}

/**
 * Where this node is *derived from*. The Implementer is told not just what
 * to build but the chain of intent above it: which Story/Epic motivated the
 * Task, which Surface contains it, which Decisions bind its shape, which
 * Risks the founder flagged. Per A2: Story/Epic are non-executable — they
 * exist as containers, and the Implementer reads them as context, not as
 * instructions.
 */
export interface DerivationContext {
  /** Parent → grandparent → … → root (Project). Closest first. */
  ancestors: NodeRef[];
  /** Decision nodes whose `depends-on` edge points at this node or any ancestor. */
  decisions: NodeRef[];
  /** Risk nodes attached anywhere up the chain. */
  risks: NodeRef[];
}

export interface NodeContext {
  project: string;               // project slug
  nodeId: string;                // "n_moa8p97m_7sndy"
  meta: Record<string, unknown>; // parsed meta.json
  plan: string;                  // raw plan.md
  brainMarkdown: string | null;  // composed brain block, or null if unavailable
  // Architecture-aware pre-flight (see docs/PROJECT_SHAPE.md). Union of every
  // touched Surface's manifest_globs. Empty = no gate (Drafter hasn't placed
  // this node yet). Implementer prompts the model with these and the post-run
  // scope guard rejects writes that fall outside all of them.
  allowedGlobs?: string[];
  touchedSurfaces?: { id: string; title: string; surface_kind?: string | null; surface_status?: string | null }[];
  /** A2.2: chain of derivation up to Project + adjacent Decisions/Risks. */
  derivation?: DerivationContext | null;
  /** Founder whose agent config / auth this run uses (provider selection). */
  userId?: string;
}

export interface QwenCodeRunResult {
  exit_code: number;
  response: string;              // top-level "response" from -o json
  diff: string;                  // git diff vs branch parent
  files_touched: string[];
  tokens_in: number;
  tokens_out: number;
  tools_called: number;
  elapsed_s: number;
  raw_json: unknown;             // entire qwen-code -o json payload
}

export interface ImplementerResult {
  nodeId: string;
  branch: string;                // "impl/<node-id>"
  worktreePath: string;
  finalState: "review" | "blocked";
  reason: string;                // surrender reason or "ok"
  allocation: AllocationResult;
  run: QwenCodeRunResult | null; // null when allocation == hand_back
  diffBytes: number;
  tscOk: boolean;
  ledgerPath: string;
}

export interface LedgerEntry {
  ts: string;                    // ISO-8601
  agent: "allocator" | "qwen-code";
  model: string;
  tokens_in: number;
  tokens_out: number;
  tools_called: number;
  elapsed_s: number;
  exit_code: number;
  note?: string;
}
