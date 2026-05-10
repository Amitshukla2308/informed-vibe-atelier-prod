/**
 * Cloudflare DNS adapter.
 *
 * What it wires:
 *   founder gives Atelier a Cloudflare API token (scoped: Zone:DNS:Edit on the
 *   founder's domain) + the zone id. Atelier never makes write calls itself —
 *   it stores the config and writes a manifest the Implementer (Phase 4) will
 *   read when it scaffolds the deploy step that needs DNS records.
 *
 * Verification:
 *   GET /client/v4/zones — read-only, lists all zones the token can see.
 *   Returns ok + latency. Cheap, no remote state mutated.
 *
 * Why no CLI detection:
 *   `cloudflared` exists but it's the tunnel daemon, not a DNS-management CLI.
 *   The credential pattern for DNS is API-only. detectInstalled() therefore
 *   returns available:false with a hint pointing at API token creation.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DistributionAdapter, VerifyResult, WriteConfigResult } from "../types";

const cloudflareConfigSchema = z.object({
  api_token: z.string().min(20, "api_token looks too short — Cloudflare tokens are typically 40+ chars"),
  zone_id: z.string().min(8, "zone_id is required (Cloudflare → domain → overview)"),
  domain: z.string().min(3, "domain is required, e.g. fastbrick.in"),
  notes: z.string().optional(),
});

export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

export const cloudflareDnsAdapter: DistributionAdapter = {
  id: "cloudflare-dns",
  category: "dns",
  label: "Cloudflare DNS",
  purpose: "Point your domain at the deploy target. Atelier stores the API token; the Implementer writes records when it ships.",
  configSchema: cloudflareConfigSchema,

  async detectInstalled() {
    return {
      available: false,
      hint: "API-only adapter — create a token at dash.cloudflare.com → My Profile → API Tokens (Zone.DNS:Edit on the target zone).",
    };
  },

  async writeConfig(opts): Promise<WriteConfigResult> {
    const cfg = cloudflareConfigSchema.parse(opts.config);
    const machinePath = resolve(opts.cwd, ".distribution", "cloudflare-dns.json");
    const humanPath = resolve(opts.cwd, "distribution", "cloudflare-dns.md");
    mkdirSync(dirname(machinePath), { recursive: true });
    mkdirSync(dirname(humanPath), { recursive: true });

    // Machine-readable: includes the api_token (Phase A plaintext — single-
    // founder local workspace). Implementer reads this at deploy-scaffold time.
    writeFileSync(machinePath, JSON.stringify({
      adapter_id: "cloudflare-dns",
      version: 1,
      project: opts.project,
      config: cfg,
      written_at: new Date().toISOString(),
    }, null, 2));

    // Human-readable: never includes the token (founder-facing reference).
    const md = [
      "# Cloudflare DNS",
      "",
      `**Domain:** ${cfg.domain}`,
      `**Zone ID:** ${cfg.zone_id}`,
      `**API token:** stored in \`.distribution/cloudflare-dns.json\` (gitignored — never commit).`,
      "",
      "## What this controls",
      "When the Implementer scaffolds your deploy step, it reads `.distribution/cloudflare-dns.json` and",
      "writes the A / AAAA / CNAME records that point this domain at the chosen host.",
      "",
      "## Scope expected on the API token",
      "- `Zone.DNS:Edit` on the target zone (or all zones if you prefer).",
      "- No `User` scopes needed.",
      "",
      cfg.notes ? `## Notes\n\n${cfg.notes}\n` : "",
    ].filter(Boolean).join("\n");
    writeFileSync(humanPath, md);

    return {
      filesWritten: [machinePath, humanPath],
      notes: [
        `Wrote machine config → ${machinePath}`,
        `Wrote founder doc → ${humanPath}`,
        "Add `.distribution/` to your project's .gitignore — it contains your API token.",
      ],
    };
  },

  async verify(opts): Promise<VerifyResult> {
    const cfg = cloudflareConfigSchema.parse(opts.config);
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=1", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${cfg.api_token}`,
          "Content-Type": "application/json",
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const latency_ms = Date.now() - t0;
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { ok: false, detail: `Cloudflare API HTTP ${r.status}`, latency_ms, error: text.slice(0, 200) };
      }
      const data = await r.json() as { success?: boolean; result?: unknown[]; result_info?: { total_count?: number } };
      if (!data.success) {
        return { ok: false, detail: "Cloudflare returned success=false", latency_ms, error: JSON.stringify(data).slice(0, 200) };
      }
      const total = data.result_info?.total_count ?? data.result?.length ?? 0;
      return { ok: true, detail: `Cloudflare OK · ${total} zone(s) visible to this token`, latency_ms };
    } catch (e) {
      return {
        ok: false,
        detail: "Cloudflare API unreachable",
        latency_ms: Date.now() - t0,
        error: String(e).slice(0, 200),
      };
    }
  },
};
