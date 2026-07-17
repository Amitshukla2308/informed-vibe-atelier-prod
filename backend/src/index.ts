/**
 * Atelier backend entrypoint.
 * Bun HTTP server + WebSocket hub. Phase A minimum.
 */

import { runBootValidation } from "~/boot/validate";
import { config } from "~/config";
import { handleHttp } from "~/routes/http";
import { handleWebSocket, broadcastToAll, type SessionData } from "~/ws/hub";
import { parseProxyPath, startUpstreamWs, type ProxyWsData } from "~/agent/terminal-proxy";

// Union of every shape the WebSocket `data` field can carry. Bun infers the
// generic from the websocket handlers below, so server.upgrade() accepts
// either side without casting.
type WsData = SessionData | ProxyWsData;
import { startReflectionWorker } from "~/session/reflection-worker";
import { startImplementerAutoPoller } from "~/implementer/auto-poller";
import { startDrafterAutoPoller } from "~/agent/drafter-background";
import { getDb } from "~/db";
import { ensureBootstrapToken } from "~/auth/bootstrap";
import { runLegacyMigration, backfillProjectsFromDisk } from "~/db/migrate";
import { getAuthContext } from "~/auth/middleware";

import type { AgentProviderId } from "~/agent/providers";

const { ok, failures } = runBootValidation();
if (!ok) {
  console.error("\n✗ Boot validation failed:\n");
  failures.forEach((f) => console.error(`  ${f}`));
  console.error("\nFix the above before starting the backend.");
  process.exit(1);
}

// Initialize SQLite + run legacy migration (promotes agents/config.yaml
// founder into first DB user, if DB is empty). Idempotent on every boot.
getDb();
const migration = runLegacyMigration();
if (migration.ran) {
  console.log(`✓ DB migration: ${migration.reason} (user=${migration.first_user_id?.slice(0, 8)}…, org=${migration.first_org_id?.slice(0, 8)}…)`);
}
const projectsBackfill = backfillProjectsFromDisk();
if (projectsBackfill.added > 0) {
  console.log(`✓ Projects backfill: added ${projectsBackfill.added} on-disk project(s) to DB`);
}

