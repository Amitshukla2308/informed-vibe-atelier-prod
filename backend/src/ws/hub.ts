/**
 * WebSocket hub — notification-only fan-out.
 *
 * Terminal I/O flows through the ttyd bridge (terminal-server.ts) and is
 * reverse-proxied to the browser via terminal-proxy.ts. This hub is retained
 * only for broadcasting notification events (e.g. reflection-worker task.started /
 * task.done) to any connected client.
 */

import type { ServerWebSocket } from "bun";

import type { AgentProviderId } from "~/agent/providers";

export interface SessionData {
  sessionId: string;
  provider: AgentProviderId;
  /**
   * Atelier user id resolved from the atelier_at cookie at WS upgrade time.
   * Drives per-user HOME scoping for the spawned CLI. "default" for legacy
   * unauthenticated flows (single-founder pre-auth installs).
   */
  userId: string;
}

// Multiple WS clients can share one logical session id (e.g. Chat + Terminal pane)
const clients = new Map<string, Set<ServerWebSocket<SessionData>>>();

/** Broadcast to EVERY connected client across ALL sessions. Used for notifications
 *  (reflection-worker task.started/task.done) — any ribbon visible in any tab sees
 *  the running task even if the user isn't in the session being reflected. */
export function broadcastToAll(data: string) {
  for (const set of clients.values()) {
    for (const ws of set) {
      try { ws.send(data); } catch { /* client gone */ }
    }
  }
}

const NOTIFY_SESSION = "__notifications__";

export const handleWebSocket = {
  open(ws: ServerWebSocket<SessionData>) {
    const { sessionId, provider } = ws.data;
    console.log(`[ws] open session=${sessionId.slice(0, 8)} provider=${provider}`);

    // Register client
    if (!clients.has(sessionId)) clients.set(sessionId, new Set());
    clients.get(sessionId)!.add(ws);

    // Notification-only listener — App.tsx ribbon opens this to receive
    // task.started / task.done events from the reflection worker. No PTY spawn.
    if (sessionId === NOTIFY_SESSION) {
      ws.send(JSON.stringify({ type: "notifications.ready" }));
      return;
    }

    // All other sessions: terminal I/O goes through ttyd (terminal-server.ts)
    // proxied at /terminal-v2/*. Acknowledge the open but do not spawn a PTY here.
    ws.send(JSON.stringify({ type: "session.open", sessionId }));
  },

  message(ws: ServerWebSocket<SessionData>, _raw: string | Buffer) {
    // Legacy clients may still send "raw"/"resize" frames for the in-process PTY.
    // The PTY bridge has been retired; ttyd handles terminal I/O directly. Silently
    // drop these — the frontend has been updated to talk to /terminal-v2/* instead.
    ws.send(JSON.stringify({ type: "error", error: "pty bridge removed; use /terminal-v2" }));
  },

  close(ws: ServerWebSocket<SessionData>) {
    const { sessionId } = ws.data;
    console.log(`[ws] close session=${sessionId.slice(0, 8)}`);

    const set = clients.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        clients.delete(sessionId);
      }
    }
  },
};
