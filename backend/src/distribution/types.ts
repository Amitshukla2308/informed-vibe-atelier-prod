/**
 * Distribution adapters — the "go-live cliff" pillar.
 *
 * Mirror of `agent/providers/types.ts` (CliAdapter), but for the *outbound*
 * side: domain DNS, payments, analytics, transactional email. Each adapter
 * is a typed connector between Atelier and a real-world distribution
 * provider chosen by the founder.
 *
 * Key design rule (per Session 6 spec):
 *   Adapters write CONFIG FILES into the project, not deploy scripts. The
 *   Implementer reads those config files later (Phase 4) when scaffolding
 *   deployment. This session ships only the adapter framework + four
 *   canonical adapters + a Settings UI section.
 *
 * Encryption-at-rest: distribution_links stores credentials *plaintext* in
 * SQLite for Phase A. The atelier DB itself sits inside a single-founder
 * local workspace (data/atelier.db). When a real key-management story lands
 * (Phase B+), this is the surface to upgrade — `writeConfig` should be the
 * only place credentials touch disk in cleartext, and a future encrypted
 * column can be swapped in transparently.
 */

import type { ZodSchema } from "zod";

export type DistributionCategory = "dns" | "payments" | "analytics" | "email";

export type DistributionAdapterId =
  | "cloudflare-dns"
  | "razorpay"
  | "plausible"
  | "resend";

export interface DetectInstalledResult {
  available: boolean;
  /** One-line founder-facing English: what to install / what's missing / what we found. */
  hint: string;
}

export interface WriteConfigOpts {
  /** Active project name (matches projects/<name>/). */
  project: string;
  /** Absolute project cwd (resolve(config.projectsDir, project)). */
  cwd: string;
  /** Validated config object (already parsed by adapter.configSchema). */
  config: unknown;
}

export interface WriteConfigResult {
  filesWritten: string[]; // absolute paths
  notes: string[];        // short markdown lines surfaced back in UI
}

export interface VerifyOpts {
  /** Validated config object (parsed by adapter.configSchema). */
  config: unknown;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  latency_ms?: number;
  error?: string;
}

export interface DistributionAdapter {
  id: DistributionAdapterId;
  category: DistributionCategory;
  /** Founder-facing label (1 short word/phrase). */
  label: string;
  /** Founder-facing 1-line purpose — what wiring this gets the founder. */
  purpose: string;
  /** Zod schema validating the founder's config payload (credentials + per-adapter fields). */
  configSchema: ZodSchema<unknown>;
  /**
   * Quick presence probe — returns `available: false` for adapters that are
   * API-only (no CLI on disk to detect). The hint string gives the founder
   * the right action.
   */
  detectInstalled(): Promise<DetectInstalledResult>;
  /**
   * Stages config files into the active project. Writes:
   *   <cwd>/.distribution/<id>.json  — machine-readable (Implementer reads, Phase 4)
   *   <cwd>/distribution/<id>.md     — human-readable founder doc
   * Returns absolute paths of files written + notes for UI surfacing.
   */
  writeConfig(opts: WriteConfigOpts): Promise<WriteConfigResult>;
  /**
   * Real read-only API call (zero-cost, never mutates remote state). Used by
   * the founder's "verify" button to confirm credentials work before relying
   * on this adapter at deploy time.
   */
  verify(opts: VerifyOpts): Promise<VerifyResult>;
}
