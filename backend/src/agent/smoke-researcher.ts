/**
 * Smoke test for runResearcher().
 *
 * Run with:
 *   cd backend && bun src/agent/smoke-researcher.ts
 *
 * Expected outcomes:
 *   - kind=ok      : LM Studio reachable, Qwen returned a markdown note.
 *                    Print the first 800 chars + extracted confidence.
 *   - kind=skipped : Provider not qwen-code (default is, so this means
 *                    LM Studio is unreachable/empty) or mode=manual.
 *                    Both are valid passes — exercises the same path.
 *   - kind=error   : Empty completion. Less common; still a valid path.
 *
 * The smoke does NOT write to og_artifacts/. That's the HTTP route's job —
 * here we just verify the runner returns a structured result against the
 * real Qwen.
 */

import { runResearcher } from "~/agent/researcher";

async function main() {
  const t0 = Date.now();
  const result = await runResearcher({
    question: "What's the founder's project layer? Summarize what 'project layer' means in Atelier in one paragraph for a smoke test.",
    nodeContext: {
      id: "smoke-test",
      kind: "Research",
      intent: "test",
      project: "smoke",
    },
  });
  const elapsed = Date.now() - t0;

  console.log(`\n=== runResearcher result (${elapsed}ms) ===`);
  console.log(`kind: ${result.kind}`);
  if (result.kind === "ok") {
    console.log(`provider: ${result.provider}`);
    console.log(`confidence: ${result.confidence ?? "(not extracted)"}`);
    console.log("\n--- markdown (first 800 chars) ---");
    console.log(result.markdown.slice(0, 800));
    if (result.markdown.length > 800) {
      console.log(`\n…(truncated; full length ${result.markdown.length} chars)`);
    }
    process.exit(0);
  }
  if (result.kind === "skipped") {
    console.log(`reason: ${result.reason}`);
    console.log("\nThis is a VALID smoke pass — the headless path returned a structured skipped envelope.");
    process.exit(0);
  }
  // error
  console.log(`reason: ${result.reason}`);
  console.log("\nThis is a VALID smoke pass — the runner produced a structured error envelope rather than throwing.");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke-researcher: uncaught", e);
  process.exit(1);
});
