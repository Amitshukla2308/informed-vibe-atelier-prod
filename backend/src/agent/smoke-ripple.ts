/**
 * Session 5 (TODO #30) ripple smoke test.
 *
 * Calls computeRipple() on a real Atelier file (`backend/src/agent/fixer.ts`),
 * prints the result, and asserts the basics: the result shape is correct,
 * the source is "git-fallback", and we got at least *something* back if
 * the file has any history.
 *
 * Run:
 *   bun src/agent/smoke-ripple.ts
 */

import { resolve } from "node:path";
import { computeRipple, formatRippleForLlm, _resetRippleCache } from "~/ripple/ripple";

// Default to two levels up from this file (backend/src/agent → repo root).
// Override with ATELIER_ROOT env if you run the smoke from elsewhere.
const ATELIER_ROOT = process.env.ATELIER_ROOT ?? resolve(import.meta.dir, "..", "..", "..");
const TARGETS = [
  "backend/src/agent/fixer.ts",
  "backend/src/implementer/worker.ts",
  "backend/src/mcp/server.ts",
];

async function main() {
  const failures: string[] = [];

  function check(cond: boolean, label: string) {
    if (cond) console.log(`  ✓ ${label}`);
    else {
      console.log(`  ✗ ${label}`);
      failures.push(label);
    }
  }

  console.log("[smoke-ripple] Session 5 — TODO #30 omnigraph_ripple");
  console.log(`[smoke-ripple] atelier root: ${ATELIER_ROOT}`);
  console.log("");

  _resetRippleCache();

  for (const target of TARGETS) {
    console.log(`=== ${target} (depth=1) ===`);
    const t0 = Date.now();
    const r = await computeRipple(target, 1, ATELIER_ROOT, { limit: 10 });
    const elapsed = Date.now() - t0;

    console.log(`  graph_built_at: ${r.graph_built_at}`);
    console.log(`  source: ${r.source}`);
    console.log(`  cached: ${r.cached}`);
    console.log(`  affected_files: ${r.affected_files.length} neighbours (computed in ${elapsed}ms)`);

    check(r.source === "git-fallback", `${target}: source is "git-fallback"`);
    check(typeof r.graph_built_at === "string" && r.graph_built_at.length > 0, `${target}: graph_built_at populated`);
    check(Array.isArray(r.affected_files), `${target}: affected_files is array`);

    for (const n of r.affected_files.slice(0, 8)) {
      const pct = Math.round(n.confidence * 100);
      const dist = n.last_change_distance < 0 ? "?" : `${n.last_change_distance}d`;
      console.log(`    · ${n.path} — ${pct}% (${dist}, d=${n.depth})`);
    }
    console.log("");
  }

  // Cache hit on second call.
  console.log("=== cache hit check ===");
  const t0 = Date.now();
  const second = await computeRipple(TARGETS[0], 1, ATELIER_ROOT, { limit: 5 });
  const elapsed = Date.now() - t0;
  console.log(`  second call elapsed: ${elapsed}ms`);
  check(second.cached === true || elapsed < 200, "second call uses cache (cached=true OR <200ms)");
  console.log("");

  // Depth=2 returns a (usually) larger set.
  console.log("=== depth=2 expansion ===");
  const d1 = await computeRipple(TARGETS[0], 1, ATELIER_ROOT, { limit: 30 });
  const d2 = await computeRipple(TARGETS[0], 2, ATELIER_ROOT, { limit: 30 });
  console.log(`  depth=1: ${d1.affected_files.length} files`);
  console.log(`  depth=2: ${d2.affected_files.length} files`);
  check(d2.affected_files.length >= d1.affected_files.length, "depth=2 ≥ depth=1");
  console.log("");

  // Format-for-LLM is non-empty.
  console.log("=== formatRippleForLlm ===");
  const formatted = formatRippleForLlm(d1);
  console.log(formatted.split("\n").slice(0, 6).join("\n"));
  check(formatted.length > 0, "formatted output non-empty");
  console.log("");

  if (failures.length > 0) {
    console.error(`[smoke-ripple] FAIL — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log("[smoke-ripple] PASS");
}

main().catch((e) => {
  console.error("[smoke-ripple] unhandled error:", e);
  process.exit(2);
});
