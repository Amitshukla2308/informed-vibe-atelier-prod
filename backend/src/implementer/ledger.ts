/**
 * Cost ledger — append-only JSONL per node.
 *
 * Path: <OG_ARTIFACTS_DIR or <atelier>/og_artifacts>/ledger/<node-id>.jsonl
 * One line per Allocator + Qwen-Code invocation; founder's Canvas UI rolls these up.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { LedgerEntry } from "./types";

function ogArtifactsDir(): string {
  if (process.env.OG_ARTIFACTS_DIR) return process.env.OG_ARTIFACTS_DIR;
  const atelierRoot = resolve(import.meta.dir, "..", "..", "..");
  return resolve(atelierRoot, "og_artifacts");
}

export function ledgerPathFor(nodeId: string): string {
  return resolve(ogArtifactsDir(), "ledger", `${nodeId}.jsonl`);
}

export function appendLedger(nodeId: string, entry: LedgerEntry): void {
  const p = ledgerPathFor(nodeId);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}
