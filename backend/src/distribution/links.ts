/**
 * distribution_links DB layer — mirror of `settings/agents.ts`'s
 * provider-link helpers, but for distribution adapters.
 *
 * Phase A storage: config_json is plaintext (single-founder local SQLite).
 * A future encrypted-column migration is the only place credentials would
 * touch disk in a different form — adapters and routes don't need to change.
 */

import { getDb, newId, nowIso } from "~/db";

export type DistributionLinkStatus = "configured" | "verified" | "failed" | "unconfigured";

export interface DistributionLink {
  adapter_id: string;
  project: string | null;
  status: DistributionLinkStatus;
  config: Record<string, unknown> | null;
  last_verified_at: string | null;
  last_verify_detail: string | null;
  last_verify_ok: boolean;
  last_config_written_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DistributionLinkRow {
  adapter_id: string;
  project: string | null;
  status: DistributionLinkStatus;
  config_json: string | null;
  last_verified_at: string | null;
  last_verify_detail: string | null;
  last_verify_ok: number;
  last_config_written_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToLink(row: DistributionLinkRow): DistributionLink {
  let config: Record<string, unknown> | null = null;
  if (row.config_json) {
    try { config = JSON.parse(row.config_json) as Record<string, unknown>; }
    catch { config = null; }
  }
  return {
    adapter_id: row.adapter_id,
    project: row.project,
    status: row.status,
    config,
    last_verified_at: row.last_verified_at,
    last_verify_detail: row.last_verify_detail,
    last_verify_ok: row.last_verify_ok === 1,
    last_config_written_at: row.last_config_written_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listDistributionLinks(userId: string): DistributionLink[] {
  const db = getDb();
  const rows = db.query(
    `SELECT adapter_id, project, status, config_json, last_verified_at,
            last_verify_detail, last_verify_ok, last_config_written_at,
            created_at, updated_at
       FROM distribution_links
      WHERE user_id = ?`,
  ).all(userId) as DistributionLinkRow[];
  return rows.map(rowToLink);
}

export function getDistributionLink(userId: string, adapterId: string): DistributionLink | null {
  const db = getDb();
  const row = db.query(
    `SELECT adapter_id, project, status, config_json, last_verified_at,
            last_verify_detail, last_verify_ok, last_config_written_at,
            created_at, updated_at
       FROM distribution_links
      WHERE user_id = ? AND adapter_id = ?`,
  ).get(userId, adapterId) as DistributionLinkRow | undefined;
  return row ? rowToLink(row) : null;
}

export function upsertDistributionLink(
  userId: string,
  adapterId: string,
  fields: { config?: Record<string, unknown>; project?: string | null; status?: DistributionLinkStatus },
): DistributionLink {
  const db = getDb();
  const now = nowIso();
  const existing = getDistributionLink(userId, adapterId);
  const config = fields.config ?? existing?.config ?? null;
  const project = fields.project !== undefined ? fields.project : (existing?.project ?? null);
  const status = fields.status ?? existing?.status ?? "configured";

  if (existing) {
    db.query(
      `UPDATE distribution_links
          SET project = ?, status = ?, config_json = ?, updated_at = ?
        WHERE user_id = ? AND adapter_id = ?`,
    ).run(
      project, status,
      config ? JSON.stringify(config) : null,
      now,
      userId, adapterId,
    );
  } else {
    db.query(
      `INSERT INTO distribution_links
         (id, user_id, adapter_id, project, status, config_json,
          last_verified_at, last_verify_detail, last_verify_ok,
          last_config_written_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)`,
    ).run(
      newId(), userId, adapterId, project, status,
      config ? JSON.stringify(config) : null,
      now, now,
    );
  }
  return getDistributionLink(userId, adapterId)!;
}

export function recordVerifyResult(
  userId: string,
  adapterId: string,
  ok: boolean,
  detail: string,
): DistributionLink | null {
  const existing = getDistributionLink(userId, adapterId);
  if (!existing) return null;
  const db = getDb();
  const now = nowIso();
  db.query(
    `UPDATE distribution_links
        SET status = ?, last_verified_at = ?, last_verify_detail = ?, last_verify_ok = ?, updated_at = ?
      WHERE user_id = ? AND adapter_id = ?`,
  ).run(
    ok ? "verified" : "failed",
    now, detail, ok ? 1 : 0, now,
    userId, adapterId,
  );
  return getDistributionLink(userId, adapterId);
}

export function recordWriteConfig(userId: string, adapterId: string): DistributionLink | null {
  const existing = getDistributionLink(userId, adapterId);
  if (!existing) return null;
  const db = getDb();
  const now = nowIso();
  db.query(
    `UPDATE distribution_links
        SET last_config_written_at = ?, updated_at = ?
      WHERE user_id = ? AND adapter_id = ?`,
  ).run(now, now, userId, adapterId);
  return getDistributionLink(userId, adapterId);
}

export function deleteDistributionLink(userId: string, adapterId: string): boolean {
  const db = getDb();
  const r = db.query(
    `DELETE FROM distribution_links WHERE user_id = ? AND adapter_id = ?`,
  ).run(userId, adapterId);
  return r.changes > 0;
}
