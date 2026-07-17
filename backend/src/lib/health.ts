import { authMode, type AuthMode } from "~/auth/mode";

/** Returns the current health status of the application. `mode` lets an
 *  exposure layer (e.g. a cloudflared unit's ExecStartPre) refuse to front
 *  anything that isn't running secure. */
export function getHealthStatus(): { ok: boolean; version: string; mode: AuthMode; timestamp: string } {
  return {
    ok: true,
    version: process.env.npm_package_version ?? "0.1.0-phase-a",
    mode: authMode(),
    timestamp: new Date().toISOString(),
  };
}
