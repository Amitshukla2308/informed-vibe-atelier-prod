/**
 * TerminalIframe — xterm.js-in-iframe terminal driven by the Rust PTY sidecar.
 *
 * Combines the three things we like:
 *   - Engine: Rust PTY sidecar — VTE grid + OSC semantic events +
 *     multi-client subscribe. Runs on :3011 today.
 *   - Render: xterm.js — same as legacy Terminal.tsx, native font feel.
 *   - Layout: iframe — own document, own viewport, immune to parent CSS.
 *     Kills the entire grid-collapse-on-remount class of bugs permanently.
 *
 * The iframe loads /terminal.html (in public/), which is a tiny standalone
 * page that boots xterm + opens its own WS. This component just renders the
 * iframe and bridges status updates via postMessage so Now.tsx's chrome bar
 * (Restart / Stop / End) can reflect connected/ready/closed states.
 */

import { useEffect, useMemo, useRef } from "react";
import type { ChatStatus } from "../views/Chat";

interface Props {
  sessionId: string;
  agentName: string;
  provider?: string;
  /**
   * Optional explicit WS endpoint. If absent, /terminal.html falls back to
   * `${parent.origin}/ws` (which goes through Vite proxy → atelier:3001 →
   * PtyBridge → sidecar once the sidecar code is ported in-tree). For the
   * cutover-period setup (Phase 1.0 ship) pass `VITE_ATELIERAPP_WS_URL`
   * here so the iframe talks directly to the sidecar :3011 hub.
   */
  wsUrl?: string;
  onStatus?: (s: ChatStatus) => void;
}

export function TerminalIframe({ sessionId, agentName, provider, wsUrl, onStatus }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

  // Build src once per (sid, provider, wsUrl) — never on parent re-render.
  // If src changed every render, the iframe would reload the WS and reset
  // the PTY session.
  const src = useMemo(() => {
    const params = new URLSearchParams();
    params.set("sid", sessionId);
    if (provider) params.set("provider", provider);
    if (wsUrl) params.set("ws", wsUrl);
    return `/terminal.html?${params.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider, wsUrl]);

  // Bridge: iframe posts {source:"atelier-terminal", type, payload} → translate
  // to ChatStatus for the parent's chrome bar.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data as { source?: string; sid?: string; type?: string; payload?: string };
      if (!m || m.source !== "atelier-terminal" || m.sid !== sessionId) return;
      if (m.type === "status" && onStatusRef.current) {
        const p = m.payload || "";
        if (p === "connected" || p === "ready") onStatusRef.current("ready");
        else if (p.startsWith("closed")) onStatusRef.current("closed");
        else if (p === "error") onStatusRef.current("error");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [sessionId]);

  // On click anywhere in the wrapper, refocus the iframe's xterm. The iframe's
  // own click handler also focuses xterm directly, but parent-level chrome
  // (term-chrome buttons) steal focus when clicked, so re-route via postMessage.
  const focus = () => {
    iframeRef.current?.contentWindow?.postMessage({ target: "atelier-terminal", cmd: "focus" }, "*");
  };

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={`Terminal session ${sessionId.slice(0, 8)} (${agentName})`}
      onLoad={focus}
      style={{
        // Fill the slot the parent gives us. iframe owns its viewport from here.
        width: "100%",
        height: "100%",
        border: 0,
        display: "block",
        background: "#1f1a14",
      }}
      // No sandbox: needs same-origin to postMessage and to share cookies if
      // the WS endpoint requires auth. iframe loads a same-origin static page.
    />
  );
}
