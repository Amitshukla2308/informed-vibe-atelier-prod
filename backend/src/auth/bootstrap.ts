/**
 * Bootstrap-window protection (ADR-001 step 2 / launch gate G2-S2).
 *
 * A fresh install has 0 users and an open first-admin registration — fine on
 * a private loopback, lethal the moment a tunnel fronts the port (an internet
 * drive-by becomes the instance admin). While 0 users exist we keep a one-time
 * token on disk and in the boot log; creating the first admin requires it
 * whenever the request could plausibly have come through an exposure layer.
 *
 * "Could plausibly be exposed" is deliberately defense-in-depth, since a
 * tunnel-forwarded request arrives over loopback TCP and cannot be told apart
 * at the socket: we require the token when the mode is `secure`, when the
 * request carries Cloudflare markers (cf-ray / cf-connecting-ip), or when a
 * cloudflared process was live at boot. A purely local install never sees a
 * prompt. The token file is deleted the moment the first admin exists.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { config } from "~/config";
import { authMode } from "~/auth/mode";

const TOKEN_PATH = () => resolve(config.dataDir, ".bootstrap-token");

let tunnelLiveAtBoot = false;

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "bt_" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Call once at boot after the DB is ready. Creates the token when the install
 * has 0 users; removes any stale token once an admin exists.
 */
export function ensureBootstrapToken(userCount: number): void {
  try {
    execSync("pgrep -x cloudflared", { stdio: "pipe" });
    tunnelLiveAtBoot = true;
  } catch { tunnelLiveAtBoot = false; }

  const path = TOKEN_PATH();
  if (userCount > 0) {
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* best-effort */ } }
    return;
  }
  if (!existsSync(path)) {
    writeFileSync(path, generateToken() + "\n", { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* fs without modes */ }
  }
  const token = readFileSync(path, "utf-8").trim();
  console.log(
    `[bootstrap] First-run token: ${token}\n` +
    `[bootstrap] Needed to create the first admin if this install is reached through a tunnel/exposed port. ` +
    `Purely local installs won't be asked. File: ${path}`
  );
}

/** Whether THIS request must present the token to create the first admin. */
export function bootstrapTokenRequired(req: Request): boolean {
  if (authMode() === "secure") return true;
  if (tunnelLiveAtBoot) return true;
  if (req.headers.get("cf-ray") || req.headers.get("cf-connecting-ip")) return true;
  return false;
}

export function verifyBootstrapToken(supplied: string | undefined | null): boolean {
  const path = TOKEN_PATH();
  if (!existsSync(path)) return false;
  const expected = readFileSync(path, "utf-8").trim();
  const got = (supplied ?? "").trim();
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Delete the token — call when the first admin has been created. */
export function clearBootstrapToken(): void {
  const path = TOKEN_PATH();
  if (existsSync(path)) { try { unlinkSync(path); } catch { /* best-effort */ } }
}
