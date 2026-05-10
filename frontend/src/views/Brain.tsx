import { useEffect, useMemo, useState } from "react";
import {
  getBrainInspection,
  getBrainPreview,
  getOmnigraphStatus,
  getAgentConstraints,
  getDomainBrain,
  type BrainInspection,
  type BrainLayerView,
  type BrainProjectLayerView,
  type BrainInjectFlags,
  type BrainPreview,
  type OmnigraphStatusResponse,
  type AgentConstraintsView,
  type DomainBrainFile,
} from "../lib/api";

interface Props {
  baseUrl: string;
  project: string;
}

type TabKey = "global" | "personal" | "project" | "domain";

// The 3-layer separation is load-bearing: mixing layers caused hallucinations
// historically (omnigraph/docs/ATELIER_OUTPUTS.md). The watermark on each tab
// names the layer's scope so the surface itself enforces the contract.
const TABS: ReadonlyArray<{ key: TabKey; label: string; sub: string; watermark: string }> = [
  {
    key: "global",
    label: "global",
    sub: "founder cognition",
    watermark: "applies to all projects · derived from session history · do not mix layers",
  },
  {
    key: "personal",
    label: "personal",
    sub: "ai collaboration",
    watermark: "applies to this founder · across all projects · user-scoped",
  },
  {
    key: "project",
    label: "project",
    sub: "objective facts",
    watermark: "shared across users on this project · per-project compiled · objective facts only",
  },
  {
    key: "domain",
    label: "domain",
    sub: "founder notes",
    watermark: "free-form notes you author · not auto-injected into prompts · industry / customer / regulation",
  },
];

function isTabKey(s: string | null): s is TabKey {
  return s === "global" || s === "personal" || s === "project" || s === "domain";
}

function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function bytesToTokens(bytes: number): number {
  // Rough estimate (4 bytes per token average for English-ish text).
  return Math.round(bytes / 4);
}

export function Brain({ baseUrl, project }: Props) {
  const [tab, setTab] = useState<TabKey>(() => {
    const saved = localStorage.getItem("atelier.brain.tab");
    if (isTabKey(saved)) return saved;
    const hash = (typeof window !== "undefined" ? window.location.hash.replace("#", "") : "");
    if (isTabKey(hash)) return hash;
    return "global";
  });
  useEffect(() => { localStorage.setItem("atelier.brain.tab", tab); }, [tab]);

  const [insp, setInsp] = useState<BrainInspection | null>(null);
  const [status, setStatus] = useState<OmnigraphStatusResponse | null>(null);
  const [drafterConstraints, setDrafterConstraints] = useState<AgentConstraintsView | null>(null);
  const [domainFiles, setDomainFiles] = useState<DomainBrainFile[] | null>(null);
  const [preview, setPreview] = useState<BrainPreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getBrainInspection(baseUrl, project),
      getOmnigraphStatus(baseUrl),
      getAgentConstraints(baseUrl, "drafter"),
    ])
      .then(([i, s, c]) => { setInsp(i); setStatus(s); setDrafterConstraints(c); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [baseUrl, project]);

  useEffect(() => {
    if (tab !== "domain") return;
    if (domainFiles !== null) return;
    getDomainBrain(baseUrl, project).then(setDomainFiles).catch(() => setDomainFiles([]));
  }, [tab, baseUrl, project, domainFiles]);

  function openPreview() {
    setShowPreview(true);
    if (preview) return;
    getBrainPreview(baseUrl, project).then(setPreview).catch(e => setError(String(e)));
  }

  if (loading || !insp || !status) {
    return (
      <div style={{ padding: "56px 72px", maxWidth: 980, margin: "0 auto" }} aria-busy="true" aria-label="Loading brain">
        <div className="skeleton-line" style={{ width: "32%", height: 12 }} />
        <div className="skeleton-line" style={{ width: "62%", height: 30, marginTop: 14 }} />
        <div className="skeleton-block" style={{ width: "100%", height: 220, marginTop: 32 }} />
        <div className="skeleton-line" style={{ width: "85%", marginTop: 20 }} />
        {error && <div style={{ marginTop: 24, color: "var(--sem-red)", fontFamily: "var(--font-mono)" }}>{error}</div>}
      </div>
    );
  }

  const tabDef = TABS.find(t => t.key === tab) ?? TABS[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--a-page)" }}>
      <BrainHeader project={project} insp={insp} status={status} onPreview={openPreview} />

      <div role="tablist" aria-label="brain layers" style={{
        display: "flex",
        borderBottom: "1px solid var(--a-line)",
        padding: "0 32px",
        background: "var(--a-paper)",
      }}>
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            data-brain-tab={t.key}
            style={{
              padding: "12px 18px",
              background: "transparent",
              border: 0,
              borderBottom: tab === t.key ? "2px solid var(--a-accent)" : "2px solid transparent",
              color: tab === t.key ? "var(--a-ink)" : "var(--a-mute)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-2)",
              textTransform: "lowercase",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
            }}
          >
            <span>{t.label}</span>
            <span style={{ fontSize: "0.68rem", opacity: 0.7 }}>{t.sub}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto", padding: "28px 48px 56px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <Watermark text={tabDef.watermark} />

          {tab === "domain" ? (
            <DomainTab project={project} files={domainFiles} />
          ) : tab === "global" ? (
            <LayerTab
              tab="global"
              project={project}
              layer={insp.global}
              isShared={false}
              isProjectLayer={false}
              injected={insp.injectFlags.includeGlobal}
              status={status}
              constraints={null}
            />
          ) : tab === "personal" ? (
            <LayerTab
              tab="personal"
              project={project}
              layer={insp.personal}
              isShared={false}
              isProjectLayer={false}
              injected={insp.injectFlags.includePersonal}
              status={status}
              constraints={null}
            />
          ) : (
            <LayerTab
              tab="project"
              project={project}
              layer={insp.project ?? emptyProjectLayer(project)}
              isShared={!!insp.project?.isShared}
              isProjectLayer={true}
              injected={insp.injectFlags.includeProject}
              status={status}
              constraints={drafterConstraints}
            />
          )}
        </div>
      </div>

      {showPreview && <PreviewModal preview={preview} onClose={() => setShowPreview(false)} />}
    </div>
  );
}

