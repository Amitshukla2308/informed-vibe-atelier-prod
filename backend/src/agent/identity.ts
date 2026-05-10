/**
 * Identity composition — builds the composed prompt passed to Claude CLI via --append-system-prompt-file.
 *
 * Drafter spawn: soul + drafter + classification + stages + (guardians-summary if post-mvp) + project context
 * Implementer spawn: soul + implementer + classification + guardians + stages + node envelope (Phase C)
 *
 * Mode-specific composition, not a shared common.md.
 * Atelier controls what goes to Claude based on mode.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { loadPrinciple } from "~/agent/load-principle";

type Mode = "drafter" | "implementer" | "onboarder";
type Stage = "onboarding" | "pre-mvp" | "post-mvp" | "experimental-sandbox";

interface ComposeInput {
  sessionId: string;
  mode: Mode;
  stage: Stage;
  projectName: string;
  projectContextMarkdown?: string; // for Drafter: project state snapshot
  nodeEnvelope?: string; // for Implementer: own plan + parent + deps
  /**
   * Optional OmniGraph brain block. When present, injected after principles
   * and before the project context — it tells the agent who the founder is
   * and how to work with them. See backend/src/session/load-omnigraph-brain.ts
   */
  omnigraphBrainMarkdown?: string;
}

/**
 * Load a non-principle agent file (e.g. `soul.md`) verbatim. Principles
 * proper (`principles/<name>.md`) flow through `loadPrinciple()` so the
 * compiled-XML preference applies. soul.md is universal disposition prose
 * not currently part of the compiled XML scheme — kept on the markdown
 * read path (TODO #29 scoped to per-role principle files).
 */
function readAgent(relpath: string): string {
  return readFileSync(resolve(config.agentsDir, relpath), "utf-8");
}

/**
 * Read a principle by short name (e.g. "drafter") with compiled-XML
 * preference. Wraps `loadPrinciple()` from agent/load-principle.ts. The
 * returned text is hydrated XML when present at
 * `og_artifacts/agents/<name>.compiled.xml`, else the raw markdown
 * fallback at `agents/principles/<name>.md`. See agent/load-principle.ts
 * for the resolution rules and the XML→text hydrator.
 */
function readPrinciple(name: string): string {
  return loadPrinciple(name);
}

/**
 * Minimal mustache-style substitution. Unknown keys are left intact as
 * `{{key}}` for forward compatibility (so a future variable referenced in
 * a principle file doesn't silently disappear in older builds).
 */
export function substituteAgentVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) =>
    vars[key] ?? `{{${key}}}`,
  );
}

function templateVars(content: string): string {
  // Read once per compose-call. config.agent is a getter that re-parses the
  // YAML; pulling it into a local snapshot avoids 4× re-reads per file.
  const a = config.agent;
  return substituteAgentVars(content, {
    agent_name: a.agent_name,
    founder_name: a.founder_name,
    org_name: a.org_name,
    active_project: a.active_project,
  });
}

export function composePrompt(input: ComposeInput): string {
  const parts: string[] = [];

  // 1. Soul — universal dispositions
  parts.push(templateVars(readAgent("soul.md")));
  parts.push("\n---\n");

  // 2. Mode-specific principles. All `readPrinciple()` reads now prefer
  //    compiled XML at og_artifacts/agents/<name>.compiled.xml and fall
  //    back to the canonical markdown source. Markdown remains the
  //    human-readable source-of-truth (TODO #29).
  if (input.mode === "onboarder") {
    // Onboarder runs before Canvas shape exists. Classification + stages
    // are still loaded for reference but Guardians are not — onboarder
    // only proposes, never executes.
    parts.push(templateVars(readPrinciple("onboarder")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("classification")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("stages")));
  } else if (input.mode === "drafter") {
    parts.push(templateVars(readPrinciple("drafter")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("classification")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("stages")));
    // Guardian summary only for drafter when post-mvp (reference, not enforcement)
    if (input.stage === "post-mvp") {
      parts.push("\n---\n");
      parts.push(templateVars(readPrinciple("guardians")));
    }
  } else {
    parts.push(templateVars(readPrinciple("implementer")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("classification")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("guardians")));
    parts.push("\n---\n");
    parts.push(templateVars(readPrinciple("stages")));
  }

  // 2.5. OmniGraph brain injection.
  //
  // Per-layer filtering happens at load time via brainLayerFlagsFromEnv().
  // By the time we get here, omnigraphBrainMarkdown already contains only
  // the layers the env says to include. We just concatenate it if non-empty.
  if (input.omnigraphBrainMarkdown && input.omnigraphBrainMarkdown.trim()) {
    parts.push("\n---\n\n");
    parts.push(input.omnigraphBrainMarkdown.trim());
    parts.push("\n");
  }

  // 3. Project context (Drafter) or node envelope (Implementer)
  parts.push("\n---\n\n## Current Project Context\n\n");
  parts.push(`Project: **${input.projectName}** | Stage: **${input.stage}**\n\n`);
  if (input.projectContextMarkdown) {
    parts.push(input.projectContextMarkdown);
  }
  if (input.nodeEnvelope) {
    parts.push("\n\n### Node Envelope\n\n");
    parts.push(input.nodeEnvelope);
  }

  return parts.join("\n");
}

export function writeComposedPrompt(input: ComposeInput): string {
  const composed = composePrompt(input);
  const outPath = resolve(config.dataDir, "tmp", `prompt_${input.sessionId}.md`);
  writeFileSync(outPath, composed, "utf-8");
  const lineCount = composed.split("\n").length;
  console.log(`[identity] composed prompt for session ${input.sessionId}: ${lineCount} lines → ${outPath}`);
  if (lineCount > 600) {
    console.warn(`[identity] WARNING: prompt exceeds ≤600 line budget (${lineCount} lines)`);
  }
  return outPath;
}
