# Atelier · Auth Model

Atelier is shipped as an **on-prem self-hostable** tool. Its security posture
is pragmatic: secure-by-default for any reachable deployment, frictionless
for purely local use, and layerable with edge-level auth (Cloudflare Access)
when the tunnel is exposed to the internet.

## What's enforced in code

### Application-level auth (always on, post-bootstrap)

| Layer | What it does |
|---|---|
| Global auth gate | Once any user exists in the SQLite `users` table, every backend endpoint requires a valid auth cookie EXCEPT `/health`, the auth bootstrap routes, and `/onboarding/*` (which self-gates internally). |
| Sign-in: email + password | Argon2id hashing via `Bun.password`, no passwords ever logged. |
| Sign-in: magic link | Passwordless link delivered via host log + `data/magic-links.txt` (no SMTP yet). 15-min expiry, single-use, only issued for **approved** users. |
| Sign-in: invite link | Admin-only minted invite; first claim creates the user record + memberships. |
| **Request access** | New visitor submits email + password + name → user record created with `status='pending'`. Cannot sign in until an admin approves. |
| Admin approval | `GET /admin/access-requests`, `POST /admin/access-requests/decide` — admin-only endpoints to list and decide pending requests. Optional org+role assignment on approve. |
| Cookies | httpOnly, SameSite=Lax, Secure (in non-dev mode), 30-day max-age. |
| Audit log | Every state-changing action is logged in the `audit_log` table. |

The first-ever user on a fresh install is auto-approved and bootstrapped as
admin (so the host doesn't have to approve themselves).

### Edge-level auth (optional, for tunneled deployments)

Atelier can sit behind **Cloudflare Access** (free tier, up to 50 users on
the Zero Trust plan). When `ATELIER_TRUST_CF_ACCESS=true` is set:

- The backend trusts the `Cf-Access-Authenticated-User-Email` header that
  Cloudflare adds AFTER verifying the visitor's JWT at the edge.
- The visitor's email is matched against the local `users` table; if found
  with `status='approved'`, they're authenticated transparently — no
  cookie needed.
- Falls through to cookie auth if the header is missing or the email isn't
  in the local users table.

This gives you two layers: Cloudflare verifies the human at the edge, and
Atelier verifies they have a workspace role.

## Local-only mode

Just run the npm package, don't expose it. `localhost:5174` is private to
your machine. The auth gate still engages once anyone registers, but you
can register yourself on the first visit and you're done.

```bash
npx atelier             # one-shot dev server on localhost:5174
```

Environment variables you might set:

| Variable | Default | Effect |
|---|---|---|
| `ATELIER_AUTH_MODE` | `dev` | Set to anything else (e.g. `prod`) to force `Secure;` flag on cookies. Required for HTTPS deployments. |
| `ATELIER_TRUST_CF_ACCESS` | unset | When `true`, accept the `Cf-Access-Authenticated-User-Email` header as identity. |
| `ATELIER_BASE_URL` | derived from request | Override if your reverse proxy mangles `Host`/`Origin`. Used only for magic-link URL emission. |

## Cloudflare Access setup (15 minutes, host-side)

This protects your tunnel hostname so only emails on your allow-list can
reach Atelier — even before the application's own auth runs.

**You need to do these steps yourself** (no automation possible from
inside Atelier):

1. **Sign up / log in** to Cloudflare Zero Trust → free up to 50 users.
   <https://one.dash.cloudflare.com>

2. **Create a team domain** if you don't have one: e.g. `mydomain.cloudflareaccess.com`.

3. **Add an Access Application**:
   - Type: **Self-hosted**.
   - Application name: `Atelier`.
   - Application domain: your tunnel hostname (e.g. `atelier.example.com`).
   - Identity providers: enable **One-time PIN** (email OTP) — no IDP
     setup needed. Or wire Google / GitHub if you prefer.

4. **Add a policy**:
   - Action: **Allow**.
   - Include rule: **Emails** → list every email you want to let in.
   - Optional: **Emails ending in** for whole domains.

5. **Save**. Cloudflare now shows a login page on `atelier.example.com`
   to anyone who hasn't authenticated. After they pass the email-OTP, CF
   forwards their request with `Cf-Access-Authenticated-User-Email` set.

6. **In your Atelier `.env`**, set:
   ```
   ATELIER_TRUST_CF_ACCESS=true
   ```
   Restart the backend.

7. **In Atelier**, make sure each CF-allowlisted email exists as an
   approved user in your `users` table — either pre-create them via
   admin invite, or have them go through the Atelier `Request access`
   flow once and approve them. After that, they sign in transparently
   (no Atelier login screen) for as long as their CF Access session is
   valid.

### Why both layers?

CF Access verifies a human is who they say they are. Atelier verifies that
human has a workspace role (admin / founder / observer / etc.) and applies
per-user data isolation (`data/users/<uid>/.claude/`). They solve different
problems and stack cleanly.

## What still needs your hands

The following can't be automated from inside Atelier:

- **Cloudflare Zero Trust account creation** — must happen in the CF dashboard.
- **Adding emails to the Access policy allow-list** — CF dashboard.
- **DNS for the tunnel hostname** — CF tunnel config / `cloudflared`.
- **Initial approval of the first non-host user** — admin clicks
  "Approve" inside Atelier's People panel.

Everything else (password setting, magic-link delivery via local file,
session management, role assignment, audit logging) lives inside Atelier
and runs on every machine.
