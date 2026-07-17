/**
 * HTTP routes for Atelier backend.
 *
 * Phase A:
 *   GET  /health
 *   GET  /onboarding/state          — includes pickup_flavor from last_session.json
 *   POST /onboarding/complete
 *   GET  /canvas/graph
 *   GET  /canvas/node/:id
 *   POST /canvas/node               — create node
 *   PATCH /canvas/node/:id          — update node meta
 *   POST /canvas/edge               — add edge
 *   GET  /domain-brain              — list + read domain_brain/ files
 *   POST /session/reflect
 *   POST /ingest/usage
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import YAML from "yaml";
import { config } from "~/config";
import { scaffoldProject, projectMeta } from "~/project/scaffold";
import { getGraph, proposeNode, proposeEdge, updateNodeMeta, updateNodePlan, deleteNode, getNode, type NodeKind, type NodeState, type NodeBadge, type NodeMeta } from "~/project/canvas";
import { recordNodeEvent, postAgentComment } from "~/project/canvas-comments";
import { reflectSession } from "~/session/reflect";
import { listProjectSessions, getSessionEntry, getSessionArtifact, getSessionRawExcerpt, getSessionArtifactPath, reconstructUserTurnsFromRawLog } from "~/session/session-index";
import { readSessionConversation } from "~/agent/providers";
import { readFileSync as _readFileSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { continueSessions, type ContinueMode } from "~/session/continue";
import { listWatchers, listRecentEvents, writeEvent } from "~/world/watchers";
import { runImplementerOnce } from "~/implementer/worker";
import { rankReadyTasks } from "~/implementer/queue";
import { getAutoPollerStatus, nudgeImplementerAutoPoller } from "~/implementer/auto-poller";
import { tickDrafterAutoPoller } from "~/agent/drafter-background";
import { checkCoherence, violationsFor } from "~/implementer/coherence";
import { scanGuardians } from "~/guardians/engine";
import { handleTerminalProxyHttp } from "~/agent/terminal-proxy";
import { handleStatus as implStatus, handleDiff as implDiff, handleApprove as implApprove, handleReject as implReject, handleSeniorReview as implSeniorReview, handleListRuns as implListRuns } from "~/implementer/endpoints";
import { handleGetAgentSettings, handleSetAgentSettings, handleSetProviderLink, handleRecentActivity, handleEtlStatus, handleOgStats, handleVerifyProvider } from "~/settings/endpoints";
import {
  handleListAdapters as distListAdapters,
  handleListLinks as distListLinks,
  handleUpsertLink as distUpsertLink,
  handleVerifyLink as distVerifyLink,
  handleWriteConfig as distWriteConfig,
  handleDeleteLink as distDeleteLink,
} from "~/distribution/endpoints";
import { getAuthContext as _getAuthCtx } from "~/auth/middleware";
import { startTerminalV2, stopTerminalV2, listTerminalV2, getTerminalV2, isTerminalV2Available } from "~/agent/terminal-server";
import { getCliAdapter } from "~/agent/providers";
import { getAgentConfig } from "~/settings/agents";
import { writeComposedPrompt } from "~/agent/identity";
import { loadOmnigraphBrain, brainLayerFlagsFromEnv } from "~/session/load-omnigraph-brain";
import { inspectOmnigraphBrain } from "~/session/inspect-omnigraph-brain";
import { omnigraphStatus, readAgentConstraints } from "~/omnigraph/status";

function json(body: unknown, status = 200): Response {
  // No CORS headers here. withCorsHeaders() in index.ts is the single source
  // of truth — it echoes the Origin only for allowlisted origins and adds
  // Allow-Credentials. The hardcoded `Access-Control-Allow-Origin: *` that
  // used to live here leaked on every response whose Origin wasn't on the
  // allowlist (and is spec-incompatible with credentialed requests anyway).
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readLastSessionFlavor(project: string): string | null {
  try {
    const p = resolve(config.projectsDir, project, "last_session.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")).flavor ?? null;
  } catch { return null; }
}

import { handleAuthRoutes } from "~/routes/auth";
import { getAuthContext } from "~/auth/middleware";
import { canUserAccessProject } from "~/auth/access";
import { getDb, newId, nowIso } from "~/db";

/** Returns Response(401) if a user-table-populated instance receives an
 *  unauth'd request to a privileged onboarding endpoint. Returns null when
 *  the request is allowed (either fresh install, or valid auth cookie). */
