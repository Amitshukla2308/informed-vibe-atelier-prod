/**
 * TerminalTtyd — Terminal v2 (ttyd-direct, reverse-proxied).
 *
 * Embeds ttyd's served xterm page in an iframe. The backend spawns a
 * dedicated ttyd subprocess per session via POST /terminal-v2/start; ttyd
 * runs the provider CLI directly as its PTY child (no tmux hop). We point
 * the iframe at the proxyUrl, which is served through Atelier's auth-gated
 * backend so any device that can reach the backend (LAN, Cloudflare
 * tunnel, phone) can open the terminal.
 *
 * Built-in benefits over the legacy WebSocket+xterm bridge:
 *   - reconnect on transient drop (ttyd's client handles it)
 *   - resize/copy/paste/mouse/bracketed-paste — all the xterm features
 *     work because ttyd ships a fully configured xterm.js
 *   - no two-process node-pty helper
 *   - works from any device that can reach the backend, not just the host
 *
 * The component starts the v2 session on mount and stops it on unmount.
 * Page refresh while a session is live currently respawns ttyd (the tmux
 * persistence path was retired with the reverse-proxy work).
 */

import { useEffect, useRef, useState } from "react";
import { startTerminalV2, stopTerminalV2, getTerminalV2Availability, BASE_URL } from "../lib/api";
import type { ChatStatus } from "../views/Chat";

interface Props {
  sessionId: string;
  agentName: string;
  onStatus?: (s: ChatStatus) => void;
  agent?: "drafter" | "allocator" | "implementer" | "senior_reviewer";
}

type ErrCause = "binary-missing" | "backend-rejected" | "network-unreachable" | "unknown";

