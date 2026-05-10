/**
 * Distribution adapter registry.
 *
 * Mirror of `agent/providers/index.ts`'s `getCliAdapter`. Same shape: a
 * fixed list of typed adapters keyed by id; a single `getDistributionAdapter`
 * lookup throws on unknown ids; `listDistributionAdapters` returns the full
 * set (for the Settings UI to enumerate).
 *
 * Adding a new adapter is two lines: import + add to the array. Type system
 * keeps the contract.
 */

import type { DistributionAdapter, DistributionAdapterId } from "./types";
import { cloudflareDnsAdapter } from "./adapters/cloudflare";
import { razorpayAdapter } from "./adapters/razorpay";
import { plausibleAdapter } from "./adapters/plausible";
import { resendAdapter } from "./adapters/resend";

const ADAPTERS: DistributionAdapter[] = [
  cloudflareDnsAdapter,
  razorpayAdapter,
  plausibleAdapter,
  resendAdapter,
];

export function listDistributionAdapters(): DistributionAdapter[] {
  return ADAPTERS;
}

export function getDistributionAdapter(id: string): DistributionAdapter {
  const found = ADAPTERS.find(a => a.id === id);
  if (!found) throw new Error(`Distribution adapter not implemented: ${id}`);
  return found;
}

export function isDistributionAdapterId(id: string): id is DistributionAdapterId {
  return ADAPTERS.some(a => a.id === id);
}

export type { DistributionAdapter, DistributionAdapterId, DistributionCategory } from "./types";