// Bootstrap-window protection: while 0 users exist, keep a one-time token
// that gates first-admin creation on reachable installs (auth/bootstrap.ts).
{
  const userCount = (getDb().query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  ensureBootstrapToken(userCount);
}

/**
 * CORS — echo the request's Origin when it's a known dev or tunnel origin.
 * `Access-Control-Allow-Origin: *` is incompatible with `credentials: include`,
 * so we must name the origin explicitly + add Allow-Credentials for cookies
 * to survive cross-origin fetches. Wildcard origins get no creds, per spec.
 */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  // localhost variants for dev. Add your production hostname(s) below by
  // setting ATELIER_ALLOWED_ORIGIN_SUFFIX to a comma-separated list of
  // domain suffixes (e.g. "atelier.example.com,*.example.com").
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  const extra = (process.env.ATELIER_ALLOWED_ORIGIN_SUFFIX ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  for (const suffix of extra) {
    // Escape regex specials except leading "*."
    const wildcard = suffix.startsWith("*.");
    const bare = wildcard ? suffix.slice(2) : suffix;
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = wildcard
      ? new RegExp(`^https:\\/\\/[a-z0-9-]+\\.${escaped}$`)
      : new RegExp(`^https:\\/\\/${escaped}$`);
    if (pattern.test(origin)) return origin;
  }
  return null;
}

/**
 * Bridge a client-side WS (server.upgrade) to an upstream WS (ttyd via
 * `new WebSocket`). Bun's WebSocket client mirrors the browser API; we set
 * binaryType to "arraybuffer" so ttyd's binary frames pass through unmolested.
 */
function openProxyBridge(ws: import("bun").ServerWebSocket<ProxyWsData>) {
  const data = ws.data;
  data.serverWs = ws;
  data.clientReady = true;
  // Flush any upstream → client frames that arrived before the client was ready.
  // The eager message listener installed in startUpstreamWs accumulated them
  // into pendingToClient.
  if (data.pendingToClient.length > 0) {
    for (const msg of data.pendingToClient) {
      if (ws.readyState === 1) ws.send(msg);
    }
    data.pendingToClient = [];
  }
  // Flush any client → upstream messages that arrived before upstream finished
  // its handshake.
  if (data.upstream.readyState === 1 && data.pendingToUpstream.length > 0) {
    for (const msg of data.pendingToUpstream) data.upstream.send(msg);
    data.pendingToUpstream = [];
  } else if (data.upstream.readyState === 0) {
    data.upstream.addEventListener("open", () => {
      for (const msg of data.pendingToUpstream) data.upstream.send(msg);
      data.pendingToUpstream = [];
    });
  }
}

function forwardClientToUpstream(ws: import("bun").ServerWebSocket<ProxyWsData>, raw: string | Buffer) {
  const data = ws.data;
  // ttyd expects binary frames as Uint8Array.
  const payload = typeof raw === "string" ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (data.upstream.readyState === 1) {
    data.upstream.send(payload);
  } else {
    data.pendingToUpstream.push(payload);
  }
}

function closeProxyBridge(ws: import("bun").ServerWebSocket<ProxyWsData>) {
  try { ws.data.upstream.close(); } catch { /* ignore */ }
}

function withCorsHeaders(resp: Response, req: Request): Response {
  const origin = allowedOrigin(req.headers.get("origin"));
  if (!origin) return resp; // no origin or disallowed — no CORS added
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  return new Response(resp.body, { status: resp.status, headers });
}

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: config.bindHost,
  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight — handled centrally so every route gets it right.
    if (req.method === "OPTIONS") {
      const origin = allowedOrigin(req.headers.get("origin"));
      return new Response(null, {
        status: 204,
        headers: {
          ...(origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" } : {}),
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Atelier-Dev-As",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
      const provider = (url.searchParams.get("provider") ?? config.agent.provider ?? "claude") as AgentProviderId;
      // Resolve atelier user from the atelier_at cookie so the PTY can
      // spawn with a scoped HOME. "default" when no cookie — keeps legacy
      // single-founder flows working until every install has claimed.
      const ctx = getAuthContext(req);
      const userId = ctx?.user.id ?? "default";
      const upgraded = server.upgrade(req, { data: { sessionId, provider, userId } });
      if (upgraded) return;
      return new Response("Upgrade failed", { status: 500 });
    }

    // Terminal v2 reverse-proxy WS upgrade. Lets devices that aren't the host
    // (LAN, tunnel, phone) open the ttyd terminal through Atelier's auth gate.
    // We open the upstream WS to ttyd here so failures return 502 cleanly
    // before we hand the connection to Bun's upgrade.
    if (url.pathname.startsWith("/terminal-v2/proxy/") && url.pathname.endsWith("/ws")) {
      const parsed = parseProxyPath(url.pathname);
      if (!parsed || parsed.remainder !== "ws") {
        return new Response("bad proxy ws path", { status: 400 });
      }
      // ttyd uses subprotocol "tty" on the WS handshake; forward whatever the
      // client requested so we don't lock to a specific ttyd version.
      const subprotocol = req.headers.get("sec-websocket-protocol");
      const data = startUpstreamWs(parsed.sessionId, subprotocol);
      if (!data) return new Response("no active terminal-v2 session", { status: 404 });
      const upgradeHeaders: Record<string, string> = {};
      if (subprotocol) upgradeHeaders["Sec-WebSocket-Protocol"] = subprotocol;
      const upgraded = server.upgrade(req, { data, headers: upgradeHeaders });
      if (upgraded) return;
      try { data.upstream.close(); } catch { /* ignore */ }
      return new Response("Upgrade failed", { status: 500 });
    }

    // HTTP routes — wrap response with CORS headers that allow credentials.
    const resp = await handleHttp(req);
    return withCorsHeaders(resp, req);
  },
  websocket: {
    open(ws: import("bun").ServerWebSocket<WsData>) {
      if ((ws.data as ProxyWsData).proxy) return openProxyBridge(ws as import("bun").ServerWebSocket<ProxyWsData>);
      return handleWebSocket.open(ws as import("bun").ServerWebSocket<SessionData>);
    },
    message(ws: import("bun").ServerWebSocket<WsData>, raw: string | Buffer) {
      if ((ws.data as ProxyWsData).proxy) return forwardClientToUpstream(ws as import("bun").ServerWebSocket<ProxyWsData>, raw);
      return handleWebSocket.message(ws as import("bun").ServerWebSocket<SessionData>, raw);
    },
    close(ws: import("bun").ServerWebSocket<WsData>) {
      if ((ws.data as ProxyWsData).proxy) return closeProxyBridge(ws as import("bun").ServerWebSocket<ProxyWsData>);
      return handleWebSocket.close(ws as import("bun").ServerWebSocket<SessionData>);
    },
  },
});

const agent = config.agent;
console.log(`\n✓ Atelier backend listening on ${config.baseUrl}`);
if (agent.agent_name && agent.active_project) {
  console.log(`  Agent: ${agent.agent_name} | Founder: ${agent.founder_name || "(anon)"}`);
  console.log(`  Active project: ${agent.active_project}`);
} else {
  console.log(`  State: awaiting onboarding`);
}
console.log(`  WebSocket: ${config.baseUrl.replace(/^http/, "ws")}/ws\n`);

// Start the background reflection scanner. Honors reflection_mode from agent
// config (manual = no-op, semi-auto = threshold, auto = all). Broadcasts task
// events so the ribbon notification slot can show "reflecting session XX".
startReflectionWorker({
  broadcast: (_sessionId, payload) => broadcastToAll(JSON.stringify(payload)),
  listActiveProjects: () => (config.agent.active_project ? [config.agent.active_project] : []),
});

// Implementer auto-poller. Default off (config.implementer.auto_run = false);
// when on, defaults to dry-run so the founder sees what *would* fire before
// allowing unsupervised commits. Re-reads YAML each tick — the kill-switch
// in Settings is honored within one interval, no restart needed.
startImplementerAutoPoller({
  broadcast: (payload) => broadcastToAll(JSON.stringify(payload)),
  listActiveProjects: () => (config.agent.active_project ? [config.agent.active_project] : []),
});

// Drafter background worker. Default ON. Closes the loop on allocator hand_back:
// auto-fixes known-easy gaps (e.g. missing "## Who benefits" inherited from
// parent Story) or marks for discussion so the founder is prompted on their
// next Drafter session. Kill-switch via agents/config.yaml `drafter.auto_run: false`.
startDrafterAutoPoller();
