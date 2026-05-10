/**
 * Shared notifications socket — single owner across the app.
 *
 * Background: App.tsx (ribbon background-task badges) and ImplementerLiveFeed
 * (per-node implementer event stream) both used to open their own
 * `?session=__notifications__` socket. Under React 19 StrictMode that meant
 * 4 sockets per first paint with close-before-open races. Same payload was
 * being broadcast to all of them anyway, so we just multiplex on the client.
 *
 * Contract:
 *   - Module-level singleton WebSocket. Lazily opened on first subscribe.
 *   - `subscribe(fn)` returns an unsubscribe. When the last subscriber leaves,
 *     the socket is closed (after a small grace period to absorb StrictMode
 *     double-mount churn).
 *   - Auto-reconnect with 2s backoff while at least one subscriber is alive.
 *   - All messages (parsed JSON or raw on parse failure) flow to every listener;
 *     each listener filters by `msg.type`.
 */
import { WS_BASE } from "./api";

type Listener = (msg: unknown) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let closeGraceTimer: number | null = null;
let stopped = true;

function open(): void {
  if (socket || stopped) return;
  try {
    const ws = new WebSocket(`${WS_BASE}/ws?session=__notifications__`);
    socket = ws;
    ws.onmessage = (e) => {
      let parsed: unknown = e.data;
      try { parsed = JSON.parse(e.data as string); } catch { /* keep raw */ }
      for (const fn of listeners) {
        try { fn(parsed); } catch { /* listener errors are not our problem */ }
      }
    };
    ws.onclose = () => {
      socket = null;
      if (stopped) return;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        open();
      }, 2000);
    };
    ws.onerror = () => { /* onclose will fire next */ };
  } catch {
    // Socket creation itself failed (e.g. invalid URL during boot). Try again later.
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, 2000);
  }
}

export function subscribeNotifications(fn: Listener): () => void {
  listeners.add(fn);
  // Cancel a pending shutdown — a new subscriber arrived inside the grace window.
  if (closeGraceTimer !== null) {
    window.clearTimeout(closeGraceTimer);
    closeGraceTimer = null;
  }
  if (stopped) {
    stopped = false;
    open();
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      // Defer the actual teardown by 250ms so React 19 StrictMode unmount→remount
      // doesn't churn the socket. If a new subscriber shows up in that window
      // (the typical case), we keep the existing connection.
      if (closeGraceTimer !== null) window.clearTimeout(closeGraceTimer);
      closeGraceTimer = window.setTimeout(() => {
        closeGraceTimer = null;
        if (listeners.size > 0) return;
        stopped = true;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        try { socket?.close(); } catch { /* ignore */ }
        socket = null;
      }, 250);
    }
  };
}
