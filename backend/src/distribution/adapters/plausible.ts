/**
 * Plausible analytics adapter.
 *
 * Why Plausible: privacy-friendly, no cookies, GDPR-compliant by default.
 * Founder pastes the site domain + an API key (created at plausible.io →
 * Account Settings → API Keys). Atelier stores the config; the Implementer
 * later writes the embed snippet into the rendered HTML / framework template.
 *
 * Verification:
 *   GET /api/v1/sites/{site_id} — returns the site object if the API key
 *   has access. Read-only, zero-cost.
 *
 * detectInstalled returns false — Plausible has no CLI, only REST + a JS snippet.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DistributionAdapter, VerifyResult, WriteConfigResult } from "../types";

const plausibleConfigSchema = z.object({
  api_key: z.string().min(20, "api_key looks too short — Plausible API keys are 40+ chars"),
  site_id: z.string().min(3, "site_id is the domain you registered with Plausible, e.g. fastbrick.in"),
  base_url: z.string().url().default("https://plausible.io"),
  notes: z.string().optional(),
});

export type PlausibleConfig = z.infer<typeof plausibleConfigSchema>;

export const plausibleAdapter: DistributionAdapter = {
  id: "plausible",
  category: "analytics",
  label: "Plausible",
  purpose: "Privacy-first analytics (no cookies, GDPR-compliant). Atelier stores the API key; the Implementer drops the snippet into your site at deploy time.",
  configSchema: plausibleConfigSchema,

  async detectInstalled() {
    return {
      available: false,
      hint: "API-only adapter — create a key at plausible.io → Account Settings → API Keys. Self-hosted is also supported (override base_url).",
    };
  },

  async writeConfig(opts): Promise<WriteConfigResult> {
    const cfg = plausibleConfigSchema.parse(opts.config);
    const machinePath = resolve(opts.cwd, ".distribution", "plausible.json");
    const humanPath = resolve(opts.cwd, "distribution", "plausible.md");
    mkdirSync(dirname(machinePath), { recursive: true });
    mkdirSync(dirname(humanPath), { recursive: true });

    writeFileSync(machinePath, JSON.stringify({
      adapter_id: "plausible",
      version: 1,
      project: opts.project,
      config: cfg,
      written_at: new Date().toISOString(),
    }, null, 2));

    const snippet = `<script defer data-domain="${cfg.site_id}" src="${cfg.base_url}/js/script.js"></script>`;
    const md = [
      "# Plausible",
      "",
      `**Site ID (domain registered with Plausible):** \`${cfg.site_id}\``,
      `**Base URL:** ${cfg.base_url}`,
      `**API key:** stored in \`.distribution/plausible.json\` (gitignored).`,
      "",
      "## Snippet to inject at deploy time",
      "",
      "```html",
      snippet,
      "```",
      "",
      "## What this controls",
      "When the Implementer scaffolds your site's HTML or framework root layout,",
      "it reads `.distribution/plausible.json` and inserts the snippet above before `</head>`.",
      "API key is reserved for future stats-pulling (founder dashboards in Atelier).",
      "",
      cfg.notes ? `## Notes\n\n${cfg.notes}\n` : "",
    ].filter(Boolean).join("\n");
    writeFileSync(humanPath, md);

    return {
      filesWritten: [machinePath, humanPath],
      notes: [
        `Wrote machine config → ${machinePath}`,
        `Wrote founder doc → ${humanPath}`,
        `Plausible domain: ${cfg.site_id} · base: ${cfg.base_url}`,
        "Snippet to inject is documented in the founder-doc — Implementer will pick it up.",
      ],
    };
  },

  async verify(opts): Promise<VerifyResult> {
    const cfg = plausibleConfigSchema.parse(opts.config);
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      // /api/v1/sites/{site_id} — returns the site object if the key has access.
      const url = `${cfg.base_url.replace(/\/$/, "")}/api/v1/sites/${encodeURIComponent(cfg.site_id)}`;
      const r = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${cfg.api_key}`,
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const latency_ms = Date.now() - t0;
      if (r.status === 401 || r.status === 403) {
        return { ok: false, detail: `Plausible ${r.status} — API key invalid or no access to ${cfg.site_id}`, latency_ms };
      }
      if (r.status === 404) {
        return { ok: false, detail: `Plausible 404 — site_id "${cfg.site_id}" not found in this account`, latency_ms };
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { ok: false, detail: `Plausible HTTP ${r.status}`, latency_ms, error: text.slice(0, 200) };
      }
      const data = await r.json() as { domain?: string; timezone?: string };
      return {
        ok: true,
        detail: `Plausible OK · site=${data.domain ?? cfg.site_id}${data.timezone ? ` (${data.timezone})` : ""}`,
        latency_ms,
      };
    } catch (e) {
      return {
        ok: false,
        detail: "Plausible API unreachable",
        latency_ms: Date.now() - t0,
        error: String(e).slice(0, 200),
      };
    }
  },
};
