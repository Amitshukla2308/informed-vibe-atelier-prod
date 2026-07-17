/**
 * γ auth middleware — reads the atelier_at cookie (or Authorization: Bearer),
 * hashes, looks up in access_tokens, loads user + memberships, returns an
 * AuthContext the route handler can use.
 *
 * Three modes (see auth/mode.ts — fail-closed, "local" when unset):
 *   - local (default): strict pattern-γ auth. No token → 401. No impersonation.
 *   - dev (ATELIER_AUTH_MODE=dev + ATELIER_DEV_UNSAFE=1): header
 *     x-atelier-dev-as: <user_id> skips the token check and acts as that
 *     user. Loopback-only by construction (boot validation refuses dev on
 *     any reachable configuration). Query-param form removed.
 *   - secure: strict auth; additionally the only mode in which the
 *     Cloudflare Access header is trusted and non-loopback bind is allowed.
 *
 * Routes opt in by calling getAuthContext(req) / requireAuth(req).
 */

import { getDb, hashToken, nowIso } from "~/db";
import { authMode, devImpersonationEnabled } from "~/auth/mode";

export interface AuthUser {
  id: string;
  display_name: string;
  email: string | null;
  last_seen_at: string | null;
}

export interface AuthMembership {
  org_id: string;
  org_name: string;
  role: string;
}

export interface AuthContext {
  user: AuthUser;
  memberships: AuthMembership[];
  /** Convenience: does the user hold a given role on a given org? */
  hasRole: (orgId: string, role: string) => boolean;
  /** Convenience: is the user admin on any org? */
  isAdmin: () => boolean;
}

function isDevMode(): boolean {
  return devImpersonationEnabled();
}

function extractToken(req: Request): string | null {
  // Authorization header wins (API callers)
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();

  // Cookie fallback (browser)
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)atelier_at=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);

  return null;
}

function extractDevAs(req: Request): string | null {
  if (!isDevMode()) return null;
  // Header only. The old ?dev_as=<user_id> query form leaked user ids into
  // logs/history and made the bypass linkable; removed 2026-07-17.
  return req.headers.get("x-atelier-dev-as");
}

function loadContext(userId: string): AuthContext | null {
  const db = getDb();
  const user = db.query(
    `SELECT id, display_name, email, last_seen_at FROM users WHERE id = ?`
  ).get(userId) as AuthUser | undefined;
  if (!user) return null;

  const memberships = db.query(
    `SELECT m.org_id, m.role, o.name AS org_name
     FROM memberships m
     JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ?`
  ).all(userId) as AuthMembership[];

  // update last_seen_at (fire-and-forget)
  db.query(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(nowIso(), userId);

  return {
    user,
    memberships,
    hasRole: (orgId, role) => memberships.some(m => m.org_id === orgId && m.role === role),
    isAdmin: () => memberships.some(m => m.role === "admin"),
  };
}

/** Returns the current auth context or null if unauthenticated.
 *
 *  Auth precedence:
 *    1. Dev impersonation header (only when dev mode is enabled).
 *    2. Cloudflare Access header (only when ATELIER_TRUST_CF_ACCESS=true).
 *       CF Access verifies the JWT at the edge and forwards the verified
 *       email in the Cf-Access-Authenticated-User-Email header. We trust
 *       it ONLY when the env flag is on AND only if a local user with
 *       that email exists with status='approved'.
 *    3. Atelier session cookie (γ access-token).
 */
export function getAuthContext(req: Request): AuthContext | null {
  // 1. Dev-mode impersonation
  const devAs = extractDevAs(req);
  if (devAs) return loadContext(devAs);

  // 2. Cloudflare Access — opt-in via env flag, honored ONLY in secure mode.
  // Trusting an email header in local/dev would let anything that can reach
  // the port mint identities with one forged header.
  if (process.env.ATELIER_TRUST_CF_ACCESS === "true" && authMode() === "secure") {
    const cfEmail = req.headers.get("cf-access-authenticated-user-email");
    if (cfEmail) {
      const db = getDb();
      const row = db.query(
        `SELECT id, status FROM users WHERE LOWER(email) = LOWER(?)`
      ).get(cfEmail.trim()) as { id: string; status: string } | undefined;
      if (row && row.status === "approved") return loadContext(row.id);
    }
  }

  const token = extractToken(req);
  if (!token) return null;

  const hash = hashToken(token);
  const db = getDb();
  const row = db.query(
    `SELECT user_id, revoked_at FROM access_tokens WHERE token_hash = ?`
  ).get(hash) as { user_id: string; revoked_at: string | null } | undefined;
  if (!row || row.revoked_at) return null;

  // update last_used_at (fire-and-forget)
  db.query(
    `UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?`
  ).run(nowIso(), hash);

  return loadContext(row.user_id);
}

/** Returns context or throws a 401 response. */
export function requireAuth(req: Request): AuthContext {
  const ctx = getAuthContext(req);
  if (!ctx) {
    throw new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return ctx;
}

/** Throws 403 if the user lacks the required role on the given org. */
export function requireRole(ctx: AuthContext, orgId: string, role: string): void {
  if (!ctx.hasRole(orgId, role)) {
    throw new Response(JSON.stringify({ error: "forbidden", required: { org: orgId, role } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
}

/** Throws 403 if the user is not an admin on any org. */
export function requireAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin()) {
    throw new Response(JSON.stringify({ error: "forbidden", required: "admin" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
}
