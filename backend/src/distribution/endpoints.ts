/**
 * Distribution adapter HTTP endpoints. Routed from `routes/http.ts`.
 *
 * Wire shape:
 *   GET    /distribution/adapters                 — list adapters + detectInstalled
 *   GET    /distribution/links                    — list user's configured links
 *   POST   /distribution/links/:id                — upsert a link's config
 *   POST   /distribution/links/:id/verify         — call adapter.verify
 *   POST   /distribution/links/:id/write-config   — call adapter.writeConfig
 *   DELETE /distribution/links/:id                — remove
 *
 * All endpoints are auth-gated by the global cookie middleware in
 * `routes/http.ts` once any user exists.
 */

import { resolve } from "node:path";
import { config } from "~/config";
import { listDistributionAdapters, getDistributionAdapter, isDistributionAdapterId } from "./index";
import {
  listDistributionLinks, getDistributionLink, upsertDistributionLink,
  recordVerifyResult, recordWriteConfig, deleteDistributionLink,
} from "./links";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Sanitize config for client display — drop the secret-looking fields so the
 *  UI never has to round-trip them through the wire. The adapter row in the
 *  DB keeps the full config; the client only needs to see "saved or not". */
function sanitizeConfig(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) return null;
  const SECRET_KEYS = new Set([
    "api_token", "api_key", "key_secret", "webhook_secret",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = typeof v === "string" && v.length > 0 ? "•••• (saved)" : null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function handleListAdapters(): Promise<Response> {
  const out: Array<Record<string, unknown>> = [];
  for (const a of listDistributionAdapters()) {
    let detect: { available: boolean; hint: string };
    try { detect = await a.detectInstalled(); }
    catch (e) { detect = { available: false, hint: `detect crashed: ${String(e).slice(0, 120)}` }; }
    out.push({
      id: a.id,
      category: a.category,
      label: a.label,
      purpose: a.purpose,
      detected: detect,
    });
  }
  return json({ adapters: out });
}

export function handleListLinks(userId: string): Response {
  const links = listDistributionLinks(userId);
  return json({
    links: links.map(l => ({
      adapter_id: l.adapter_id,
      project: l.project,
      status: l.status,
      config: sanitizeConfig(l.config),
      has_config: l.config !== null,
      last_verified_at: l.last_verified_at,
      last_verify_detail: l.last_verify_detail,
      last_verify_ok: l.last_verify_ok,
      last_config_written_at: l.last_config_written_at,
      updated_at: l.updated_at,
    })),
  });
}

export async function handleUpsertLink(userId: string, adapterId: string, body: unknown): Promise<Response> {
  if (!isDistributionAdapterId(adapterId)) return json({ error: `unknown adapter: ${adapterId}` }, 400);
  const adapter = getDistributionAdapter(adapterId);
  const b = (body ?? {}) as { config?: unknown; project?: string | null };
  const project = (typeof b.project === "string" && b.project.length > 0) ? b.project : null;

  // If the client only sends partial config (e.g. just the non-secret fields),
  // merge with what's already saved before validating.
  const existing = getDistributionLink(userId, adapterId);
  const incoming = (b.config ?? {}) as Record<string, unknown>;
  const SECRET_KEYS = new Set(["api_token", "api_key", "key_secret", "webhook_secret"]);
  // Drop sentinel placeholder values from incoming so we don't overwrite real
  // secrets with the "•••• (saved)" placeholder we sent down.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (SECRET_KEYS.has(k) && typeof v === "string" && v.startsWith("••••")) continue;
    cleaned[k] = v;
  }
  const merged = { ...(existing?.config ?? {}), ...cleaned };

  let validated: unknown;
  try {
    validated = adapter.configSchema.parse(merged);
  } catch (e) {
    return json({ error: "config validation failed", detail: String(e).slice(0, 400) }, 400);
  }

  const link = upsertDistributionLink(userId, adapterId, {
    config: validated as Record<string, unknown>,
    project,
    status: "configured",
  });
  return json({ ok: true, link: {
    adapter_id: link.adapter_id,
    project: link.project,
    status: link.status,
    config: sanitizeConfig(link.config),
    has_config: link.config !== null,
    last_verified_at: link.last_verified_at,
    last_verify_detail: link.last_verify_detail,
    last_verify_ok: link.last_verify_ok,
    last_config_written_at: link.last_config_written_at,
    updated_at: link.updated_at,
  } });
}

export async function handleVerifyLink(userId: string, adapterId: string): Promise<Response> {
  if (!isDistributionAdapterId(adapterId)) return json({ error: `unknown adapter: ${adapterId}` }, 400);
  const adapter = getDistributionAdapter(adapterId);
  const link = getDistributionLink(userId, adapterId);
  if (!link?.config) return json({ ok: false, detail: "no config saved — configure the adapter first" }, 400);

  const t0 = Date.now();
  try {
    const result = await adapter.verify({ config: link.config });
    recordVerifyResult(userId, adapterId, result.ok, result.detail);
    return json({ ...result, latency_ms: result.latency_ms ?? Date.now() - t0 });
  } catch (e) {
    const detail = "verify crashed";
    recordVerifyResult(userId, adapterId, false, detail);
    return json({
      ok: false,
      detail,
      latency_ms: Date.now() - t0,
      error: String(e).slice(0, 300),
    });
  }
}

export async function handleWriteConfig(userId: string, adapterId: string, body: unknown): Promise<Response> {
  if (!isDistributionAdapterId(adapterId)) return json({ error: `unknown adapter: ${adapterId}` }, 400);
  const adapter = getDistributionAdapter(adapterId);
  const link = getDistributionLink(userId, adapterId);
  if (!link?.config) return json({ ok: false, detail: "no config saved — configure the adapter first" }, 400);

  const b = (body ?? {}) as { project?: string };
  const project = b.project ?? link.project ?? config.agent.active_project;
  if (!project) return json({ error: "no active project" }, 400);
  const cwd = resolve(config.projectsDir, project);

  try {
    const result = await adapter.writeConfig({ project, cwd, config: link.config });
    recordWriteConfig(userId, adapterId);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({
      ok: false,
      error: String(e).slice(0, 300),
    }, 500);
  }
}

export function handleDeleteLink(userId: string, adapterId: string): Response {
  if (!isDistributionAdapterId(adapterId)) return json({ error: `unknown adapter: ${adapterId}` }, 400);
  const removed = deleteDistributionLink(userId, adapterId);
  return json({ ok: true, removed });
}
