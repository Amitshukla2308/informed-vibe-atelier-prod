/**
 * Atelier database singleton (bun:sqlite).
 *
 * Single file at data/atelier.db. Held open for the lifetime of the process.
 * Prepared statements created lazily in the callers that need them.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "~/config";
import { SCHEMA_SQL } from "./schema";

let _db: Database | null = null;

function dbPath(): string {
  return resolve(config.atelierRoot, "data", "atelier.db");
}

export function getDb(): Database {
  if (_db) return _db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path, { create: true });
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  _db.exec(SCHEMA_SQL);
  applyAddColumnMigrations(_db);
  return _db;
}

/** Idempotent ALTER TABLE ADD COLUMN migrations for tables that pre-date a
 *  schema change. SQLite has no IF NOT EXISTS for ADD COLUMN, so we read
 *  PRAGMA table_info and only add what's missing. Safe to run on every boot. */
function applyAddColumnMigrations(db: Database) {
  const ensureColumn = (table: string, name: string, ddl: string) => {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some(c => c.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  // Email/password + access-status columns added 2026-04-25.
  ensureColumn("users", "password_hash",       "password_hash TEXT");
  ensureColumn("users", "status",              "status TEXT NOT NULL DEFAULT 'approved'");
  ensureColumn("users", "requested_at",        "requested_at TEXT");
  ensureColumn("users", "approved_at",         "approved_at TEXT");
  ensureColumn("users", "approved_by_user_id", "approved_by_user_id TEXT");
  // contributor_kind: founder | technical | business | observer — decoupled
  // from access roles, used for UI coloring of contributions.
  ensureColumn("users", "contributor_kind",    "contributor_kind TEXT");
  // Org-level default visibility — added 2026-04-25 with the projects model.
  ensureColumn("orgs",  "default_visibility",  "default_visibility TEXT NOT NULL DEFAULT 'members'");
  // Indexes for the new columns — created after columns exist.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_status      ON users(status)`);

  // Drop the agent_name CHECK constraint on agent_configs if a legacy schema
  // still has it. Agents are added often (reflect joined Drafter/Allocator/
  // Implementer/Senior-Reviewer 2026-04-26); validating the set in TypeScript
  // means new agents land without a follow-up migration.
  try {
    const t = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_configs'`).get() as { sql?: string } | undefined;
    if (t?.sql && /agent_name\s+TEXT\s+NOT\s+NULL\s+CHECK/i.test(t.sql)) {
      db.exec(`
        CREATE TABLE agent_configs_new (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id),
          agent_name   TEXT NOT NULL,
          mode         TEXT NOT NULL CHECK (mode IN ('manual','semi_auto','auto')) DEFAULT 'manual',
          provider     TEXT NOT NULL DEFAULT 'qwen-code',
          updated_at   TEXT NOT NULL,
          UNIQUE(user_id, agent_name)
        );
        INSERT INTO agent_configs_new (id, user_id, agent_name, mode, provider, updated_at)
          SELECT id, user_id, agent_name, mode, provider, updated_at FROM agent_configs;
        DROP TABLE agent_configs;
        ALTER TABLE agent_configs_new RENAME TO agent_configs;
        CREATE INDEX IF NOT EXISTS idx_agent_configs_user ON agent_configs(user_id);
      `);
    }
  } catch (e) {
    console.warn(`[db.migrate] agent_configs CHECK drop failed: ${String(e).slice(0, 200)}`);
  }

  // Expand magic_links.kind CHECK to include 'password_reset'. The original
  // table only allowed 'signin' / 'invite_new'; the email-based reset flow
  // (added 2026-05-01) adds a third kind. SQLite has no ALTER CHECK, so we
  // copy → drop → rename. Idempotent: only fires when the old CHECK is found.
  try {
    const t = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='magic_links'`).get() as { sql?: string } | undefined;
    if (t?.sql && !/password_reset/i.test(t.sql)) {
      db.exec(`
        CREATE TABLE magic_links_new (
          token_hash    TEXT PRIMARY KEY,
          email         TEXT NOT NULL,
          kind          TEXT NOT NULL CHECK (kind IN ('signin','invite_new','password_reset')),
          display_name  TEXT,
          created_at    TEXT NOT NULL,
          expires_at    TEXT NOT NULL,
          used_at       TEXT,
          requested_ua  TEXT
        );
        INSERT INTO magic_links_new (token_hash, email, kind, display_name, created_at, expires_at, used_at, requested_ua)
          SELECT token_hash, email, kind, display_name, created_at, expires_at, used_at, requested_ua FROM magic_links;
        DROP TABLE magic_links;
        ALTER TABLE magic_links_new RENAME TO magic_links;
        CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_links(email);
      `);
    }
  } catch (e) {
    console.warn(`[db.migrate] magic_links CHECK expand failed: ${String(e).slice(0, 200)}`);
  }
}

/** Truncate-all for tests / resets. Never call in prod. */
export function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM access_tokens;
    DELETE FROM invites;
    DELETE FROM memberships;
    DELETE FROM orgs;
    DELETE FROM users;
  `);
}

export function newId(): string {
  // crypto.randomUUID is globally available in Bun.
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashToken(raw: string): string {
  // Using Bun's built-in crypto for sha256 hex.
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(raw);
  return hasher.digest("hex");
}

export function randomToken(prefix: string, bytes = 32): string {
  // URL-safe base64 of random bytes.
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  const b64 = Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}_${b64}`;
}
