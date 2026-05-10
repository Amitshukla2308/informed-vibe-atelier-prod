/**
 * Axiom verification — the mechanical post-Qwen check.
 *
 * Drafter emits a `## Axioms` section in plan.md (≤5 bullets). After the
 * Qwen run finishes, we walk that list and verify each axiom against the
 * sandbox worktree. Verifiable failures hand the node back as `blocked`
 * with the failed axiom in the comment thread; unverifiable lines (no
 * known pattern) are recorded as `unverified` — surfaced to the founder
 * but not auto-blocking.
 *
 * Patterns kept narrow on purpose. The flywheel adds new patterns over
 * time as we observe what Drafter writes; today we cover the four most
 * common shapes: file-exists, exports-name, regex-matches, type-checks.
 *
 * Phase 1: deterministic only — no LLM call. Phase 2 routes ambiguous
 * lines through Qwen for a confidence-scored verdict.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type AxiomStatus = "passed" | "failed" | "unverified";

export interface AxiomResult {
  axiom: string;
  status: AxiomStatus;
  detail: string;
}

const RE_AXIOMS_HEADING = /^##\s+axioms\b/im;

/**
 * Pull the `## Axioms` section bullets out of a plan.md. Returns an empty
 * array when the section is missing or empty — the allocator stub-guard
 * already rejects that case before we get here.
 */
export function extractAxioms(plan: string): string[] {
  const lines = plan.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    if (RE_AXIOMS_HEADING.test(lines[i] ?? "")) break;
  }
  if (i >= lines.length) return [];
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (/^##\s+\S/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

const RE_FILE_EXISTS    = /^file\s+`([^`]+)`\s+exists\s*$/i;
const RE_FILE_EXPORTS   = /^file\s+`([^`]+)`\s+exports\s+`([^`]+)`\s*$/i;
const RE_REGEX_MATCHES  = /^regex\s+`([^`]+)`\s+matches\s+in\s+`([^`]+)`\s*$/i;
const RE_TYPE_CHECK     = /^file\s+`([^`]+)`\s+passes\s+type-check\s*$/i;

function safePath(workdir: string, p: string): string {
  // Reject absolute and ../-walk paths so a malformed axiom can't escape
  // the sandbox. Implementer prompts already constrain Qwen to
  // manifest_globs; this is belt-and-braces for what Drafter writes.
  if (p.startsWith("/") || p.includes("..")) return resolve(workdir, "__invalid__");
  return resolve(workdir, p);
}

function exists(workdir: string, rel: string): boolean {
  try { return existsSync(safePath(workdir, rel)); } catch { return false; }
}

function readSafe(workdir: string, rel: string): string | null {
  try {
    const full = safePath(workdir, rel);
    if (!existsSync(full)) return null;
    if (!statSync(full).isFile()) return null;
    return readFileSync(full, "utf-8");
  } catch { return null; }
}

const RE_EXPORT = (name: string): RegExp =>
  // Match `export function foo`, `export const foo`, `export class foo`,
  // `export type foo`, `export interface foo`, `export {foo,...}`,
  // `export default function foo`. Name is escaped at call-site.
  new RegExp(
    `^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class|type|interface|enum)\\s+${name}\\b|^\\s*export\\s*\\{[^}]*\\b${name}\\b`,
    "m",
  );

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verify a single axiom against the worktree. tscOk drives the type-check
 * path (passed when the global tsc step succeeded); other patterns hit the
 * filesystem directly.
 */
function verifyOne(axiom: string, workdir: string, tscOk: boolean): AxiomResult {
  let m: RegExpMatchArray | null;

  m = axiom.match(RE_FILE_EXISTS);
  if (m) {
    const rel = m[1]!;
    const ok = exists(workdir, rel);
    return { axiom, status: ok ? "passed" : "failed", detail: ok ? `file ${rel} exists` : `file ${rel} not found` };
  }

  m = axiom.match(RE_FILE_EXPORTS);
  if (m) {
    const rel = m[1]!;
    const name = m[2]!;
    const body = readSafe(workdir, rel);
    if (body === null) return { axiom, status: "failed", detail: `cannot read ${rel}` };
    const re = RE_EXPORT(escapeRegex(name));
    const ok = re.test(body);
    return { axiom, status: ok ? "passed" : "failed", detail: ok ? `${rel} exports ${name}` : `no \`export ... ${name}\` in ${rel}` };
  }

  m = axiom.match(RE_REGEX_MATCHES);
  if (m) {
    const pattern = m[1]!;
    const rel = m[2]!;
    const body = readSafe(workdir, rel);
    if (body === null) return { axiom, status: "failed", detail: `cannot read ${rel}` };
    let re: RegExp;
    try { re = new RegExp(pattern, "m"); } catch (e) {
      return { axiom, status: "failed", detail: `bad regex ${pattern}: ${String(e).slice(0, 100)}` };
    }
    const ok = re.test(body);
    return { axiom, status: ok ? "passed" : "failed", detail: ok ? `regex matched in ${rel}` : `regex did not match in ${rel}` };
  }

  m = axiom.match(RE_TYPE_CHECK);
  if (m) {
    const rel = m[1]!;
    if (!exists(workdir, rel)) {
      return { axiom, status: "failed", detail: `file ${rel} not found (cannot type-check)` };
    }
    return { axiom, status: tscOk ? "passed" : "failed", detail: tscOk ? `tsc passed (covers ${rel})` : `tsc failed (covers ${rel})` };
  }

  return { axiom, status: "unverified", detail: "no matching pattern (Phase 1 supports: file exists, file exports NAME, regex matches in file, file passes type-check)" };
}

export function verifyAxioms(plan: string, workdir: string, tscOk: boolean): AxiomResult[] {
  return extractAxioms(plan).map((a) => verifyOne(a, workdir, tscOk));
}

export function summarizeAxioms(results: AxiomResult[]): { failed: AxiomResult[]; unverified: AxiomResult[]; passed: AxiomResult[]; ok: boolean } {
  const failed: AxiomResult[] = [];
  const unverified: AxiomResult[] = [];
  const passed: AxiomResult[] = [];
  for (const r of results) {
    if (r.status === "failed") failed.push(r);
    else if (r.status === "unverified") unverified.push(r);
    else passed.push(r);
  }
  return { failed, unverified, passed, ok: failed.length === 0 };
}
