/**
 * Settings → Agents group.
 *
 * Per-agent row: Drafter / Allocator / Implementer / Senior Reviewer.
 * Mode picker (manual | semi_auto | auto) as .tweak-chips.
 * Provider <select> backed by /settings/agents → known_providers.
 * Link state badge + inline "Link" button that records bin_path / base_url
 * via /settings/providers/:provider.
 */

import { useEffect, useState } from "react";
import {
  getAgentSettings, updateAgentSetting, updateProviderLink, verifyProvider,
  getImplementerAutoPoller, setImplementerAutoPoller,
  type AgentSettingsResponse, type AgentName, type AgentMode, type ProviderLink,
  type ProviderVerifyResult, type AutoPollerStatus,
} from "../lib/api";

const AGENT_PURPOSE: Record<AgentName, string> = {
  drafter:         "Founder co-thinker. Builds Canvas nodes from conversation.",
  fixer:           "Background headless Drafter. Auto-unblocks nodes the Allocator hand-backs (or marks for discussion).",
  researcher:      "Headless world-grounding. Invoked from Decision / Risk / Research drawers; writes findings to project brain and comments back.",
  allocator:       "Pre-Implementer classifier. Decides qwen | hand-back per node.",
  implementer:     "Background coder. Builds approved nodes on impl/<id> branches.",
  senior_reviewer: "Opt-in cloud critique pass on a finished diff.",
  reflect:         "Six-lens session crystallization at session-end. Writes brain layers.",
};

const AGENT_LABEL: Record<AgentName, string> = {
  drafter: "Drafter",
  fixer: "Fixer",
  researcher: "Researcher",
  allocator: "Allocator",
  implementer: "Implementer",
  senior_reviewer: "Senior Reviewer",
  reflect: "Reflect",
};

