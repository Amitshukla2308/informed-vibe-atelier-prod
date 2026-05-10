/**
 * Project access resolution.
 *
 * Single function: given (userId, projectIdentifier) return whether the user
 * can touch the project and at what role. Implements the visibility rule
 * documented in the design pass:
 *
 *   1. Project belongs to org X.
 *   2. If user is admin of X      → access at role 'admin' (implicit).
 *   3. If org X has default_visibility='all' AND user is a member of X
 *                                  → access at role 'editor' (implicit).
 *   4. If user has a project_members row on this project
 *                                  → access at the row's role.
 *   5. Otherwise                   → no access.
 *
 * `projectIdentifier` accepts either the project_id (UUID) or the on-disk
 * project name — handlers commonly know one or the other.
 */

import { getDb } from "~/db";

export type ProjectRole = "admin" | "editor" | "viewer";

export interface ProjectAccess {
  ok: boolean;
  role?: ProjectRole;
  /** Why the answer is what it is — useful for logging + admin diagnostics. */
  reason: string;
  project?: { id: string; org_id: string; name: string };
}

export function canUserAccessProject(
  userId: string,
  projectIdentifier: string
): ProjectAccess {
  const db = getDb();

  // Resolve project — accept either id or name.
  const project = (db.query(
    `SELECT id, org_id, name FROM projects WHERE id = ? OR name = ? LIMIT 1`
  ).get(projectIdentifier, projectIdentifier)) as
    | { id: string; org_id: string; name: string }
    | undefined;

  if (!project) {
    return { ok: false, reason: "project not found" };
  }

  // Org admin → implicit admin role on every project in the org.
  const adminMembership = db.query(
    `SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? AND role = 'admin'`
  ).get(userId, project.org_id);
  if (adminMembership != null) {
    return { ok: true, role: "admin", reason: "org admin", project };
  }

  // Org member?
  const anyMembership = db.query(
    `SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ?`
  ).get(userId, project.org_id);
  const isOrgMember = anyMembership != null;

  // Default-visibility=all gives org members editor access without explicit rows.
  if (isOrgMember) {
    const orgRow = db.query(
      `SELECT default_visibility FROM orgs WHERE id = ?`
    ).get(project.org_id) as { default_visibility: string } | undefined;
    if (orgRow?.default_visibility === "all") {
      return { ok: true, role: "editor", reason: "org open-visibility", project };
    }
  }

  // Explicit project_members row.
  const explicit = db.query(
    `SELECT role FROM project_members WHERE user_id = ? AND project_id = ?`
  ).get(userId, project.id) as { role: ProjectRole } | undefined;
  if (explicit) {
    return { ok: true, role: explicit.role, reason: "project_members row", project };
  }

  return {
    ok: false,
    reason: isOrgMember
      ? "no project_members row in members-default org"
      : "not a member of the org",
    project,
  };
}

/** Convenience: throw a 403 Response if access is denied; otherwise return the access. */
export function requireProjectAccess(
  userId: string,
  projectIdentifier: string,
  minRole: ProjectRole = "viewer"
): ProjectAccess {
  const access = canUserAccessProject(userId, projectIdentifier);
  if (!access.ok) {
    throw new Response(JSON.stringify({ error: "no access to this project", reason: access.reason }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  // Role hierarchy for write gating: admin > editor > viewer.
  const order: Record<ProjectRole, number> = { admin: 3, editor: 2, viewer: 1 };
  if ((order[access.role!] ?? 0) < order[minRole]) {
    throw new Response(JSON.stringify({ error: `needs ${minRole}`, has: access.role }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return access;
}
