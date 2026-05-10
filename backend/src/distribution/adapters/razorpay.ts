/**
 * Razorpay payments adapter.
 *
 * Why Razorpay alongside Stripe: it's the standard payments rail for
 * India-region projects. Razorpay's API is well-documented, supports
 * test/live keys, and the verify path uses Basic auth with a read-only call.
 *
 * Verification:
 *   GET /v1/payments?count=1 — read-only, lists last payment (or empty
 *   array on a fresh account). Returns ok + latency. Uses Basic auth with
 *   key_id + key_secret.
 *
 * detectInstalled returns false — Razorpay has no CLI, only a REST API.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DistributionAdapter, VerifyResult, WriteConfigResult } from "../types";

const razorpayConfigSchema = z.object({
  key_id: z.string().min(8, "key_id is required (rzp_test_… or rzp_live_…)"),
  key_secret: z.string().min(16, "key_secret is required"),
  mode: z.enum(["test", "live"]).default("test"),
  webhook_secret: z.string().optional(),
  notes: z.string().optional(),
});

export type RazorpayConfig = z.infer<typeof razorpayConfigSchema>;

export const razorpayAdapter: DistributionAdapter = {
  id: "razorpay",
  category: "payments",
  label: "Razorpay",
  purpose: "Accept payments from Indian customers (UPI, cards, netbanking). Atelier stores test/live keys; the Implementer wires the checkout when shipping.",
  configSchema: razorpayConfigSchema,

  async detectInstalled() {
    return {
      available: false,
      hint: "API-only adapter — create keys at dashboard.razorpay.com → Settings → API Keys. Use test mode first.",
    };
  },

  async writeConfig(opts): Promise<WriteConfigResult> {
    const cfg = razorpayConfigSchema.parse(opts.config);
    const machinePath = resolve(opts.cwd, ".distribution", "razorpay.json");
    const humanPath = resolve(opts.cwd, "distribution", "razorpay.md");
    mkdirSync(dirname(machinePath), { recursive: true });
    mkdirSync(dirname(humanPath), { recursive: true });

    writeFileSync(machinePath, JSON.stringify({
      adapter_id: "razorpay",
      version: 1,
      project: opts.project,
      config: cfg,
      written_at: new Date().toISOString(),
    }, null, 2));

    const md = [
      "# Razorpay",
      "",
      `**Mode:** ${cfg.mode} (${cfg.mode === "test" ? "no real money will move" : "REAL money — production keys"})`,
      `**Key ID:** \`${cfg.key_id}\``,
      `**Key secret:** stored in \`.distribution/razorpay.json\` (gitignored — never commit).`,
      cfg.webhook_secret ? "**Webhook secret:** stored alongside (signs incoming webhook payloads)." : "**Webhook secret:** not configured. Set up later when wiring webhook endpoint.",
      "",
      "## What this controls",
      "When the Implementer scaffolds the checkout flow, it reads `.distribution/razorpay.json` and",
      "wires the `Razorpay` SDK with these keys. Webhooks (if configured) are validated against `webhook_secret`.",
      "",
      "## Mode discipline",
      "- Use `test` mode until the full happy path runs end-to-end.",
      "- Switch to `live` only after the founder explicitly approves go-live (this is a payments cliff — stripe/razorpay outages are visible to every user).",
      "",
      cfg.notes ? `## Notes\n\n${cfg.notes}\n` : "",
    ].filter(Boolean).join("\n");
    writeFileSync(humanPath, md);

    return {
      filesWritten: [machinePath, humanPath],
      notes: [
        `Wrote machine config → ${machinePath}`,
        `Wrote founder doc → ${humanPath}`,
        cfg.mode === "test"
          ? "Mode = test — safe. Switch to live only after end-to-end smoke."
          : "Mode = live — REAL money. Verify checkout in test once before relying on this.",
        "Add `.distribution/` to project's .gitignore — `key_secret` is plaintext.",
      ],
    };
  },

  async verify(opts): Promise<VerifyResult> {
    const cfg = razorpayConfigSchema.parse(opts.config);
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const auth = "Basic " + Buffer.from(`${cfg.key_id}:${cfg.key_secret}`).toString("base64");
      const r = await fetch("https://api.razorpay.com/v1/payments?count=1", {
        method: "GET",
        headers: {
          "Authorization": auth,
          "Content-Type": "application/json",
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const latency_ms = Date.now() - t0;
      if (r.status === 401) {
        return { ok: false, detail: "Razorpay 401 — key_id or key_secret invalid", latency_ms };
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { ok: false, detail: `Razorpay HTTP ${r.status}`, latency_ms, error: text.slice(0, 200) };
      }
      const data = await r.json() as { count?: number; items?: unknown[] };
      const count = data.count ?? data.items?.length ?? 0;
      return {
        ok: true,
        detail: `Razorpay OK (${cfg.mode} mode) · ${count} recent payment(s) visible`,
        latency_ms,
      };
    } catch (e) {
      return {
        ok: false,
        detail: "Razorpay API unreachable",
        latency_ms: Date.now() - t0,
        error: String(e).slice(0, 200),
      };
    }
  },
};
