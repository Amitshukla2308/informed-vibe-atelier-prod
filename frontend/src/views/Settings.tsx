import { useEffect, useState } from "react";
import { PeoplePanel } from "../components/PeoplePanel";
import { ChangePasswordSection } from "../components/ChangePasswordSection";
import { AgentSettingsSection } from "../components/AgentSettingsSection";
import { DistributionSettingsSection } from "../components/DistributionSettingsSection";
import { MarkdownView } from "../components/MarkdownView";
import { BASE_URL, getTerminalV2Availability, type TerminalV2Availability } from "../lib/api";

type TerminalEngine = "legacy" | "ttyd";

/**
 * Architecture primer — entry point to PROJECT_SHAPE.md inside the product.
 * The doc is the contract between founder, Drafter, and Implementer; we want
 * the founder to be able to glance at it from Settings without opening a
 * terminal or a separate file viewer.
 */
function ArchitecturePrimerSection() {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openPrimer() {
    setOpen(true);
    if (src || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${BASE_URL}/docs/project-shape`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const md = await r.text();
      setSrc(md);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <div>
        <h2>Architecture</h2>
        <div className="hint">
          how Atelier shapes a project — the 6 altitudes (layer · plane · surface · story|epic · task · subtask)
          and the rules that converge work toward the silhouette. read this once at project start; reference any
          time things feel structurally off.
        </div>
      </div>
      <div>
        <button
          type="button"
          className="settings-btn"
          onClick={openPrimer}
          title="open the project-shape primer"
          style={{
            padding: "0.45rem 1.1rem",
            background: "var(--a-accent)",
            color: "var(--a-page)",
            border: "1px solid var(--a-accent)",
            borderRadius: 4,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-2)",
            textTransform: "lowercase",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          read the project-shape primer
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 22, 18, 0.55)",
            backdropFilter: "blur(2px)",
            zIndex: 100,
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            padding: "5vh 4vw",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: "1 1 auto",
              maxWidth: 980,
              background: "var(--a-page)",
              border: "1px solid var(--a-line)",
              borderRadius: 6,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px solid var(--a-line)",
                background: "var(--a-paper)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ fontSize: "var(--t-2)", textTransform: "lowercase", color: "var(--a-mute)" }}>
                docs / project-shape.md
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  padding: "0.25rem 0.7rem",
                  background: "transparent",
                  color: "var(--a-mute)",
                  border: "1px solid var(--a-line-2)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-2)",
                  textTransform: "lowercase",
                  cursor: "pointer",
                }}
              >
                close
              </button>
            </div>
            <div style={{ flex: "1 1 auto", overflow: "auto", padding: "20px 28px" }}>
              {busy && <div style={{ color: "var(--a-mute)" }}>loading…</div>}
              {err && <div style={{ color: "var(--sem-orange, #E8A86A)" }}>failed to load: {err}</div>}
              {src && <MarkdownView src={src} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TerminalEngineSection() {
  const [engine, setEngine] = useState<TerminalEngine>(() => (localStorage.getItem("atelier.terminalEngine") as TerminalEngine) || "legacy");
  const [avail, setAvail] = useState<TerminalV2Availability | null>(null);

  useEffect(() => {
    localStorage.setItem("atelier.terminalEngine", engine);
  }, [engine]);

  useEffect(() => {
    getTerminalV2Availability().then(setAvail).catch(() => setAvail({ available: false, reasons: ["could not reach backend"] }));
  }, []);

  return (
    <div className="settings-section">
      <div>
        <h2>Terminal Engine</h2>
        <div className="hint">
          Legacy is the WebSocket+xterm bridge that ships today. v2 swaps in <strong>ttyd</strong> directly driving the provider CLI, reverse-proxied through Atelier so the terminal works on any device that can reach the backend (LAN, tunnel, phone). Both route the same provider CLI; only the rendering plumbing differs.
        </div>
      </div>
      <div>
        <div className="agent-mode-pickers" style={{ marginBottom: 8 }}>
          <button
            type="button"
            className={`tweak-chip${engine === "legacy" ? " on" : ""}`}
            onClick={() => setEngine("legacy")}
          >legacy</button>
          <button
            type="button"
            className={`tweak-chip${engine === "ttyd" ? " on" : ""}`}
            onClick={() => setEngine("ttyd")}
            disabled={avail !== null && !avail.available}
            title={avail && !avail.available ? avail.reasons.join("; ") : ""}
          >v2 ttyd</button>
        </div>
        <div className="agent-row-purpose" style={{ marginTop: 4 }}>
          {avail === null
            ? "checking ttyd availability…"
            : avail.available
              ? <>✓ ttyd detected — v2 ready to use.</>
              : <>v2 unavailable: {avail.reasons.join("; ")}</>}
        </div>
        <div className="agent-row-purpose" style={{ marginTop: 4, color: "var(--a-mute-2)" }}>
          Once v2 proves out across a few sessions, the legacy bridge will be removed.
        </div>
      </div>
    </div>
  );
}

interface Props {
  agentName: string;
  founderName: string;
  activeProject: string;
  theme: string;
  setTheme: (t: string) => void;
  density: string;
  setDensity: (d: string) => void;
}

type ReflectionMode = "manual" | "semi-auto" | "auto";

interface ThemeDef {
  slug: string;
  name: string;
  tagline: string;
  page: string;
  ink: string;
  accent: string;
}

const themes: ThemeDef[] = [
  { slug: "paper",     name: "Paper",         tagline: "atelier default · warm",                page: "#F3EDDF", ink: "#1A1714", accent: "#A94E2B" },
  { slug: "midnight",  name: "Midnight",      tagline: "deep · amber glow",                     page: "#1C1F26", ink: "#F1EFEA", accent: "#D9A066" },
  { slug: "ash",       name: "Ash",           tagline: "neutral grey · calm",                   page: "#ECEEF0", ink: "#161A1F", accent: "#7B6D54" },
  { slug: "fog",       name: "Fog",           tagline: "soft blue-grey · overcast",             page: "#EAEDEF", ink: "#202428", accent: "#6E7F8E" },
  { slug: "oat",       name: "Oat",           tagline: "warm cream · sage accent",              page: "#EFE9DA", ink: "#2B2519", accent: "#6B8A6E" },
  { slug: "deep",      name: "The Deep",      tagline: "deep-work · minimizes glow",            page: "#0F1115", ink: "#E8ECEF", accent: "#00FFC2" },
  { slug: "executive", name: "The Executive", tagline: "physical docs · business trust",        page: "#F9F7F2", ink: "#1A1A1A", accent: "#2C3E50" },
  { slug: "hybrid",    name: "The Hybrid",    tagline: "tech clarity + operational status",     page: "#F5F5F5", ink: "#2F2F2F", accent: "#635BFF" },
  { slug: "sage",      name: "The Global",    tagline: "dark moss · silver for the globalist",  page: "#1B1D17", ink: "#E5E0D8", accent: "#D1D5DB" },
];

export function Settings({ agentName, founderName, activeProject, theme, setTheme, density, setDensity }: Props) {
  // Reflection mode is a local UI stub until we wire to backend config.yaml via a
  // settings-patch endpoint. For now changes persist to localStorage and the worker
  // reads the yaml directly, so these toggles are previewed here but applied by
  // editing agents/config.yaml on disk.
  const [reflectMode, setReflectMode] = useState<ReflectionMode>(() => (localStorage.getItem("atelier.reflectMode") as ReflectionMode) || "semi-auto");
  const [threshold, setThreshold] = useState(() => Number(localStorage.getItem("atelier.reflectThreshold") ?? 8000));
  const [provider, setProvider] = useState(() => localStorage.getItem("atelier.provider") || "claude");

  function persistMode(m: ReflectionMode) {
    setReflectMode(m);
    localStorage.setItem("atelier.reflectMode", m);
  }
  function persistThreshold(n: number) {
    setThreshold(n);
    localStorage.setItem("atelier.reflectThreshold", String(n));
  }
  function persistProvider(p: string) {
    setProvider(p);
    localStorage.setItem("atelier.provider", p);
  }

  return (
    <div className="settings-root">
      <h1>Settings</h1>
      <div className="sub">Everything that's you, not the project.</div>

      <AgentSettingsSection />

      <DistributionSettingsSection />

      <ArchitecturePrimerSection />

      {/* R3.6 — Diagnostics extracted from /home into /settings/diagnostics. Quick link from Settings. */}
      <div className="settings-section">
        <div>
          <h2>Diagnostics</h2>
          <div className="hint">PIDs, paths, ETL pipeline stages, source folder counts. Used to live behind a disclosure on /home; now its own page for the engineering view.</div>
        </div>
        <div>
          <button
            type="button"
            className="settings-btn"
            onClick={() => {
              window.history.pushState({}, "", "/settings/diagnostics");
              window.dispatchEvent(new Event("atelier:navigate"));
            }}
            style={{
              padding: "0.45rem 1.1rem",
              background: "var(--a-accent)",
              color: "var(--a-page)",
              border: "1px solid var(--a-accent)",
              borderRadius: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-2)",
              textTransform: "lowercase",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            open diagnostics →
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>Account</h2>
          <div className="hint">your password and identity on this Atelier instance.</div>
        </div>
        <div>
          <ChangePasswordSection />
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>People</h2>
          <div className="hint">invite collaborators, manage roles, revoke access.</div>
        </div>
        <div>
          <PeoplePanel />
        </div>
      </div>

      <TerminalEngineSection />

      <div className="settings-section">
        <div>
          <h2>Appearance</h2>
          <div className="hint">paper by default.</div>
        </div>
        <div>
          <div className="settings-control">
            <label>theme</label>
            <div className="theme-grid">
              {themes.map(t => (
                <div
                  key={t.slug}
                  className={`theme-swatch ${theme === t.slug ? "on" : ""}`}
                  onClick={() => setTheme(t.slug)}
                  title={t.tagline}
                >
                  <div className="swatch-top">
                    <span style={{ background: t.page }} />
                    <span style={{ background: t.ink }} />
                    <span style={{ background: t.accent }} />
                  </div>
                  <div className="name">{t.name}</div>
                  <div className="tagline">{t.tagline}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="settings-control">
            <label>density</label>
            <div className="tweak-chips">
              {["comfy", "compact"].map(d => (
                <button key={d} className={`tweak-chip ${density === d ? "on" : ""}`} onClick={() => setDensity(d)}>{d}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>Identity</h2>
          <div className="hint">your name + your AI co-founder's name. agents config (provider per role) lives in the section above.</div>
        </div>
        <div>
          <div className="settings-control">
            <label htmlFor="settings-agent-name">agent name</label>
            <input id="settings-agent-name" aria-label="agent name" defaultValue={agentName} readOnly style={{ background: "var(--a-paper-2)", cursor: "not-allowed" }} />
            <label htmlFor="settings-founder-name">founder name</label>
            <input id="settings-founder-name" aria-label="founder name" defaultValue={founderName} readOnly style={{ background: "var(--a-paper-2)", cursor: "not-allowed" }} />
          </div>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            to rename, re-run onboarding · config stored in project directory
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>Project</h2>
          <div className="hint">active project context.</div>
        </div>
        <div>
          <div className="settings-control">
            <label htmlFor="settings-active-project">active project</label>
            <input id="settings-active-project" aria-label="active project" defaultValue={activeProject} readOnly style={{ background: "var(--a-paper-2)", cursor: "not-allowed" }} />
          </div>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            one project per workspace for now · multi-project switching coming
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>Reflection</h2>
          <div className="hint">when the agent writes reflection artifacts. auto = every unreflected session. semi-auto = only if session tokens ≥ threshold. manual = you trigger in reflect view.</div>
        </div>
        <div>
          <div className="settings-control">
            <label>mode</label>
            <div className="tweak-chips">
              {(["manual", "semi-auto", "auto"] as ReflectionMode[]).map(m => (
                <button
                  key={m}
                  className={`tweak-chip ${reflectMode === m ? "on" : ""}`}
                  onClick={() => persistMode(m)}
                >{m}</button>
              ))}
            </div>
          </div>
          {reflectMode === "semi-auto" && (
            <div className="settings-control">
              <label htmlFor="settings-token-threshold">token threshold</label>
              <input
                id="settings-token-threshold"
                aria-label="token threshold"
                type="number"
                value={threshold}
                min={1000}
                step={1000}
                onChange={e => persistThreshold(Number(e.target.value))}
                style={{ width: 120 }}
              />
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                sessions above this token count auto-reflect. default 8000.
              </div>
            </div>
          )}
          <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
            to apply: edit <code>agents/config.yaml</code> → <code>reflection_mode: {reflectMode}</code>
            {reflectMode === "semi-auto" && <> · <code>reflection_token_threshold: {threshold}</code></>}
            <br />backend worker re-reads the yaml each scan (every 2 min).
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div>
          <h2>Stack</h2>
          <div className="hint">what atelier runs on.</div>
        </div>
        <div>
          <div className="settings-control">
            <label>default provider</label>
            <div className="tweak-chips">
              {["claude", "gemini"].map(p => (
                <button
                  key={p}
                  className={`tweak-chip ${provider === p ? "on" : ""}`}
                  onClick={() => persistProvider(p)}
                >{p}</button>
              ))}
            </div>
          </div>
          <div className="settings-control">
            <label htmlFor="settings-backend">backend</label>
            <input id="settings-backend" aria-label="backend" defaultValue="localhost:3001 (Bun + TS)" readOnly style={{ background: "var(--a-paper-2)", cursor: "not-allowed" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
