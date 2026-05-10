import { useCallback, useEffect, useMemo, useState } from "react";
import { Terminal } from "./Terminal";
import { TerminalTtyd } from "../components/TerminalTtyd";
import { TerminalIframe } from "../components/TerminalIframe";
import type { ChatStatus } from "./Chat";
import {
  BASE_URL, endSessionWithReflection, type ReflectResult,
  getAgentSettings, updateAgentSetting,
  type AgentSettingsResponse, type AgentName,
} from "../lib/api";
import { LiveGraph } from "../components/LiveGraph";

type TerminalEngine = "legacy" | "ttyd" | "sidecar";
function loadTerminalEngine(): TerminalEngine {
  const v = localStorage.getItem("atelier.terminalEngine");
  if (v === "legacy" || v === "ttyd" || v === "sidecar") return v;
  // Default: the sidecar (Rust PTY engine + iframe-wrapped xterm). Combines
  // legacy's render fidelity with ttyd's layout isolation. legacy/ttyd stay
  // available as fallback engines via the chip selector.
  return "sidecar";
}
/** Sidecar engine WS endpoint. Cutover-period default points at the standalone
 *  Rust PTY sidecar's hub. Once the sidecar code is ported in-tree, this falls
 *  back to atelier's own /ws and the env var is removed. */
const SIDECAR_WS_URL: string | undefined =
  (import.meta as { env?: { VITE_ATELIERAPP_WS_URL?: string } }).env?.VITE_ATELIERAPP_WS_URL
  ?? "ws://localhost:3011/ws";

interface BgItem {
  kind: string;
  state: "active" | "idle" | "done";
  time: string;
  text: string;
}

interface Props {
  agentName: string;
  founderName: string;
  activeProject: string;
  pickupFlavor?: string | null;
  onWsStatus?: (s: ChatStatus) => void;
  onOpenCanvas?: (nodeId?: string) => void;
  onEndSession?: () => void;
}

/** Filter out fallback / placeholder flavors so the "picking up from" banner
 *  doesn't surface technical noise like "Session abcd — fallback reflection
 *  (Claude CLI unavailable)." Real flavors are short prose distilled from a
 *  past session; if the flavor looks like a system stub, treat it as absent. */
function meaningfulFlavor(f: string | null | undefined): string | null {
  if (!f) return null;
  const t = f.trim();
  if (!t) return null;
  if (/fallback reflection|cli unavailable|no transcript|claude cli/i.test(t)) return null;
  if (/^session\s+[0-9a-f-]{6,}/i.test(t)) return null;
  return t;
}

