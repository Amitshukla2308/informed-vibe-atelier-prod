/**
 * Background reflection worker.
 *
 * Honors the agent config's `reflection_mode`:
 *   - "manual"    → worker does nothing; founder triggers via /sessions/:id/reflect
 *   - "semi-auto" → reflects any unreflected session whose approxTokens ≥ threshold
 *   - "auto"      → reflects any unreflected session, regardless of size
 *
 * Broadcasts `task.started` / `task.done` over the WS hub so the ribbon can show
 * "reflecting session XX · 12s" to the founder.
 *
 * Poll cadence: every 2 minutes. Idempotent — never re-runs a session that already
 * has an artifact on disk. Quiet failure — logs but doesn't crash the backend.
 */

import { loadAgentConfig } from "~/config";
import { listProjectSessions } from "~/session/session-index";
import { reflectSession } from "~/session/reflect";

type ReflectionMode = "manual" | "semi-auto" | "auto";

interface WorkerHooks {
  broadcast: (sessionId: string, payload: unknown) => void;
  listActiveProjects: () => string[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function readMode(): { mode: ReflectionMode; threshold: number } {
  // Fallback is "semi-auto" (not "manual"): the Settings UI presents reflect as
  // automatic, and onboarding now writes the key explicitly. An absent key
  // means a pre-2026-07-17 install or the shipped template — coherent default
  // is to reflect substantive sessions, not to silently do nothing (QA finding
  // 15). semi-auto only reflects sessions past the token threshold, so trivial
  // ones are skipped and token spend stays bounded.
  try {
    const cfg = loadAgentConfig() as unknown as { reflection_mode?: ReflectionMode; reflection_token_threshold?: number };
    return {
      mode: cfg.reflection_mode ?? "semi-auto",
      threshold: cfg.reflection_token_threshold ?? 8000,
    };
  } catch {
    return { mode: "semi-auto", threshold: 8000 };
  }
}

async function scanOnce(hooks: WorkerHooks): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { mode, threshold } = readMode();
    if (mode === "manual") return;

    for (const project of hooks.listActiveProjects()) {
      const sessions = await listProjectSessions(project);
      const candidates = sessions.filter(s => {
        if (s.reflected) return false;
        if (s.turnCount === 0) return false; // never really started
        if (mode === "auto") return true;
        return (s.approxTokens ?? 0) >= threshold;
      });

      for (const s of candidates) {
        const payload = (type: "started" | "done", extra: Record<string, unknown> = {}) => ({
          type: `task.${type}`,
          kind: "reflection",
          sessionId: s.sessionId,
          summary: `reflecting session ${s.sessionId.slice(0, 8)}`,
          ...extra,
        });
        hooks.broadcast(s.sessionId, payload("started"));
        const startedAt = Date.now();
        try {
          await reflectSession({ sessionId: s.sessionId });
          hooks.broadcast(s.sessionId, payload("done", { ok: true, durationMs: Date.now() - startedAt }));
        } catch (err) {
          console.warn(`[reflection-worker] session=${s.sessionId.slice(0, 8)} failed: ${(err as Error).message}`);
          hooks.broadcast(s.sessionId, payload("done", { ok: false, error: String(err) }));
        }
      }
    }
  } finally {
    running = false;
  }
}

/** Start the background scanner. Safe to call more than once; idempotent. */
export function startReflectionWorker(hooks: WorkerHooks): void {
  if (timer) return;
  // Initial scan after 20s (let the server boot first), then every 2 min.
  setTimeout(() => { scanOnce(hooks).catch(() => {}); }, 20_000);
  timer = setInterval(() => { scanOnce(hooks).catch(() => {}); }, 120_000);
}

export function stopReflectionWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
