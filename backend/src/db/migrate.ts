/**
 * Legacy-to-DB migration: on boot, if `users` is empty but `agents/config.yaml`
 * has a configured founder, promote that founder into the first user + first
 * org + admin+founder memberships. Idempotent — safe to run every boot.
 *
 * Does NOT touch `agents/config.yaml` — it remains the source of PTY-spawn
 * values (agent_name, active_project) until a broader migration later.
 */

import { getDb, newId, nowIso } from "./index";
import { loadAgentConfig } from "~/config";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";

export interface MigrationSummary {
  ran: boolean;
  reason: string;
  first_user_id?: string;
  first_org_id?: string;
}

export function runLegacyMigration(): MigrationSummary {
  const db = getDb();
  const userCount = (db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (userCount > 0) {
    return { ran: false, reason: "users table already populated" };
  }

  // Check for existing agent config.
  const configPath = resolve(config.agentsDir, "config.yaml");
  if (!existsSync(configPath)) {
    return { ran: false, reason: "no legacy agents/config.yaml to migrate from" };
  }

  let cfg;
  try {
    cfg = loadAgentConfig();
  } catch {
    return { ran: false, reason: "agents/config.yaml exists but failed to parse" };
  }

  const founderName = (cfg.founder_name || "").trim();
  const orgName = (cfg.org_name || "").trim() || "Default Org";

  if (!founderName) {
    return { ran: false, reason: "legacy config has no founder_name yet" };
  }

  const userId = newId();
  const orgId = newId();
  const now = nowIso();

  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO users (id, display_name, email, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, founderName, cfg.founder_email || null, now, now);

    db.query(
      `INSERT INTO orgs (id, name, owner_user_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(orgId, orgName, userId, now);

    // Two memberships: admin AND founder. Both apply.
    db.query(
      `INSERT INTO memberships (id, user_id, org_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId(), userId, orgId, "admin", now);
    db.query(
      `INSERT INTO memberships (id, user_id, org_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId(), userId, orgId, "founder", now);

    db.query(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId(), userId, "legacy.migrate", "user", userId,
      JSON.stringify({ founder_name: founderName, org_name: orgName, from: "agents/config.yaml" }),
      now
    );
  });
  tx();

  return {
    ran: true,
    reason: "promoted legacy founder to first user + org",
    first_user_id: userId,
    first_org_id: orgId,
  };
}

/** Idempotent backfill: every directory under projects/ should have a row in
 *  the new `projects` table. Runs on every boot. Attaches new rows to the
 *  first org of the legacy admin (oldest user). Lossless — never edits
 *  on-disk files, never modifies existing rows. */
export function backfillProjectsFromDisk(): { added: number } {
  const db = getDb();

  // Find legacy admin (oldest user) and their first org.
  const adminRow = db.query(
    `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`
  ).get() as { id: string } | undefined;
  if (!adminRow) return { added: 0 };

  const orgRow = db.query(
    `SELECT id FROM orgs WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1`
  ).get(adminRow.id) as { id: string } | undefined;
  if (!orgRow) return { added: 0 };

  const projectsDir = config.projectsDir;
  if (!existsSync(projectsDir)) return { added: 0 };

  let entries: string[] = [];
  try { entries = readdirSync(projectsDir); } catch { return { added: 0 }; }

  let added = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = resolve(projectsDir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const exists = db.query(
      `SELECT id FROM projects WHERE org_id = ? AND name = ?`
    ).get(orgRow.id, name);
    if (exists) continue;

    const now = nowIso();
    db.query(
      `INSERT INTO projects (id, org_id, name, display_name, description,
                              created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), orgRow.id, name, name, null, now, adminRow.id);
    added += 1;
  }

  return { added };
}
