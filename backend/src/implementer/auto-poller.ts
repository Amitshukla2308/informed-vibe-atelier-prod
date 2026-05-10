/**
 * Implementer auto-poller.
 *
 * Reads `implementer.auto_run` (default false) and `implementer.dry_run`
 * (default true) from agents/config.yaml. On each tick:
 *
 *   - off (default)         → no-op
 *   - on + dry_run=true     → ranks the queue, broadcasts what *would* run,
 *                             does NOT spawn the worker
 *   - on + dry_run=false    → ranks the queue, runs the head node via
 *                             runImplementerOnce
 *
 * Single-flight (`running` guard); idempotent boot. WS broadcasts use the
 * existing `task.*` envelope already consumed by the ribbon.
 *
 * Safety contract:
 *   1. Default off — founder must explicitly opt in.
 *   2. Default dry-run on first opt-in — founder must explicitly disable
 *      it before unsupervised commits happen.
 *   3. Re-reads YAML each tick so a kill-switch toggle in Settings is honored
 *      within the next interval (no restart needed).
 */

import { loadAgentConfig } from "~/config";
import { rankReadyTasks } from "./queue";
import { runImplementerOnce } from "./worker";

interface AutoPollerHooks {
  broadcast: (payload: unknown) => void;
  listActiveProjects: () => string[];
}

interface AutoPollerSettings {
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let storedHooks: AutoPollerHooks | null = null;

function readSettings(): AutoPollerSettings {
  try {
    const cfg = loadAgentConfig() as unknown as {
      implementer?: {
        auto_run?: boolean;
        dry_run?: boolean;
        interval_ms?: number;
      };
    };
    const impl = cfg.implementer ?? {};
    return {
      enabled: impl.auto_run === true,
      dryRun: impl.dry_run !== false, // default true (safer)
      intervalMs: Math.max(MIN_INTERVAL_MS, Number(impl.interval_ms) || DEFAULT_INTERVAL_MS),
    };
  } catch {
    return { enabled: false, dryRun: true, intervalMs: DEFAULT_INTERVAL_MS };
  }
}

async function tick(hooks: AutoPollerHooks): Promise<void> {
  if (running) return;
  const { enabled, dryRun } = readSettings();
  if (!enabled) return;

  running = true;
  try {
    for (const project of hooks.listActiveProjects()) {
      const ranked = rankReadyTasks(project);
      const head = ranked[0];
      if (!head || !head.reasons.topo_ready) continue;

      const summary = `${(head.meta.title ?? head.meta.id).toString().slice(0, 80)}`;
      const envelope = (type: "started" | "done", extra: Record<string, unknown> = {}) => ({
        type: `task.${type}`,
        kind: "implementer-auto",
        dryRun,
        project,
        nodeId: head.meta.id,
        summary: dryRun ? `would run: ${summary}` : `auto-running: ${summary}`,
        explanation: head.explanation,
        ...extra,
      });

      hooks.broadcast(envelope("started"));

      if (dryRun) {
        // Just announce — no spawn. Founder watches what *would* fire.
        hooks.broadcast(envelope("done", { ok: true, dryRun: true }));
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await runImplementerOnce({ project, nodeId: head.meta.id });
        hooks.broadcast(envelope("done", {
          ok: result.finalState === "review",
          durationMs: Date.now() - startedAt,
          state: result.finalState,
          reason: result.reason,
        }));
      } catch (err) {
        console.warn(`[implementer-auto-poller] node=${head.meta.id} failed: ${(err as Error).message}`);
        hooks.broadcast(envelope("done", { ok: false, error: String(err).slice(0, 500) }));
      }

      // One node per tick — fairness across surfaces, and a kill-switch
      // toggled mid-run gets honored on the next tick boundary instead of
      // chewing through the entire queue.
      break;
    }
  } finally {
    running = false;
  }
}

/** Start the auto-poller. Idempotent. Reads settings each tick. */
export function startImplementerAutoPoller(hooks: AutoPollerHooks): void {
  if (timer) return;
  storedHooks = hooks;
  const { intervalMs } = readSettings();
  // Initial probe after 30s (let the server settle), then every interval.
  setTimeout(() => { tick(hooks).catch(() => {}); }, 30_000);
  timer = setInterval(() => { tick(hooks).catch(() => {}); }, intervalMs);
}

export function stopImplementerAutoPoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * Fire one tick now (the Work-tab "Nudge implementer" button). Honors the
 * single-flight guard inside tick(); if a tick is already running, the call
 * is a no-op and returns `{ already_running: true }`. Honors `auto_run` /
 * `dry_run` settings as the regular interval-driven tick does — Nudge does
 * NOT bypass the kill switch, only the wait.
 */
export async function nudgeImplementerAutoPoller(): Promise<{ ok: boolean; already_running: boolean; reason?: string }> {
  if (!storedHooks) return { ok: false, already_running: false, reason: "auto-poller not started" };
  if (running) return { ok: true, already_running: true };
  await tick(storedHooks);
  return { ok: true, already_running: false };
}

/** Exposed for the /implementer/auto-poller/status endpoint. */
export function getAutoPollerStatus(): AutoPollerSettings & { running: boolean } {
  return { ...readSettings(), running };
}
