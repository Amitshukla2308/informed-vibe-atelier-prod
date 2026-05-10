/**
 * Resend transactional email adapter.
 *
 * Why Resend: simple API, modern DX, good React-Email integration. The
 * `resend` Bun dependency is already in package.json (used by the auth
 * magic-link flow). For the distribution adapter we use the bare HTTPS API
 * so the verify path doesn't depend on the SDK quirks.
 *
 * Verification:
 *   GET /domains — returns the founder's verified sending domains. Read-only,
 *   zero-cost, confirms the API key works.
 *
 * detectInstalled returns false — Resend is API-first; no CLI is canonical.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DistributionAdapter, VerifyResult, WriteConfigResult } from "../types";

const resendConfigSchema = z.object({
  api_key: z.string().min(20, "api_key is required (re_…) — create at resend.com/api-keys"),
  from_address: z.string().email("from_address must be a valid email at a domain you've verified with Resend"),
  reply_to: z.string().email().optional(),
  notes: z.string().optional(),
});

export type ResendConfig = z.infer<typeof resendConfigSchema>;

export const resendAdapter: DistributionAdapter = {
  id: "resend",
  category: "email",
  label: "Resend",
  purpose: "Send transactional email (signup confirmations, magic links, receipts). Atelier stores the API key; the Implementer wires the send path when needed.",
  configSchema: resendConfigSchema,

  async detectInstalled() {
    return {
      available: false,
      hint: "API-only adapter — create a key at resend.com/api-keys and verify your sending domain (DNS records via Cloudflare adapter).",
    };
  },

  async writeConfig(opts): Promise<WriteConfigResult> {
    const cfg = resendConfigSchema.parse(opts.config);
    const machinePath = resolve(opts.cwd, ".distribution", "resend.json");
    const humanPath = resolve(opts.cwd, "distribution", "resend.md");
    mkdirSync(dirname(machinePath), { recursive: true });
    mkdirSync(dirname(humanPath), { recursive: true });

    writeFileSync(machinePath, JSON.stringify({
      adapter_id: "resend",
      version: 1,
      project: opts.project,
      config: cfg,
      written_at: new Date().toISOString(),
    }, null, 2));

    const md = [
      "# Resend",
      "",
      `**From address:** \`${cfg.from_address}\``,
      cfg.reply_to ? `**Reply-To:** \`${cfg.reply_to}\`` : "**Reply-To:** not set (replies bounce to from_address).",
      "**API key:** stored in `.distribution/resend.json` (gitignored — never commit).",
      "",
      "## What this controls",
      "When the Implementer wires a send path (welcome email, magic link, receipt),",
      "it reads `.distribution/resend.json` and uses the `resend` SDK with these defaults.",
      "",
      "## Domain verification",
      "Resend will refuse to send from `from_address` until the parent domain is verified.",
      "Pair with the Cloudflare DNS adapter to add the SPF / DKIM / DMARC records Resend prescribes.",
      "",
      cfg.notes ? `## Notes\n\n${cfg.notes}\n` : "",
    ].filter(Boolean).join("\n");
    writeFileSync(humanPath, md);

    return {
      filesWritten: [machinePath, humanPath],
      notes: [
        `Wrote machine config → ${machinePath}`,
        `Wrote founder doc → ${humanPath}`,
        `Sender: ${cfg.from_address}`,
        "Verify the from-address domain at resend.com/domains before relying on this adapter at deploy.",
      ],
    };
  },

  async verify(opts): Promise<VerifyResult> {
    const cfg = resendConfigSchema.parse(opts.config);
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch("https://api.resend.com/domains", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${cfg.api_key}`,
          "Content-Type": "application/json",
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const latency_ms = Date.now() - t0;
      if (r.status === 401 || r.status === 403) {
        return { ok: false, detail: `Resend ${r.status} — api_key invalid`, latency_ms };
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { ok: false, detail: `Resend HTTP ${r.status}`, latency_ms, error: text.slice(0, 200) };
      }
      const data = await r.json() as { data?: Array<{ name?: string; status?: string }> };
      const domains = data.data ?? [];
      const fromDomain = cfg.from_address.split("@")[1] ?? "";
      const match = domains.find(d => d.name === fromDomain);
      const verified = match?.status === "verified";
      const detail = domains.length === 0
        ? `Resend OK but 0 domains — verify ${fromDomain || "your sending domain"} at resend.com/domains`
        : verified
          ? `Resend OK · ${fromDomain} verified · ${domains.length} domain(s) total`
          : match
            ? `Resend OK · ${fromDomain} present but status=${match.status} (not yet verified)`
            : `Resend OK but ${fromDomain || "from_address domain"} not registered · ${domains.length} domain(s) found`;
      return { ok: true, detail, latency_ms };
    } catch (e) {
      return {
        ok: false,
        detail: "Resend API unreachable",
        latency_ms: Date.now() - t0,
        error: String(e).slice(0, 200),
      };
    }
  },
};
