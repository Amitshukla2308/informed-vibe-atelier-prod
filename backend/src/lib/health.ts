/** Returns the current health status of the application. */
export function getHealthStatus(): { ok: boolean; version: string; timestamp: string } {
  return {
    ok: true,
    version: process.env.npm_package_version ?? "0.1.0-phase-a",
    timestamp: new Date().toISOString(),
  };
}
