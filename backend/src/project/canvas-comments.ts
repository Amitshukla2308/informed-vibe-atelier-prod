/**
 * Canvas comment-thread helpers — DB layer for canvas_node_comments.
 *
 * The HTTP route at /canvas/node/:id/comments writes founder/cofounder
 * comments. This module is the agent-side counterpart: allocator hand_back,
 * implementer blocked, and drafter resolution call postAgentComment to
 * leave a human-readable note on the card without going through HTTP.
 *
 * Per CANVAS_REFRAME_DECISIONS.md §7. Best-effort writes — never let a
 * comment failure abort the agent's work.
 */

import { getDb, nowIso } from "~/db";

export type AgentRole = "drafter" | "allocator" | "implementer" | "researcher" | "system" | "cofounder" | "founder";

/**
 * Append a canvas_node_event row. Used by the PATCH state path to surface
 * founder-driven state changes in the per-node drawer timeline. Best-effort.
 */
export function recordNodeEvent(
  project: string,
  nodeId: string,
  agent: AgentRole,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const now = nowIso();
  try {
    getDb()
      .query(
        `INSERT INTO canvas_node_events (project, node_id, ts, agent, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, nodeId, now, agent, kind, JSON.stringify(payload), now);
  } catch {
    // best-effort
  }
}

/**
 * Record a structured verifier-failure event for the agent_constraints
 * flywheel (per approvals/A2_omnigraph_flywheel.md).
 *
 * Producers:
 *   - implementer/allocator.ts  — every stub-guard hand_back
 *   - implementer/worker.ts     — every failed AxiomResult
 *   - agent/fixer.ts (caller)   — every Fixer surrender
 *
 * Payload schema:
 *   { axiom, evidence, suggested_constraint,
 *     acknowledged: false, rejected?: boolean, edited_constraint?: string }
 *
 * `acknowledged: false` is load-bearing — the OG agent_constraints compiler
 * filters on `acknowledged === true && rejected !== true` so unreviewed
 * failures never reach the agent prompt. The Approvals UI flips the flag.
 */
export function recordVerifierUnverified(
  project: string,
  nodeId: string,
  agentRole: AgentRole,
  axiom: string,
  evidence: string,
  suggestedConstraint: string,
): void {
  const now = nowIso();
  try {
    getDb()
      .query(
        `INSERT INTO canvas_node_events (project, node_id, ts, agent, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project,
        nodeId,
        now,
        agentRole,
        "verifier_unverified",
        JSON.stringify({
          axiom,
          evidence,
          suggested_constraint: suggestedConstraint,
          acknowledged: false,
        }),
        now,
      );
  } catch {
    // best-effort — never let an event-write failure abort verifier flow
  }
}

/**
 * Append an agent-authored comment to a canvas node, mirroring it as a
 * canvas_node_event so the Activity firehose surfaces it. Trims whitespace
 * and silently no-ops on empty body.
 */
export function postAgentComment(project: string, nodeId: string, role: AgentRole, body: string): void {
  const text = body.trim();
  if (!text) return;
  const now = nowIso();
  try {
    getDb()
      .query(
        `INSERT INTO canvas_node_comments (project, node_id, author_user_id, author_role, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(project, nodeId, null, role, text, now);
    getDb()
      .query(
        `INSERT INTO canvas_node_events (project, node_id, ts, agent, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, nodeId, now, role, "comment", JSON.stringify({ body: text }), now);
  } catch {
    // best-effort
  }
}
