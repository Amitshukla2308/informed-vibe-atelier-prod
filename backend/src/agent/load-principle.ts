/**
 * load-principle — single entry point for reading agent principle files.
 *
 * Prefers compiled XML (`og_artifacts/agents/<name>.compiled.xml`) over raw
 * markdown (`agents/principles/<name>.md`). The composed system prompt the
 * CLI subprocess receives is text; XML is storage-only — this module's
 * `hydrateAgentXml()` reconstructs readable text from the compressed XML
 * IR emitted by `omnigraph compile agent_principles`.
 *
 * Falls back to .md when XML is missing or unreadable. Never throws on a
 * missing file — returns an empty string and the caller chooses what to do
 * with it (boot validate enforces drafter.md exists).
 *
 * Token-cost story: drafter compiled XML is ~56% smaller than the source
 * markdown by approx-tokens (4-chars-per-token proxy). The hydrated text
 * the model receives is a slim outline — section headers, rules, optional
 * subheaders — without the original markdown narrative paragraphs which
 * the compiler intentionally drops. (See
 * `omnigraph/src/compiler/agent_principles.py` for compression rules.)
 *
 * Per the task spec (TODO #29): markdown stays canonical, human-readable
 * source-of-truth; XML is runtime-only. Switch off compiled-XML preference
 * by setting env `ATELIER_AGENT_PRINCIPLES_USE_XML=0`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";

/**
 * Resolve the og_artifacts agents directory. Mirrors the resolution in
 * `og_artifacts/load.ts`: respect `OMNIGRAPH_OUT_DIR` when set, else
 * default to `<atelier-root>/og_artifacts/`.
 */
function compiledAgentDir(): string {
  const env = process.env.OMNIGRAPH_OUT_DIR;
  if (env) return resolve(env, "agents");
  return resolve(config.atelierRoot, "og_artifacts", "agents");
}

function compiledPath(name: string): string {
  return resolve(compiledAgentDir(), `${name}.compiled.xml`);
}

function markdownPath(name: string): string {
  return resolve(config.agentsDir, "principles", `${name}.md`);
}

/**
 * Hydrate compressed agent IR XML (`<a><meta/><s><h/><r/></s></a>`) into
 * a plain-text representation the model can read directly.
 *
 * Element semantics (per agent_principles.py compile rules):
 *   <a n="…">   — outer agent envelope. Header line emitted as `# <name>`.
 *   <meta>      — audit block. Dropped from hydrated text (not for the model).
 *   <s t="…">   — section. Emit `## <title>`.
 *   <h>…</h>    — sub-section. Emit `### <text>`.
 *   <r>…</r>    — rule (bullet). Emit `- <text>`.
 *   <d>…</d>    — dropped-prose retention (only with KEEP_PROSE=1). Emit as paragraph.
 *
 * This is a minimal regex parser by design — the IR is line-oriented and
 * never nests beyond `<s>…</s>`. We avoid pulling an XML dep into the
 * backend. Inputs that don't match the expected shape fall through to a
 * permissive "extract text-between-tags" pass.
 */
export function hydrateAgentXml(xml: string): string {
  if (!xml) return "";
  const out: string[] = [];

  // Outer agent name → H1 (purely informational; the compose path adds its
  // own framing too, but this keeps standalone hydrations readable).
  const aMatch = xml.match(/<a\s+n="([^"]+)"[^>]*>/);
  const agentName = aMatch ? aMatch[1] : null;
  if (agentName) {
    out.push(`# ${agentName}`);
    out.push("");
  }

  // Strip the meta block — purely audit; the model does not need it.
  const stripped = xml.replace(/<meta>[\s\S]*?<\/meta>/g, "");

  // Walk lines, decoding the small element vocabulary in order so section
  // headers stay above their rules.
  const lines = stripped.split(/\r?\n/);
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Section open
    let m = line.match(/^<s\s+t="([^"]+)"\s*>$/);
    if (m) {
      if (inSection) out.push("");
      inSection = true;
      out.push(`## ${decodeXml(m[1])}`);
      out.push("");
      continue;
    }
    if (line === "</s>") {
      inSection = false;
      continue;
    }
    // Sub-section header
    m = line.match(/^<h>(.*)<\/h>$/);
    if (m) {
      out.push(`### ${decodeXml(m[1])}`);
      out.push("");
      continue;
    }
    // Rule
    m = line.match(/^<r>(.*)<\/r>$/);
    if (m) {
      out.push(`- ${decodeXml(m[1])}`);
      continue;
    }
    // Retained prose (KEEP_PROSE=1 only)
    m = line.match(/^<d>(.*)<\/d>$/);
    if (m) {
      out.push(decodeXml(m[1]));
      out.push("");
      continue;
    }
    // @import directive — A2 flywheel hook. Compiler emits as <i>; resolver
    // substitutes the path content at compose time (resolveImports()).
    m = line.match(/^<i>(.*)<\/i>$/);
    if (m) {
      out.push(decodeXml(m[1]));
      out.push("");
      continue;
    }
    // Closing root tag — ignore
    if (line === "</a>" || /^<a\s+/.test(line)) continue;
    // Fallback: a content line that doesn't match the expected vocabulary.
    // Strip surrounding tags to recover the text rather than dropping it.
    const recovered = line.replace(/<[^>]+>/g, "").trim();
    if (recovered) out.push(recovered);
  }

  // Trim trailing blank lines.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/**
 * Minimal XML entity decoder. We only need to undo `xml.sax.saxutils.escape`,
 * which emits `&amp; &lt; &gt; &quot;` (and `&apos;` when quote=True).
 * Anything else is content as-is.
 */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Whether to prefer compiled XML over raw markdown. Default true. Set
 * `ATELIER_AGENT_PRINCIPLES_USE_XML=0` to force markdown (debugging /
 * regression-checking against pre-compile behavior).
 */
