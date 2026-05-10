/**
 * Guardian rules loader (scaffold).
 *
 * Reads atelier/projects/<P>/guardians.yaml. Returns parsed rules ready for
 * pre/post-execution scans. The full pattern-matching engine (regex + scope
 * globbing + severity routing + Canvas badge integration + Kanban
 * surfacing) is its own initiative — this loader is the contract surface
 * other modules consume.
 *
 * Spec: agents/principles/guardians.md
 * Per-project location: atelier/projects/<P>/guardians.yaml
 *
 * Atelier-specific (NOT Ripple-Guard / HR Guardian Rules Engine — those are
 * code-review-time tools for shipped repos. These run inside Atelier sessions
 * pre/post each Implementer action).
 *
 * Brain precedence (per agents/principles/guardians.md C2 section):
 *   - block-severity Guardian violation always halts, regardless of brain
 *   - warn-severity logs and proceeds; brain may suggest mitigations
 *   - founder-authored Guardians outrank machine-proposed ones
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { config } from "~/config";

export type Severity = "block" | "block-in-mvp" | "warn" | "audit-only";
export type Stage = "pre-mvp" | "post-mvp";

export interface Guardian {
  name: string;
  severity: Severity;
  rationale: string;
  domain?: string;
  always_on?: boolean;
  // One of the following (at least one):
  pattern?: string;       // regex over file content
  scope?: string;         // glob over file paths
  check?: string;         // human-readable predicate; engine interprets
  exclude_if?: string;    // human-readable predicate excluding matches
}

export interface GuardianRules {
  version: number;
  stage_behavior?: { pre_mvp?: string; post_mvp?: string };
  guardians: Guardian[];
}

export interface ScanContext {
  projectName: string;
  stage: Stage;
}


function rulesPath(projectName: string): string {
  return resolve(config.projectsDir, projectName, "guardians.yaml");
}


/**
 * Load + validate a project's Guardian rules. Returns null cleanly if the
 * file doesn't exist (project hasn't defined Guardians yet — pre-MVP norm).
 * Throws ONLY on YAML parse error so the operator sees structural mistakes.
 */
export function loadGuardians(projectName: string): GuardianRules | null {
  const path = rulesPath(projectName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new Error(
      `[guardians] failed to parse ${path}: ${(e as Error).message}`,
    );
  }
  const obj = parsed as Partial<GuardianRules> | null;
  if (!obj || !Array.isArray(obj.guardians)) {
    throw new Error(`[guardians] ${path} missing required 'guardians' array`);
  }
  return {
    version: obj.version ?? 1,
    stage_behavior: obj.stage_behavior,
    guardians: obj.guardians,
  };
}


/**
 * Filter guardians applicable in the current stage (per stage_behavior +
 * always_on flag). Pre-MVP: only always_on rules apply. Post-MVP: all.
 */
export function applicableGuardians(
  rules: GuardianRules,
  ctx: ScanContext,
): Guardian[] {
  if (ctx.stage === "post-mvp") return rules.guardians;
  return rules.guardians.filter((g) => g.always_on === true);
}


/**
 * Pre-execution scan stub — engine is its own initiative. Returns no
 * violations for now so callers can wire the integration without blocking
 * on pattern matching. Replace with real engine when Atelier guardian
 * project ships its first iteration.
 */
export function preExecutionScan(
  _intentMarkdown: string,
  rules: GuardianRules,
  ctx: ScanContext,
): { violations: Array<{ guardian: Guardian; reason: string }>; checked: number } {
  const checked = applicableGuardians(rules, ctx).length;
  return { violations: [], checked };
}


/**
 * Post-execution scan stub — same contract as pre-execution. Will scan the
 * diff once the engine ships.
 */
export function postExecutionScan(
  _diff: string,
  rules: GuardianRules,
  ctx: ScanContext,
): { violations: Array<{ guardian: Guardian; reason: string }>; checked: number } {
  const checked = applicableGuardians(rules, ctx).length;
  return { violations: [], checked };
}
