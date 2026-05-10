/**
 * Terminal — xterm.js renderer bridged to the backend WebSocket.
 * Renders the raw PTY stream from Claude CLI faithfully (ANSI colors, prompts, etc.).
 */

import { useEffect, useRef } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { WS_BASE } from "../lib/api";
import type { ChatStatus } from "./Chat";

interface Props {
  sessionId: string;
  agentName: string;
  onStatus?: (status: ChatStatus) => void;
  provider?: string;
}

export function Terminal({ sessionId, agentName, onStatus, provider }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Flipped once the PTY exits — stops Terminal from forwarding keystrokes
  // to a dead bridge (which would spam "[atelier] no active bridge" per key).
  const closedRef = useRef(false);
  // Keep onStatus in a ref so re-renders from parents that swap the callback
  // don't blow away the xterm instance and the PTY session with it.
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  const agentNameRef = useRef(agentName);
  useEffect(() => { agentNameRef.current = agentName; }, [agentName]);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new XtermTerminal({
      fontFamily: "'JetBrains Mono', 'Menlo', monospace",
      fontSize: 13,
      theme: {
        background: "#1f1a14",
        foreground: "#e8ddc9",
        cursor: "#d9a066",
        selectionBackground: "#544a38",
      },
      cursorBlink: true,
      convertEol: true,
      scrollback: 10000,
      scrollOnUserInput: true,
      smoothScrollDuration: 120,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;

    const fitAndResize = () => {
      try {
        fit.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch { /* ignore */ }
    };

    // Initial sizing — two rAFs for the CSS/layout pass, then a 150ms safety.
    // Without this the PTY keeps whatever cols xterm defaulted to (often ~80)
    // because `resize` got sent before `fit()` computed the real dimensions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAndResize();
        term.focus();
      });
    });
    const initFitTimer = setTimeout(fitAndResize, 150);

    const p = provider || localStorage.getItem("atelier.provider") || "claude";
    const ws = new WebSocket(`${WS_BASE}/ws?session=${sessionId}&provider=${p}`);
    wsRef.current = ws;
    onStatusRef.current?.("connecting");

    ws.onopen = () => {
      onStatusRef.current?.("open");
      // Send whatever we have now (may still be the default), then force a re-fit
      // so the authoritative cols/rows hit the PTY before Claude Code renders.
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      requestAnimationFrame(() => fitAndResize());
    };
    ws.onclose = () => onStatusRef.current?.("closed");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "agent.data" && typeof msg.chunk === "string") {
          term.write(msg.chunk);
        } else if (msg.type === "session.open") {
          // Suppress the spawn banner — keeps the terminal clean for the user
        } else if (msg.type === "session.ready") {
          onStatusRef.current?.("ready");
        } else if (msg.type === "atelier.boot_sent") {
          // Silent boot context now lives in the system prompt; nothing to announce
        } else if (msg.type === "session.closed") {
          closedRef.current = true;
          term.write(`\r\n\x1b[33m[atelier] session closed (code ${msg.code})\x1b[0m\r\n`);
        } else if (msg.type === "error") {
          onStatusRef.current?.("error");
          term.write(`\r\n\x1b[31m[atelier] ${msg.error}\x1b[0m\r\n`);
        }
      } catch {
        /* ignore non-JSON */
      }
    };

    // Forward user keystrokes to the PTY (raw mode — supports vi, control chars, etc.)
    const dataHandler = term.onData((data) => {
      if (closedRef.current) {
        // Session has exited. Show a one-time hint instead of spamming the PTY.
        term.write("\r\n\x1b[38;5;214m[atelier] session ended · click \"end session\" to reflect + close\x1b[0m\r\n");
        closedRef.current = false; // avoid repeating the hint on each keystroke
        setTimeout(() => { closedRef.current = true; }, 1_500);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "raw", data }));
      }
    });

    // Fit on any size change — window resize OR parent element resize
    window.addEventListener("resize", fitAndResize);
    const ro = new ResizeObserver(fitAndResize);
    if (hostRef.current) ro.observe(hostRef.current);

    // Focus on any click inside the terminal region, so Tab/arrow keys don't bounce out
    const host = hostRef.current;
    const clickHandler = () => term.focus();
    host.addEventListener("click", clickHandler);

    // Global refocus: if the user starts typing while focus is on the body (not on
    // another input/textarea/button/modal), route the keystroke to the terminal.
    // This fixes "I typed a response and nothing happened" when focus drifted off.
    const globalKeyHandler = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || active?.isContentEditable) return;
      if (active?.closest(".tweaks, .drawer, .reflection-overlay")) return;
      if (tag === "button" && (e.key === "Enter" || e.key === " ")) return;
      // Everything else → refocus terminal. xterm.onData will pick up the next key.
      term.focus();
    };
    window.addEventListener("keydown", globalKeyHandler);

    return () => {
      clearTimeout(initFitTimer);
      window.removeEventListener("resize", fitAndResize);
      window.removeEventListener("keydown", globalKeyHandler);
      ro.disconnect();
      host.removeEventListener("click", clickHandler);
      dataHandler.dispose();
      ws.close();
      term.dispose();
    };
    // Intentionally depend only on sessionId — onStatus/agentName are captured via refs
    // above so parent re-renders that hand us a new callback identity don't tear
    // down the terminal (which was killing the PTY session on every parent re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return <div ref={hostRef} className="xterm-host" />;
}