function emptyProjectLayer(projectName: string): BrainProjectLayerView {
  return { exists: false, path: "", xml: null, bytes: 0, mtime: null, source: null, projectName, isShared: false };
}

function Watermark({ text }: { text: string }) {
  return (
    <div className="brain-watermark" style={{
      padding: "10px 14px",
      background: "var(--a-paper-2, #1a1a1a)",
      borderLeft: "2px solid var(--a-accent)",
      borderRadius: 3,
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-1)",
      color: "var(--a-mute)",
      textTransform: "lowercase",
      marginBottom: 22,
      lineHeight: 1.5,
    }}>{text}</div>
  );
}

function BrainHeader({ project, insp, status, onPreview }: {
  project: string;
  insp: BrainInspection;
  status: OmnigraphStatusResponse;
  onPreview: () => void;
}) {
  const tokens = bytesToTokens(insp.totalInjectedBytes);
  const daemonOk = status.daemon.running;
  const layersOn = (Object.entries(insp.injectFlags) as Array<[keyof BrainInjectFlags, boolean]>)
    .filter(([, v]) => v)
    .map(([k]) => k.replace("include", "").toLowerCase())
    .join(" / ");
  return (
    <div style={{
      padding: "20px 32px 16px",
      borderBottom: "1px solid var(--a-line)",
      background: "var(--a-page)",
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 18,
    }}>
      <div style={{ minWidth: 220 }}>
        <div className="micro" style={{ color: "var(--a-mute)" }}>{project} · brain</div>
        <h2 style={{ margin: "4px 0 0", fontFamily: "var(--font-serif)", fontWeight: 600, letterSpacing: "-0.02em", fontSize: "var(--t-5)", lineHeight: 1.2 }}>
          What the agent knows about you
        </h2>
      </div>
      <div style={{
        display: "flex", flex: "1 1 auto", flexWrap: "wrap", gap: 14,
        fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase",
      }}>
        <Pill label="etl daemon" value={daemonOk ? "● up" : "○ down"} tone={daemonOk ? "ok" : "warn"} />
        <Pill label="last compile" value={formatAge(status.layerMtimes.global)} />
        <Pill label="injected at boot" value={`${insp.totalInjectedBytes.toLocaleString()} b · ~${tokens.toLocaleString()} tk`} />
        <Pill label="layers on" value={layersOn || "none"} />
        {status.constraints.pendingEvents > 0 && (
          <Pill label="pending verifier" value={String(status.constraints.pendingEvents)} tone="warn" />
        )}
        {status.constraints.stale && <Pill label="constraints" value="stale" tone="warn" />}
      </div>
      <button
        type="button"
        onClick={onPreview}
        data-brain-action="preview"
        style={{
          padding: "6px 14px",
          background: "transparent",
          border: "1px solid var(--a-accent)",
          color: "var(--a-accent)",
          borderRadius: 3,
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--t-1)",
          textTransform: "lowercase",
        }}
      >preview boot prompt →</button>
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const color = tone === "warn" ? "var(--sem-orange)" : tone === "ok" ? "var(--a-accent)" : "var(--a-ink)";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span style={{ color, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function LayerTab({ tab, project, layer, isShared, isProjectLayer, injected, status, constraints }: {
  tab: TabKey;
  project: string;
  layer: BrainLayerView | BrainProjectLayerView;
  isShared: boolean;
  isProjectLayer: boolean;
  injected: boolean;
  status: OmnigraphStatusResponse;
  constraints: AgentConstraintsView | null;
}) {
  if (!layer.exists) {
    return (
      <div style={{
        padding: 24,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-2)",
        color: "var(--a-mute)",
        textTransform: "lowercase",
        border: "1px dashed var(--a-line)",
        borderRadius: 3,
      }}>
        no {tab} brain compiled yet for {project}.
        <div style={{ marginTop: 8, fontSize: "0.85rem" }}>
          run the omnigraph etl or wait for the next cycle. status: {status.daemon.running ? "daemon up" : "daemon down"}.
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 18,
        padding: "10px 14px", marginBottom: 18,
        fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase",
        border: "1px solid var(--a-line)", borderRadius: 3,
      }}>
        <span>source · <strong style={{ color: "var(--a-ink)" }}>{layer.source ?? "—"}{isProjectLayer && isShared ? " (shared)" : ""}</strong></span>
        <span>bytes · <strong style={{ color: "var(--a-ink)" }}>{layer.bytes.toLocaleString()}</strong></span>
        <span>compiled · <strong style={{ color: "var(--a-ink)" }}>{formatAge(layer.mtime)}</strong></span>
        <span>inject · <strong style={{ color: injected ? "var(--a-accent)" : "var(--sem-orange)" }}>{injected ? "✓ on" : "✗ off"}</strong></span>
        <span style={{ marginLeft: "auto", opacity: 0.55, fontSize: "0.72rem" }}>{layer.path}</span>
      </div>

      <XmlPreview xml={layer.xml || ""} />

      {isProjectLayer && constraints && (
        <ConstraintsBlock
          constraints={constraints}
          stale={status.constraints.stale}
          pending={status.constraints.pendingEvents}
        />
      )}
    </>
  );
}

function ConstraintsBlock({ constraints, stale, pending }: {
  constraints: AgentConstraintsView;
  stale: boolean;
  pending: number;
}) {
  if (!constraints.exists) {
    return (
      <section style={{ marginTop: 36 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase" }}>
          constraint flywheel · no compiled rules yet
        </div>
      </section>
    );
  }
  const rules = constraints.audit?.rules ?? [];
  return (
    <section data-brain-block="constraints" style={{ marginTop: 36 }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8,
        fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase",
      }}>
        <span style={{ color: "var(--a-ink)", fontWeight: 600 }}>agent_constraints/{constraints.role}.md</span>
        <span style={{ color: "var(--a-mute)" }}>· compiled {formatAge(constraints.mtime)}</span>
        {stale && <span style={{ color: "var(--sem-orange)", fontWeight: 600 }}>· stale</span>}
        {pending > 0 && <span style={{ color: "var(--sem-orange)" }}>· {pending} pending verifier events</span>}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginBottom: 14, textTransform: "lowercase" }}>
        constraint flywheel · founder-accepted verifier failures the agent honors on next session boot
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
        <thead>
          <tr style={{ background: "var(--a-paper-2)", color: "var(--a-mute)", textAlign: "left" }}>
            <th style={{ padding: 8, fontWeight: 500 }}>#</th>
            <th style={{ padding: 8, fontWeight: 500 }}>rule</th>
            <th style={{ padding: 8, fontWeight: 500 }}>freq</th>
            <th style={{ padding: 8, fontWeight: 500 }}>last seen</th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: 14, color: "var(--a-mute)", textTransform: "lowercase" }}>
                no compiled rules yet · accept a verifier_unverified event on /approvals to seed
              </td>
            </tr>
          )}
          {rules.map((r, i) => {
            const constraint = String((r as { constraint?: unknown }).constraint ?? "");
            const count = String((r as { count?: unknown }).count ?? "");
            const lastSeen = String((r as { last_seen?: unknown }).last_seen ?? "").slice(0, 10);
            return (
              <tr key={i} style={{ borderTop: "1px solid var(--a-line)" }}>
                <td style={{ padding: 8, color: "var(--a-mute)" }}>{i + 1}</td>
                <td style={{ padding: 8 }}>{constraint}</td>
                <td style={{ padding: 8, color: "var(--a-mute)" }}>{count}</td>
                <td style={{ padding: 8, color: "var(--a-mute)" }}>{lastSeen}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function DomainTab({ project, files }: { project: string; files: DomainBrainFile[] | null }) {
  if (files === null) {
    return <div style={{ fontFamily: "var(--font-mono)", color: "var(--a-mute)", textTransform: "lowercase" }}>loading domain files…</div>;
  }
  if (files.length === 0) {
    return (
      <div style={{
        padding: 24,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-2)",
        color: "var(--a-mute)",
        textTransform: "lowercase",
        border: "1px dashed var(--a-line)",
        borderRadius: 3,
      }}>
        no domain brain files in projects/{project}/domain_brain/.
        <div style={{ marginTop: 8, fontSize: "0.85rem" }}>
          drop free-form markdown about your industry, customer, or regulation here. it does not auto-inject — the agent reads it on demand.
        </div>
      </div>
    );
  }
  return <DomainList files={files} />;
}

function DomainList({ files }: { files: DomainBrainFile[] }) {
  const [sel, setSel] = useState<string>(files[0]?.name ?? "");
  const active = useMemo(() => files.find(f => f.name === sel) ?? files[0], [files, sel]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 24 }}>
      <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {files.map(f => (
          <button
            key={f.name}
            type="button"
            onClick={() => setSel(f.name)}
            style={{
              padding: "6px 10px",
              textAlign: "left",
              background: sel === f.name ? "var(--a-paper-2)" : "transparent",
              border: 0,
              color: sel === f.name ? "var(--a-accent-2)" : "var(--a-ink)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-1)",
              cursor: "pointer",
              borderRadius: 3,
            }}
          >{f.filename}</button>
        ))}
      </nav>
      <article>
        <h3 style={{ margin: "0 0 12px", fontFamily: "var(--font-serif)", fontWeight: 600 }}>{active.filename}</h3>
        <pre style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "var(--a-paper)",
          padding: 16,
          borderRadius: 3,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--t-1)",
          color: "var(--a-ink)",
          maxHeight: 540,
          overflow: "auto",
        }}>{active.content}</pre>
      </article>
    </div>
  );
}

