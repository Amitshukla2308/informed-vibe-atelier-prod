/**
 * Project-context markdown — Drafter's upfront awareness pack.
 *
 * Drafter previously got just `Project: <name> | Stage: <stage>` in the
 * system prompt, with no inventory of existing nodes, Surfaces, or queue
 * state. That blindness cascaded into the data-quality bug: Drafter
 * couldn't set `touches` (didn't know which Surfaces existed), couldn't
 * set `cycle` (didn't know the active cycle), proposed duplicates of
 * existing work, and wrote Acceptance criteria that contradicted locked
 * Decisions.
 *
 * This module assembles a compact, scannable snapshot from canvas/meta
 * state and returns a single markdown block to inject into the prompt.
 */

import { listNodes, type NodeMeta } from "~/project/canvas";
import { projectMeta } from "~/project/scaffold";
import { rankReadyTasks } from "~/implementer/queue";

const MAX_RECENT_NODES = 10;
const MAX_QUEUE_HEAD = 5;
const MAX_SUPERSEDED = 5;

/**
 * Build the project-context markdown for `projectName`. Returns null if
 * the project doesn't exist on disk (caller falls back to the bare
 * Project/Stage line).
 */
export function buildProjectContextMarkdown(projectName: string): string | null {
  const meta = projectMeta(projectName);
  if (!meta) return null;

  const nodes = listNodes(projectName);
  const sections: string[] = [];

  sections.push(`## Project snapshot — ${projectName}`);
  sections.push("");
  sections.push("This is the canvas state at session start. Treat it as the");
  sections.push("authoritative inventory of *what already exists*. Before");
  sections.push("proposing a new node, scan it: don't duplicate existing");
  sections.push("Surfaces, don't re-propose superseded Tasks, and use the");
  sections.push("Surface IDs below verbatim when populating `touches`.");
  sections.push("");

  // ── Project meta ───────────────────────────────────────────────────────
  sections.push("### Meta");
  sections.push("");
  sections.push(`- **Stage**: ${meta.stage}`);
  if (meta.target_ship_date) sections.push(`- **Target ship date**: ${meta.target_ship_date}`);
  // Layer lives on the Project-kind canvas node, not in ProjectMeta. Pull
  // it from the canvas if present so Drafter sees the altitude classification.
  const projectNode = nodes.find((n) => n.kind === "Project");
  if (projectNode?.layer) sections.push(`- **Layer**: ${projectNode.layer}`);
  if (projectNode?.outcome) sections.push(`- **Outcome**: ${projectNode.outcome}`);
  if (meta.repo_path) sections.push(`- **Repo path**: ${meta.repo_path} (branch base: ${meta.repo_branch_base ?? "main"})`);
  else sections.push(`- **Mode**: local sandbox (no repo_path set; Implementer writes to .implementer-runs/)`);
  if (meta.description) sections.push(`- **Description**: ${meta.description}`);
  sections.push("");

  // ── Surface inventory ─────────────────────────────────────────────────
  // Surfaces are how Drafter places work. Without these IDs visible, it
  // can't populate `touches`, which blocks every Story/Epic/Task from
  // reaching state: approved.
  const surfaces = nodes.filter((n) => n.kind === "Surface");
  sections.push(`### Surfaces (${surfaces.length})`);
  sections.push("");
  if (surfaces.length === 0) {
    sections.push("_No Surfaces yet. New Surface nodes need a Plane parent and a non-empty `manifest_globs` list._");
  } else {
    sections.push("| id | title | kind | status | manifest_globs |");
    sections.push("|---|---|---|---|---|");
    for (const s of surfaces) {
      const globs = (s.manifest_globs ?? []).join(", ") || "(empty)";
      const kind = s.surface_kind ?? "—";
      const status = s.surface_status ?? "—";
      sections.push(`| \`${s.id}\` | ${escapeCell(s.title)} | ${kind} | ${status} | ${escapeCell(globs)} |`);
    }
  }
  sections.push("");

  // ── Recent nodes (any kind) ───────────────────────────────────────────
  // Last N by updated_at — gives Drafter "what was happening on this
  // canvas recently" without dumping the entire graph.
  const recent = [...nodes]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, MAX_RECENT_NODES);
  sections.push(`### Recent nodes (top ${recent.length} by updated_at)`);
  sections.push("");
  if (recent.length === 0) {
    sections.push("_No nodes yet._");
  } else {
    sections.push("| id | kind | state | title | cycle | touches |");
    sections.push("|---|---|---|---|---|---|");
    for (const n of recent) {
      const touches = (n.touches ?? []).join(", ") || "—";
      const cycle = n.cycle ?? "—";
      sections.push(`| \`${n.id}\` | ${n.kind} | ${n.state} | ${escapeCell(n.title)} | ${cycle} | ${escapeCell(touches)} |`);
    }
  }
  sections.push("");

  // ── Open Decisions ────────────────────────────────────────────────────
  // Allocator's hand-back criteria include "Acceptance contradicts a
  // locked Decision". Surfacing these prevents that class of refusal.
  const decisions = nodes.filter(
    (n) => n.kind === "Decision" && (n.state === "approved" || n.state === "proposed"),
  );
  sections.push(`### Open Decisions (${decisions.length})`);
  sections.push("");
  if (decisions.length === 0) {
    sections.push("_No open Decisions._");
  } else {
    for (const d of decisions) {
      sections.push(`- \`${d.id}\` (${d.state}) — ${escapeCell(d.title)}: ${escapeCell((d.intent ?? "").slice(0, 200))}`);
    }
  }
  sections.push("");

  // ── Implementer queue head ────────────────────────────────────────────
  // What's about to run, in order. If Drafter sees the queue is already
  // deep on a Surface, it can defer adding more work there.
  let queueRows: ReturnType<typeof rankReadyTasks> = [];
  try {
    queueRows = rankReadyTasks(projectName).slice(0, MAX_QUEUE_HEAD);
  } catch {
    // Queue ranking can throw if graph.json is mid-write; degrade gracefully.
    queueRows = [];
  }
  sections.push(`### Implementer queue head (top ${queueRows.length})`);
  sections.push("");
  if (queueRows.length === 0) {
    sections.push("_Queue empty — no Tasks/Subtasks in state approved|review with deps satisfied._");
  } else {
    sections.push("| rank | id | title | reason |");
    sections.push("|---|---|---|---|");
    queueRows.forEach((r, i) => {
      sections.push(`| ${i + 1} | \`${r.meta.id}\` | ${escapeCell(r.meta.title)} | ${escapeCell(r.explanation)} |`);
    });
  }
  sections.push("");

  // ── Recently superseded ───────────────────────────────────────────────
  // A node X with `supersedes: Y` means Drafter has pivoted away from Y.
  // Re-proposing Y or anything close is wasted effort.
  const superseded: Array<{ from: NodeMeta; toId: string }> = [];
  for (const n of nodes) {
    if (n.supersedes) {
      const from = nodes.find((m) => m.id === n.supersedes);
      if (from) superseded.push({ from, toId: n.id });
    }
  }
  superseded.sort((a, b) => (b.from.updated_at ?? "").localeCompare(a.from.updated_at ?? ""));
  const recentlySuperseded = superseded.slice(0, MAX_SUPERSEDED);
  sections.push(`### Recently superseded (${recentlySuperseded.length})`);
  sections.push("");
  if (recentlySuperseded.length === 0) {
    sections.push("_None._");
  } else {
    for (const { from, toId } of recentlySuperseded) {
      sections.push(`- \`${from.id}\` (${escapeCell(from.title)}) → replaced by \`${toId}\``);
    }
  }
  sections.push("");

  return sections.join("\n");
}

/** Pipe characters break markdown table rendering; escape them. */
function escapeCell(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export interface ProjectContextStats {
  surfaces: number;
  recent_nodes: number;
  open_decisions: number;
  queue_head: number;
  superseded: number;
  bytes: number;
}

/**
 * Same as buildProjectContextMarkdown but returns stats alongside the
 * markdown so the caller can log session-start telemetry.
 */
export function buildProjectContextWithStats(
  projectName: string,
): { markdown: string; stats: ProjectContextStats } | null {
  const md = buildProjectContextMarkdown(projectName);
  if (md === null) return null;
  const nodes = listNodes(projectName);
  let queueLen = 0;
  try { queueLen = rankReadyTasks(projectName).slice(0, MAX_QUEUE_HEAD).length; } catch { queueLen = 0; }
  return {
    markdown: md,
    stats: {
      surfaces: nodes.filter((n) => n.kind === "Surface").length,
      recent_nodes: Math.min(MAX_RECENT_NODES, nodes.length),
      open_decisions: nodes.filter((n) => n.kind === "Decision" && (n.state === "approved" || n.state === "proposed")).length,
      queue_head: queueLen,
      superseded: nodes.filter((n) => n.supersedes).length,
      bytes: md.length,
    },
  };
}