export function Now({ agentName, activeProject, pickupFlavor, onWsStatus, onOpenCanvas }: Props) {
  const flavor = meaningfulFlavor(pickupFlavor);
  // Session doesn't start until the founder clicks "Start now". This prevents
  // every tab open / hard refresh / React strict-double-mount from spawning a
  // Claude PTY — each of those costs tokens + creates a dead session folder.
  const [started, setStarted] = useState(false);
  const sessionId = useMemo(() => crypto.randomUUID(), [started]);
  // Terminal engine is a UI preference (legacy WebSocket+xterm bridge vs the
  // new ttyd v2 reverse-proxied through the backend). Persisted via
  // localStorage; switched in Settings or via the inline toggle in the start
  // card so a session can opt in without navigating away.
  const [terminalEngine, setTerminalEngine] = useState<TerminalEngine>(loadTerminalEngine());
  useEffect(() => {
    localStorage.setItem("atelier.terminalEngine", terminalEngine);
  }, [terminalEngine]);

  // Provider for THIS session is the founder's Drafter agent provider in Settings.
  // No more "claude" hardcode — providers is generic. Loads from /settings/agents
  // on mount; a "change provider" affordance in the footbar lets the founder swap
  // for the next session without leaving Now.
  const [agentSettings, setAgentSettings] = useState<AgentSettingsResponse | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    getAgentSettings().then(setAgentSettings).catch(() => setAgentSettings(null));
  }, []);

  const drafterCfg = agentSettings?.configs.find((c) => c.agent_name === "drafter");
  const providerOverride = drafterCfg?.provider ?? "claude";

  const swapProvider = async (next: string) => {
    if (!drafterCfg) return;
    setSavingProvider(true);
    try {
      await updateAgentSetting("drafter" as AgentName, drafterCfg.mode, next);
      const fresh = await getAgentSettings();
      setAgentSettings(fresh);
    } finally {
      setSavingProvider(false);
      setPopoverOpen(false);
    }
  };
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [ending, setEnding] = useState(false);
  const [reflection, setReflection] = useState<ReflectResult | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const [bgItems, setBgItems] = useState<BgItem[]>([
    { kind: "session", state: "idle", time: "ready", text: "press start to begin a session" },
  ]);

  const handleStatus = useCallback((s: ChatStatus) => {
    setStatus(s);
    onWsStatus?.(s);
    // Single sticky status row instead of accumulating transition history —
    // noisy and pointless once we've reached "ready".
    const text =
      s === "ready"   ? `${agentName} is ready · say hi to begin` :
      s === "closed"  ? "session closed" :
      s === "error"   ? "connection error" :
      s === "open"    ? "launching agent…" :
      "connecting…";
    const state: BgItem["state"] = s === "ready" ? "idle" : s === "error" || s === "closed" ? "done" : "active";
    setBgItems([{ kind: "session", state, time: "now", text }]);
  }, [agentName, onWsStatus]);

  async function handleEnd() {
    if (ending) return;
    setEnding(true);
    setEndError(null);
    try {
      const result = await endSessionWithReflection(sessionId);
      setReflection(result);
      // Don't auto-navigate — Now hides on view change, modal would disappear.
      // User dismisses modal then navigates to reflect if they want to see it.
    } catch (e) {
      setEndError(String(e));
    } finally {
      setEnding(false);
    }
  }

  // Close-terminal: drop the session without running reflection and return to
  // the start screen. Unmounting the iframe closes its WS, the sidecar/hub
  // observes the disconnect and tears down the PTY. `sessionId` is keyed on
  // `started`, so the next start gets a fresh session.
  function handleCloseTerminal() {
    setStarted(false);
    setStatus("connecting");
    setBgItems([{ kind: "session", state: "idle", time: "ready", text: "press start to begin a session" }]);
  }

  const statusLabel = !started ? "not started"
    : status === "ready" ? "live"
    : status === "connecting" || status === "open" ? "starting"
    : status === "closed" ? "closed"
    : "errored";
  const statusColor = !started ? "var(--a-line-2)"
    : status === "ready" ? "var(--sem-green)"
    : status === "closed" || status === "error" ? "var(--sem-red)"
    : "var(--sem-amber)";

  return (
    <div className="now-root">
      <div className="bg-strip" tabIndex={0} role="region" aria-label="Background activity">
        <div className="bg-strip-label">
          <span className="orb" />
          background · {agentName} while you think
        </div>
        {bgItems.map((b, i) => (
          <div key={i} className="bg-strip-item" data-s={b.state}>
            <div className="bs-kind">
              <span>{b.kind}</span>
              <span className="sep">·</span>
              <span>{b.time}</span>
            </div>
            <div className="bs-body">{b.text}</div>
          </div>
        ))}
      </div>

      <div className="now-body">
        <div className="chat terminal-pane">
          {flavor && started && (
            <div className="chat-head">
              <div>
                <div className="pickup-tag">picking up from</div>
                <p className="pickup">"{flavor}"</p>
              </div>
              <div className="chat-head-meta">
                session · {statusLabel}
              </div>
            </div>
          )}
          {started ? (
            terminalEngine === "sidecar" ? (
              <TerminalIframe
                sessionId={sessionId}
                agentName={agentName}
                provider={providerOverride}
                wsUrl={SIDECAR_WS_URL}
                onStatus={handleStatus}
              />
            ) : terminalEngine === "ttyd" ? (
              <TerminalTtyd
                sessionId={sessionId}
                agentName={agentName}
                onStatus={handleStatus}
                agent="drafter"
              />
            ) : (
              <Terminal
                sessionId={sessionId}
                agentName={agentName}
                onStatus={handleStatus}
                provider={providerOverride}
              />
            )
          ) : (
            <div className="now-start-pane">
              <div className="now-start-card">
                <div className="kicker">session · not started</div>
                <h2 className="now-start-h">Ready when you are.</h2>
                <p className="now-start-sub">
                  {flavor
                    ? <>Pick up from <em>"{flavor}"</em></>
                    : <>{agentName} has the project context loaded silently. Press start and type your first thought.</>
                  }
                </p>
                <div style={{ marginTop: 12, marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
                  drafter provider: <span style={{ color: "var(--a-accent)" }}>{providerOverride}</span>
                  <span style={{ marginLeft: 8 }}>· change in <em>Settings → Agents</em> or via the footbar.</span>
                </div>
                <div style={{ marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
                  terminal engine:{" "}
                  <button
                    type="button"
                    className={`tweak-chip${terminalEngine === "legacy" ? " on" : ""}`}
                    onClick={() => setTerminalEngine("legacy")}
                  >legacy</button>{" "}
                  <button
                    type="button"
                    className={`tweak-chip${terminalEngine === "ttyd" ? " on" : ""}`}
                    onClick={() => setTerminalEngine("ttyd")}
                  >v2 ttyd</button>{" "}
                  <button
                    type="button"
                    className={`tweak-chip${terminalEngine === "sidecar" ? " on" : ""}`}
                    onClick={() => setTerminalEngine("sidecar")}
                    title="Rust PTY sidecar — VTE grid + semantic events. Iframe-isolated for layout safety."
                  >sidecar</button>
                  <span style={{ marginLeft: 8 }}>(legacy = WebSocket + xterm; v2 = ttyd reverse-proxied; sidecar = iframe-wrapped xterm + Rust PTY engine — the v1.0 ship target.)</span>
                </div>
                <button className="now-start-btn" onClick={() => setStarted(true)}>
                  <span className="now-start-dot" />
                  start now
                </button>
                <div className="now-start-meta">
                  one session = one {providerOverride} process · press end-session → reflect when done
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="live-canvas">
          <div className="live-canvas-head">
            <h3>Canvas · {activeProject}</h3>
            <div className="meta" onClick={() => onOpenCanvas?.()} style={{ cursor: "pointer" }}>open full canvas →</div>
          </div>
          <LiveGraph
            project={activeProject}
            baseUrl={BASE_URL}
            onNodeClick={(node) => onOpenCanvas?.(node.id)}
          />
          <div className="live-canvas-foot">
            <span>drag to pan · scroll to zoom · hover to peek · click to pin · click again to open</span>
          </div>
        </div>
      </div>

      <div className="now-footbar" style={{ position: "relative" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
          {activeProject} · {statusLabel}
        </span>
        <button
          className="now-provider-switch"
          type="button"
          onClick={() => setPopoverOpen((o) => !o)}
          title="change drafter provider"
          disabled={savingProvider || !agentSettings}
        >
          provider · <span className="now-provider-switch-current">{providerOverride}</span>
        </button>
        {popoverOpen && agentSettings && (
          <div className="now-provider-popover">
            {agentSettings.known_providers.map((p) => (
              <button
                key={p.id}
                className={p.id === providerOverride ? "current" : ""}
                onClick={() => swapProvider(p.id)}
                disabled={savingProvider}
              >
                {p.label}{p.id === providerOverride ? " · current" : ""}
              </button>
            ))}
          </div>
        )}
        {started && (
          <button
            className="now-close-btn"
            onClick={handleCloseTerminal}
            title="close terminal · drops the session without reflecting and returns to the start screen"
          >
            × close terminal
          </button>
        )}
        {started && (status === "closed" || status === "error") ? (
          <button
            className="end-btn"
            onClick={() => { setStarted(false); setStatus("connecting"); }}
            title="session ended · click to go back to the start pane"
          >
            start new session →
          </button>
        ) : (
          <button
            className="end-btn"
            onClick={handleEnd}
            disabled={!started || ending || status !== "ready"}
            title={!started ? "no session yet — click start now" : status !== "ready" ? `waiting for session (${statusLabel})` : "end session · writes reflection artifact"}
          >
            {ending ? "reflecting…" : "end session → reflect →"}
          </button>
        )}
      </div>

      {reflection && (
        <div className="reflection-overlay" onClick={() => { setReflection(null); setStarted(false); }}>
          <div className="reflection-card" onClick={e => e.stopPropagation()}>
            <h3>reflection saved</h3>
            <p>Artifact: <code>{reflection.artifact_path}</code></p>
            <p>Signals: <strong>{reflection.signals_extracted}</strong></p>
            {reflection.used_fallback && <p style={{ color: "var(--a-mute)", fontSize: "var(--t-2)" }}>fallback template used</p>}
            <button onClick={() => { setReflection(null); setStarted(false); }}>close</button>
          </div>
        </div>
      )}

      {endError && (
        <div className="reflection-overlay" onClick={() => setEndError(null)}>
          <div className="reflection-card" onClick={e => e.stopPropagation()}>
            <h3>reflection failed</h3>
            <p style={{ color: "var(--sem-red)" }}>{endError}</p>
            <button onClick={() => setEndError(null)}>close</button>
          </div>
        </div>
      )}
    </div>
  );
}
