/**
 * Implementer event broadcaster.
 *
 * Tiny helper around the existing ws/hub `broadcastToAll` so the worker
 * can announce phase transitions to every connected client without
 * coupling worker.ts to the WebSocket internals.
 *
 * Frame envelope (matches the rest of the hub's flat-type style):
 *   { type: "implementer.event", payload: { phase, nodeId, project, ... } }
 *
 * The persistent execution.jsonl is still the source of truth — broadcast
 * failures are swallowed and logged so a flaky client never aborts a run.
 */

import { broadcastToAll } from "./hub";
import { getDb, nowIso } from "~/db";

export type ImplementerPhase =
  | "started"
  | "allocator"
  | "writing"
  | "verifying"
  | "completed"
  | "blocked";

export interface ImplementerEventPayload {
  phase: ImplementerPhase;
  nodeId: string;
  project: string;
  ts: string;
  // Phase-specific extras — kept loose because consumers (the live feed)
  // pull what they need by phase.
  [k: string]: unknown;
}

export function broadcastImplementerEvent(
  payload: Omit<ImplementerEventPayload, "ts"> & { ts?: string },
): void {
  const ts = payload.ts ?? new Date().toISOString();
  // Persist to canvas_node_events so the Activity tab + per-node drawer
  // timeline survive reloads. Failure here must never
  // block the broadcast.
  try {
    getDb().query(
      `INSERT INTO canvas_node_events (project, node_id, ts, agent, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(payload.project),
      String(payload.nodeId),
      ts,
      "implementer",
      `impl-${payload.phase}`,
      JSON.stringify(payload),
      nowIso(),
    );
  } catch (e) {
    console.warn(
      `[implementer-events] persist failed: ${String(e).slice(0, 200)}`,
    );
  }
  try {
    const frame = JSON.stringify({
      type: "implementer.event",
      payload: { ...payload, ts },
    });
    broadcastToAll(frame);
  } catch (e) {
    console.warn(
      `[implementer-events] broadcast failed: ${String(e).slice(0, 200)}`,
    );
  }
}
