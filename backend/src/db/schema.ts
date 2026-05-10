/**
 * SQLite schema for Atelier's auth + user module (pattern γ).
 *
 * Uses TEXT for all ids (UUIDs) for URL-friendliness + portability.
 * Uses TEXT ISO8601 for timestamps — bun's CURRENT_TIMESTAMP default works too,
 * but explicit ISO strings make export/audit trivially readable.
 *
 * Tables are idempotent: CREATE IF NOT EXISTS. Safe to run on every boot.
 */

export const SCHEMA_SQL = `
  -- users: atelier identity. email is optional at claim time; email-based
  -- password reset is a future (β) feature. For now, access tokens are the
  -- sole credential.
  CREATE TABLE IF NOT EXISTS users (
    id                     TEXT PRIMARY KEY,
    display_name           TEXT NOT NULL,
    email                  TEXT,
    password_hash          TEXT,
    status                 TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected','suspended')),
    requested_at           TEXT,
    approved_at            TEXT,
    approved_by_user_id    TEXT,
    created_at             TEXT NOT NULL,
    last_seen_at           TEXT
  );

  -- NOTE: indexes for password/status columns live in the migration step
  -- (db/index.ts) because they reference columns that legacy databases gain
  -- via ALTER TABLE on first boot.

  -- orgs: a workspace. Each project belongs to exactly one org.
  -- owner_user_id is the original admin; can be changed via admin UI.
  CREATE TABLE IF NOT EXISTS orgs (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    owner_user_id      TEXT NOT NULL REFERENCES users(id),
    default_visibility TEXT NOT NULL DEFAULT 'members'
                          CHECK (default_visibility IN ('members','all')),
    created_at         TEXT NOT NULL
  );

  -- projects: every project belongs to exactly one org. Mirrors the on-disk
  -- directory under projects/<name>/. A backfill on boot creates these rows
  -- for any pre-existing on-disk projects so legacy installs don't lose data.
  CREATE TABLE IF NOT EXISTS projects (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES orgs(id),
    name                TEXT NOT NULL,
    display_name        TEXT,
    description         TEXT,
    created_at          TEXT NOT NULL,
    created_by_user_id  TEXT REFERENCES users(id),
    archived_at         TEXT,
    UNIQUE(org_id, name)
  );

  -- project_members: explicit per-project access. Read in conjunction with
  -- the org-admin implicit-access rule (admins see all projects in their org)
  -- and the org default_visibility='all' shortcut (members see all without rows).
  CREATE TABLE IF NOT EXISTS project_members (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    project_id  TEXT NOT NULL REFERENCES projects(id),
    role        TEXT NOT NULL CHECK (role IN ('editor','viewer')),
    created_at  TEXT NOT NULL,
    UNIQUE(user_id, project_id)
  );

  CREATE INDEX IF NOT EXISTS idx_projects_org      ON projects(org_id);
  CREATE INDEX IF NOT EXISTS idx_pmembers_user     ON project_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_pmembers_project  ON project_members(project_id);

  -- memberships: user<->org with role. One user can hold multiple roles on
  -- one org (e.g., [admin, founder] or [technical, founder-proxy]).
  CREATE TABLE IF NOT EXISTS memberships (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    org_id      TEXT NOT NULL REFERENCES orgs(id),
    role        TEXT NOT NULL CHECK (role IN ('admin','founder','technical','business','observer')),
    created_at  TEXT NOT NULL,
    UNIQUE(user_id, org_id, role)
  );

  -- invites: one-time tokens that redeem to a user+membership.
  -- token_hash = SHA-256 of the raw invite token (never store raw).
  CREATE TABLE IF NOT EXISTS invites (
    token_hash           TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs(id),
    role                 TEXT NOT NULL,
    invited_by_user_id   TEXT NOT NULL REFERENCES users(id),
    intended_email       TEXT,
    created_at           TEXT NOT NULL,
    expires_at           TEXT NOT NULL,
    redeemed_at          TEXT,
    redeemed_by_user_id  TEXT REFERENCES users(id)
  );

  -- access_tokens: long-lived bearer for in-app sessions. Stored as SHA-256
  -- hash. Raw token is sent once to the client as httpOnly cookie.
  CREATE TABLE IF NOT EXISTS access_tokens (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT,
    user_agent    TEXT
  );

  -- magic_links: one-time email-bound tokens. token_hash = SHA-256 of the
  -- raw token. kind narrows behaviour:
  --   'signin'         — resolves to an existing user by email, sets cookie.
  --   'invite_new'     — creates a new user record with display_name on first claim.
  --   'password_reset' — consumed by /auth/reset-password/confirm to update password_hash
  --                      and sign in. TTL longer (30min) since the user reads email.
  -- Single-use (used_at != NULL → dead). Expiry per kind enforced in route code.
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash    TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('signin','invite_new','password_reset')),
    display_name  TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    used_at       TEXT,
    requested_ua  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_links(email);

  -- audit_log: every state-changing action gets a row. Cheap to query
  -- for "who did what when" forensics.
  CREATE TABLE IF NOT EXISTS audit_log (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    details_json  TEXT,
    created_at    TEXT NOT NULL
  );

  -- agent_configs: per-user, per-agent runtime settings (mode + provider).
  -- One row per (user_id, agent_name). Founder sees their settings; in Phase A
  -- single-founder, user_id is always the active founder.
  -- agent_name: drafter | allocator | implementer | senior_reviewer
  -- mode: manual | semi_auto | auto
  -- provider: free string keyed to provider_links.provider (claude|gemini|qwen-code|openai|anthropic-api|...)
  CREATE TABLE IF NOT EXISTS agent_configs (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    agent_name   TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('manual','semi_auto','auto')) DEFAULT 'manual',
    provider     TEXT NOT NULL DEFAULT 'qwen-code',
    updated_at   TEXT NOT NULL,
    UNIQUE(user_id, agent_name)
  );

  -- provider_links: per-user, per-provider auth state. Stored opaquely;
  -- credential is either an env-var pointer or a path to a binary (CLI providers)
  -- or an encrypted blob (API-key providers). Phase A: env-var pointers only.
  CREATE TABLE IF NOT EXISTS provider_links (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    provider      TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('linked','unlinked','expired')) DEFAULT 'unlinked',
    bin_path      TEXT,
    base_url      TEXT,
    model_id      TEXT,
    api_key_env   TEXT,
    notes         TEXT,
    linked_at     TEXT,
    updated_at    TEXT NOT NULL,
    UNIQUE(user_id, provider)
  );

  -- implementer_runs: per-execution log row mirroring og_artifacts/ledger/<node>.jsonl
  -- but queryable. Surfaces the Recent Activity feed on Home.
  CREATE TABLE IF NOT EXISTS implementer_runs (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    project       TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    branch        TEXT,
    final_state   TEXT NOT NULL,
    reason        TEXT,
    diff_bytes    INTEGER NOT NULL DEFAULT 0,
    tsc_ok        INTEGER NOT NULL DEFAULT 0,
    attempt       INTEGER NOT NULL DEFAULT 1,
    qwen_exit     INTEGER,
    qwen_elapsed  REAL,
    qwen_tools    INTEGER,
    tokens_in     INTEGER NOT NULL DEFAULT 0,
    tokens_out    INTEGER NOT NULL DEFAULT 0,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memberships_user  ON memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_org   ON memberships(org_id);
  CREATE INDEX IF NOT EXISTS idx_invites_org       ON invites(org_id);
  CREATE INDEX IF NOT EXISTS idx_invites_email     ON invites(intended_email);
  CREATE INDEX IF NOT EXISTS idx_access_user       ON access_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user        ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created     ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_configs_user ON agent_configs(user_id);
  CREATE INDEX IF NOT EXISTS idx_provider_links_user ON provider_links(user_id);
  CREATE INDEX IF NOT EXISTS idx_implementer_runs_node ON implementer_runs(project, node_id);
  CREATE INDEX IF NOT EXISTS idx_implementer_runs_finished ON implementer_runs(finished_at);

  -- canvas_node_events: append-only event log per canvas node. Mirrors the
  -- Standard task_events pattern. Powers the Activity firehose tab and the
  -- per-node event timeline in the drawer. broadcastImplementerEvent writes
  -- here in addition to broadcasting on the WS so reloads have history.
  -- See docs/CANVAS_REFRAME_DECISIONS.md §4.
  CREATE TABLE IF NOT EXISTS canvas_node_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    ts          TEXT NOT NULL,
    agent       TEXT NOT NULL,        -- drafter | allocator | implementer | founder | cofounder | system
    kind        TEXT NOT NULL,        -- create | state | block | unblock | discuss | resolve | comment | impl-event
    payload     TEXT,                  -- JSON
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_canvas_events_node     ON canvas_node_events(project, node_id, ts);
  CREATE INDEX IF NOT EXISTS idx_canvas_events_recent   ON canvas_node_events(project, ts);

  -- canvas_node_comments: human-readable text writes by founders, cofounders,
  -- or agents (with author_role). Distinct from events: events are
  -- machine-readable state changes, comments are prose handoffs.
  -- See docs/CANVAS_REFRAME_DECISIONS.md §7.
  CREATE TABLE IF NOT EXISTS canvas_node_comments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project         TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    author_user_id  TEXT,                -- null for agent comments
    author_role     TEXT NOT NULL,        -- founder | cofounder | drafter | allocator | implementer | system
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_canvas_comments_node ON canvas_node_comments(project, node_id, created_at);

  -- distribution_links: per-user, per-distribution-adapter config + credentials.
  -- Adapter ids: cloudflare-dns | razorpay | plausible | resend (Phase A set —
  -- new adapters add rows without schema changes; the id is a free text key).
  -- status:    'configured' (credentials saved, never verified)
  --          | 'verified'   (last verify() call returned ok)
  --          | 'failed'     (last verify() returned ok=false)
  --          | 'unconfigured' (default — no row, surfaced to UI as "needs setup")
  -- config_json: JSON-encoded adapter-specific config. Schema is per-adapter
  --              (zod-validated server-side before storage). Phase A stores
  --              this PLAINTEXT — a future migration will encrypt at rest.
  -- last_verified_at + last_verify_detail: most recent verify() result.
  -- Distinct from provider_links (agent-side providers) — distribution is the
  -- *outbound* go-live cliff, agents are the *inbound* execution layer.
  CREATE TABLE IF NOT EXISTS distribution_links (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id),
    adapter_id          TEXT NOT NULL,
    project             TEXT,
    status              TEXT NOT NULL CHECK (status IN ('configured','verified','failed','unconfigured')) DEFAULT 'configured',
    config_json         TEXT,
    last_verified_at    TEXT,
    last_verify_detail  TEXT,
    last_verify_ok      INTEGER NOT NULL DEFAULT 0,
    last_config_written_at TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(user_id, adapter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_distribution_links_user ON distribution_links(user_id);
`;
