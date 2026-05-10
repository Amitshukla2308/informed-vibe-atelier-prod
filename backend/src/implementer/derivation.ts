/**
 * A2.2 — derivation context builder.
 *
 * Given a runnable node (Task / Subtask), assemble the chain of intent
 * above it that the Implementer needs to read but cannot execute against:
 *
 *   - ancestors  — walk parent_id upward, closest first, until null/cycle.
 *                  Typically Subtask → Task → Story|Epic → Surface →
 *                  Plane → Project.
 *   - decisions  — Decision nodes whose `depends-on` edge points at THIS
 *                  node or any ancestor. The contract Decisions our
 *                  coherence gate (Iter 4) lives on are exactly this shape.
 *   - risks      — Risk nodes pointed at by depends-on edges to ancestors,
 *                  or with `parent_id` matching any ancestor.
 *
 * Pure: no canvas writes; reads listNodes + getGraph. Cheap enough to call
 * on every worker spawn; the prompt builder slices it for token budget.
 */

import { listNodes, getGraph, type NodeMeta, type Edge } from "~/project/canvas";
import type { DerivationContext, NodeRef } from "./types";

const SLICE_LEN = 240;

function toRef(n: NodeMeta): NodeRef {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title ?? n.id,
    intent: n.intent ? n.intent.slice(0, SLICE_LEN) : undefined,
    state: n.state,
  };
}

function walkAncestors(byId: Map<string, NodeMeta>, startId: string): NodeMeta[] {
  const seen = new Set<string>();
  const out: NodeMeta[] = [];
  let cur = byId.get(startId);
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export function buildDerivation(project: string, nodeId: string): DerivationContext {
  const nodes = listNodes(project);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ancestors = walkAncestors(byId, nodeId);

  const ancestorIds = new Set([nodeId, ...ancestors.map(a => a.id)]);

  // Edge schema (canvas.ts:392): { from: dependency, to: dependent, kind }.
  // For "Decision → Task" we look for kind="depends-on" where `to` is in
  // our ancestorIds set, and the source is a Decision node.
  const { edges } = getGraph(project);
  const decisions: NodeMeta[] = [];
  const risks: NodeMeta[] = [];
  const seenDec = new Set<string>();
  const seenRisk = new Set<string>();

  for (const e of edges) {
    if (e.kind !== "depends-on") continue;
    if (!ancestorIds.has(e.to)) continue;
    const src = byId.get(e.from);
    if (!src) continue;
    if (src.kind === "Decision" && !seenDec.has(src.id)) {
      decisions.push(src);
      seenDec.add(src.id);
    } else if (src.kind === "Risk" && !seenRisk.has(src.id)) {
      risks.push(src);
      seenRisk.add(src.id);
    }
  }

  // Also: Risks attached via parent_id to any ancestor (legacy shape).
  for (const n of nodes) {
    if (n.kind !== "Risk") continue;
    if (seenRisk.has(n.id)) continue;
    if (n.parent_id && ancestorIds.has(n.parent_id)) {
      risks.push(n);
      seenRisk.add(n.id);
    }
  }

  return {
    ancestors: ancestors.map(toRef),
    decisions: decisions.map(toRef),
    risks: risks.map(toRef),
  };
}

/** Render the derivation block for the qwen prompt. Empty string when there
 *  is nothing to say (no ancestors AND no decisions AND no risks). */
export function renderDerivationForPrompt(d: DerivationContext | null | undefined): string {
  if (!d) return "";
  if (d.ancestors.length === 0 && d.decisions.length === 0 && d.risks.length === 0) return "";
  const lines: string[] = [];
  lines.push("\n## Derivation (read-only context — do not execute)");
  lines.push("");
  lines.push("This Task does not exist in isolation. It is derived from the chain below.");
  lines.push("Use this to ground your implementation in the founder's intent. Do not");
  lines.push("widen scope to address ancestor concerns — those are tracked elsewhere.");
  lines.push("");
  if (d.ancestors.length > 0) {
    lines.push("### Ancestor chain (closest first → Project root)");
    for (const a of d.ancestors) {
      const intent = a.intent ? ` — ${a.intent}` : "";
      lines.push(`- **${a.kind}** \`${a.id}\` · ${a.title} · state=${a.state}${intent}`);
    }
    lines.push("");
  }
  if (d.decisions.length > 0) {
    lines.push("### Binding Decisions (depends-on into this Task or its ancestors)");
    for (const dc of d.decisions) {
      const intent = dc.intent ? ` — ${dc.intent}` : "";
      lines.push(`- \`${dc.id}\` · ${dc.title}${intent}`);
    }
    lines.push("");
  }
  if (d.risks.length > 0) {
    lines.push("### Open Risks on this lineage");
    for (const r of d.risks) {
      const intent = r.intent ? ` — ${r.intent}` : "";
      lines.push(`- \`${r.id}\` · ${r.title} · state=${r.state}${intent}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