export function TerminalTtyd({ sessionId, agentName, onStatus, agent = "drafter" }: Props) {
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; cause: ErrCause } | null>(null);
  const [busy, setBusy] = useState(true);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

  useEffect(() => {
    let cancelled = false;
    onStatusRef.current?.("connecting");

    (async () => {
      // The previous error path collapsed every failure into the same
      // "install ttyd" suggestion. That was actively wrong when the real
      // cause was a network blip / backend down. We now classify into
      // three distinct causes and render different remediation per cause.
      try {
        // Always force a FRESH ttyd subprocess on mount. Reusing an existing
        // session would leave the iframe pointing at a stale port whose
        // env (provider keys, model id) was set when that ttyd first
        // spawned. After a backend restart with new env config, the
        // cached subprocess still serves the old environment — and the
        // user sees stale crashes (e.g. the qwen-code Gradient bug
        // triggered by missing lmstudio env vars).
        // Stop-then-start guarantees every iframe load reflects the
        // latest backend code path.
        await stopTerminalV2(sessionId).catch(() => undefined);

        // Verify ttyd binary is reachable before we try to start.
        let avail;
        try {
          avail = await getTerminalV2Availability();
        } catch (e) {
          // Thrown only on network failure (TypeError: Failed to fetch) or
          // non-2xx where api.ts rethrows. Either way, the backend is the
          // problem, not ttyd binary.
          if (!cancelled) {
            setError({ msg: String(e).slice(0, 240), cause: "network-unreachable" });
            setBusy(false);
            onStatusRef.current?.("error");
          }
          return;
        }
        if (!avail.available) {
          if (!cancelled) {
            setError({
              msg: `Terminal v2 is unavailable: ${avail.reasons.join("; ")}`,
              cause: "binary-missing",
            });
            setBusy(false);
            onStatusRef.current?.("error");
          }
          return;
        }

        const result = await startTerminalV2(sessionId, agent);
        if (cancelled) return;
        if (result.ok) {
          // Prefer the proxy URL — it's served through Atelier's auth-gated
          // backend, so any device that can reach Atelier (LAN, Cloudflare
          // tunnel, phone) loads the terminal. The absolute `result.url`
          // points at 127.0.0.1 and only works on the host machine.
          // We prepend BASE_URL so the iframe resolves against the same
          // /api proxy the rest of the frontend uses (Vite dev: rewritten;
          // tunnel/prod: passes through unchanged).
          const fullUrl = result.proxyUrl
            ? `${BASE_URL}${result.proxyUrl}`
            : result.url;
          setIframeUrl(fullUrl);
          setBusy(false);
          onStatusRef.current?.("ready");
        } else {
          setError({ msg: result.reason, cause: "backend-rejected" });
          setBusy(false);
          onStatusRef.current?.("error");
        }
      } catch (e) {
        // Anything thrown past the inner try blocks is a network failure —
        // startTerminalV2 doesn't throw on backend-rejected (it returns
        // {ok:false, reason} which is handled above).
        if (!cancelled) {
          setError({ msg: String(e).slice(0, 240), cause: "network-unreachable" });
          setBusy(false);
          onStatusRef.current?.("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      // Stop server-side on unmount. If the founder ends the session
      // explicitly, Now will already have called this; calling again is a
      // safe no-op (returns ok: false with "no active terminal-v2").
      stopTerminalV2(sessionId).catch(() => undefined);
      onStatusRef.current?.("closed");
    };
  }, [sessionId, agent]);

  if (error) {
    return (
      <div className="xterm-host" style={{ padding: "1rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
        <div className="impl-error" style={{ marginBottom: 8 }}>
          [terminal-v2] {error.msg}
        </div>
        <div style={{ fontSize: "var(--t-1)", lineHeight: 1.5 }}>
          {error.cause === "binary-missing" && (
            <>
              ttyd is not installed on this machine.
              {" "}<code style={{ color: "var(--a-accent)" }}>brew install ttyd</code>
              {" "}/ <code style={{ color: "var(--a-accent)" }}>apt install ttyd</code>,
              {" "}or switch to <em>Legacy</em> in Settings → Terminal Engine.
            </>
          )}
          {error.cause === "backend-rejected" && (
            <>
              The backend rejected the start request. Reason shown above. Common causes: ttyd failed to bind a port (try restarting the backend), the provider CLI isn't installed for this agent, or the agent config is invalid. You can also switch to <em>Legacy</em> in Settings → Terminal Engine while you investigate.
            </>
          )}
          {error.cause === "network-unreachable" && (
            <>
              Could not reach the Atelier backend. Check that it's running (
              <code style={{ color: "var(--a-accent)" }}>./scripts/atelier-restart.sh status</code>),
              tail <code>/tmp/atelier-backend.log</code> for crashes,
              and verify your tunnel/network if you're on a remote device. This is <em>not</em> a ttyd install issue.
            </>
          )}
          {error.cause === "unknown" && (
            <>{agentName}'s session couldn't start the v2 terminal. Switch to <em>Legacy</em> in Settings → Terminal Engine while you investigate.</>
          )}
        </div>
      </div>
    );
  }

  if (busy || !iframeUrl) {
    return (
      <div className="xterm-host" style={{ padding: "1rem", color: "var(--a-mute)", fontFamily: "var(--font-mono)" }}>
        starting terminal v2 (ttyd)…
      </div>
    );
  }

  const handleStop = async () => {
    if (!confirm("Stop this terminal? The session ends and the iframe closes — no auto-restart.")) return;
    try {
      await stopTerminalV2(sessionId);
    } finally {
      setIframeUrl(null);
      setError({
        msg: "Terminal stopped by founder. Click 'start now' from Now to spawn a fresh session.",
        cause: "unknown",
      });
      onStatusRef.current?.("closed");
    }
  };

  return (
    <div className="xterm-host" style={{ position: "relative", background: "var(--a-page)", padding: 0 }}>
      <iframe
        src={iframeUrl}
        title={`terminal-v2 · ${sessionId.slice(0, 8)}`}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          background: "var(--a-page)",
        }}
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-clipboard-read allow-clipboard-write"
      />
      {/* Corner overlay — wheel-modifier hint + stop button. Stays out of
          the terminal's vertical real estate. */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 5, display: "flex", gap: 6 }}>
        <WheelHint />
        <button
          type="button"
          onClick={handleStop}
          title="Stop ttyd subprocess and close iframe (founder-triggered)"
          style={{
            padding: "0.25rem 0.55rem",
            background: "rgba(45, 49, 38, 0.85)",
            backdropFilter: "blur(4px)",
            color: "var(--sem-orange, #E8A86A)",
            border: "1px solid var(--a-line-2)",
            borderRadius: 4,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-1)",
            cursor: "pointer",
            textTransform: "lowercase",
            lineHeight: 1.4,
          }}
        >
          stop terminal
        </button>
      </div>
    </div>
  );
}

function WheelHint() {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("atelier.ttyd.hintDismissed") === "1");
  if (dismissed) return null;
  return (
    <button
      type="button"
      onClick={() => { sessionStorage.setItem("atelier.ttyd.hintDismissed", "1"); setDismissed(true); }}
      style={{
        padding: "0.25rem 0.55rem",
        background: "rgba(45, 49, 38, 0.85)",
        backdropFilter: "blur(4px)",
        color: "var(--a-mute)",
        border: "1px solid var(--a-line-2)",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-1)",
        cursor: "pointer",
        textTransform: "lowercase",
        lineHeight: 1.4,
      }}
      title="Hide hint for this session"
    >
      shift+wheel = history · alt+wheel = fast · ✕
    </button>
  );
}