function XmlPreview({ xml }: { xml: string }) {
  return (
    <pre data-brain-block="xml" style={{
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      background: "var(--a-paper)",
      padding: 18,
      borderRadius: 3,
      border: "1px solid var(--a-line)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-1)",
      color: "var(--a-ink)",
      maxHeight: 540,
      overflow: "auto",
      margin: 0,
    }}>{xml || "(empty)"}</pre>
  );
}

function PreviewModal({ preview, onClose }: { preview: BrainPreview | null; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="boot prompt preview"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--a-page)",
        borderRadius: 6,
        border: "1px solid var(--a-line)",
        maxWidth: 880,
        maxHeight: "calc(100vh - 64px)",
        display: "flex",
        flexDirection: "column",
        width: "100%",
      }}>
        <div style={{
          display: "flex",
          padding: "14px 20px",
          borderBottom: "1px solid var(--a-line)",
          alignItems: "center",
        }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", flex: 1 }}>
            boot-prompt preview · what the agent actually receives
            {preview && (
              <span style={{ marginLeft: 12, color: "var(--a-mute)" }}>
                {preview.bytes.toLocaleString()} b · ~{bytesToTokens(preview.bytes).toLocaleString()} tk
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            style={{
              background: "transparent",
              border: 0,
              color: "var(--a-mute)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-2)",
              padding: 4,
            }}
          >✕</button>
        </div>
        <div style={{ flex: "1 1 auto", overflow: "auto", padding: 20 }}>
          {!preview ? (
            <div style={{ color: "var(--a-mute)", fontFamily: "var(--font-mono)", textTransform: "lowercase" }}>loading…</div>
          ) : (
            <pre style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-1)",
              color: "var(--a-ink)",
              margin: 0,
            }}>{preview.markdown || "(no brain artifacts found)"}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