function preferXml(): boolean {
  const v = process.env.ATELIER_AGENT_PRINCIPLES_USE_XML;
  if (v === undefined || v === null || v === "") return true;
  return !(v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "no");
}

/**
 * Resolve `@import <relative/path>` directives inside a hydrated principle
 * text. Per A2 (Phase 5): the principles markdown adds a
 *   @import og_artifacts/agent_constraints/<role>.md
 * line; this resolver inlines the file content at compose-time so the
 * compiler stays simple and constraints update faster than principles
 * recompile.
 *
 * Behaviour:
 *   - One @import per line. Anything trailing on the line is treated as a
 *     comment and dropped.
 *   - Path is resolved relative to atelierRoot. Absolute paths are honored
 *     (rare; they're for adversarial test fixtures).
 *   - Path traversal (..) past atelierRoot is rejected — the @import line
 *     is replaced with an empty string. This stops a malformed compiled
 *     XML from reading arbitrary disk.
 *   - Missing files become empty strings (silent). Constraints don't exist
 *     yet on a fresh install; the principle loads anyway.
 *   - Recursion depth: 1. The imported file is NOT itself scanned for
 *     further @imports — keeps the implementation simple and matches the
 *     A2 doc's "compiler emits markdown table; resolver inlines verbatim".
 */
export function resolveImports(text: string, atelierRoot: string): string {
  if (!text || !text.includes("@import")) return text;
  const root = resolve(atelierRoot);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*@import\s+([^\s]+)\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1] ?? "";
    let target: string;
    if (rel.startsWith("/")) {
      target = resolve(rel);
    } else {
      target = resolve(root, rel);
    }
    // Path-traversal guard: refuse anything outside atelierRoot unless
    // the absolute path was passed explicitly (test fixtures).
    if (!rel.startsWith("/") && !target.startsWith(root + "/")) {
      out.push("");
      continue;
    }
    if (!existsSync(target)) {
      // Soft miss — common during fresh installs before the first ETL.
      out.push("");
      continue;
    }
    try {
      const body = readFileSync(target, "utf-8");
      out.push(body.trimEnd());
    } catch {
      out.push("");
    }
  }
  return out.join("\n");
}

/**
 * Read an agent principle by name (e.g. "drafter", "fixer", "classification").
 *
 * Resolution order:
 *   1. Compiled XML at og_artifacts/agents/<name>.compiled.xml — hydrated
 *      to plain text via hydrateAgentXml(). (Skipped when
 *      ATELIER_AGENT_PRINCIPLES_USE_XML=0.)
 *   2. Raw markdown at agents/principles/<name>.md.
 *   3. Empty string (caller decides — boot/validate.ts already enforces
 *      drafter.md presence).
 *
 * Post-resolution: any `@import <path>` directives in the loaded text are
 * inlined via resolveImports(). This is how Phase 5 of A2 wires the
 * compiled `og_artifacts/agent_constraints/<role>.md` into the prompt
 * without re-running the agent_principles compiler.
 *
 * Single source: this fn is what identity.ts/composePrompt and fixer.ts
 * call. Keep both flows on this single resolver so the prefer-XML gate
 * stays consistent.
 */
export function loadPrinciple(name: string): string {
  let text = "";
  if (preferXml()) {
    const xmlPath = compiledPath(name);
    if (existsSync(xmlPath)) {
      try {
        const xml = readFileSync(xmlPath, "utf-8");
        const hydrated = hydrateAgentXml(xml);
        if (hydrated.trim().length > 0) text = hydrated;
      } catch {
        // fall through to markdown
      }
    }
  }
  if (!text) {
    const mdPath = markdownPath(name);
    if (existsSync(mdPath)) {
      try {
        text = readFileSync(mdPath, "utf-8");
      } catch {
        text = "";
      }
    }
  }
  return resolveImports(text, config.atelierRoot);
}

/**
 * Diagnostic helper: which source loadPrinciple() actually used. Returned
 * as `"xml" | "md" | "missing"`. Smoke tests + boot validate read this.
 */
export function principleSource(name: string): "xml" | "md" | "missing" {
  if (preferXml() && existsSync(compiledPath(name))) return "xml";
  if (existsSync(markdownPath(name))) return "md";
  return "missing";
}
