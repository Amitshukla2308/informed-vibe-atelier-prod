/**
 * OmniGraph 3-layer brain reader.
 *
 * Reads the compiled artifacts OmniGraph publishes per user and returns a
 * single merged markdown block ready to inject into a session's system prompt.
 *
 * Contract (per omnigraph/docs/ATELIER_OUTPUTS.md):
 *
 *   data/users/<atelier_user_id>/brain/personal/compiled/
 *     ├── light_ir.global.xml      ALWAYS inject (mental moves, drift triggers)
 *     ├── light_ir.personal.xml    ALWAYS inject (AI-collab rules, anticipate hints)
 *     └── projects/<slug>/brain.xml  inject ONLY when session has a project
 *
 * If artifacts are missing (OmniGraph hasn't run yet, user is brand-new), this
 * returns null and the caller proceeds without brain injection — the session
 * still works, just without OmniGraph context.
 *
 * Source decisions:
 *   - omnigraph_atelier_conversation.md Turn 20 (3-layer redesign)
 *   - omnigraph_atelier_conversation.md Turn 21 (quality pass + load_bearing surfacing)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";

export interface OmnigraphBrain {
  markdown: string;
  layersLoaded: { global: boolean; personal: boolean; project: string | null };
  bytes: number;
}

export interface LoadOmnigraphBrainOptions {
  /**
   * Per-layer enable flags. A layer is included only if it loads from disk
   * AND its flag is true. Defaults: global+personal on, project off — the
   * project layer is gated separately because the compiled XMLs degraded
   * agent behavior in a 2026-04-27 live test.
   */
  includeGlobal?: boolean;
  includePersonal?: boolean;
  includeProject?: boolean;
}

/**
 * Resolve per-layer flags from env. Single source of truth so the brain
 * loader and identity (inject) agree on which layers are on.
 *
 *   OMNIGRAPH_INJECT_GLOBAL    — default ON  (mental moves, drift triggers)
 *   OMNIGRAPH_INJECT_PERSONAL  — default ON  (AI-collab rules)
 *   OMNIGRAPH_INJECT_PROJECT   — default OFF (compiler regression unresolved)
 *   OMNIGRAPH_INJECT=1         — legacy "all three on" override
 */
export function brainLayerFlagsFromEnv(): Required<LoadOmnigraphBrainOptions> {
  const legacyAll = process.env.OMNIGRAPH_INJECT === "1";
  const flag = (name: string, defaultOn: boolean): boolean => {
    const v = process.env[name];
    if (v === "1") return true;
    if (v === "0") return false;
    return defaultOn;
  };
  return {
    includeGlobal: legacyAll || flag("OMNIGRAPH_INJECT_GLOBAL", true),
    includePersonal: legacyAll || flag("OMNIGRAPH_INJECT_PERSONAL", true),
    includeProject: legacyAll || flag("OMNIGRAPH_INJECT_PROJECT", false),
  };
}

/**
 * Slug a project name the same way OmniGraph does (see
 * omnigraph/src/compiler/_layers.py#slug_for_project).
 */
function slugForProject(project: string): string {
  return project
    .toLowerCase()
    .trim()
    .replaceAll(" ", "-")
    .replaceAll("/", "-");
}

/**
 * Compose the per-user compiled-brain dir.
 *   <atelierRoot>/data/users/<userId>/brain/personal/compiled/
 */
function compiledDirFor(userId: string): string {
  return resolve(
    config.dataDir,
    "users",
    userId,
    "brain",
    "personal",
    "compiled",
  );
}

/**
 * Read a layer file if present; return null otherwise. Never throws — a
 * missing brain artifact is a normal state (founder-new user, ETL not yet run).
 */
function readLayer(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, "utf-8").trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Load the user's brain for this session. Returns null if no layers were
 * available (caller should proceed without injection).
 *
 * Downstream prompt-assembly should treat the returned markdown as a single
 * opaque block and concatenate it before its own project context.
 */
