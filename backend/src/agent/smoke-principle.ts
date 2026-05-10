/**
 * Smoke test for TODO #29 — agent_principles compiled-XML preference.
 *
 * Verifies, end-to-end:
 *   1. loadPrinciple("drafter") returns hydrated text from compiled XML
 *      when og_artifacts/agents/drafter.compiled.xml is present.
 *   2. The hydrated text contains drafter-specific markers (section
 *      headers, rules) so we know the hydrator did its job.
 *   3. composePrompt(mode="drafter") assembles a coherent system prompt
 *      that includes drafter's principles.
 *   4. ATELIER_AGENT_PRINCIPLES_USE_XML=0 forces the markdown fallback.
 *
 * Run:  cd backend && bun src/agent/smoke-principle.ts
 *
 * Exits non-zero on any assertion failure so the restart script (or a
 * future CI hook) catches regressions.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { hydrateAgentXml, loadPrinciple, principleSource } from "~/agent/load-principle";
import { composePrompt } from "~/agent/identity";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("smoke: load-principle + identity.composePrompt");
console.log("------------------------------------------------");

// 1. principleSource() — what's actually wired?
const xmlPath = resolve(config.atelierRoot, "og_artifacts", "agents", "drafter.compiled.xml");
const mdPath = resolve(config.agentsDir, "principles", "drafter.md");
console.log(`  xml path : ${xmlPath} (exists=${existsSync(xmlPath)})`);
console.log(`  md path  : ${mdPath} (exists=${existsSync(mdPath)})`);
const src = principleSource("drafter");
console.log(`  resolves : ${src}`);
check("drafter resolves to xml when compiled", src === "xml", `got ${src}`);

// 2. Hydrator output looks like a principle.
const drafterText = loadPrinciple("drafter");
check("drafter text non-empty", drafterText.trim().length > 0);
check(
  "drafter contains H1 agent name (hydrator opener)",
  /^# drafter\b/m.test(drafterText),
);
check(
  "drafter contains at least one ## section header",
  /^## .+/m.test(drafterText),
);
check(
  "drafter contains at least one rule bullet",
  /^- .+/m.test(drafterText),
);
check(
  "drafter does NOT leak <a> / <s> / <r> tags into hydrated text",
  !/<a\s+n=|<s\s+t=|<r>/.test(drafterText),
);

// 3. Tokens-saved sanity: hydrated XML output should be smaller than the
//    raw markdown source (4-chars-per-token proxy).
const mdText = (() => {
  process.env.ATELIER_AGENT_PRINCIPLES_USE_XML = "0";
  const v = loadPrinciple("drafter");
  delete process.env.ATELIER_AGENT_PRINCIPLES_USE_XML;
  return v;
})();
const mdTokens = Math.ceil(mdText.length / 4);
const hydratedTokens = Math.ceil(drafterText.length / 4);
const savings = mdTokens
  ? Math.round(((mdTokens - hydratedTokens) / mdTokens) * 100)
  : 0;
console.log(
  `  md tokens (approx)       : ${mdTokens}\n` +
  `  hydrated XML tokens      : ${hydratedTokens}\n` +
  `  hydrated savings         : ${savings}%`,
);
check("hydrated drafter is smaller than markdown", hydratedTokens < mdTokens);

// 4. ATELIER_AGENT_PRINCIPLES_USE_XML=0 forces markdown
process.env.ATELIER_AGENT_PRINCIPLES_USE_XML = "0";
const mdSrc = principleSource("drafter");
delete process.env.ATELIER_AGENT_PRINCIPLES_USE_XML;
check("USE_XML=0 forces md path", mdSrc === "md", `got ${mdSrc}`);

// 5. composePrompt actually includes drafter content.
const composed = composePrompt({
  sessionId: "smoke-principle",
  mode: "drafter",
  stage: "pre-mvp",
  projectName: "demo",
});
check("composed prompt non-empty", composed.length > 0);
check(
  "composed prompt includes a drafter rule",
  /^- .+/m.test(composed),
  "no rule bullets found in composed text",
);
check(
  "composed prompt includes a section header",
  /^## /m.test(composed),
);
check(
  "composed prompt includes Current Project Context",
  /Current Project Context/.test(composed),
);
console.log(`  composed lines           : ${composed.split("\n").length}`);
console.log(`  composed chars           : ${composed.length}`);

// 6. Standalone hydrator can survive empty input.
check("hydrateAgentXml('') returns ''", hydrateAgentXml("") === "");

console.log("------------------------------------------------");
if (failed > 0) {
  console.error(`smoke FAILED: ${failed} assertion(s)`);
  process.exit(1);
} else {
  console.log("smoke OK");
  process.exit(0);
}
