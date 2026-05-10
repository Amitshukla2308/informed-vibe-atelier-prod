/**
 * Guardian scan engine — Phase A.
 *
 * Replaces the stubs in load.ts with a working pattern matcher. Honors three
 * forms of guardian rule:
 *
 *   - `pattern`  — regex evaluated against plan markdown (and, post-run, diff).
 *                  Match → violation. This is the load-bearing form for
 *                  Phase A; covers always-on rules like `no_secrets_in_config`.
 *
 *   - `scope`    — glob over the plan's `Planned artifacts` paths. A match
 *                  by itself is treated as "this rule applies"; combined with
 *                  `pattern` (over plan body), the rule fires only when both
 *                  hit. Without `pattern`, scope-only rules are evaluated as
 *                  *applicable* (engine returns them in `applicable_only`)
 *                  but do not block — Phase A defers their `check` predicate.
 *
 *   - `check`    — human-readable predicates (`must_include:X`, `must_not_include:X`,
 *                  `regex:X`, `forbid:X`). The engine handles these limited forms;
 *                  unknown checks are flagged in `unknown_checks` for the founder.
 *
 * Severity routing:
 *   - `block`         → halts the run, reason='guardian_block:<name>'.
 *   - `block-in-mvp`  → halts only when `stage === "post-mvp"`.
 *   - `warn`          → recorded but doesn't halt.
 *   - `audit-only`    → recorded for forensics; never halts.
 *
 * Stage detection: looks for `meta.json:stage` in the project root, falling
 * back to "pre-mvp" — early-stage projects are intentionally permissive.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { config } from "~/config";
import {
  loadGuardians,
  applicableGuardians,
  type Guardian,
  type Severity,
  type Stage,
  type ScanContext,
} from "./load";

export interface GuardianViolation {
  guardian: string;
  severity: Severity;
  reason: string;
  matched_text?: string;
}

export interface GuardianScanResult {
  /** Violations that should block (severity=block, or block-in-mvp + post-mvp). */
  blocking: GuardianViolation[];
  /** Non-blocking warnings + audit notes. */
  warnings: GuardianViolation[];
  /** Rules whose pattern doesn't apply but engine wants the founder to know. */
  applicable_only: Array<{ guardian: string; reason: string }>;
  /** `check:` strings the engine couldn't parse. */
  unknown_checks: string[];
  /** Total guardian count examined. */
  checked: number;
}

const EMPTY: GuardianScanResult = {
  blocking: [],
  warnings: [],
  applicable_only: [],
  unknown_checks: [],
  checked: 0,
};

function readProjectStage(projectName: string): Stage {
  const metaPath = resolve(config.projectsDir, projectName, "meta.json");
  if (!existsSync(metaPath)) return "pre-mvp";
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { stage?: string };
    return meta.stage === "post-mvp" ? "post-mvp" : "pre-mvp";
  } catch {
    return "pre-mvp";
  }
}

/** Expand `**` and `*` to a regex; `*` does not cross `/`. */
function globToRegex(glob: string): RegExp {
  // Order matters: handle `**` before single `*`.
  let s = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  s = s.replace(/\*\*/g, "::DSTAR::");
  s = s.replace(/\*/g, "[^/]*");
  s = s.replace(/::DSTAR::/g, ".*");
  return new RegExp(`^${s}$`);
}

function matchesAnyGlob(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

function effectiveSeverity(g: Guardian, stage: Stage): Severity {
  if (g.severity === "block-in-mvp") return stage === "post-mvp" ? "block" : "warn";
  return g.severity;
}

/** Apply a `check:` mini-DSL line. Returns null if not parseable. */
function evaluateCheck(check: string, planMarkdown: string): { matched: boolean; matched_text?: string } | null {
  const m = /^(must_include|must_not_include|regex|forbid):\s*(.+)$/.exec(check);
  if (!m) return null;
  const op = m[1];
  const arg = m[2];
  if (op === "regex" || op === "forbid") {
    try {
      const rx = new RegExp(arg);
      const hit = rx.exec(planMarkdown);
      return { matched: !!hit, matched_text: hit?.[0] };
    } catch {
      return null;
    }
  }
  if (op === "must_include") {
    return { matched: !planMarkdown.includes(arg) }; // violation = NOT included
  }
  if (op === "must_not_include") {
    const i = planMarkdown.indexOf(arg);
    return { matched: i >= 0, matched_text: i >= 0 ? arg : undefined };
  }
  return null;
}

/**
 * Pre-execution scan.
 *
 * @param projectName Atelier project (used to load guardians.yaml + stage)
 * @param planMarkdown The plan body (Drafter's plan.md content)
 * @param plannedArtifacts Paths from the plan's `Planned artifacts` section
 */
export function scanGuardians(
  projectName: string,
  planMarkdown: string,
  plannedArtifacts: string[] = [],
): GuardianScanResult {
  const rules = loadGuardians(projectName);
  if (!rules) return EMPTY;

  const stage = readProjectStage(projectName);
  const ctx: ScanContext = { projectName, stage };
  const guardians = applicableGuardians(rules, ctx);
  const blocking: GuardianViolation[] = [];
  const warnings: GuardianViolation[] = [];
  const applicable_only: Array<{ guardian: string; reason: string }> = [];
  const unknown_checks: string[] = [];

  for (const g of guardians) {
    const sev = effectiveSeverity(g, stage);
    const route = (v: GuardianViolation) => {
      if (sev === "block") blocking.push(v);
      else warnings.push(v);
    };
    let fired = false;

    // Scope filter — if scope is set and no planned artifact matches, skip.
    if (g.scope) {
      const inScope = plannedArtifacts.some(p => matchesAnyGlob(p, g.scope!));
      if (!inScope) continue;
    }

    if (g.pattern) {
      try {
        const rx = new RegExp(g.pattern);
        const hit = rx.exec(planMarkdown);
        if (hit) {
          fired = true;
          route({
            guardian: g.name,
            severity: sev,
            reason: g.rationale,
            matched_text: hit[0].slice(0, 200),
          });
        }
      } catch {
        unknown_checks.push(`${g.name}: invalid regex /${g.pattern}/`);
      }
    }

    if (g.check) {
      const evald = evaluateCheck(g.check, planMarkdown);
      if (evald === null) {
        unknown_checks.push(`${g.name}: ${g.check}`);
      } else if (evald.matched) {
        fired = true;
        route({
          guardian: g.name,
          severity: sev,
          reason: g.rationale,
          matched_text: evald.matched_text,
        });
      }
    }

    if (!fired && g.scope && !g.pattern && !g.check) {
      // Scope-only rule with nothing to check — flag for founder.
      applicable_only.push({
        guardian: g.name,
        reason: `${g.scope} matched but no pattern/check defined`,
      });
    }
  }

  return { blocking, warnings, applicable_only, unknown_checks, checked: guardians.length };
}
