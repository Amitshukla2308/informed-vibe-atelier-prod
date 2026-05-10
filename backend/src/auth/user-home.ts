/**
 * Per-user scoped HOME for CLI spawn.
 *
 * Each user gets an isolated directory: data/users/<user_id>/
 * The CLI subprocess is spawned with HOME=<that dir>, so Claude Code's
 * ~/.claude/config.json, projects/, memory/ all live per-user. Nobody
 * sees anyone else's conversations, memory files, or session history.
 *
 * For the legacy-bootstrapped admin (first DB user, oldest created_at)
 * whose ~/.claude/ already exists at the system HOME, we auto-seed their
 * scoped dir on first access by copying config.json (auth) + symlinking
 * projects/ and memory/ (history). The legacy admin keeps working without
 * manual re-linking; new users upload their config.json explicitly.
 */

import { existsSync, mkdirSync, symlinkSync, copyFileSync, lstatSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { getDb } from "~/db";

export function userHomeDir(userId: string): string {
  return resolve(config.atelierRoot, "data", "users", userId);
}

export function userClaudeDir(userId: string): string {
  return resolve(userHomeDir(userId), ".claude");
}

/**
 * The canonical Claude auth file. Current versions of the CLI store the
 * OAuth refresh token here; older versions used `config.json`. We check
 * both to stay compatible.
 */
export function userClaudeCredentialsPath(userId: string): string {
  return resolve(userClaudeDir(userId), ".credentials.json");
}

export function userClaudeConfigPath(userId: string): string {
  return resolve(userClaudeDir(userId), "config.json");
}

/** Top-level ~/.claude.json (HOME root). Claude CLI keeps global settings here. */
export function userClaudeGlobalJsonPath(userId: string): string {
  return resolve(userHomeDir(userId), ".claude.json");
}

export function userEventsDir(userId: string): string {
  return resolve(userHomeDir(userId), "data", "events");
}

/** True if this user has Claude auth (credentials.json is primary; config.json legacy). */
export function isClaudeLinked(userId: string): boolean {
  return existsSync(userClaudeCredentialsPath(userId)) || existsSync(userClaudeConfigPath(userId));
}

/**
 * The legacy admin (oldest user by created_at) — the one promoted from
 * agents/config.yaml on boot. For this user only, we auto-seed the scoped
 * HOME from their existing system ~/.claude/ so they don't have to upload.
 */
export function isLegacyAdmin(userId: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT u.id FROM users u
     JOIN memberships m ON m.user_id = u.id
     WHERE m.role = 'admin'
     ORDER BY u.created_at ASC
     LIMIT 1`
  ).get() as { id: string } | undefined;
  return row?.id === userId;
}

function systemHomeClaude(): string {
  return resolve(process.env.HOME ?? "/root", ".claude");
}

/**
 * Ensures `data/users/<uid>/` exists and — for the legacy admin only —
 * seeds .claude/ from the system HOME on first run. Idempotent + safe
 * to call on every session spawn.
 */
export function ensureUserHome(userId: string): void {
  const home = userHomeDir(userId);
  const claudeDir = userClaudeDir(userId);
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(userEventsDir(userId), { recursive: true });

  // Legacy-admin auto-seed: copy .credentials.json (auth) + ~/.claude.json
  // (top-level global), symlink projects/memory/CLAUDE.md so history + rules
  // flow through. Idempotent — only copies what's missing.
  if (!isClaudeLinked(userId) && isLegacyAdmin(userId)) {
    const sysHome = process.env.HOME ?? "/root";
    const sysClaude = systemHomeClaude();

    // Copy auth credentials — .credentials.json inside .claude/.
    const sysCreds = resolve(sysClaude, ".credentials.json");
    if (existsSync(sysCreds) && !existsSync(userClaudeCredentialsPath(userId))) {
      try {
        copyFileSync(sysCreds, userClaudeCredentialsPath(userId));
        try { chmodSync(userClaudeCredentialsPath(userId), 0o600); } catch {}
      } catch (e) {
        console.warn(`[user-home] legacy credentials copy failed for ${userId}:`, e);
      }
    }
    // Back-compat: if only old-style config.json exists, copy that too.
    const sysConfig = resolve(sysClaude, "config.json");
    if (existsSync(sysConfig) && !existsSync(userClaudeConfigPath(userId))) {
      try { copyFileSync(sysConfig, userClaudeConfigPath(userId)); } catch {}
    }
    // Copy top-level ~/.claude.json (global settings) if it exists.
    const sysGlobal = resolve(sysHome, ".claude.json");
    if (existsSync(sysGlobal) && !existsSync(userClaudeGlobalJsonPath(userId))) {
      try { copyFileSync(sysGlobal, userClaudeGlobalJsonPath(userId)); } catch {}
    }
    // Symlink stable history + memory sources.
    for (const sub of ["projects", "memory", "CLAUDE.md"]) {
      const src = resolve(sysClaude, sub);
      const dst = resolve(claudeDir, sub);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          const stat = lstatSync(src);
          if (stat.isDirectory() || stat.isFile()) {
            symlinkSync(src, dst);
          }
        } catch (e) {
          console.warn(`[user-home] legacy ${sub} symlink failed:`, e);
        }
      }
    }
  }
}

/**
 * Returns the env block to inject for a PTY spawn for this user.
 *
 * **Legacy-admin carve-out**: the instance's original founder (the one
 * promoted from agents/config.yaml at first boot) keeps the system HOME
 * unchanged. Claude Code's CLI expects its self-install at
 * `$HOME/.local/bin/claude` + `$HOME/.local/share/claude/` — scoping HOME
 * for the legacy admin would hide those paths and the CLI falls into a
 * "native install exists but not in PATH" warning state that eats input.
 *
 * Non-legacy users (invited collaborators) get the scoped HOME + must
 * upload their own ~/.claude/.credentials.json via Settings; they'll need
 * their own local claude install too — Phase B item.
 */
export function userSpawnEnv(userId: string): Record<string, string> {
  ensureUserHome(userId);
  if (isLegacyAdmin(userId)) {
    // No override — legacy admin uses system HOME. ensureUserHome still
    // ran to reserve the scoped dir for later data (events, etc.), but
    // the CLI subprocess sees no env change.
    return {};
  }
  return {
    HOME: userHomeDir(userId),
    // XDG_CONFIG + CACHE get scoped so the CLI's config/cache lands
    // per-user. XDG_DATA_HOME is NOT scoped — Claude Code installs itself
    // under it, and we don't want a fresh user's scoped dir to hide the
    // system-wide binary. The trade is: per-user config/creds isolation,
    // shared binary install.
    XDG_CONFIG_HOME: resolve(userHomeDir(userId), ".config"),
    XDG_CACHE_HOME: resolve(userHomeDir(userId), ".cache"),
  };
}
