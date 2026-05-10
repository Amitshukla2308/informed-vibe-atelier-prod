/**
 * Project scaffolding — creates projects/<name>/ with meta, canvas, brain/domain subdirs.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { ensureCanvas, proposeNode } from "~/project/canvas";

export interface ProjectMeta {
  name: string;
  description: string;
  /**
   * Lifecycle stage. New projects start at "onboarding" — Onboarder mode
   * drives the first session. Once the founder approves shape + target
   * ship date, Onboarder writes "pre-mvp" and hands off to Drafter.
   */
  stage: "onboarding" | "pre-mvp" | "post-mvp" | "experimental-sandbox";
  target_ship_date: string | null;
  created_at: string;
  /**
   * Optional absolute path to the founder's git repo for this project.
   *
   * - When PRESENT: the Implementer creates a real git worktree in this
   *   repo, branches `impl/<nodeId>` off `repo_branch_base` (default "main"),
   *   and commits the run.
   * - When NULL/MISSING: the Implementer runs in "local" mode — a snapshot
   *   sandbox at <projectRoot>/.implementer-runs/<nodeId>/ with before/ and
   *   after/ trees + a generated diff.patch + summary.json. No git
   *   pollution of any repo.
   *
   * Existing projects without this field stay in local mode by default.
   * No automatic migration is performed on legacy meta.json files.
   */
  repo_path?: string | null;
  /**
   * Base branch in `repo_path` to branch from. Default "main". Ignored when
   * repo_path is missing.
   */
  repo_branch_base?: string | null;
}

export function scaffoldProject(name: string, description: string): ProjectMeta {
  const root = resolve(config.projectsDir, name);
  if (existsSync(root)) {
    throw new Error(`project ${name} already exists at ${root}`);
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(root, "domain_brain"), { recursive: true });
  mkdirSync(resolve(root, "sessions"), { recursive: true });
  ensureCanvas(name);

  const meta: ProjectMeta = {
    name,
    description,
    // New projects start in onboarding; Onboarder mode owns the first
    // session. Once shape is locked + ship date set, flipped to pre-mvp.
    stage: "onboarding",
    target_ship_date: null,
    created_at: new Date().toISOString(),
  };
  writeFileSync(resolve(root, "meta.json"), JSON.stringify(meta, null, 2));

  // Project-level CLAUDE.md — Atelier-managed protocols
  writeFileSync(
    resolve(root, "CLAUDE.md"),
    `# ${name} — Atelier-managed

This project is managed by Atelier. Follow these protocols:

- Never write files directly for new features. Propose via \`canvas_propose_node\` and \`canvas_propose_plan\`.
- For read-only exploration, use Read/Grep/Glob normally.
- When a meaningful milestone reached, call \`session_checkpoint\`.
- When you observe a pattern worth remembering about the founder, call \`brain_write_personal\` with confidence tag.
- Respect per-node token budgets declared in each node's plan.md.

Current stage: **onboarding** (Onboarder mode owns the first session; flips to pre-mvp when shape is approved).
`
  );

  // Root Project node — one node, created from founder's own description.
  // Everything else emerges from real conversation with the agent.
  const projectNode = proposeNode({
    project: name,
    kind: "Project",
    title: name,
    intent: description,
    confidence: "high",
    proposed_by: "founder",
    layer: "application",
  });

  // Seed empty altitudes 2 / 3 / 4 with placeholder nodes so Drafter has
  // slots to fill rather than layers to create. Each carries `placeholder:
  // true` and `proposed_by: "scaffold"`. Drafter's "fill, don't create"
  // rule (per agents/principles/drafter.md) requires renaming/replacing
  // these rather than adding alongside.
  const planeNode = proposeNode({
    project: name,
    kind: "Plane",
    title: "Single plane",
    intent: "Placeholder Plane — Drafter renames or splits when the project takes shape.",
    parent_id: projectNode.id,
    plane_kind: "cross-cutting",
    confidence: "low",
    proposed_by: "scaffold",
    placeholder: true,
  });

  const surfaceNode = proposeNode({
    project: name,
    kind: "Surface",
    title: "Default surface",
    intent: "Placeholder Surface — Drafter renames it (and tightens manifest_globs) when work concentrates around a real region.",
    parent_id: planeNode.id,
    parent_plane_id: planeNode.id,
    surface_kind: "all",
    surface_status: "proposed",
    manifest_globs: ["**/*"],
    confidence: "low",
    proposed_by: "scaffold",
    placeholder: true,
  });

  proposeNode({
    project: name,
    kind: "Epic",
    title: "Catch-all epic",
    intent: "Placeholder Epic — first real Tasks parent here until Drafter splits into themed Stories/Epics.",
    parent_id: surfaceNode.id,
    touches: [surfaceNode.id],
    confidence: "low",
    proposed_by: "scaffold",
    placeholder: true,
  });

  return meta;
}

export function projectMeta(name: string): ProjectMeta | null {
  const p = resolve(config.projectsDir, name, "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(require("node:fs").readFileSync(p, "utf-8")) as ProjectMeta;
}

/**
 * Flip stage from "onboarding" → "pre-mvp" and set ship date.
 * Called by the Onboarder MCP tool `project_complete_onboarding` when the
 * founder accepts the shape. Idempotent: if already past onboarding, no-op
 * except for updating target_ship_date if the caller provides one.
 */
export function completeOnboarding(name: string, targetShipDate: string): ProjectMeta {
  const p = resolve(config.projectsDir, name, "meta.json");
  if (!existsSync(p)) throw new Error(`project ${name} not found`);
  const meta = JSON.parse(require("node:fs").readFileSync(p, "utf-8")) as ProjectMeta;
  if (meta.stage === "onboarding") {
    meta.stage = "pre-mvp";
  }
  if (targetShipDate) {
    meta.target_ship_date = targetShipDate;
  }
  writeFileSync(p, JSON.stringify(meta, null, 2));

  // Refresh the CLAUDE.md stage line so subsequent sessions boot with
  // the right label. Cheap replace; if CLAUDE.md has been edited, this
  // only touches the stage line.
  const claudePath = resolve(config.projectsDir, name, "CLAUDE.md");
  if (existsSync(claudePath)) {
    const claudeMd = require("node:fs").readFileSync(claudePath, "utf-8") as string;
    const patched = claudeMd.replace(
      /Current stage: \*\*[^*]+\*\*[^\n]*/,
      "Current stage: **pre-mvp** (classifier + Guardians off; liberal auto-add)."
    );
    if (patched !== claudeMd) writeFileSync(claudePath, patched);
  }
  return meta;
}