export function AgentSettingsSection() {
  const [data, setData] = useState<AgentSettingsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<Record<string, { running?: boolean; result?: ProviderVerifyResult }>>({});

  const onVerify = async (provider: string) => {
    setVerifyState((s) => ({ ...s, [provider]: { running: true } }));
    try {
      const existing = data?.links.find((l) => l.provider === provider) ?? null;
      const result = await verifyProvider(provider, existing ?? {});
      setVerifyState((s) => ({ ...s, [provider]: { running: false, result } }));
    } catch (e) {
      setVerifyState((s) => ({
        ...s,
        [provider]: { running: false, result: { ok: false, latency_ms: 0, detail: "verify failed", error: String(e).slice(0, 200) } },
      }));
    }
  };

  const load = async () => {
    try {
      const d = await getAgentSettings();
      setData(d);
    } catch (e) {
      setError(String(e).slice(0, 200));
    }
  };

  useEffect(() => { load(); }, []);

  if (!data) return <div className="settings-section"><h2>Agents</h2><div className="hint">{error ?? "loading agents…"}</div></div>;

  const linkStatusFor = (provider: string): ProviderLink["status"] => {
    const link = data.links.find((l) => l.provider === provider);
    if (link) return link.status;
    const det = data.detected.find((d) => d.provider === provider);
    return det?.available ? "linked" : "unlinked";
  };

  const onModeChange = async (agent: AgentName, mode: AgentMode) => {
    if (!data) return;
    setBusy(agent);
    try {
      const cfg = data.configs.find((c) => c.agent_name === agent)!;
      await updateAgentSetting(agent, mode, cfg.provider);
      await load();
    } catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(null); }
  };

  const onProviderChange = async (agent: AgentName, provider: string) => {
    if (!data) return;
    setBusy(agent);
    try {
      const cfg = data.configs.find((c) => c.agent_name === agent)!;
      await updateAgentSetting(agent, cfg.mode, provider);
      await load();
    } catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(null); }
  };

  return (
    <div className="settings-section">
      <div>
        <h2>Agents</h2>
        <div className="hint">
          Each agent has a mode (manual / semi-auto / auto) and a provider. Change once, applies everywhere.
        </div>
      </div>
      <div className="agents-group">
        {data.configs.map((cfg) => {
          const status = linkStatusFor(cfg.provider);
          return (
            <div key={cfg.agent_name} className="agent-row">
              <div>
                <div className="agent-row-label">{AGENT_LABEL[cfg.agent_name]}</div>
                <div className="agent-row-purpose">{AGENT_PURPOSE[cfg.agent_name]}</div>
              </div>
              <div className="agent-row-controls">
                <div className="agent-mode-pickers">
                  {data.agent_modes.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`tweak-chip${cfg.mode === m ? " on" : ""}`}
                      onClick={() => onModeChange(cfg.agent_name, m)}
                      disabled={busy === cfg.agent_name}
                    >
                      {m.replace("_", "-")}
                    </button>
                  ))}
                </div>
                <select
                  className="agent-provider-select"
                  aria-label={`Provider for ${AGENT_LABEL[cfg.agent_name]}`}
                  value={cfg.provider}
                  onChange={(e) => onProviderChange(cfg.agent_name, e.target.value)}
                  disabled={busy === cfg.agent_name}
                >
                  {data.known_providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="impl-btn-secondary"
                  onClick={() => setLinkOpen(linkOpen === cfg.provider ? null : cfg.provider)}
                >
                  {status === "linked" ? "✓ linked" : status === "expired" ? "expired — relink" : "link"}
                </button>
                <button
                  type="button"
                  className="impl-btn-secondary"
                  onClick={() => onVerify(cfg.provider)}
                  disabled={verifyState[cfg.provider]?.running}
                  title="Headless connectivity check — spawn `<bin> --version` for CLI providers, GET /v1/models for API providers"
                >
                  {verifyState[cfg.provider]?.running
                    ? "verifying…"
                    : verifyState[cfg.provider]?.result
                      ? (verifyState[cfg.provider]!.result!.ok ? "✓ verified" : "✗ failed — verify")
                      : "verify"}
                </button>
                <span className={`agent-link-state ${status === "linked" ? "" : "unlinked"}`}>
                  {data.detected.find((d) => d.provider === cfg.provider)?.hint ?? ""}
                </span>
                {(() => {
                  const r = verifyState[cfg.provider]?.result;
                  if (!r) return null;
                  return (
                    <div className="agent-row-purpose" style={{ flexBasis: "100%", marginTop: 4, color: r.ok ? "var(--a-accent)" : "var(--sem-orange, #E8A86A)" }}>
                      {r.ok ? "✓ " : "✗ "}
                      {r.detail}
                      {r.latency_ms ? ` · ${r.latency_ms}ms` : ""}
                      {r.error ? ` · ${r.error.slice(0, 120)}` : ""}
                    </div>
                  );
                })()}
              </div>
              {linkOpen === cfg.provider && (
                <div className="impl-diff-preview" style={{ gridColumn: "1 / -1" }}>
                  <ProviderLinkInline
                    provider={cfg.provider}
                    kind={data.known_providers.find((p) => p.id === cfg.provider)?.kind ?? "cli"}
                    existing={data.links.find((l) => l.provider === cfg.provider) ?? null}
                    onSaved={async () => { setLinkOpen(null); await load(); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="impl-error" style={{ gridColumn: "1 / -1" }}>{error}</div>}
      <ImplementerAutoPollerPanel />
    </div>
  );
}

/**
 * Auto-poller controls. Lives inside the Agents settings section because it
 * governs how the Implementer wakes up. Default state: off + dry-run; toggling
 * "live" off requires explicit enable + explicit unchecking dry-run, so an
 * accidental click cannot start unsupervised commits.
 */
function ImplementerAutoPollerPanel() {
  const [status, setStatus] = useState<AutoPollerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try { setStatus(await getImplementerAutoPoller()); }
    catch (e) { setErr(String(e).slice(0, 200)); }
  };

  useEffect(() => { load(); }, []);

  const update = async (patch: { enabled?: boolean; dry_run?: boolean }) => {
    setBusy(true); setErr(null);
    try {
      const next = await setImplementerAutoPoller(patch);
      setStatus(next);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally { setBusy(false); }
  };

  if (!status) return null;

  return (
    <div className="agent-row" style={{ gridColumn: "1 / -1", marginTop: 4 }}>
      <div>
        <div className="agent-row-label">
          Implementer auto-poller
          {status.enabled && (
            <span
              className="tweak-chip on"
              style={{ marginLeft: 8, fontSize: "var(--t-1)", padding: "1px 8px" }}
              aria-label={status.dryRun ? "auto-poller in dry-run mode" : "auto-poller live — running unsupervised"}
            >
              {status.dryRun ? "auto · dry-run" : "auto · live"}
            </span>
          )}
        </div>
        <div className="agent-row-purpose">
          When on, the backend ranks the queue every {Math.round(status.intervalMs / 1000)}s and
          {status.dryRun
            ? " announces what would run (dry-run — no commits)."
            : " spawns the worker on the head node (LIVE — commits land on impl/<id> branches)."}
          {" "}Re-reads config every tick; toggling here is honored within the next interval.
        </div>
      </div>
      <div className="agent-row-controls">
        <button
          type="button"
          className={`tweak-chip${status.enabled ? " on" : ""}`}
          onClick={() => update({ enabled: !status.enabled })}
          disabled={busy}
          aria-pressed={status.enabled}
        >
          {status.enabled ? "on" : "off"}
        </button>
        <button
          type="button"
          className={`tweak-chip${status.dryRun ? " on" : ""}`}
          onClick={() => update({ dry_run: !status.dryRun })}
          disabled={busy || !status.enabled}
          aria-pressed={status.dryRun}
          title={!status.enabled ? "enable the poller first" : "toggle dry-run mode"}
        >
          dry-run {status.dryRun ? "✓" : "off"}
        </button>
        {status.enabled && !status.dryRun && (
          <button
            type="button"
            className="impl-btn-secondary"
            onClick={() => update({ enabled: false })}
            disabled={busy}
            style={{ borderColor: "var(--sem-orange, #E8A86A)", color: "var(--sem-orange, #E8A86A)" }}
          >
            kill-switch
          </button>
        )}
      </div>
      {err && <div className="impl-error" style={{ gridColumn: "1 / -1" }}>{err}</div>}
    </div>
  );
}

interface InlineProps {
  provider: string;
  kind: "cli" | "api";
  existing: ProviderLink | null;
  onSaved: () => Promise<void>;
}

const PROVIDER_HINTS: Record<string, { binPlaceholder?: string; baseUrlPlaceholder?: string; modelIdPlaceholder?: string; apiKeyEnvDefault?: string; cliLoginCommand?: string }> = {
  claude:        { binPlaceholder: "/home/you/.local/bin/claude",         cliLoginCommand: "claude login" },
  gemini:        { binPlaceholder: "/usr/local/bin/gemini",                cliLoginCommand: "gemini auth" },
  "qwen-code":   { binPlaceholder: "/home/you/.npm-global/bin/qwen",       baseUrlPlaceholder: "http://localhost:1234/v1", modelIdPlaceholder: "qwen/qwen3.6-35b-a3b", cliLoginCommand: "qwen (interactive OAuth or set OPENAI_BASE_URL/OPENAI_API_KEY)" },
  "openai-api":  { baseUrlPlaceholder: "https://api.openai.com/v1",        modelIdPlaceholder: "gpt-4o", apiKeyEnvDefault: "OPENAI_API_KEY" },
  "anthropic-api": { baseUrlPlaceholder: "https://api.anthropic.com",      modelIdPlaceholder: "claude-sonnet-4-6", apiKeyEnvDefault: "ANTHROPIC_API_KEY" },
  "lm-studio":   { baseUrlPlaceholder: "http://localhost:1234/v1",      modelIdPlaceholder: "qwen/qwen3.6-35b-a3b", apiKeyEnvDefault: "(none — local)" },
};

function ProviderLinkInline({ provider, kind, existing, onSaved }: InlineProps) {
  const hints = PROVIDER_HINTS[provider] ?? {};
  const [binPath, setBinPath] = useState(existing?.bin_path ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? "");
  const [modelId, setModelId] = useState(existing?.model_id ?? "");
  const [apiKeyEnv, setApiKeyEnv] = useState(existing?.api_key_env ?? hints.apiKeyEnvDefault ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (status: "linked" | "unlinked") => {
    setSaving(true);
    setErr(null);
    try {
      await updateProviderLink(provider, {
        bin_path: kind === "cli" ? (binPath || null) : null,
        base_url: baseUrl || null,
        model_id: modelId || null,
        api_key_env: kind === "api" ? (apiKeyEnv || null) : null,
        status,
      });
      await onSaved();
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "var(--a-ink-2)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
        link {provider} <span style={{ color: "var(--a-accent)" }}>· {kind === "cli" ? "CLI auth (uses provider's own login)" : "API key (env var pointer)"}</span>
      </div>

      {kind === "cli" ? (
        <>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-ink-2)", lineHeight: 1.5 }}>
            Atelier never stores your credentials for CLI providers. Auth lives inside the CLI itself.
            {hints.cliLoginCommand && (
              <> Log in once externally with{" "}
                <code style={{ color: "var(--a-accent)", background: "var(--a-paper-3)", padding: "1px 5px", borderRadius: 3 }}>{hints.cliLoginCommand}</code>{", "}
                then enter the binary path below.
              </>
            )}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            binary path (absolute or on $PATH)
            <input value={binPath} onChange={(e) => setBinPath(e.target.value)} className="agent-provider-select" placeholder={hints.binPlaceholder ?? "/usr/local/bin/<provider>"} />
          </label>
          {(provider === "qwen-code") && (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
                local model server URL (optional — for OpenAI-compat endpoints)
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="agent-provider-select" placeholder={hints.baseUrlPlaceholder} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
                model id
                <input value={modelId} onChange={(e) => setModelId(e.target.value)} className="agent-provider-select" placeholder={hints.modelIdPlaceholder} />
              </label>
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-ink-2)", lineHeight: 1.5 }}>
            Atelier stores only the env-var <em>name</em>, never the key. Set the variable in your shell or
            <code style={{ color: "var(--a-accent)", background: "var(--a-paper-3)", padding: "1px 5px", borderRadius: 3, margin: "0 4px" }}>.env</code>
            file before starting the backend.
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            base URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="agent-provider-select" placeholder={hints.baseUrlPlaceholder} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            model id
            <input value={modelId} onChange={(e) => setModelId(e.target.value)} className="agent-provider-select" placeholder={hints.modelIdPlaceholder} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            api key env var name
            <input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} className="agent-provider-select" placeholder={hints.apiKeyEnvDefault ?? "MY_API_KEY"} />
          </label>
        </>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="impl-btn-primary" onClick={() => save("linked")} disabled={saving}>
          {saving ? "saving…" : "mark linked"}
        </button>
        <button className="impl-btn-secondary" onClick={() => save("unlinked")} disabled={saving}>
          unlink
        </button>
      </div>
      {err && <div className="impl-error">{err}</div>}
    </div>
  );
}
