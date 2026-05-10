/**
 * γ auth routes: invite · claim · me · logout · users/orgs listing.
 *
 * Lives as a separate module and is called from http.ts BEFORE the rest of
 * the route handlers, so auth endpoints never collide with legacy paths.
 * Returns `null` when the path isn't an auth route → http.ts continues.
 */

import { existsSync, writeFileSync, unlinkSync, chmodSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { getDb, hashToken, newId, nowIso, randomToken } from "~/db";
import { getAuthContext, requireAuth, requireAdmin } from "~/auth/middleware";
import { ensureUserHome, userClaudeConfigPath, userClaudeCredentialsPath, isClaudeLinked } from "~/auth/user-home";
import { sendMagicLink, sendPasswordResetLink, isMailerConfigured } from "~/lib/mailer";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCESS_TOKEN_MAX_AGE_DAYS = 30;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

function buildCookie(rawToken: string): string {
  // httpOnly, SameSite=Lax (works across tunnel hostname), 30-day max-age.
  const maxAge = ACCESS_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60;
  const secure = (process.env.ATELIER_AUTH_MODE ?? "dev") !== "dev" ? " Secure;" : "";
  return `atelier_at=${encodeURIComponent(rawToken)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(): string {
  return `atelier_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function handleAuthRoutes(req: Request, url: URL, path: string): Promise<Response | null> {
  // GET /me — current user + memberships
  if (path === "/me" && req.method === "GET") {
    const ctx = getAuthContext(req);
    if (!ctx) return json({ user: null, memberships: [] });
    return json({
      user: {
        id: ctx.user.id,
        display_name: ctx.user.display_name,
        email: ctx.user.email,
      },
      memberships: ctx.memberships,
    });
  }

  // GET /auth/install-state — public; reports whether this install needs a host bootstrap.
  // Used by the SignIn page to decide whether to show "Sign in" vs "Set up host" UX.
  if (path === "/auth/install-state" && req.method === "GET") {
    const row = getDb().query(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
    return json({ host_exists: row.n > 0, user_count: row.n });
  }

  // POST /logout — revoke current access token
  if (path === "/logout" && req.method === "POST") {
    const cookie = req.headers.get("cookie") ?? "";
    const m = cookie.match(/(?:^|;\s*)atelier_at=([^;]+)/);
    if (m) {
      const raw = decodeURIComponent(m[1]);
      const hash = hashToken(raw);
      getDb().query(
        `UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
      ).run(nowIso(), hash);
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  // ── Email + password auth ──────────────────────────────────────────────────
  // Three endpoints:
  //   POST /auth/register       — create user with status='pending', awaiting admin approval
  //   POST /auth/login          — verify password, set cookie (only if status='approved')
  //   GET  /admin/access-requests + POST /admin/access-requests/decide
  //
  // Passwords hashed with argon2id via Bun.password (built-in, no deps).
  // Magic-link sign-in stays as a passwordless alternative for known users.

  if (path === "/auth/register" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
      display_name?: string;
    };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const displayName = (body.display_name ?? "").trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "valid email required" }, 400);
    }
    if (!displayName) return json({ error: "display_name required" }, 400);
    if (password.length < 8) {
      return json({ error: "password must be at least 8 characters" }, 400);
    }

    const db = getDb();
    const existing = db.query(
      `SELECT id, display_name, status FROM users WHERE LOWER(email) = ?`
    ).get(email) as { id: string; display_name: string; status: string } | undefined;

    // Once any user exists, new registrations land in 'pending' awaiting
    // admin approval. The first-ever user (truly fresh install) is auto-
    // approved as the host — they bootstrap the instance.
    const userCount = (db.query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
    const isFirstUser = userCount === 0;

    if (existing) {
      // Single safe carve-out: the legacy admin's first claim. Allowed only
      // when there is exactly ONE user in the entire DB (so nobody else can
      // be impersonated) AND that user has no password set yet. This handles
      // the bootstrap case where the first DB user came from agents/config.yaml
      // migration without a password column. Anyone else without a password
      // (collaborators added pre-password) must go through admin-issued reset.
      const singleUserNoPwd = userCount === 1
        && existing.id === (db.query(`SELECT id FROM users LIMIT 1`).get() as { id: string } | undefined)?.id;
      const fullRow = singleUserNoPwd
        ? db.query(`SELECT password_hash FROM users WHERE id = ?`).get(existing.id) as { password_hash: string | null }
        : null;
      if (singleUserNoPwd && fullRow && fullRow.password_hash === null) {
        const hash = await Bun.password.hash(password, "argon2id");
        const now = nowIso();
        db.query(`UPDATE users SET password_hash = ?, last_seen_at = ? WHERE id = ?`).run(hash, now, existing.id);
        const rawAccessToken = randomToken("at", 32);
        const accessHash = hashToken(rawAccessToken);
        db.query(
          `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
           VALUES (?, ?, ?, ?, ?)`
        ).run(accessHash, existing.id, now, now, (req.headers.get("user-agent") ?? "").slice(0, 240));
        db.query(
          `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(newId(), existing.id, "user.legacy-admin-claim", "user", existing.id, "{}", now);
        return json(
          { ok: true, status: "approved", first_user: true,
            user: { id: existing.id, display_name: existing.display_name, email } },
          200,
          { "set-cookie": buildCookie(rawAccessToken) },
        );
      }
      return json({ error: "an account with this email already exists" }, 409);
    }

    const userId = newId();
    const now = nowIso();
    const hash = await Bun.password.hash(password, "argon2id");
    const status = isFirstUser ? "approved" : "pending";

    db.query(
      `INSERT INTO users (id, display_name, email, password_hash, status,
                           requested_at, approved_at, approved_by_user_id,
                           created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, displayName, email, hash, status,
      now,
      isFirstUser ? now : null,
      isFirstUser ? userId : null,
      now,
      now,
    );

    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), userId, isFirstUser ? "user.register.bootstrap" : "user.register.pending",
          "user", userId, JSON.stringify({ email, display_name: displayName }), now);

    if (isFirstUser) {
      // Bootstrap: log them in immediately.
      const rawAccessToken = randomToken("at", 32);
      const accessHash = hashToken(rawAccessToken);
      db.query(
        `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).run(accessHash, userId, now, now, (req.headers.get("user-agent") ?? "").slice(0, 240));
      return json(
        { ok: true, status: "approved", first_user: true,
          user: { id: userId, display_name: displayName, email } },
        200,
        { "set-cookie": buildCookie(rawAccessToken) },
      );
    }

    return json(
      { ok: true, status: "pending",
        message: "Access request submitted. The host will review and approve." },
      202,
    );
  }

  // POST /me/change-password — authed user changes/sets their own password.
  // current_password is REQUIRED if the user already has a password set;
  // omit it (or send null) for legacy/temp-password accounts where no
  // current password is on file. Returns 200 on success, 401 on wrong
  // current_password, 400 on weak new_password.
  if (path === "/me/change-password" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    const body = (await req.json().catch(() => ({}))) as {
      current_password?: string | null;
      new_password?: string;
    };
    const newPwd = body.new_password ?? "";
    if (newPwd.length < 8) {
      return json({ error: "new password must be at least 8 characters" }, 400);
    }

    const db = getDb();
    const row = db.query(
      `SELECT password_hash FROM users WHERE id = ?`
    ).get(ctx.user.id) as { password_hash: string | null } | undefined;
    if (!row) return json({ error: "user not found" }, 404);

    if (row.password_hash) {
      // Has a password → must verify current.
      const cur = body.current_password ?? "";
      if (!cur) return json({ error: "current_password required" }, 400);
      const ok = await Bun.password.verify(cur, row.password_hash);
      if (!ok) return json({ error: "current password is incorrect" }, 401);
    }
    // No password on file → setting it for the first time, no current to verify.

    const newHash = await Bun.password.hash(newPwd, "argon2id");
    db.query(`UPDATE users SET password_hash = ? WHERE id = ?`).run(newHash, ctx.user.id);
    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "user.change-password", "user", ctx.user.id, "{}", nowIso());
    return json({ ok: true });
  }

  // POST /admin/users/reset-password — admin issues a temp password for any
  // user. Returns the temp password ONCE in the response; admin hands it to
  // the user out-of-band. The user signs in with it then is expected (UI-
  // enforced) to change it via /me/change-password.
  if (path === "/admin/users/reset-password" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const body = (await req.json().catch(() => ({}))) as { user_id?: string };
    if (!body.user_id) return json({ error: "user_id required" }, 400);

    const db = getDb();
    const target = db.query(
      `SELECT id, email FROM users WHERE id = ?`
    ).get(body.user_id) as { id: string; email: string | null } | undefined;
    if (!target) return json({ error: "user not found" }, 404);

    // Generate an ergonomic-but-strong temp password: 16 random chars,
    // URL-safe alphabet (no ambiguous 0/O, 1/l/I).
    const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let temp = "";
    for (let i = 0; i < 16; i++) temp += alpha[buf[i] % alpha.length];

    const hash = await Bun.password.hash(temp, "argon2id");
    db.query(
      `UPDATE users SET password_hash = ?, last_seen_at = ? WHERE id = ?`
    ).run(hash, nowIso(), body.user_id);

    // Revoke all the target's existing access tokens so the temp password
    // sign-in is the only valid path forward.
    db.query(
      `UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
    ).run(nowIso(), body.user_id);

    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "user.reset-password", "user", body.user_id,
      JSON.stringify({ email: target.email }), nowIso());

    return json({
      ok: true,
      temp_password: temp,
      hint: "share once, then ask the user to change it via Settings → Account.",
    });
  }

  if (path === "/auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    // Trim password too. Whitespace from copy-paste (especially leading spaces
    // in Markdown-formatted temp passwords) was causing silent verify failures.
    // Trade-off accepted: passwords with intentional leading/trailing spaces
    // can't be set; that's an extreme edge case worth losing.
    const password = (body.password ?? "").trim();
    if (!email || !password) return json({ error: "email and password required" }, 400);

    const db = getDb();
    const row = db.query(
      `SELECT id, display_name, email, password_hash, status FROM users WHERE LOWER(email) = ?`
    ).get(email) as { id: string; display_name: string; email: string; password_hash: string | null; status: string } | undefined;

    // Same generic error for "no such user" and "wrong password" to avoid
    // user enumeration. Status-specific errors only surface when the
    // password actually verifies.
    const generic = () => json({ error: "invalid email or password" }, 401);
    if (!row || !row.password_hash) return generic();
    const ok = await Bun.password.verify(password, row.password_hash);
    if (!ok) return generic();

    if (row.status === "pending") {
      return json({ error: "your access request is still pending approval", status: "pending" }, 403);
    }
    if (row.status === "rejected" || row.status === "suspended") {
      return json({ error: "your account is not active", status: row.status }, 403);
    }

    const now = nowIso();
    const rawAccessToken = randomToken("at", 32);
    const accessHash = hashToken(rawAccessToken);
    db.query(
      `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    ).run(accessHash, row.id, now, now, (req.headers.get("user-agent") ?? "").slice(0, 240));
    db.query(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(now, row.id);

    return json(
      { ok: true, user: { id: row.id, display_name: row.display_name, email: row.email } },
      200,
      { "set-cookie": buildCookie(rawAccessToken) },
    );
  }

  if (path === "/admin/access-requests" && req.method === "GET") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const db = getDb();
    const rows = db.query(
      `SELECT id, display_name, email, requested_at, status FROM users
       WHERE status = 'pending' ORDER BY requested_at DESC`
    ).all();
    return json({ requests: rows });
  }

  if (path === "/admin/access-requests/decide" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const body = (await req.json().catch(() => ({}))) as {
      user_id?: string;
      action?: "approve" | "reject";
      org_id?: string;
      role?: string;
      project_ids?: string[];
      project_role?: "editor" | "viewer";
      contributor_kind?: "founder" | "technical" | "business" | "observer";
    };
    if (!body.user_id || !body.action) return json({ error: "user_id and action required" }, 400);
    if (body.action !== "approve" && body.action !== "reject") {
      return json({ error: "action must be 'approve' or 'reject'" }, 400);
    }
    const targetUserId: string = body.user_id;
    const action: "approve" | "reject" = body.action;
    const orgId = body.org_id ?? null;
    const orgRole = body.role ?? null;
    const projectIds = Array.isArray(body.project_ids) ? body.project_ids : [];
    const projectRole = body.project_role === "viewer" ? "viewer" : "editor";
    const contributorKind = body.contributor_kind ?? null;

    const db = getDb();
    const target = db.query(
      `SELECT id, status FROM users WHERE id = ?`
    ).get(targetUserId) as { id: string; status: string } | undefined;
    if (!target) return json({ error: "user not found" }, 404);
    if (target.status !== "pending") return json({ error: "user is not pending" }, 409);

    const now = nowIso();
    const tx = db.transaction(() => {
      if (action === "approve") {
        db.query(
          `UPDATE users SET status = 'approved', approved_at = ?, approved_by_user_id = ? WHERE id = ?`
        ).run(now, ctx.user.id, targetUserId);
        if (contributorKind) {
          db.query(`UPDATE users SET contributor_kind = ? WHERE id = ?`).run(contributorKind, targetUserId);
        }
        if (orgId && orgRole && ctx.hasRole(orgId, "admin")) {
          db.query(
            `INSERT INTO memberships (id, user_id, org_id, role, created_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(newId(), targetUserId, orgId, orgRole, now);
          // Optional explicit project access (only meaningful when org is members-default
          // and the new user is not an org admin). Skip silently if either condition fails.
          if (projectIds.length > 0 && orgRole !== "admin") {
            for (const pid of projectIds) {
              const proj = db.query(
                `SELECT id FROM projects WHERE id = ? AND org_id = ?`
              ).get(pid, orgId);
              if (!proj) continue;
              db.query(
                `INSERT OR IGNORE INTO project_members (id, user_id, project_id, role, created_at)
                 VALUES (?, ?, ?, ?, ?)`
              ).run(newId(), targetUserId, pid, projectRole, now);
            }
          }
        }
      } else {
        db.query(`UPDATE users SET status = 'rejected' WHERE id = ?`).run(targetUserId);
      }
      db.query(
        `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), ctx.user.id, `access_request.${action}`, "user", targetUserId,
        JSON.stringify({ org_id: orgId, role: orgRole }), now);
    });
    tx();
    return json({ ok: true });
  }

  // POST /auth/magic-link/request — mint a single-use sign-in link for an
  // EXISTING user. This is "link a device": you're already a user, you want
  // to add an access-token row from another browser/phone/tablet.
  //
  // Adding a NEW user is a different flow — it goes through the admin
  // invite UI inside the workspace (POST /invite → invite link with role).
  // We refuse invite-by-email here so a stranger can't self-onboard onto a
  // running instance.
  //
  // Delivery: there's no SMTP yet, so the link is printed to the host log
  // AND appended to data/magic-links.txt (mode 0600). The host forwards it.
  if (path === "/auth/magic-link/request" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "valid email required" }, 400);
    }
    const db = getDb();
    const existing = db.query(
      `SELECT id, display_name, status FROM users WHERE LOWER(email) = ?`
    ).get(email) as { id: string; display_name: string; status: string } | undefined;
    if (!existing) {
      return json({
        error: "no account for this email",
        hint: "ask the person running this Atelier to invite you from their workspace.",
      }, 404);
    }
    if (existing.status !== "approved") {
      return json({
        error: "your account is not active",
        hint: existing.status === "pending"
          ? "your access request is awaiting approval."
          : "contact the host of this Atelier instance.",
      }, 403);
    }

    const kind = "signin" as const;
    const rawToken = randomToken("ml", 32);
    const tokenHash = hashToken(rawToken);
    const now = nowIso();
    const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);

    db.query(
      `INSERT INTO magic_links (token_hash, email, kind, display_name, created_at, expires_at, requested_ua)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenHash, email, kind, null, now, expires, userAgent);

    // Build the click-target URL the host will forward to the requester.
    // We honour Origin/Host so the link lands on the same hostname the
    // request came from (laptop, tunnel, LAN ip — all work).
    const origin = req.headers.get("origin")
      ?? (() => {
        const host = req.headers.get("host");
        const proto = req.headers.get("x-forwarded-proto") ?? "http";
        return host ? `${proto}://${host}` : "";
      })();
    const link = `${origin}/api/auth/magic-link/claim?token=${encodeURIComponent(rawToken)}`;

    const line =
      `[${now}] kind=${kind} email=${email} user="${existing.display_name}" expires=${expires}\n  ${link}\n`;

    // Delivery: prefer Resend when configured; fall back to host log + data/magic-links.txt
    // so dev installs without an API key still work.
    let delivery: "email" | "host-forwarded" = "host-forwarded";
    if (isMailerConfigured()) {
      const result = await sendMagicLink(email, link, existing.display_name);
      if (result.delivered) {
        delivery = "email";
        console.log(`[mailer] magic-link sent to=${email} id=${result.reason}`);
      } else {
        console.warn(`[mailer] magic-link send failed (${result.reason}); falling back to host log`);
      }
    }
    if (delivery === "host-forwarded") {
      console.log(`\n=== MAGIC LINK ===\n${line}`);
      try {
        const dataDir = pathResolve(process.cwd(), "data");
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const filePath = pathResolve(dataDir, "magic-links.txt");
        appendFileSync(filePath, line, { mode: 0o600 });
        try { chmodSync(filePath, 0o600); } catch { /* best-effort */ }
      } catch (e) {
        console.warn("magic-link: could not persist to data/magic-links.txt:", e);
      }
    }

    return json({
      ok: true,
      kind,
      email,
      expires_at: expires,
      // We never return the raw token in the response body — it lives in
      // logs + the email + (when used) the data file only, so a malicious
      // page can't fish for it.
      delivery,
    });
  }

  // POST /auth/reset-password/request — send a one-time password-reset link to
  // the email's inbox. The link lands on the frontend at /?reset=<token>, which
  // shows a "set a new password" form that posts to /auth/reset-password/confirm.
  // Same enumeration-resistant behaviour as login: a successful response shape
  // for non-existent emails so an attacker can't probe who has accounts.
  if (path === "/auth/reset-password/request" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "valid email required" }, 400);
    }

    const db = getDb();
    const existing = db.query(
      `SELECT id, display_name, status FROM users WHERE LOWER(email) = ?`
    ).get(email) as { id: string; display_name: string; status: string } | undefined;

    // Generic success response shape so an attacker can't tell whether the
    // email is registered. We only do work + send mail if the row really exists
    // and is approved.
    const generic = () => json({
      ok: true,
      email,
      message: "if an account exists for this email, a reset link has been sent.",
    });

    if (!existing || existing.status !== "approved") {
      // Log internally but return generic success.
      console.log(`[reset-password] no-op for email=${email} reason=${!existing ? "no-user" : "status=" + existing.status}`);
      return generic();
    }

    const kind = "password_reset" as const;
    const rawToken = randomToken("rp", 32);
    const tokenHash = hashToken(rawToken);
    const now = nowIso();
    const expires = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);

    db.query(
      `INSERT INTO magic_links (token_hash, email, kind, display_name, created_at, expires_at, requested_ua)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenHash, email, kind, null, now, expires, userAgent);

    // Build the public URL where the founder will land. ATELIER_PUBLIC_URL wins
    // (canonical https origin); else use the request's Origin/Host so dev/LAN
    // setups still work.
    const publicUrl = process.env.ATELIER_PUBLIC_URL
      ?? req.headers.get("origin")
      ?? (() => {
        const host = req.headers.get("host");
        const proto = req.headers.get("x-forwarded-proto") ?? "http";
        return host ? `${proto}://${host}` : "";
      })();
    const link = `${publicUrl}/signin?reset=${encodeURIComponent(rawToken)}`;

    if (isMailerConfigured()) {
      const result = await sendPasswordResetLink(email, link, existing.display_name);
      if (result.delivered) {
        console.log(`[mailer] password-reset sent to=${email} id=${result.reason}`);
      } else {
        console.warn(`[mailer] password-reset send failed (${result.reason}); writing to host log + data/password-resets.txt`);
        try {
          const dataDir = pathResolve(process.cwd(), "data");
          if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
          const filePath = pathResolve(dataDir, "password-resets.txt");
          appendFileSync(filePath,
            `[${now}] email=${email} expires=${expires}\n  ${link}\n`,
            { mode: 0o600 });
          try { chmodSync(filePath, 0o600); } catch { /* best-effort */ }
        } catch (e) {
          console.warn("reset-password: could not persist:", e);
        }
        console.log(`\n=== PASSWORD RESET LINK ===\n  ${link}\n`);
      }
    } else {
      console.log(`\n=== PASSWORD RESET LINK ===\n  email=${email}\n  ${link}\n`);
    }

    return generic();
  }

  // POST /auth/reset-password/confirm — consume a reset token, update the
  // user's password_hash, set the cookie. Caller posts { token, new_password }.
  // On success the response sets atelier_at — the user is signed in immediately,
  // no second login round-trip.
  if (path === "/auth/reset-password/confirm" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { token?: string; new_password?: string };
    const rawToken = (body.token ?? "").trim();
    const newPwd = (body.new_password ?? "").trim();
    if (!rawToken) return json({ error: "missing token" }, 400);
    if (newPwd.length < 8) return json({ error: "password must be at least 8 characters" }, 400);

    const db = getDb();
    const tokenHash = hashToken(rawToken);
    const row = db.query(
      `SELECT token_hash, email, kind, expires_at, used_at FROM magic_links WHERE token_hash = ?`
    ).get(tokenHash) as { token_hash: string; email: string; kind: string; expires_at: string; used_at: string | null } | undefined;
    if (!row) return json({ error: "link not found" }, 404);
    if (row.kind !== "password_reset") return json({ error: "wrong link kind" }, 400);
    if (row.used_at) return json({ error: "link already used" }, 410);
    if (new Date(row.expires_at) < new Date()) return json({ error: "link expired" }, 410);

    const user = db.query(
      `SELECT id, display_name, email, status FROM users WHERE LOWER(email) = ?`
    ).get(row.email.toLowerCase()) as { id: string; display_name: string; email: string; status: string } | undefined;
    if (!user) return json({ error: "account no longer exists" }, 410);
    if (user.status !== "approved") return json({ error: "account not active" }, 403);

    const newHash = await Bun.password.hash(newPwd, "argon2id");
    const now = nowIso();
    const rawAccessToken = randomToken("at", 32);
    const accessHash = hashToken(rawAccessToken);
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);

    db.transaction(() => {
      // Mark the reset token consumed.
      db.query(`UPDATE magic_links SET used_at = ? WHERE token_hash = ?`).run(now, tokenHash);
      // Update the user's password.
      db.query(`UPDATE users SET password_hash = ?, last_seen_at = ? WHERE id = ?`).run(newHash, now, user.id);
      // Revoke any access tokens older than this reset — clean slate after a
      // password change is what users expect ("logged out everywhere else").
      // The cookie we issue below is fresh and unaffected.
      db.query(
        `UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
      ).run(now, user.id);
      // Issue a fresh access token for this browser.
      db.query(
        `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).run(accessHash, user.id, now, now, userAgent);
      db.query(
        `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), user.id, "user.reset-password-confirm", "user", user.id,
        JSON.stringify({ via: "email-reset" }), now);
    })();

    return json(
      { ok: true, user: { id: user.id, display_name: user.display_name, email: user.email } },
      200,
      { "set-cookie": buildCookie(rawAccessToken) },
    );
  }

  // GET /auth/magic-link/claim?token=<raw> — consume a token, set cookie,
  // redirect to /home. For invite_new, creates the user record on the fly
  // and (if exactly one org exists) attaches them as 'observer' so they
  // land in a working workspace; admin can promote later.
  if (path === "/auth/magic-link/claim" && req.method === "GET") {
    const rawToken = url.searchParams.get("token");
    if (!rawToken) {
      return new Response("missing token", { status: 400 });
    }
    const tokenHash = hashToken(rawToken);
    const db = getDb();
    const row = db.query(
      `SELECT token_hash, email, kind, display_name, expires_at, used_at
       FROM magic_links WHERE token_hash = ?`
    ).get(tokenHash) as any;
    if (!row) return new Response("link not found", { status: 404 });
    if (row.used_at) return new Response("link already used", { status: 410 });
    if (new Date(row.expires_at) < new Date()) {
      return new Response("link expired", { status: 410 });
    }

    const now = nowIso();
    let userId: string;
    let displayName: string;
    let email: string = row.email;
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);
    const rawAccessToken = randomToken("at", 32);
    const accessHash = hashToken(rawAccessToken);

    if (row.kind === "signin") {
      const u = db.query(
        `SELECT id, display_name FROM users WHERE LOWER(email) = ?`
      ).get(email) as any;
      if (!u) {
        // The user was deleted between request and claim — surface clearly.
        return new Response("account no longer exists", { status: 410 });
      }
      userId = u.id;
      displayName = u.display_name;
    } else {
      // invite_new
      userId = newId();
      displayName = row.display_name || email.split("@")[0];
    }

    const tx = db.transaction(() => {
      if (row.kind === "invite_new") {
        db.query(
          `INSERT INTO users (id, display_name, email, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(userId, displayName, email, now, now);

        // If exactly one org exists, attach as observer so the new user
        // lands somewhere usable. Otherwise admin must invite explicitly.
        const orgs = db.query(`SELECT id FROM orgs LIMIT 2`).all() as { id: string }[];
        if (orgs.length === 1) {
          db.query(
            `INSERT INTO memberships (id, user_id, org_id, role, created_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(newId(), userId, orgs[0].id, "observer", now);
        }
      } else {
        db.query(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(now, userId);
      }

      db.query(
        `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).run(accessHash, userId, now, now, userAgent);

      db.query(`UPDATE magic_links SET used_at = ? WHERE token_hash = ?`).run(now, tokenHash);

      db.query(
        `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), userId, `magic_link.${row.kind}`, "magic_link", tokenHash,
        JSON.stringify({ email, user_agent: userAgent }), now);
    });
    tx();

    // Redirect to /home; cookie set in headers.
    return new Response(null, {
      status: 302,
      headers: {
        "set-cookie": buildCookie(rawAccessToken),
        "location": "/home",
      },
    });
  }

  // GET /join?inv=<token> — invite preview (no redemption)
  if (path === "/join" && req.method === "GET") {
    const rawInv = url.searchParams.get("inv");
    if (!rawInv) return json({ error: "missing invite token" }, 400);
    const invHash = hashToken(rawInv);
    const db = getDb();
    const row = db.query(
      `SELECT i.token_hash, i.org_id, i.role, i.invited_by_user_id, i.intended_email,
              i.expires_at, i.redeemed_at,
              o.name AS org_name,
              u.display_name AS invited_by_name
       FROM invites i
       JOIN orgs o ON o.id = i.org_id
       JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.token_hash = ?`
    ).get(invHash) as any;
    if (!row) return json({ error: "invite not found" }, 404);
    if (row.redeemed_at) return json({ error: "invite already redeemed" }, 410);
    if (new Date(row.expires_at) < new Date()) return json({ error: "invite expired", expires_at: row.expires_at }, 410);

    return json({
      org: { id: row.org_id, name: row.org_name },
      role: row.role,
      invited_by: row.invited_by_name,
      intended_email: row.intended_email,
      expires_at: row.expires_at,
    });
  }

  // POST /invite — create invite (admin only). Accepts either `role` (single,
  // legacy) or `roles` (array — multi-role e.g. ["business","founder"]).
  // Stored as comma-separated in the invites.role column; split on claim.
  if (path === "/invite" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }

    const body = (await req.json()) as {
      org_id: string;
      role?: string;
      roles?: string[];
      intended_email?: string;
      ttl_days?: number;
    };
    const validRoles = ["admin", "founder", "technical", "business", "observer"];
    const roles = Array.from(new Set((body.roles?.length ? body.roles : (body.role ? [body.role] : []))
      .map(r => r.trim()).filter(Boolean)));
    if (!body.org_id || roles.length === 0) return json({ error: "org_id and at least one role required" }, 400);
    for (const r of roles) {
      if (!validRoles.includes(r)) return json({ error: `unknown role "${r}"; must be one of ${validRoles.join(",")}` }, 400);
    }
    if (!ctx.hasRole(body.org_id, "admin")) {
      return json({ error: "must be admin of target org" }, 403);
    }

    const rawToken = randomToken("inv", 24);
    const hash = hashToken(rawToken);
    const now = nowIso();
    const ttlMs = (body.ttl_days && body.ttl_days > 0 ? body.ttl_days * 24 * 60 * 60 * 1000 : INVITE_TTL_MS);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rolesCsv = roles.join(",");

    const db = getDb();
    db.query(
      `INSERT INTO invites (token_hash, org_id, role, invited_by_user_id, intended_email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(hash, body.org_id, rolesCsv, ctx.user.id, body.intended_email || null, now, expiresAt);

    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "invite.create", "invite", hash,
      JSON.stringify({ org_id: body.org_id, roles, intended_email: body.intended_email }),
      now);

    return json({
      invite_token: rawToken,
      expires_at: expiresAt,
      org_id: body.org_id,
      roles,
    });
  }

  // POST /claim — redeem an invite, create user + membership + access token
  if (path === "/claim" && req.method === "POST") {
    const body = (await req.json()) as {
      inv: string;
      display_name: string;
      email?: string;
    };
    if (!body.inv || !body.display_name?.trim()) {
      return json({ error: "inv and display_name required" }, 400);
    }

    const db = getDb();
    const hash = hashToken(body.inv);
    const inv = db.query(
      `SELECT token_hash, org_id, role, expires_at, redeemed_at FROM invites WHERE token_hash = ?`
    ).get(hash) as any;
    if (!inv) return json({ error: "invite not found" }, 404);
    if (inv.redeemed_at) return json({ error: "invite already redeemed" }, 410);
    if (new Date(inv.expires_at) < new Date()) return json({ error: "invite expired" }, 410);

    const userId = newId();
    const now = nowIso();
    const rawAccessToken = randomToken("at", 32);
    const accessHash = hashToken(rawAccessToken);
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);

    // Invite.role may be comma-separated for multi-role. Split + iterate.
    const rolesFromInvite = String(inv.role).split(",").map((s: string) => s.trim()).filter(Boolean);

    const tx = db.transaction(() => {
      // User
      db.query(
        `INSERT INTO users (id, display_name, email, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, body.display_name.trim(), body.email?.trim() || null, now, now);

      // One membership row per role (matches memberships UNIQUE constraint).
      for (const r of rolesFromInvite) {
        db.query(
          `INSERT INTO memberships (id, user_id, org_id, role, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(newId(), userId, inv.org_id, r, now);
      }

      // Access token
      db.query(
        `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      ).run(accessHash, userId, now, now, userAgent);

      // Burn invite
      db.query(
        `UPDATE invites SET redeemed_at = ?, redeemed_by_user_id = ? WHERE token_hash = ?`
      ).run(now, userId, hash);

      db.query(
        `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), userId, "invite.redeem", "invite", hash,
        JSON.stringify({ org_id: inv.org_id, role: inv.role, display_name: body.display_name }),
        now);
    });
    tx();

    return json(
      {
        ok: true,
        user: { id: userId, display_name: body.display_name.trim(), email: body.email || null },
        org_id: inv.org_id,
        roles: rolesFromInvite,
      },
      200,
      { "set-cookie": buildCookie(rawAccessToken) }
    );
  }

  // GET /admin/users — list all users (admin-only)
  if (path === "/admin/users" && req.method === "GET") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const db = getDb();
    const rows = db.query(
      `SELECT u.id, u.display_name, u.email, u.created_at, u.last_seen_at,
              GROUP_CONCAT(m.role || ':' || o.name, ', ') AS memberships
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN orgs o ON o.id = m.org_id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    ).all();
    return json({ users: rows });
  }

  // GET /admin/invites — list invites (admin-only)
  if (path === "/admin/invites" && req.method === "GET") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const db = getDb();
    const rows = db.query(
      `SELECT i.token_hash, i.org_id, o.name AS org_name, i.role,
              i.intended_email, i.created_at, i.expires_at, i.redeemed_at,
              ub.display_name AS invited_by_name,
              ur.display_name AS redeemed_by_name
       FROM invites i
       JOIN orgs o ON o.id = i.org_id
       JOIN users ub ON ub.id = i.invited_by_user_id
       LEFT JOIN users ur ON ur.id = i.redeemed_by_user_id
       ORDER BY i.created_at DESC
       LIMIT 200`
    ).all();
    return json({ invites: rows });
  }

  // POST /admin/users/remove-from-org — revoke a user's access: delete all
  // their memberships on the given org AND revoke all their access tokens.
  // Admin-only. Refuses to remove the last admin of an org (safety).
  if (path === "/admin/users/remove-from-org" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const body = (await req.json()) as { user_id: string; org_id: string };
    if (!body.user_id || !body.org_id) return json({ error: "user_id and org_id required" }, 400);
    if (!ctx.hasRole(body.org_id, "admin")) return json({ error: "must be admin of target org" }, 403);

    const db = getDb();
    // Safety: don't let the last admin of an org be removed. Note: SQLite
    // `.get()` returns undefined when no row matches, NOT null — `!== null`
    // would silently flag everyone as admin. Use `!= null` (loose) so both
    // undefined and null mean "no row found".
    const adminRow = db.query(
      `SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? AND role = 'admin'`
    ).get(body.user_id, body.org_id);
    const targetIsAdmin = adminRow != null;
    if (targetIsAdmin) {
      const adminCount = (db.query(
        `SELECT COUNT(DISTINCT user_id) AS c FROM memberships WHERE org_id = ? AND role = 'admin'`
      ).get(body.org_id) as { c: number }).c;
      if (adminCount <= 1) {
        return json({ error: "cannot remove the last admin of an org" }, 409);
      }
    }

    const tx = db.transaction(() => {
      // Delete all memberships on the org.
      db.query(`DELETE FROM memberships WHERE user_id = ? AND org_id = ?`).run(body.user_id, body.org_id);
      // Revoke all their access tokens (they may have memberships on other orgs,
      // but a fresh login flow would be simplest if we're removing them anywhere).
      db.query(
        `UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
      ).run(nowIso(), body.user_id);
      db.query(
        `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), ctx.user.id, "user.remove-from-org", "user", body.user_id,
        JSON.stringify({ org_id: body.org_id }), nowIso());
    });
    tx();

    return json({ ok: true });
  }

  // POST /admin/invites/revoke — revoke unredeemed invite (admin only)
  if (path === "/admin/invites/revoke" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    try { requireAdmin(ctx); } catch (r) { return r as Response; }
    const body = (await req.json()) as { token_hash: string };
    if (!body.token_hash) return json({ error: "token_hash required" }, 400);
    const db = getDb();
    const result = db.query(
      `UPDATE invites SET expires_at = ? WHERE token_hash = ? AND redeemed_at IS NULL`
    ).run(nowIso(), body.token_hash);
    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "invite.revoke", "invite", body.token_hash, "{}", nowIso());
    return json({ ok: true, changes: result.changes });
  }

  // GET /me/claude-link/status — does this user have Claude auth linked?
  if (path === "/me/claude-link/status" && req.method === "GET") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    ensureUserHome(ctx.user.id);
    if (!isClaudeLinked(ctx.user.id)) return json({ linked: false });
    // Prefer .credentials.json (current); fall back to config.json (legacy).
    const primary = userClaudeCredentialsPath(ctx.user.id);
    const fallback = userClaudeConfigPath(ctx.user.id);
    const path = existsSync(primary) ? primary : fallback;
    try {
      const st = statSync(path);
      return json({
        linked: true,
        linked_at: st.mtime.toISOString(),
        size_bytes: st.size,
        shape: existsSync(primary) ? "credentials" : "legacy-config",
      });
    } catch {
      return json({ linked: false });
    }
  }

  // POST /me/claude-link — upload Claude auth credentials. Body:
  //   { credentials_json: "<contents of ~/.claude/.credentials.json>" }
  // (legacy: { config_json: "..." } also accepted; stored as config.json.)
  // Written with 0600 perms under the user's scoped HOME.
  if (path === "/me/claude-link" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    const body = (await req.json().catch(() => ({}))) as { credentials_json?: string; config_json?: string };
    const isCreds = !!body.credentials_json?.trim();
    const raw = (body.credentials_json ?? body.config_json ?? "").trim();
    if (!raw) return json({ error: "credentials_json (or legacy config_json) required" }, 400);

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) {
      return json({ error: `must be valid JSON: ${String(e)}` }, 400);
    }
    if (typeof parsed !== "object" || parsed === null) {
      return json({ error: "must be a JSON object" }, 400);
    }
    // Known shape hints — loose validation only.
    const credsKeys = ["claudeAiOauth", "oauthAccount", "accessToken", "refreshToken", "primaryApiKey"];
    const configKeys = ["oauthAccount", "userID", "numStartups", "projects"];
    const target = isCreds ? credsKeys : configKeys;
    const looksRight = target.some(k => (parsed as Record<string, unknown>)[k] !== undefined);

    ensureUserHome(ctx.user.id);
    const dest = isCreds
      ? userClaudeCredentialsPath(ctx.user.id)
      : userClaudeConfigPath(ctx.user.id);
    try {
      writeFileSync(dest, raw, { mode: 0o600 });
      chmodSync(dest, 0o600);
    } catch (e) {
      return json({ error: `write failed: ${String(e)}` }, 500);
    }

    getDb().query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "claude.link", "user", ctx.user.id,
      JSON.stringify({ size_bytes: raw.length, shape: isCreds ? "credentials" : "legacy-config", recognized_shape: looksRight }), nowIso());

    return json({ ok: true, linked: true, shape: isCreds ? "credentials" : "legacy-config", recognized_shape: looksRight });
  }

  // POST /me/claude-link/unlink — remove stored auth (both credentials + legacy config).
  if (path === "/me/claude-link/unlink" && req.method === "POST") {
    let ctx;
    try { ctx = requireAuth(req); } catch (r) { return r as Response; }
    for (const p of [userClaudeCredentialsPath(ctx.user.id), userClaudeConfigPath(ctx.user.id)]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch (e) {
          return json({ error: `delete failed: ${String(e)}` }, 500);
        }
      }
    }
    getDb().query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), ctx.user.id, "claude.unlink", "user", ctx.user.id, "{}", nowIso());
    return json({ ok: true, linked: false });
  }

  // POST /bootstrap-session — dev-mode only. If exactly one user exists in
  // the DB (the legacy-migrated founder) AND the caller has no session yet,
  // mint an access-token cookie for that user. Lets the first admin land on
  // their own admin UI without going through /claim. Never allowed in prod.
  if (path === "/bootstrap-session" && req.method === "POST") {
    if ((process.env.ATELIER_AUTH_MODE ?? "dev") !== "dev") {
      return json({ error: "bootstrap-session disabled in production" }, 403);
    }
    // If already authenticated, just return current user — no new token.
    const existing = getAuthContext(req);
    if (existing) {
      return json({ ok: true, bootstrapped: false, user: existing.user, memberships: existing.memberships });
    }
    const db = getDb();
    // Pick the oldest admin — the legacy-migrated founder. Works regardless of
    // how many users are in the DB (useful once we've invited collaborators).
    const admin = db.query(
      `SELECT u.id, u.display_name
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       WHERE m.role = 'admin'
       ORDER BY u.created_at ASC
       LIMIT 1`
    ).get() as { id: string; display_name: string } | undefined;
    if (!admin) {
      return json({ error: "bootstrap refused — no admin user exists" }, 409);
    }
    const userId = admin.id;
    const rawAccessToken = randomToken("at", 32);
    const accessHash = hashToken(rawAccessToken);
    const now = nowIso();
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 240);

    db.query(
      `INSERT INTO access_tokens (token_hash, user_id, created_at, last_used_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    ).run(accessHash, userId, now, now, userAgent);
    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), userId, "session.bootstrap", "user", userId, JSON.stringify({ mode: "dev" }), now);

    return json(
      { ok: true, bootstrapped: true, user_id: userId },
      200,
      { "set-cookie": buildCookie(rawAccessToken) }
    );
  }

  // GET /orgs — list orgs user has membership in (with their highest role)
  if (path === "/orgs" && req.method === "GET") {
    const ctx = getAuthContext(req);
    if (!ctx) return json({ orgs: [] });
    const db = getDb();
    const orgIds = Array.from(new Set(ctx.memberships.map(m => m.org_id)));
    if (orgIds.length === 0) return json({ orgs: [] });
    const placeholders = orgIds.map(() => "?").join(",");
    const rows = db.query(
      `SELECT id, name, default_visibility FROM orgs WHERE id IN (${placeholders})`
    ).all(...orgIds) as { id: string; name: string; default_visibility: string }[];
    const orgsWithRole = rows.map(r => {
      const isAdmin = ctx.memberships.some(m => m.org_id === r.id && m.role === "admin");
      return {
        id: r.id,
        name: r.name,
        default_visibility: r.default_visibility,
        role: isAdmin ? "admin" : "member",
      };
    });
    return json({ orgs: orgsWithRole });
  }

  // GET /orgs/:id/projects — list projects in an org that the caller can access
  {
    const m = path.match(/^\/orgs\/([^\/]+)\/projects$/);
    if (m && req.method === "GET") {
      let ctx;
      try { ctx = requireAuth(req); } catch (r) { return r as Response; }
      const orgId = m[1];

      const inOrg = ctx.memberships.some(m => m.org_id === orgId);
      if (!inOrg) return json({ error: "not a member of this org" }, 403);

      const db = getDb();
      const isAdmin = ctx.memberships.some(m => m.org_id === orgId && m.role === "admin");
      const orgRow = db.query(
        `SELECT default_visibility FROM orgs WHERE id = ?`
      ).get(orgId) as { default_visibility: string } | undefined;
      if (!orgRow) return json({ error: "org not found" }, 404);

      let rows;
      if (isAdmin || orgRow.default_visibility === "all") {
        // See everything in the org.
        rows = db.query(
          `SELECT p.id, p.name, p.display_name, p.description, p.created_at, p.archived_at,
                  ${isAdmin ? "'admin'" : "'editor'"} AS role
           FROM projects p
           WHERE p.org_id = ? AND p.archived_at IS NULL
           ORDER BY p.created_at DESC`
        ).all(orgId);
      } else {
        // members-default: only projects with an explicit row.
        rows = db.query(
          `SELECT p.id, p.name, p.display_name, p.description, p.created_at, p.archived_at,
                  pm.role AS role
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.id
           WHERE p.org_id = ? AND pm.user_id = ? AND p.archived_at IS NULL
           ORDER BY p.created_at DESC`
        ).all(orgId, ctx.user.id);
      }

      return json({ projects: rows });
    }
  }

  return null; // not an auth route
}