function gateOnboardingWrite(req: Request): Response | null {
  const userCount = (getDb().query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  if (userCount === 0) return null;       // fresh install: any caller may bootstrap
  if (getAuthContext(req)) return null;   // authed: allow
  return new Response(JSON.stringify({ error: "auth required" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return json({}, 200);

  if (path === "/health") return json({ ok: true, version: "0.1.0-phase-a" });

  // γ auth routes (invite/claim/me/logout/admin/*) — handle first. Returns
  // null when path isn't an auth route so legacy handlers can continue.
  const authResp = await handleAuthRoutes(req, url, path);
  if (authResp) return authResp;

  // ── GLOBAL AUTH GATE ────────────────────────────────────────────────────────
  // Once any user exists in the DB, every endpoint outside the small set of
  // public bootstrap paths requires a valid auth cookie. /onboarding/* paths
  // self-gate (state returns a public stub; writes return 401 without a
  // cookie). This is the load-bearing rule that prevents a stranger on the
  // tunnel/LAN from reading or writing the workspace.
  const _userCount = (getDb().query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  if (_userCount > 0) {
    const isPublicBootstrap =
      path.startsWith("/onboarding/") ||
      path === "/health";
    if (!isPublicBootstrap) {
      const ctx = getAuthContext(req);
      if (!ctx) {
        return new Response(JSON.stringify({ error: "auth required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      // Project-scope gate: any path that operates on a project must verify
      // the caller has access to it. The project name is the URL ?project=
      // param when present, falling back to the active project from agent
      // config (legacy behaviour for the host).
      const PROJECT_SCOPED_PREFIXES = [
        "/canvas/", "/sessions", "/domain-brain", "/world/", "/projects/switch",
        "/research/", "/brain", "/brain/preview",
      ];
      const isProjectScoped = PROJECT_SCOPED_PREFIXES.some(p =>
        path === p.replace(/\/$/, "") || path.startsWith(p)
      );
      if (isProjectScoped) {
        const project = url.searchParams.get("project") || config.agent.active_project;
        if (project) {
          const access = canUserAccessProject(ctx.user.id, project);
          if (!access.ok) {
            return new Response(
              JSON.stringify({ error: "no access to this project", reason: access.reason }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
          }
        }
      }
    }
  }

  // ── Terminal v2 reverse proxy ───────────────────────────────────────────────
  // Forwards /terminal-v2/proxy/<sid>/... to the local ttyd instance bound to
  // 127.0.0.1. Lets the founder use the terminal from any device that can reach
  // Atelier (LAN, tunnel, phone). Sits behind the global auth gate so only
  // authenticated cookies can reach ttyd. The /ws upgrade is handled in
  // index.ts before this point — by the time we get here we only see HTTP.
  {
    const proxyResp = await handleTerminalProxyHttp(req, url);
    if (proxyResp) return proxyResp;
  }

  // ── Founder-facing docs ─────────────────────────────────────────────────────
  // GET /docs/:slug — returns the markdown of an in-product reference doc.
  // Currently serves only the project-shape primer; extend the allowlist as
  // more docs become founder-readable in-product. No path traversal: we map
  // a fixed allowlist to absolute paths.
  if (path.startsWith("/docs/") && req.method === "GET") {
    const slug = path.slice("/docs/".length);
    const allowlist: Record<string, string> = {
      "project-shape": resolve(config.atelierRoot, "docs", "PROJECT_SHAPE.md"),
    };
    const target = allowlist[slug];
    if (!target) return json({ error: "unknown doc" }, 404);
    try {
      const md = readFileSync(target, "utf-8");
      return new Response(md, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
      });
    } catch (e) {
      return json({ error: `failed to read ${slug}: ${String(e)}` }, 500);
    }
  }

  // ── Onboarding ──────────────────────────────────────────────────────────────

  if (path === "/onboarding/state" && req.method === "GET") {
    // SECURITY GATE: once any user exists in the DB, /onboarding/state is
    // strictly authenticated — an unauth'd request gets a "public" stub,
    // which the frontend treats as unconfigured and routes to Landing.
    // Without this gate, a stranger hitting the URL on the same machine /
    // tunnel reads the agent config straight out of agents/config.yaml.
    //
    // Truly fresh install (zero users) keeps the legacy fast-path so the
    // very first onboarding flow works without a cookie.
    const userCount = (getDb().query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
    const ctx = userCount > 0 ? getAuthContext(req) : null;
    if (userCount > 0 && !ctx) {
      return json({
        configured: false,
        logged_out: false,
        agent_name: null,
        founder_name: null,
        org_name: null,
        active_project: null,
        pickup_flavor: null,
        provider: null,
        previous_identity: null,
        public: true,
      });
    }

    const agentCfg = config.agent as typeof config.agent & { logged_out?: boolean };
    const hasAgentConfig = !!agentCfg.agent_name && !!agentCfg.active_project;
    const projectExists = hasAgentConfig && !!projectMeta(agentCfg.active_project);
    const loggedOut = !!agentCfg.logged_out;
    const configured = hasAgentConfig && projectExists && !loggedOut;
    const pickupFlavor = configured
      ? readLastSessionFlavor(agentCfg.active_project)
      : null;
    // If identity is present but the user logged out, surface a "previous_identity" so
    // the frontend can offer "continue as X" vs "start fresh" instead of re-onboarding.
    const previousIdentity = (hasAgentConfig && projectExists && loggedOut)
      ? {
          agent_name: agentCfg.agent_name,
          founder_name: agentCfg.founder_name || null,
          org_name: agentCfg.org_name || null,
          active_project: agentCfg.active_project,
        }
      : null;
    return json({
      configured,
      logged_out: loggedOut,
      agent_name: configured ? agentCfg.agent_name : null,
      founder_name: configured ? (agentCfg.founder_name || null) : null,
      org_name: configured ? (agentCfg.org_name || null) : null,
      active_project: configured ? agentCfg.active_project : null,
      pickup_flavor: pickupFlavor,
      provider: agentCfg.provider || "claude",
      previous_identity: previousIdentity,
    });
  }

  if (path === "/onboarding/complete" && req.method === "POST") {
    const gate = gateOnboardingWrite(req); if (gate) return gate;
    try {
      const body = (await req.json()) as {
        agent_name: string;
        founder_name: string;
        org_name: string;
        project_name: string;
        project_description: string;
        provider?: string;
      };
      if (typeof body.agent_name !== "string" || body.agent_name.trim() === "") {
        return json({ error: "agent_name is required" }, 400);
      }
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      current.agent_name = body.agent_name.trim();
      current.founder_name = body.founder_name;
      current.org_name = body.org_name;
      current.active_project = body.project_name;
      if (body.provider) current.provider = body.provider;
      current.logged_out = false;  // completing onboarding clears any stale logout flag
      // Reflection default: write it explicitly at onboarding so the background
      // worker and the Settings UI agree from day one. Without a value the
      // worker fell back to "manual" (memory only accrued if the founder hit
      // end-session every time) while the UI advertised reflect as auto —
      // QA 2026-07-17 finding 15. "semi-auto" reflects substantive sessions
      // (>= token threshold) and skips trivial ones, bounding token spend.
      if (current.reflection_mode === undefined) current.reflection_mode = "semi-auto";
      writeFileSync(configPath, YAML.stringify(current));
      let created = false;
      if (!projectMeta(body.project_name)) {
        scaffoldProject(body.project_name, body.project_description);
        created = true;
      }

      // Mirror onboarding output into SQL so multi-tenant ACL checks
      // (canUserAccessProject) succeed for canvas/sessions/brain endpoints.
      // Resolve the calling user — either the authed user, or the lone
      // bootstrap user when this is the very first onboarding pass on a
      // fresh box (gateOnboardingWrite allowed it through with userCount<=1).
      const ctx = getAuthContext(req);
      const db = getDb();
      let actingUserId: string | null = ctx?.user.id ?? null;
      if (!actingUserId) {
        const sole = db.query(`SELECT id FROM users LIMIT 2`).all() as { id: string }[];
        if (sole.length === 1) actingUserId = sole[0].id;
      }

      if (actingUserId && body.org_name && body.org_name.trim() !== "") {
        const now = nowIso();
        // Find or create org owned by this user with this name.
        let orgRow = db.query(
          `SELECT id FROM orgs WHERE owner_user_id = ? AND name = ?`
        ).get(actingUserId, body.org_name) as { id: string } | undefined;
        if (!orgRow) {
          const orgId = newId();
          db.query(
            `INSERT INTO orgs (id, name, owner_user_id, default_visibility, created_at)
             VALUES (?, ?, ?, 'all', ?)`
          ).run(orgId, body.org_name, actingUserId, now);
          orgRow = { id: orgId };
        }
        // Admin membership (UNIQUE on user/org/role — INSERT OR IGNORE).
        db.query(
          `INSERT OR IGNORE INTO memberships (id, user_id, org_id, role, created_at)
           VALUES (?, ?, ?, 'admin', ?)`
        ).run(newId(), actingUserId, orgRow.id, now);
        // Project row (UNIQUE on org_id+name — INSERT OR IGNORE).
        if (body.project_name && body.project_name.trim() !== "") {
          db.query(
            `INSERT OR IGNORE INTO projects (id, org_id, name, description, created_at, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(newId(), orgRow.id, body.project_name, body.project_description ?? null, now, actingUserId);
        }
      }

      return json({ ok: true, project_created: created });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // Soft logout — preserves identity + project data; sets a flag so /state returns
  // configured:false with previous_identity, letting the frontend offer "continue as X".
  // Aliased as both /reset (original name, kept for back-compat) and /logout (new semantic name).
  if ((path === "/onboarding/reset" || path === "/onboarding/logout") && req.method === "POST") {
    const gate = gateOnboardingWrite(req); if (gate) return gate;
    try {
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      current.logged_out = true;
      writeFileSync(configPath, YAML.stringify(current));
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // Resume a soft-logged-out identity — just clears the logout flag.
  if (path === "/onboarding/resume" && req.method === "POST") {
    const gate = gateOnboardingWrite(req); if (gate) return gate;
    try {
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      if (!current.agent_name || !current.active_project) {
        return json({ error: "no previous identity to resume" }, 404);
      }
      if (!projectMeta(current.active_project)) {
        return json({ error: "previous active project no longer exists" }, 404);
      }
      current.logged_out = false;
      writeFileSync(configPath, YAML.stringify(current));
      return json({
        ok: true,
        agent_name: current.agent_name,
        founder_name: current.founder_name || null,
        org_name: current.org_name || null,
        active_project: current.active_project,
      });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // Hard wipe — clears identity completely. Use when user wants a truly fresh start.
  // On-disk project data is NOT deleted; only the agent config is cleared.
  if (path === "/onboarding/wipe" && req.method === "POST") {
    const gate = gateOnboardingWrite(req); if (gate) return gate;
    try {
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      current.agent_name = "";
      current.founder_name = "";
      current.org_name = "";
      current.active_project = "";
      current.logged_out = false;
      writeFileSync(configPath, YAML.stringify(current));
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // Rename organization.
  if (path === "/org" && req.method === "PATCH") {
    try {
      const body = (await req.json()) as { name: string };
      const name = (body.name ?? "").trim();
      if (!name) return json({ error: "name required" }, 400);
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      current.org_name = name;
      writeFileSync(configPath, YAML.stringify(current));
      return json({ ok: true, org_name: name });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // ── Projects list / create / switch ──────────────────────────────────────────

  if (path === "/projects" && req.method === "GET") {
    try {
      const entries = readdirSync(config.projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith("."))
        .map(d => d.name)
        .filter(name => !!projectMeta(name));
      const projects = entries.map(name => {
        const meta = projectMeta(name) as { description?: string; created_at?: string } | null;
        return {
          name,
          description: meta?.description ?? "",
          created_at: meta?.created_at ?? null,
          active: name === config.agent.active_project,
        };
      });
      return json({ projects, active: config.agent.active_project || null });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path === "/projects" && req.method === "POST") {
    try {
      const body = (await req.json()) as { name: string; description?: string; make_active?: boolean };
      const name = (body.name ?? "").trim();
      if (!name) return json({ error: "name required" }, 400);
      if (!/^[A-Za-z0-9 _-]+$/.test(name)) return json({ error: "name must be alphanumeric/dash/underscore/space" }, 400);

      // Resolve org for the new project. Prefer the authed user's first
      // org (admin or any membership). Fallback: oldest user's first org —
      // the same heuristic backfillProjectsFromDisk uses.
      const ctx = _getAuthCtx(req);
      const db = getDb();
      let orgId: string | null = null;
      let createdByUserId: string | null = null;
      if (ctx?.user.id) {
        const row = db.query(
          `SELECT org_id FROM memberships WHERE user_id = ? ORDER BY rowid ASC LIMIT 1`
        ).get(ctx.user.id) as { org_id: string } | undefined;
        if (row) { orgId = row.org_id; createdByUserId = ctx.user.id; }
      }
      if (!orgId) {
        const fallback = db.query(
          `SELECT u.id AS uid, m.org_id AS oid
             FROM users u
             JOIN memberships m ON m.user_id = u.id
            ORDER BY u.created_at ASC LIMIT 1`
        ).get() as { uid: string; oid: string } | undefined;
        if (fallback) { orgId = fallback.oid; createdByUserId = fallback.uid; }
      }

      let created = false;
      if (!projectMeta(name)) {
        scaffoldProject(name, (body.description ?? "").trim());
        created = true;
      }

      // Insert DB row so the access gate (requireProjectAccess) lets the
      // creator read the canvas. Without this row the project exists on
      // disk but every API call fails 403 "project not found".
      // UNIQUE(org_id, name) makes this idempotent on retry.
      if (orgId) {
        const exists = db.query(
          `SELECT id FROM projects WHERE org_id = ? AND name = ?`
        ).get(orgId, name);
        if (!exists) {
          db.query(
            `INSERT INTO projects (id, org_id, name, display_name, description,
                                    created_at, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(newId(), orgId, name, name, (body.description ?? "").trim() || null, nowIso(), createdByUserId);
        }
      } else {
        console.warn(`[/projects POST] no org found for project '${name}' — DB row skipped, access will fail`);
      }

      let active_project: string | null = config.agent.active_project || null;
      if (body.make_active !== false) {
        const configPath = resolve(config.agentsDir, "config.yaml");
        const current = YAML.parse(readFileSync(configPath, "utf-8"));
        current.active_project = name;
        writeFileSync(configPath, YAML.stringify(current));
        active_project = name;
      }
      return json({ ok: true, created, name, active_project });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  if (path === "/projects/switch" && req.method === "POST") {
    try {
      const body = (await req.json()) as { name: string };
      const name = (body.name ?? "").trim();
      if (!name) return json({ error: "name required" }, 400);
      if (!projectMeta(name)) return json({ error: "unknown project" }, 404);
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8"));
      current.active_project = name;
      writeFileSync(configPath, YAML.stringify(current));
      return json({ ok: true, active_project: name });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // ── Ripple — co-change query (Session 5, TODO #30) ───────────────────────────
  // GET /ripple?file=<path>&depth=<1..3>&limit=<N>
  // Workspace-level (not project-scoped). Cheap, cacheable. Returns the same
  // shape as the omnigraph_ripple MCP tool but as raw JSON for callers like
  // the frontend node drawer.
  if (path === "/ripple" && req.method === "GET") {
    const file = url.searchParams.get("file") ?? "";
    const depth = Math.max(1, Math.min(3, Number(url.searchParams.get("depth") ?? "1")));
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? "12")));
    if (!file) return json({ error: "missing ?file=<path>" }, 400);
    try {
      const { computeRipple } = await import("~/ripple/ripple");
      const r = await computeRipple(file, depth, config.atelierRoot, { limit });
      return json(r);
    } catch (e) {
      return json({ error: "ripple failed", reason: String(e).slice(0, 400) }, 500);
    }
  }

  // ── Canvas graph ─────────────────────────────────────────────────────────────

  if (path === "/canvas/graph" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      return json(getGraph(project));
    } catch (e) {
      return json({ nodes: [], edges: [], error: String(e) });
    }
  }

  // ── Canvas event firehose + per-node comments + per-node event timeline ────
  // Placed BEFORE the catch-all /canvas/node/:id below because they share the
  // same prefix and the next block's id-extractor is naive.

  // GET /canvas/events?project=&since=<id>&limit=<N> — Activity-tab firehose.
  if (path === "/canvas/events" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500);
    try {
      const rows = getDb().query(
        `SELECT id, project, node_id, ts, agent, kind, payload
         FROM canvas_node_events
         WHERE project = ? AND id > ?
         ORDER BY id DESC
         LIMIT ?`,
      ).all(project, since, limit) as Array<{ id: number; project: string; node_id: string; ts: string; agent: string; kind: string; payload: string | null }>;
      const events = rows.map(r => ({
        id: r.id, project: r.project, node_id: r.node_id, ts: r.ts,
        agent: r.agent, kind: r.kind,
        payload: r.payload ? JSON.parse(r.payload) : null,
      }));
      return json({ events });
    } catch (e) {
      return json({ events: [], error: String(e) }, 500);
    }
  }

  // GET /canvas/node/:id/events?project=&limit=<N>
  const _nodeEventsMatch = path.match(/^\/canvas\/node\/([^/]+)\/events$/);
  if (_nodeEventsMatch && req.method === "GET") {
    const id = _nodeEventsMatch[1];
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
    try {
      const rows = getDb().query(
        `SELECT id, ts, agent, kind, payload
         FROM canvas_node_events
         WHERE project = ? AND node_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      ).all(project, id, limit) as Array<{ id: number; ts: string; agent: string; kind: string; payload: string | null }>;
      const events = rows.map(r => ({
        id: r.id, ts: r.ts, agent: r.agent, kind: r.kind,
        payload: r.payload ? JSON.parse(r.payload) : null,
      }));
      return json({ events });
    } catch (e) {
      return json({ events: [], error: String(e) }, 500);
    }
  }

  // ── Verifier-constraints flywheel (A2) ───────────────────────────────────
  // GET /verifier-constraints?project= — pending constraints (acknowledged=false,
  // rejected!=true). Returned grouped by agent_role on the client; backend
  // returns flat rows with role on each so filtering stays simple.
  if (path === "/verifier-constraints" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      const rows = getDb().query(
        `SELECT id, project, node_id, ts, agent, payload
         FROM canvas_node_events
         WHERE project = ? AND kind = 'verifier_unverified'
         ORDER BY id DESC
         LIMIT 500`,
      ).all(project) as Array<{ id: number; project: string; node_id: string; ts: string; agent: string; payload: string | null }>;
      const constraints = rows
        .map((r) => {
          let p: { axiom?: string; evidence?: string; suggested_constraint?: string; edited_constraint?: string; acknowledged?: boolean; rejected?: boolean } = {};
          try { p = r.payload ? JSON.parse(r.payload) : {}; } catch { p = {}; }
          return {
            event_id: r.id,
            project: r.project,
            node_id: r.node_id,
            ts: r.ts,
            agent_role: r.agent,
            axiom: p.axiom ?? "",
            evidence: p.evidence ?? "",
            suggested_constraint: p.edited_constraint ?? p.suggested_constraint ?? "",
            acknowledged: p.acknowledged === true,
            rejected: p.rejected === true,
          };
        })
        .filter((c) => !c.acknowledged && !c.rejected);
      return json({ constraints });
    } catch (e) {
      return json({ constraints: [], error: String(e) }, 500);
    }
  }

  // POST /verifier-constraints/:event_id/accept   { edited_constraint?: string }
  // POST /verifier-constraints/:event_id/reject
  const _vcMatch = path.match(/^\/verifier-constraints\/(\d+)\/(accept|reject)$/);
  if (_vcMatch && req.method === "POST") {
    const eventId = Number(_vcMatch[1]);
    const action = _vcMatch[2] as "accept" | "reject";
    try {
      const row = getDb().query(
        `SELECT id, payload FROM canvas_node_events WHERE id = ? AND kind = 'verifier_unverified'`,
      ).get(eventId) as { id: number; payload: string | null } | undefined;
      if (!row) return json({ error: "not found" }, 404);
      let payload: Record<string, unknown> = {};
      try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch { payload = {}; }
      if (action === "accept") {
        let edited: string | undefined;
        try {
          const body = (await req.json()) as { edited_constraint?: string };
          edited = (body?.edited_constraint ?? "").trim() || undefined;
        } catch { /* no body is fine */ }
        payload.acknowledged = true;
        payload.rejected = false;
        if (edited) payload.edited_constraint = edited;
        payload.decided_at = nowIso();
      } else {
        payload.acknowledged = false;
        payload.rejected = true;
        payload.decided_at = nowIso();
      }
      getDb().query(
        `UPDATE canvas_node_events SET payload = ? WHERE id = ?`,
      ).run(JSON.stringify(payload), eventId);
      return json({ ok: true, event_id: eventId, action });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // GET/POST /canvas/node/:id/comments?project=
  const _commentsMatch = path.match(/^\/canvas\/node\/([^/]+)\/comments$/);
  if (_commentsMatch) {
    const id = _commentsMatch[1];
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    if (req.method === "GET") {
      try {
        const rows = getDb().query(
          `SELECT id, author_user_id, author_role, body, created_at
           FROM canvas_node_comments
           WHERE project = ? AND node_id = ?
           ORDER BY id ASC`,
        ).all(project, id);
        return json({ comments: rows });
      } catch (e) {
        return json({ comments: [], error: String(e) }, 500);
      }
    }
    if (req.method === "POST") {
      try {
        const body = (await req.json()) as { body?: string; author_user_id?: string; author_role?: string };
        const text = (body.body ?? "").trim();
        if (!text) return json({ error: "comment body required" }, 400);
        const role = body.author_role ?? "founder";
        const now = nowIso();
        getDb().query(
          `INSERT INTO canvas_node_comments (project, node_id, author_user_id, author_role, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(project, id, body.author_user_id ?? null, role, text, now);
        // Mirror as a canvas_node_event so the Activity firehose sees it too.
        try {
          getDb().query(
            `INSERT INTO canvas_node_events (project, node_id, ts, agent, kind, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(project, id, now, role, "comment", JSON.stringify({ body: text }), now);
        } catch { /* best-effort mirror */ }
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }
  }

  // ── Canvas node CRUD ─────────────────────────────────────────────────────────

  if (path.startsWith("/canvas/node/")) {
    const id = path.slice("/canvas/node/".length);
    const project = url.searchParams.get("project") ?? config.agent.active_project;

    if (req.method === "GET") {
      if (!id) return json({ error: "missing node id" }, 400);
      const nodeDir = resolve(config.projectsDir, project, "canvas/nodes", id);
      const metaPath = resolve(nodeDir, "meta.json");
      if (!existsSync(metaPath)) return json({ error: "node not found", id }, 404);
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const planPath = resolve(nodeDir, "plan.md");
        const plan = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
        const discussionsDir = resolve(nodeDir, "discussions");
        let discussions: Array<{ file: string; entries: unknown[] }> | undefined;
        if (existsSync(discussionsDir)) {
          const files = readdirSync(discussionsDir).filter(f => f.endsWith(".jsonl"));
          if (files.length) {
            discussions = files.map(f => {
              const raw = readFileSync(resolve(discussionsDir, f), "utf-8");
              const entries = raw.split(/\r?\n/).filter(Boolean).map(l => {
                try { return JSON.parse(l); } catch { return { raw: l }; }
              });
              return { file: f, entries };
            });
          }
        }
        return json({ meta, plan, discussions });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (req.method === "PATCH") {
      if (!id) return json({ error: "missing node id" }, 400);
      try {
        const body = (await req.json()) as {
          title?: string;
          intent?: string;
          state?: NodeState;
          badge?: NodeBadge;
          confidence?: "high" | "medium" | "low";
          priority?: "P0-now" | "P1-soon" | "P2-later" | "P3-backlog";
          cycle?: string | null;
          outcome?: string | null;
          target_date?: string | null;
          plan?: string;
          // 6-altitude metadata edits — applied per-kind in updateNodeMeta
          layer?: "infra" | "middle" | "application" | null;
          plane_kind?: "frontend" | "backend" | "data" | "integration" | "cross-cutting" | null;
          parent_plane_id?: string | null;
          manifest_globs?: string[];
          surface_kind?: string | null;
          surface_status?: "proposed" | "active" | "deprecated" | null;
          touches?: string[];
          lock_id?: string | null;
          priority_score?: number | null;
          supersedes?: string | null;
          // Optional founder-supplied summary attached to the cascade discussion entry
          // when a Surface is being edited. Useful for "renamed because we split it" notes.
          cascade_summary?: string;
          // Consultation kind only (Session 4 — Pillar B). Six fields mirrored
          // from meta.json. When `answer` transitions null → non-null, the
          // route fires a ripple: writes a brain artifact, posts a comment,
          // records a `consultation_answered` event.
          expert_role?: string | null;
          channel?: string | null;
          question?: string | null;
          answer?: string | null;
          deadline?: string | null;
        };
        const { plan, cascade_summary, ...metaUpdates } = body;
        // Capture pre-update state so we can record the transition for the
        // per-node drawer timeline (decisions §4 — events table).
        // Also snapshot the prior `answer` field so we can detect the
        // null→non-null transition that fires the Consultation ripple
        // (Session 4 — Pillar B).
        let priorMeta: NodeMeta | null = null;
        try { priorMeta = getNode(project, id); } catch { priorMeta = null; }
        const fromState: NodeState | null = metaUpdates.state !== undefined
          ? (priorMeta?.state ?? null)
          : null;
        const priorAnswer = priorMeta?.kind === "Consultation"
          ? (priorMeta.answer ?? null)
          : null;

        // Auto-stamp answered_at when this PATCH transitions answer null → non-null.
        // Idempotent: we don't overwrite an existing answered_at.
        const answerJustFilled =
          priorMeta?.kind === "Consultation" &&
          metaUpdates.answer !== undefined &&
          (priorAnswer === null || priorAnswer === "") &&
          typeof metaUpdates.answer === "string" &&
          metaUpdates.answer.trim().length > 0;
        const stampedAnsweredAt = answerJustFilled && !priorMeta?.answered_at
          ? new Date().toISOString()
          : undefined;

        let meta = updateNodeMeta(project, id, {
          ...metaUpdates,
          ...(stampedAnsweredAt ? { answered_at: stampedAnsweredAt } : {}),
          _cascade_summary: cascade_summary,
        });
        if (plan !== undefined) meta = updateNodePlan(project, id, plan);
        if (metaUpdates.state !== undefined && fromState !== null && fromState !== meta.state) {
          recordNodeEvent(project, id, "founder", "state", {
            from: fromState,
            to: meta.state,
            summary: `state · ${fromState} → ${meta.state}`,
          });
        }

        // Consultation answer ripple. When the founder pastes the off-platform
        // expert's answer, persist it to the brain so dependent nodes see it
        // at next session boot. No new compiler — the brain dir is already
        // read by the OG → composed-prompt pipeline.
        if (answerJustFilled && meta.kind === "Consultation") {
          try {
            const brainDir = resolve(
              config.atelierRoot,
              "og_artifacts/brain/projects",
              project,
              "consultations",
            );
            mkdirSync(brainDir, { recursive: true });
            const brainPath = resolve(brainDir, `${meta.id}.md`);
            const expertRole = meta.expert_role ?? "(unspecified expert)";
            const channel = meta.channel ?? "(unspecified channel)";
            const questionText = meta.question ?? meta.intent ?? "";
            const answerText = meta.answer ?? "";
            const headerLine = `${expertRole}: ${(questionText || "").slice(0, 60)}`;
            const md = [
              `# ${headerLine}`,
              ``,
              `**Asked:** ${meta.created_at}`,
              `**Channel:** ${channel}`,
              `**Answered:** ${meta.answered_at ?? new Date().toISOString()}`,
              ``,
              `## Question`,
              questionText,
              ``,
              `## Answer`,
              answerText,
              ``,
            ].join("\n");
            writeFileSync(brainPath, md, "utf-8");
            postAgentComment(
              project,
              meta.id,
              "system",
              `answer recorded — written to brain at consultations/${meta.id}.md.`,
            );
            recordNodeEvent(project, meta.id, "founder", "consultation_answered", {
              expert_role: expertRole,
              channel,
              brain_path: `og_artifacts/brain/projects/${project}/consultations/${meta.id}.md`,
              summary: `consultation answered · ${expertRole} via ${channel}`,
            });
          } catch (e) {
            // Ripple is best-effort; the answer is still persisted in meta.
            console.warn(`[consultation-ripple] failed for ${id}: ${String(e).slice(0, 200)}`);
          }
        }

        // Coherence lint: if the state moved into the run pipeline (approved
        // or review), or the plan body changed, surface any cross-artifact
        // violations now so the founder sees them at draft-emission time
        // rather than waiting for the run to fail-fast on the gate. This is
        // a soft signal — the state change still applies, but the response
        // carries `coherence_warnings` so the UI can flag the node.
        const triggersLint = metaUpdates.state === "approved" || metaUpdates.state === "review" || plan !== undefined;
        let coherence_warnings: ReturnType<typeof violationsFor> | undefined;
        if (triggersLint) {
          try { coherence_warnings = violationsFor(project, id); } catch { /* non-fatal */ }
        }
        return json(coherence_warnings && coherence_warnings.length > 0
          ? { ...meta, coherence_warnings }
          : meta);
      } catch (e) {
        const msg = String(e);
        // Convergence-rule violations are 409 (conflict, founder/agent action required) rather
        // than 400 (malformed request). Frontend uses the status to render a "blocked by altitude
        // rule" toast vs a generic error.
        const isConvergence = /touches|Surface|Plane|layer|altitude/i.test(msg);
        return json({ error: msg }, isConvergence ? 409 : 400);
      }
    }

    if (req.method === "DELETE") {
      if (!id) return json({ error: "missing node id" }, 400);
      try {
        const result = deleteNode(project, id);
        return json({ ok: true, ...result });
      } catch (e) {
        return json({ error: String(e) }, 400);
      }
    }
  }

  if (path === "/canvas/node" && req.method === "POST") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      const body = (await req.json()) as {
        kind: NodeKind;
        title: string;
        intent: string;
        parent_id?: string;
        dependencies?: string[];
        confidence?: "high" | "medium" | "low";
        priority?: "P0-now" | "P1-soon" | "P2-later" | "P3-backlog";
        cycle?: string | null;
        outcome?: string | null;
        target_date?: string | null;
        layer?: "infra" | "middle" | "application" | null;
        plane_kind?: "frontend" | "backend" | "data" | "integration" | "cross-cutting" | null;
        parent_plane_id?: string | null;
        manifest_globs?: string[];
        surface_kind?: string | null;
        surface_status?: "proposed" | "active" | "deprecated" | null;
        touches?: string[];
        lock_id?: string | null;
        priority_score?: number | null;
        supersedes?: string | null;
      };
      if (!body.intent?.trim()) return json({ error: "intent required" }, 400);
      if (!body.title?.trim()) return json({ error: "title required (2 words max)" }, 400);
      const meta = proposeNode({
        project,
        kind: body.kind ?? "Task",
        title: body.title.trim(),
        intent: body.intent.trim(),
        parent_id: body.parent_id ?? null,
        dependencies: body.dependencies ?? [],
        confidence: body.confidence ?? "medium",
        priority: body.priority,
        cycle: body.cycle ?? null,
        outcome: body.outcome ?? null,
        target_date: body.target_date ?? null,
        layer: body.layer ?? null,
        plane_kind: body.plane_kind ?? null,
        parent_plane_id: body.parent_plane_id ?? null,
        manifest_globs: body.manifest_globs,
        surface_kind: body.surface_kind ?? null,
        surface_status: body.surface_status ?? null,
        touches: body.touches,
        lock_id: body.lock_id ?? null,
        priority_score: body.priority_score ?? null,
        supersedes: body.supersedes ?? null,
      });
      return json(meta);
    } catch (e) {
      const msg = String(e);
      const isConvergence = /touches|Surface|Plane|layer|altitude/i.test(msg);
      return json({ error: msg }, isConvergence ? 409 : 400);
    }
  }

  if (path === "/canvas/edge" && req.method === "POST") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      const body = (await req.json()) as { from: string; to: string; kind?: string };
      if (!body.from || !body.to) return json({ error: "from and to required" }, 400);
      proposeEdge(project, {
        from: body.from,
        to: body.to,
        kind: (body.kind as any) ?? "depends-on",
      });
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // ── Domain brain ─────────────────────────────────────────────────────────────

  if (path === "/domain-brain" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const brainDir = resolve(config.projectsDir, project, "domain_brain");
    if (!existsSync(brainDir)) return json({ files: [] });
    try {
      const files = readdirSync(brainDir)
        .filter(f => [".md", ".txt", ".json"].includes(extname(f)))
        .map(f => {
          const content = readFileSync(resolve(brainDir, f), "utf-8");
          return { name: basename(f, extname(f)), filename: f, content };
        });
      return json({ files });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── Brain v2 — 3-layer inspection + boot-prompt preview ──────────────────────
  // The contract is "do not mix layers" (omnigraph/docs/ATELIER_OUTPUTS.md).
  // /brain returns each layer as a separate document with its own attribution;
  // /brain/preview returns the merged text exactly as injected at session boot
  // so the founder can see what the agent actually receives.

  if (path === "/brain" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    const userId = ctx?.user.id ?? "default";
    const project = url.searchParams.get("project") ?? config.agent.active_project ?? null;
    try {
      return json(inspectOmnigraphBrain(userId, project));
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path === "/brain/preview" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    const userId = ctx?.user.id ?? "default";
    const project = url.searchParams.get("project") ?? config.agent.active_project ?? null;
    try {
      const flags = brainLayerFlagsFromEnv();
      const merged = loadOmnigraphBrain(userId, project, flags);
      if (!merged) {
        return json({
          markdown: null,
          bytes: 0,
          layersLoaded: { global: false, personal: false, project: null },
          injectFlags: flags,
        });
      }
      return json({
        markdown: merged.markdown,
        bytes: merged.bytes,
        layersLoaded: merged.layersLoaded,
        injectFlags: flags,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path === "/omnigraph/status" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    const userId = ctx?.user.id ?? "default";
    try {
      return json(omnigraphStatus(userId));
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path.startsWith("/agent-constraints/") && req.method === "GET") {
    const role = path.slice("/agent-constraints/".length);
    if (!role) return json({ error: "missing role" }, 400);
    try {
      return json(readAgentConstraints(role));
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── Session ───────────────────────────────────────────────────────────────────

  // ── Sessions (Reflect view) ──────────────────────────────────────────────────

  if (path === "/sessions" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    return json({ sessions: await listProjectSessions(project) });
  }

  if (path.startsWith("/sessions/") && path.endsWith("/reflect") && req.method === "POST") {
    const id = path.slice("/sessions/".length, -"/reflect".length);
    if (!id) return json({ error: "missing sessionId" }, 400);
    try {
      const result = await reflectSession({ sessionId: id });
      // Reflection ends the session — tear down any v2 ttyd subprocess that
      // was attached so it doesn't outlive the conversation.
      try { stopTerminalV2(id); } catch { /* best-effort */ }
      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path.startsWith("/sessions/") && path.endsWith("/artifact") && req.method === "PATCH") {
    const id = path.slice("/sessions/".length, -"/artifact".length);
    if (!id) return json({ error: "missing sessionId" }, 400);
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const artifactPath = await getSessionArtifactPath(project, id);
    if (!artifactPath) return json({ error: "no artifact bound to this session" }, 404);
    try {
      const body = (await req.json()) as { content: string };
      if (typeof body?.content !== "string") return json({ error: "content must be a string" }, 400);
      // Preserve the session-id comment at the top of the file so the greedy matcher
      // keeps binding this artifact to the right session after an edit.
      const existing = readFileSync(artifactPath, "utf-8");
      const header = existing.split("\n")[0];
      const preserveHeader = /atelier:session-id/.test(header) ? header + "\n" : "";
      writeFileSync(artifactPath, preserveHeader + body.content, "utf-8");
      return json({ ok: true, path: artifactPath });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path.startsWith("/sessions/") && path.endsWith("/artifact") && req.method === "DELETE") {
    const id = path.slice("/sessions/".length, -"/artifact".length);
    if (!id) return json({ error: "missing sessionId" }, 400);
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const artifactPath = await getSessionArtifactPath(project, id);
    if (!artifactPath) return json({ error: "no artifact bound to this session" }, 404);
    try {
      unlinkSync(artifactPath);
      return json({ ok: true, path: artifactPath });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path.startsWith("/sessions/") && req.method === "GET") {
    const id = path.slice("/sessions/".length);
    if (!id) return json({ error: "missing sessionId" }, 400);
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const entry = await getSessionEntry(project, id);
    if (!entry) return json({ error: "not found" }, 404);
    // Prefer the provider's structured JSONL. If it doesn't exist (legacy session
    // where Claude Code didn't persist for that machine), fall back to rebuilding
    // user-side turns from raw.log. Assistant side can't be cleanly recovered —
    // the UI flags that path with a "user side only" notice.
    const projectCwd = resolve(config.projectsDir, project);
    const conv = await readSessionConversation(id, projectCwd, entry.provider ?? "claude");
    const structured = !!conv;
    const turns = conv?.turns ?? reconstructUserTurnsFromRawLog(id);
    return json({
      entry,
      artifact: await getSessionArtifact(project, id),
      rawExcerpt: getSessionRawExcerpt(id, 200),
      turns,
      toolCalls: conv?.toolCalls ?? [],
      turnSource: structured ? "provider" : turns.length > 0 ? "raw-log-reconstruction" : "none",
    });
  }

  if (path === "/sessions/continue" && req.method === "POST") {
    try {
      const body = (await req.json()) as { project?: string; sessionIds: string[]; mode: ContinueMode };
      const project = body.project ?? config.agent.active_project;
      if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
        return json({ error: "sessionIds must be a non-empty array" }, 400);
      }
      if (body.sessionIds.length > 5) {
        return json({ error: "max 5 sessions may be pooled" }, 400);
      }
      if (body.mode !== "summarize" && body.mode !== "resume") {
        return json({ error: "mode must be 'summarize' or 'resume'" }, 400);
      }
      const result = await continueSessions({ project, sessionIds: body.sessionIds, mode: body.mode });
      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── World watchers (Phase C minimal) ─────────────────────────────────────────

  if (path === "/world/watchers" && req.method === "GET") {
    return json({ watchers: listWatchers() });
  }

  if (path === "/world/events" && req.method === "GET") {
    const days = Number(url.searchParams.get("days") ?? 7);
    return json({ events: listRecentEvents(days) });
  }

  if (path === "/world/event" && req.method === "POST") {
    try {
      const body = (await req.json()) as Parameters<typeof writeEvent>[0];
      if (!body?.title || !body?.body || !body?.source || !body?.watcher) {
        return json({ error: "title, body, source, watcher are required" }, 400);
      }
      return json(writeEvent(body));
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // ── Legacy reflect endpoint (kept for compat) ────────────────────────────────

  if (path === "/session/reflect" && req.method === "POST") {
    try {
      const body = (await req.json()) as { sessionId: string };
      if (!body?.sessionId) return json({ error: "missing sessionId" }, 400);
      const result = await reflectSession({ sessionId: body.sessionId });
      // Reflection ends the session — tear down any v2 ttyd subprocess that
      // was attached so it doesn't outlive the conversation.
      try { stopTerminalV2(body.sessionId); } catch { /* best-effort */ }
      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (path === "/ingest/usage" && req.method === "POST") {
    try {
      const body = await req.json();
      const outPath = resolve(config.dataDir, "usage.jsonl");
      const { appendFileSync } = await import("node:fs");
      appendFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), ...(body as object) }) + "\n");
      return json({ received: true });
    } catch {
      return json({ error: "invalid json" }, 400);
    }
  }

  // ── Implementer: drafter→shipped journey trigger ─────────────────────────────
  // POST /implementer/run  body: { project?: string, nodeId: string, userId?: string }
  if (path === "/implementer/run" && req.method === "POST") {
    try {
      const body = (await req.json()) as { project?: string; nodeId?: string; userId?: string; timeoutMs?: number };
      const project = body.project ?? config.agent.active_project;
      if (!project) return json({ error: "no active project; pass `project`" }, 400);
      if (!body.nodeId) return json({ error: "missing nodeId" }, 400);

      // Project / Plane / Surface / Decision / Risk / Research / Milestone
      // are framing nodes — they hold context, not work. Only Task and
      // Subtask are runnable. Reject up front with a clear message so
      // founders / scripts that aim Implementer at a brief get a real
      // explanation instead of a spawned-then-blocked run.
      try {
        const meta = (await import("~/project/canvas")).getNode(project, body.nodeId);
        const RUNNABLE = new Set(["Task", "Subtask"]);
        if (!RUNNABLE.has(meta.kind)) {
          return json({
            error: `${meta.kind} is not runnable`,
            reason: meta.kind === "Project"
              ? "Project nodes are a brief view — context for the work, not a unit of work. Implementer only runs Tasks and Subtasks. Open the Project node to read/edit its brief; pick a Task on the canvas to run."
              : `${meta.kind} nodes are framing/structural; only Task and Subtask are runnable. Pick a Task that touches this ${meta.kind}.`,
            kind: meta.kind,
            nodeId: body.nodeId,
          }, 400);
        }
      } catch (e) {
        // getNode throws "node X not found" — let runImplementerOnce report it.
        // Don't preempt; fall through.
        void e;
      }

      const result = await runImplementerOnce({
        project,
        nodeId: body.nodeId,
        userId: body.userId,
        timeoutMs: body.timeoutMs,
      });
      return json(result);
    } catch (e) {
      return json({ error: String(e).slice(0, 1000) }, 500);
    }
  }

  // GET /implementer/queue?project=<P>
  // Returns the 6-criterion-ranked list of approved Tasks/Subtasks. Auto-poller
  // (when it ships) takes the head; founder UI renders the list with the
  // per-criterion "explanation" so they can see *why* a Task is ahead of
  // another. Empty list = nothing to run; that's normal between sessions.
  if (path === "/implementer/queue" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      const ranked = rankReadyTasks(project);
      // Trim meta to the fields the founder UI actually needs — the full meta
      // includes plan classification + 6-altitude metadata that bloats the
      // response when the queue holds 50 Tasks.
      const slim = ranked.map((r) => ({
        id: r.meta.id,
        title: r.meta.title,
        kind: r.meta.kind,
        state: r.meta.state,
        parent_id: r.meta.parent_id,
        touches: r.meta.touches ?? [],
        priority_score: r.reasons.priority_score,
        lock_id: r.reasons.lock_id,
        topo_ready: r.reasons.topo_ready,
        surface_heat: r.reasons.surface_heat === Number.MAX_SAFE_INTEGER ? null : r.reasons.surface_heat,
        artifact_count: r.reasons.artifact_count,
        author_age_days: Math.floor(r.reasons.author_age_ms / (24 * 60 * 60 * 1000)),
        score: r.score,
        explanation: r.explanation,
        coherence_blocked: r.coherenceBlocked,
      }));
      return json({ project, queue: slim });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // GET /implementer/derivation?project=<P>&node=<id> — preview the
  // derivation context the worker would inject for this node.
  if (path === "/implementer/derivation" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const nodeId = url.searchParams.get("node");
    if (!nodeId) return json({ error: "node param required" }, 400);
    try {
      const { buildDerivation } = await import("~/implementer/derivation");
      return json({ project, nodeId, derivation: buildDerivation(project, nodeId) });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // GET /implementer/guardians?project=<P>&node=<id> — scan a node's plan
  // against project guardians. Returns blocking + warning violations.
  if (path === "/implementer/guardians" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    const nodeId = url.searchParams.get("node");
    if (!nodeId) return json({ error: "node param required" }, 400);
    try {
      const planPath = resolve(config.projectsDir, project, "canvas", "nodes", nodeId, "plan.md");
      if (!existsSync(planPath)) return json({ error: `plan.md not found for ${nodeId}` }, 404);
      const plan = readFileSync(planPath, "utf-8");
      const planned = (await import("~/implementer/worker")).extractPlannedArtifacts(plan);
      return json(scanGuardians(project, plan, planned));
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // GET /implementer/coherence?project=<P> — list cross-artifact violations.
  if (path === "/implementer/coherence" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? config.agent.active_project;
    try {
      const violations = checkCoherence(project);
      return json({ project, violations, count: violations.length });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // GET /implementer/auto-poller — current settings + running flag.
  if (path === "/implementer/auto-poller" && req.method === "GET") {
    return json(getAutoPollerStatus());
  }

  // POST /implementer/auto-poller  body: { enabled?: boolean, dry_run?: boolean, interval_ms?: number }
  // Rewrites agents/config.yaml under the `implementer` key. The poller re-reads
  // the file every tick, so changes apply within one interval — no restart.
  if (path === "/implementer/auto-poller" && req.method === "POST") {
    try {
      const body = (await req.json()) as { enabled?: boolean; dry_run?: boolean; interval_ms?: number };
      const configPath = resolve(config.agentsDir, "config.yaml");
      const current = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const impl = (current.implementer && typeof current.implementer === "object")
        ? current.implementer as Record<string, unknown>
        : {};
      if (typeof body.enabled === "boolean") impl.auto_run = body.enabled;
      if (typeof body.dry_run === "boolean") impl.dry_run = body.dry_run;
      if (typeof body.interval_ms === "number" && body.interval_ms >= 10_000) impl.interval_ms = body.interval_ms;
      current.implementer = impl;
      writeFileSync(configPath, YAML.stringify(current));
      return json({ ok: true, ...getAutoPollerStatus() });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // POST /implementer/auto-poller/tick — fire one tick now (the Work-tab
  // "Nudge implementer" button). Honors auto_run/dry_run; only skips the
  // 30s wait, never the kill switch.
  if (path === "/implementer/auto-poller/tick" && req.method === "POST") {
    try {
      const result = await nudgeImplementerAutoPoller();
      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // POST /drafter/auto-poller/tick — fire one Drafter background pass now.
  // Walks blocked nodes with allocator hand_back comments and either auto-
  // fixes (e.g. inherit "## Who benefits" from parent Story) or marks for
  // discussion. Returns the action count so callers can show "fixed N nodes".
  if (path === "/drafter/auto-poller/tick" && req.method === "POST") {
    try {
      const result = await tickDrafterAutoPoller();
      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── Researcher: Pillar A world-grounding ────────────────────────────────────
  // POST /research/run  body: { project?: string, nodeId: string, question: string }
  // Founder invokes this from a Decision / Risk / Research node drawer; the
  // Canvas-side button posts here and waits for a research note. Path is
  // gated by the project-scoped auth prefix above.
  if (path === "/research/run" && req.method === "POST") {
    try {
      const body = (await req.json()) as { project?: string; nodeId?: string; question?: string };
      const project = body.project ?? config.agent.active_project;
      if (!project) return json({ error: "no active project; pass `project`" }, 400);
      if (!body.nodeId) return json({ error: "missing nodeId" }, 400);
      const question = (body.question ?? "").trim();
      if (!question) return json({ error: "missing question" }, 400);

      // Gate: Researcher only fires on framing nodes where world-grounding
      // matters. Task / Subtask / Artifact don't need it (Implementer drives
      // those); Project / Plane / Surface are too coarse. Decision / Risk /
      // Research is the founder-facing action surface today.
      const ALLOWED_KINDS = new Set(["Decision", "Risk", "Research"]);
      let nodeMeta: import("~/project/canvas").NodeMeta | null = null;
      try {
        nodeMeta = (await import("~/project/canvas")).getNode(project, body.nodeId);
      } catch (e) {
        return json({ error: `node ${body.nodeId} not found in ${project}: ${String(e)}` }, 404);
      }
      if (!ALLOWED_KINDS.has(nodeMeta.kind)) {
        return json({
          error: `${nodeMeta.kind} is not a research surface`,
          reason: `Researcher runs on Decision / Risk / Research nodes. ${nodeMeta.kind} nodes use Drafter (foreground) or Implementer (Task/Subtask).`,
          kind: nodeMeta.kind,
        }, 400);
      }

      // Run the headless researcher.
      const { runResearcher } = await import("~/agent/researcher");
      const result = await runResearcher({
        question,
        nodeContext: {
          id: nodeMeta.id,
          kind: nodeMeta.kind,
          intent: nodeMeta.intent,
          parent_id: nodeMeta.parent_id,
          surface_kind: nodeMeta.surface_kind ?? null,
          project,
        },
      });

      const { postAgentComment, recordNodeEvent } = await import("~/project/canvas-comments");

      if (result.kind === "ok") {
        // Persist the note under og_artifacts/brain/projects/<P>/research/.
        // ATELIER_OUTPUTS.md v0.4.1 allows additions under projects/.
        const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
        const filename = `${nodeMeta.id}-${ts}.md`;
        // Resolve og_artifacts: respect OMNIGRAPH_OUT_DIR like load-principle does.
        const ogOutDir = process.env.OMNIGRAPH_OUT_DIR
          ? resolve(process.env.OMNIGRAPH_OUT_DIR)
          : resolve(config.atelierRoot, "og_artifacts");
        const dir = resolve(ogOutDir, "brain", "projects", project, "research");
        try {
          mkdirSync(dir, { recursive: true });
        } catch (e) {
          return json({ error: `could not create research dir: ${String(e)}` }, 500);
        }
        const fullPath = resolve(dir, filename);
        try {
          writeFileSync(fullPath, result.markdown, "utf-8");
        } catch (e) {
          return json({ error: `could not write research note: ${String(e)}` }, 500);
        }
        const relPath = `og_artifacts/brain/projects/${project}/research/${filename}`;
        const confTag = result.confidence ? ` Confidence: ${result.confidence}.` : "";
        const webTag = result.webReachable
          ? ` Web: ${result.webSources.length} ${result.webSources.length === 1 ? "source" : "sources"} (firecrawl).`
          : " Web: firecrawl unreachable — synthesis-only.";
        const commentBody =
          `researcher (${result.provider}): wrote findings to ${relPath}.${confTag}${webTag}\n\n` +
          // Quote first ~600 chars of the note so the comment is useful even
          // before the founder opens the file.
          result.markdown.slice(0, 600) +
          (result.markdown.length > 600 ? "\n\n…(truncated; open the artifact for the full note)" : "");
        postAgentComment(project, body.nodeId, "researcher", commentBody);
        recordNodeEvent(project, body.nodeId, "researcher", "research", {
          provider: result.provider,
          path: relPath,
          confidence: result.confidence,
          question,
          web_reachable: result.webReachable,
          web_sources: result.webSources,
          summary: `Research note written (${result.confidence ?? "no-conf"}): ${question.slice(0, 80)}`,
        });
        return json({
          ok: true,
          status: "ok",
          path: relPath,
          confidence: result.confidence,
          provider: result.provider,
          web_reachable: result.webReachable,
          web_sources: result.webSources,
        });
      }

      if (result.kind === "skipped") {
        const commentBody = `researcher: skipped — ${result.reason}`;
        postAgentComment(project, body.nodeId, "researcher", commentBody);
        recordNodeEvent(project, body.nodeId, "researcher", "research", {
          status: "skipped",
          reason: result.reason,
          question,
          summary: `Research skipped: ${result.reason.slice(0, 120)}`,
        });
        return json({ ok: false, status: "skipped", reason: result.reason }, 200);
      }

      // result.kind === "error"
      const commentBody = `researcher: error — ${result.reason}`;
      postAgentComment(project, body.nodeId, "researcher", commentBody);
      recordNodeEvent(project, body.nodeId, "researcher", "research", {
        status: "error",
        reason: result.reason,
        question,
        summary: `Research errored: ${result.reason.slice(0, 120)}`,
      });
      return json({ ok: false, status: "error", reason: result.reason }, 200);
    } catch (e) {
      return json({ error: String(e).slice(0, 1000) }, 500);
    }
  }

  // GET /implementer/runs?project=<P>&limit=<N> — recent runs for live feed backfill.
  if (path === "/implementer/runs" && req.method === "GET") {
    const projectFilter = url.searchParams.get("project");
    const limit = Number(url.searchParams.get("limit") ?? "20") || 20;
    return implListRuns(projectFilter, limit);
  }

  // GET /implementer/status/:project/:nodeId
  if (path.startsWith("/implementer/status/") && req.method === "GET") {
    const tail = path.slice("/implementer/status/".length);
    const [proj, ...nodeParts] = tail.split("/");
    const nodeId = nodeParts.join("/");
    if (!proj || !nodeId) return json({ error: "usage: /implementer/status/:project/:nodeId" }, 400);
    return implStatus(decodeURIComponent(proj), decodeURIComponent(nodeId));
  }

  // GET /implementer/diff/:project/:nodeId
  if (path.startsWith("/implementer/diff/") && req.method === "GET") {
    const tail = path.slice("/implementer/diff/".length);
    const [proj, ...nodeParts] = tail.split("/");
    const nodeId = nodeParts.join("/");
    if (!proj || !nodeId) return json({ error: "usage: /implementer/diff/:project/:nodeId" }, 400);
    return implDiff(decodeURIComponent(proj), decodeURIComponent(nodeId));
  }

  // POST /implementer/approve/:project/:nodeId
  if (path.startsWith("/implementer/approve/") && req.method === "POST") {
    const tail = path.slice("/implementer/approve/".length);
    const [proj, ...nodeParts] = tail.split("/");
    const nodeId = nodeParts.join("/");
    if (!proj || !nodeId) return json({ error: "usage: /implementer/approve/:project/:nodeId" }, 400);
    return implApprove(decodeURIComponent(proj), decodeURIComponent(nodeId));
  }

  // POST /implementer/reject/:project/:nodeId   body: { reason?: string }
  if (path.startsWith("/implementer/reject/") && req.method === "POST") {
    const tail = path.slice("/implementer/reject/".length);
    const [proj, ...nodeParts] = tail.split("/");
    const nodeId = nodeParts.join("/");
    if (!proj || !nodeId) return json({ error: "usage: /implementer/reject/:project/:nodeId" }, 400);
    let body: { reason?: string } = {};
    try { body = (await req.json()) as { reason?: string }; } catch { /* tolerate empty body */ }
    return implReject(decodeURIComponent(proj), decodeURIComponent(nodeId), body.reason);
  }

  // POST /implementer/senior_review/:project/:nodeId
  if (path.startsWith("/implementer/senior_review/") && req.method === "POST") {
    const tail = path.slice("/implementer/senior_review/".length);
    const [proj, ...nodeParts] = tail.split("/");
    const nodeId = nodeParts.join("/");
    if (!proj || !nodeId) return json({ error: "usage: /implementer/senior_review/:project/:nodeId" }, 400);
    const ctx = _getAuthCtx(req);
    const userId = ctx?.user.id ?? "default";
    return implSeniorReview(decodeURIComponent(proj), decodeURIComponent(nodeId), userId);
  }

  // ── Settings: agent-mode + provider linking ──────────────────────────────────
  if (path === "/settings/agents" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    return handleGetAgentSettings(ctx.user.id);
  }

  if (path.startsWith("/settings/agents/") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const agent = path.slice("/settings/agents/".length);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    return handleSetAgentSettings(ctx.user.id, agent, body);
  }

  if (path.startsWith("/settings/providers/") && path.endsWith("/verify") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const provider = path.slice("/settings/providers/".length, path.length - "/verify".length);
    let body: unknown = {};
    try { body = await req.json(); } catch { /* tolerate empty body */ }
    return handleVerifyProvider(provider, body);
  }

  if (path.startsWith("/settings/providers/") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const provider = path.slice("/settings/providers/".length);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    return handleSetProviderLink(ctx.user.id, provider, body);
  }

  // ── Distribution adapters (Pillar C — go-live cliff) ─────────────────────────
  if (path === "/distribution/adapters" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    return distListAdapters();
  }

  if (path === "/distribution/links" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    return distListLinks(ctx.user.id);
  }

  if (path.startsWith("/distribution/links/") && path.endsWith("/verify") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const adapterId = path.slice("/distribution/links/".length, path.length - "/verify".length);
    return distVerifyLink(ctx.user.id, adapterId);
  }

  if (path.startsWith("/distribution/links/") && path.endsWith("/write-config") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const adapterId = path.slice("/distribution/links/".length, path.length - "/write-config".length);
    let body: unknown = {};
    try { body = await req.json(); } catch { /* tolerate empty */ }
    return distWriteConfig(ctx.user.id, adapterId, body);
  }

  if (path.startsWith("/distribution/links/") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const adapterId = path.slice("/distribution/links/".length);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    return distUpsertLink(ctx.user.id, adapterId, body);
  }

  if (path.startsWith("/distribution/links/") && req.method === "DELETE") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const adapterId = path.slice("/distribution/links/".length);
    return distDeleteLink(ctx.user.id, adapterId);
  }

  // ── Activity feed ────────────────────────────────────────────────────────────
  if (path === "/activity/recent" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    return handleRecentActivity(ctx.user.id, url.searchParams.get("limit"));
  }

  if (path === "/activity/etl-status" && req.method === "GET") {
    return handleEtlStatus();
  }

  if (path === "/activity/og-stats" && req.method === "GET") {
    return handleOgStats();
  }

  // ── Terminal v2 (ttyd-via-tmux) — opt-in, runs alongside legacy ──────────
  if (path === "/terminal-v2/availability" && req.method === "GET") {
    return json(isTerminalV2Available());
  }

  if (path === "/terminal-v2/start" && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    let body: { sessionId?: string; agent?: string };
    try { body = await req.json() as { sessionId?: string; agent?: string }; } catch { return json({ error: "invalid json" }, 400); }
    if (!body.sessionId) return json({ error: "missing sessionId" }, 400);

    // Resolve which agent this session is for (default: drafter — the
    // foreground co-thinker). The agent's configured provider drives bin/args.
    const agentName = (body.agent ?? "drafter") as "drafter" | "allocator" | "implementer" | "senior_reviewer";
    let cfg;
    try { cfg = getAgentConfig(ctx.user.id, agentName); }
    catch (e) { return json({ error: `agent config: ${String(e)}` }, 500); }

    let adapter;
    try {
      adapter = getCliAdapter(cfg.provider as Parameters<typeof getCliAdapter>[0]);
    } catch (e) {
      return json({ error: `provider not implemented: ${cfg.provider}`, detail: String(e) }, 400);
    }

    // Compose the same identity prompt + MCP config the legacy bridge uses.
    // This is the load-bearing parity — without it v2 boots a "naked" CLI
    // without the 3-layer brain, drafter principles, or canvas/brain MCP tools.
    const project = config.agent.active_project ?? "default";
    const projectCwd = resolve(config.projectsDir, project);
    const tmpDir = resolve(config.dataDir, "tmp");
    const { mkdirSync: _mkdir, writeFileSync: _write } = await import("node:fs");
    _mkdir(tmpDir, { recursive: true });
    _mkdir(projectCwd, { recursive: true });

    // 3-layer brain (global + personal + project) — null on a fresh founder.
    const brain = loadOmnigraphBrain(ctx.user.id, project);

    // Map agent to the composer's Mode union (only drafter/implementer
    // currently have prompt compositions; allocator + senior_reviewer are
    // bespoke and don't go through the Now terminal).
    const composerMode: "drafter" | "implementer" = agentName === "implementer" ? "implementer" : "drafter";
    const promptPath = writeComposedPrompt({
      sessionId: body.sessionId,
      mode: composerMode,
      stage: "pre-mvp",
      projectName: project,
      omnigraphBrainMarkdown: brain?.markdown,
    });

    // MCP config — atelier's MCP server is stdio'd into the CLI. Without
    // this the agent can't propose canvas nodes / query brain / call
    // omnigraph_* mid-session.
    const mcpConfigPath = resolve(tmpDir, `mcp_${body.sessionId}.json`);
    _write(mcpConfigPath, JSON.stringify({
      mcpServers: {
        atelier: {
          command: "bun",
          args: [resolve(config.atelierRoot, "backend/src/mcp/server.ts")],
        },
      },
    }, null, 2));

    const interactive = adapter.getInteractiveCommand({
      sessionId: body.sessionId,
      systemPromptPath: promptPath,
      cwd: projectCwd,
      mcpConfigPath,
      tools: [],
    });

    const rawLogPath = resolve(config.dataDir, "sessions", body.sessionId, "raw.log");
    const result = await startTerminalV2({
      sessionId: body.sessionId,
      cwd: projectCwd,
      bin: interactive.bin,
      args: interactive.args,
      env: interactive.env,
      preSpawnWrites: interactive.preSpawnWrites,
      rawLogPath,
      userId: ctx.user.id,
    });
    return json(result, result.ok ? 200 : 500);
  }

  if (path.startsWith("/terminal-v2/stop/") && req.method === "POST") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const sid = path.slice("/terminal-v2/stop/".length);
    if (!sid) return json({ error: "missing sessionId" }, 400);
    const stopResult = stopTerminalV2(sid);
    // False-done detector (QA 2026-07-17 / ADR-001 step 6): a session that ran
    // but left no transcript is the "looks done, actually empty" failure the
    // v2 engine reintroduced. Check the provider JSONL + raw.log; report
    // captured so the UI can flag it instead of silently showing nothing.
    let captured = true;
    try {
      const project = config.agent.active_project ?? "default";
      const projectCwd = resolve(config.projectsDir, project);
      const conv = await readSessionConversation(sid, projectCwd, "claude");
      const rawPath = resolve(config.dataDir, "sessions", sid, "raw.log");
      const rawBytes = existsSync(rawPath) ? statSync(rawPath).size : 0;
      captured = !!(conv && conv.userTurnCount > 0) || rawBytes > 0;
      if (!captured) {
        console.warn(`[terminal-v2] session ${sid.slice(0, 8)} closed with NO capture (no provider JSONL, empty raw.log) — reflection will have nothing to read.`);
      }
    } catch { /* capture check is best-effort — never block stop */ }
    return json({ ...stopResult, captured });
  }

  if (path.startsWith("/terminal-v2/status/") && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    const sid = path.slice("/terminal-v2/status/".length);
    const session = getTerminalV2(sid);
    if (!session) return json({ active: false }, 200);
    return json({
      active: true,
      ...session,
      url: `http://127.0.0.1:${session.ttydPort}/`,
      wsUrl: `ws://127.0.0.1:${session.ttydPort}/ws`,
    });
  }

  if (path === "/terminal-v2/list" && req.method === "GET") {
    const ctx = _getAuthCtx(req);
    if (!ctx) return json({ error: "auth required" }, 401);
    return json({ active: listTerminalV2() });
  }

  return json({ error: "not found", path }, 404);
}
