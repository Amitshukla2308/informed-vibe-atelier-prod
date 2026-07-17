/**
 * Auth-mode resolution — the fail-closed core.
 *
 * Three modes:
 *   - "local"  (DEFAULT when ATELIER_AUTH_MODE is unset): full pattern-γ auth,
 *              loopback bind, NO impersonation. A fresh install is private to
 *              the machine and honest about auth from the first boot.
 *   - "dev":   impersonation enabled (header-only). Requires BOTH
 *              ATELIER_AUTH_MODE=dev AND ATELIER_DEV_UNSAFE=1 so it cannot be
 *              reached by setting one stray variable. Boot validation refuses
 *              this mode when anything about the process looks reachable
 *              (non-loopback bind, CF-Access trust, live cloudflared).
 *   - "secure": required for any exposure (non-loopback bind, Cloudflare
 *              Access header trust, tunnel). Explicit opt-in only.
 *
 * Unknown ATELIER_AUTH_MODE values resolve to "secure" — a typo must never
 * open anything.
 *
 * History: before 2026-07-17 the default when unset was "dev", which enabled
 * a ?dev_as=<user_id> auth bypass on any reachable install (QA finding P0-3).
 */

export type AuthMode = "local" | "dev" | "secure";

export function authMode(): AuthMode {
  const raw = (process.env.ATELIER_AUTH_MODE ?? "").trim();
  if (raw === "" || raw === "local") return "local";
  if (raw === "secure") return "secure";
  if (raw === "dev") {
    // dev needs the second key; without it, run as local (boot warns).
    return process.env.ATELIER_DEV_UNSAFE === "1" ? "dev" : "local";
  }
  return "secure";
}

/** True only when impersonation is permitted (both dev vars present). */
export function devImpersonationEnabled(): boolean {
  return authMode() === "dev";
}

/** Set, but ineffective — dev requested without ATELIER_DEV_UNSAFE=1. */
export function devModeRequestedButIncomplete(): boolean {
  return (
    (process.env.ATELIER_AUTH_MODE ?? "").trim() === "dev" &&
    process.env.ATELIER_DEV_UNSAFE !== "1"
  );
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}