export function loadOmnigraphBrain(
  userId: string,
  projectName?: string | null,
  options?: LoadOmnigraphBrainOptions,
): OmnigraphBrain | null {
  if (!userId) return null;
  const includeGlobal = options?.includeGlobal ?? true;
  const includePersonal = options?.includePersonal ?? true;
  const includeProject = options?.includeProject ?? false;

  // Resolve compiled dir. If the requested userId has nothing AND we're not
  // already trying "default", fall back — single-founder installs publish to
  // both the real user dir AND data/users/default/ so the legacy path works.
  let compiled = compiledDirFor(userId);
  let resolvedUid = userId;
  if (
    userId !== "default" &&
    !readLayer(resolve(compiled, "light_ir.global.xml")) &&
    !readLayer(resolve(compiled, "light_ir.personal.xml"))
  ) {
    const fallback = compiledDirFor("default");
    if (
      readLayer(resolve(fallback, "light_ir.global.xml")) ||
      readLayer(resolve(fallback, "light_ir.personal.xml"))
    ) {
      compiled = fallback;
      resolvedUid = "default";
      console.warn(
        `[omnigraph-brain] no artifacts for user '${userId}'; using default-user brain`,
      );
    }
  }

  const globalPath = resolve(compiled, "light_ir.global.xml");
  const personalPath = resolve(compiled, "light_ir.personal.xml");

  const globalText = includeGlobal ? readLayer(globalPath) : null;
  const personalText = includePersonal ? readLayer(personalPath) : null;

  // PROJECT layer is now SHARED across founders (B2 decision 2026-04-26):
  // project facts are objective, so multiple founders touching the same
  // project should read the same brain. Try the shared path first
  // (atelier/projects/<projectName>/brain.xml); fall back to per-user
  // for back-compat with brains published before the move.
  let projectText: string | null = null;
  let projectLoaded: string | null = null;
  if (includeProject && projectName) {
    const slug = slugForProject(projectName);
    const sharedPath = resolve(
      config.projectsDir, projectName, "brain.xml",
    );
    const perUserPath = resolve(compiled, "projects", slug, "brain.xml");
    projectText = readLayer(sharedPath) ?? readLayer(perUserPath);
    if (projectText) projectLoaded = projectName;
  }

  if (!globalText && !personalText && !projectText) {
    console.warn(
      `[omnigraph-brain] no brain artifacts found for user '${userId}'` +
        (resolvedUid !== userId ? ` (or fallback '${resolvedUid}')` : "") +
        ` — session will run without OmniGraph context`,
    );
    return null;
  }

  // Layer-metadata header — surfaces what loaded so we can debug stale or
  // missing brain artifacts when an answer goes sideways. The mtime of
  // light_ir.global.xml is the canonical "brain freshness" timestamp.
  const globalMtime = (() => {
    try {
      const { statSync } = require("node:fs");
      return statSync(globalPath).mtime.toISOString();
    } catch { return "unknown"; }
  })();
  const layerSummary = [
    globalText ? "global" : null,
    personalText ? "personal" : null,
    projectLoaded ? `project(${projectLoaded})` : null,
  ].filter(Boolean).join(" + ") || "none";

  const sections: string[] = [
    "## OmniGraph brain (compiled from prior AI sessions)",
    "",
    `_Loaded layers: ${layerSummary} · brain freshness: ${globalMtime}_`,
    "",
    "Below is a structured brain block extracted from your prior AI",
    "conversations across multiple tools. Use it to tailor your response to",
    "this specific founder. Three layers may be present:",
    "",
    "  - GLOBAL: how this founder thinks and works (always present if any).",
    "  - PERSONAL: how AI agents should behave with this founder.",
    "  - PROJECT: facts and decisions for the active project — ground every",
    "    project-specific claim in this layer; do NOT borrow project-specific",
    "    framings from GLOBAL or PERSONAL when answering about this project.",
    "",
    "**Freshness note:** the snapshot below is loaded at session start and",
    "may be stale during long sessions. For *current* decision state (open",
    "items, recent supersessions, decision history of an entity), prefer",
    "the MCP tools `omnigraph_open` / `omnigraph_history` / `omnigraph_supersession`",
    "over the static snapshot — they query the live brain.",
    "",
  ];

  if (globalText) {
    sections.push(
      "### GLOBAL — how this founder thinks",
      "",
      globalText,
      "",
    );
  }
  if (personalText) {
    sections.push(
      "### PERSONAL — how to collaborate with this founder",
      "",
      personalText,
      "",
    );
  }
  if (projectText && projectLoaded) {
    sections.push(
      `### PROJECT (${projectLoaded}) — authoritative for project facts`,
      "",
      projectText,
      "",
    );
  }

  const markdown = sections.join("\n");
  return {
    markdown,
    layersLoaded: {
      global: globalText !== null,
      personal: personalText !== null,
      project: projectLoaded,
    },
    bytes: markdown.length,
  };
}

/**
 * Convenience wrapper: returns the markdown string or empty string.
 * Use when the caller wants drop-in concatenation without a null check.
 */
export function loadOmnigraphBrainMarkdown(
  userId: string,
  projectName?: string | null,
  options?: LoadOmnigraphBrainOptions,
): string {
  const b = loadOmnigraphBrain(userId, projectName, options);
  return b?.markdown ?? "";
}
