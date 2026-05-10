/**
 * Settings → Distribution group.
 *
 * Sibling section to AgentSettingsSection. Mirrors its row shape (label /
 * purpose / collapsible config form / link button / verify button / status
 * badge) so the two read as one Settings page in two halves: agents (the
 * inbound execution layer) and distribution (the outbound go-live cliff).
 *
 * Phase 6 design rule:
 *   Adapters write CONFIG FILES into the project, not deploy scripts. The
 *   "write config" button stages `<project>/.distribution/<id>.json` +
 *   `<project>/distribution/<id>.md`. Implementer reads these later (Phase 4).
 *
 * No new sidebar item, no top-level toolbar, no global tab. Distribution
 * lives inside Settings, identical visual hierarchy as Agents.
 */

import { useEffect, useState } from "react";
import {
  listDistributionAdapters, listDistributionLinks, upsertDistributionLink,
  verifyDistributionLink, writeDistributionConfig, deleteDistributionLink,
  type DistributionAdapterEntry, type DistributionLink,
  type DistributionVerifyResult, type DistributionWriteConfigResult,
} from "../lib/api";

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password" | "select";
  options?: string[];
  required?: boolean;
  hint?: string;
}

const FIELD_SCHEMA: Record<string, FieldDef[]> = {
  "cloudflare-dns": [
    { key: "api_token", label: "api token (Zone.DNS:Edit scope)", type: "password", placeholder: "create at dash.cloudflare.com → My Profile → API Tokens", required: true },
    { key: "zone_id", label: "zone id", placeholder: "from cloudflare → domain → overview", required: true },
    { key: "domain", label: "domain", placeholder: "fastbrick.in", required: true },
    { key: "notes", label: "notes (optional)", placeholder: "anything you'd want to remember about this DNS setup" },
  ],
  "razorpay": [
    { key: "key_id", label: "key id", placeholder: "rzp_test_… or rzp_live_…", required: true },
    { key: "key_secret", label: "key secret", type: "password", placeholder: "from razorpay → settings → api keys", required: true },
    { key: "mode", label: "mode", type: "select", options: ["test", "live"], required: true, hint: "stay on test until end-to-end checkout works" },
    { key: "webhook_secret", label: "webhook secret (optional)", type: "password", placeholder: "set when you wire webhook endpoint" },
    { key: "notes", label: "notes (optional)" },
  ],
  "plausible": [
    { key: "api_key", label: "api key", type: "password", placeholder: "plausible.io → account settings → api keys", required: true },
    { key: "site_id", label: "site id (domain registered with plausible)", placeholder: "fastbrick.in", required: true },
    { key: "base_url", label: "base url", placeholder: "https://plausible.io (or self-hosted)" },
    { key: "notes", label: "notes (optional)" },
  ],
  "resend": [
    { key: "api_key", label: "api key", type: "password", placeholder: "resend.com/api-keys (re_…)", required: true },
    { key: "from_address", label: "from address", placeholder: "noreply@fastbrick.in", required: true },
    { key: "reply_to", label: "reply-to (optional)", placeholder: "founder@fastbrick.in" },
    { key: "notes", label: "notes (optional)" },
  ],
};

const CATEGORY_LABEL: Record<string, string> = {
  dns: "domain",
  payments: "payments",
  analytics: "analytics",
  email: "email",
};

interface UiState {
  configOpen: string | null; // adapter id whose form is open
  busy: string | null;
  verifyState: Record<string, { running?: boolean; result?: DistributionVerifyResult }>;
  writeState: Record<string, { running?: boolean; result?: DistributionWriteConfigResult }>;
  drafts: Record<string, Record<string, string>>;
  saveError: Record<string, string | null>;
}

export function DistributionSettingsSection() {
  const [adapters, setAdapters] = useState<DistributionAdapterEntry[] | null>(null);
  const [links, setLinks] = useState<DistributionLink[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ui, setUi] = useState<UiState>({
    configOpen: null,
    busy: null,
    verifyState: {},
    writeState: {},
    drafts: {},
    saveError: {},
  });

  const load = async () => {
    try {
      const [a, l] = await Promise.all([listDistributionAdapters(), listDistributionLinks()]);
      setAdapters(a.adapters);
      setLinks(l.links);
    } catch (e) {
      setLoadError(String(e).slice(0, 200));
    }
  };
  useEffect(() => { load(); }, []);

  const linkFor = (id: string): DistributionLink | undefined => links.find(l => l.adapter_id === id);

  const statusFor = (id: string): "verified" | "configured" | "failed" | "needs setup" => {
    const link = linkFor(id);
    if (!link) return "needs setup";
    if (link.status === "verified") return "verified";
    if (link.status === "failed")   return "failed";
    if (link.status === "configured") return "configured";
    return "needs setup";
  };

  const statusBadge = (id: string) => {
    const s = statusFor(id);
    const map: Record<typeof s, { color: string; bg: string }> = {
      "verified":   { color: "var(--sem-blue, #4796E4)", bg: "transparent" },
      "configured": { color: "var(--a-mute)",            bg: "transparent" },
      "failed":     { color: "var(--sem-orange, #E8A86A)", bg: "transparent" },
      "needs setup": { color: "var(--a-mute)",           bg: "transparent" },
    };
    const c = map[s];
    return (
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
        padding: "1px 8px", border: `1px solid ${c.color}`, borderRadius: 999,
        color: c.color, background: c.bg, textTransform: "lowercase",
      }}>
        {s}
      </span>
    );
  };

  const onToggleConfig = (id: string) => {
    const willOpen = ui.configOpen !== id;
    let drafts = ui.drafts;
    if (willOpen) {
      const link = linkFor(id);
      const existing = (link?.config ?? {}) as Record<string, unknown>;
      const draft: Record<string, string> = {};
      for (const f of FIELD_SCHEMA[id] ?? []) {
        const v = existing[f.key];
        // Don't pre-fill secret placeholder values — leave the input empty if
        // the saved value is the redacted "•••• (saved)" sentinel, but keep it
        // for non-secret fields so the founder sees what's saved.
        if (typeof v === "string" && v.startsWith("••••")) draft[f.key] = "";
        else if (typeof v === "string" || typeof v === "number") draft[f.key] = String(v);
        else draft[f.key] = "";
      }
      drafts = { ...ui.drafts, [id]: draft };
    }
    setUi(s => ({ ...s, configOpen: willOpen ? id : null, drafts, saveError: { ...s.saveError, [id]: null } }));
  };

  const onDraftChange = (id: string, key: string, value: string) => {
    setUi(s => ({ ...s, drafts: { ...s.drafts, [id]: { ...(s.drafts[id] ?? {}), [key]: value } } }));
  };

  const onSave = async (id: string) => {
    const draft = ui.drafts[id] ?? {};
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (typeof v === "string" && v.length === 0) continue;
      config[k] = v;
    }
    setUi(s => ({ ...s, busy: id, saveError: { ...s.saveError, [id]: null } }));
    try {
      await upsertDistributionLink(id, config);
      await load();
      setUi(s => ({ ...s, busy: null, configOpen: null }));
    } catch (e) {
      setUi(s => ({ ...s, busy: null, saveError: { ...s.saveError, [id]: String(e).slice(0, 200) } }));
    }
  };

  const onVerify = async (id: string) => {
    setUi(s => ({ ...s, verifyState: { ...s.verifyState, [id]: { running: true } } }));
    try {
      const result = await verifyDistributionLink(id);
      setUi(s => ({ ...s, verifyState: { ...s.verifyState, [id]: { running: false, result } } }));
      load();
    } catch (e) {
      setUi(s => ({
        ...s,
        verifyState: { ...s.verifyState, [id]: { running: false, result: { ok: false, detail: "verify failed", error: String(e).slice(0, 200) } } },
      }));
    }
  };

  const onWriteConfig = async (id: string) => {
    setUi(s => ({ ...s, writeState: { ...s.writeState, [id]: { running: true } } }));
    try {
      const result = await writeDistributionConfig(id);
      setUi(s => ({ ...s, writeState: { ...s.writeState, [id]: { running: false, result } } }));
      load();
    } catch (e) {
      setUi(s => ({
        ...s,
        writeState: { ...s.writeState, [id]: { running: false, result: { ok: false, error: String(e).slice(0, 200) } } },
      }));
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Remove ${id} configuration? Saved credentials will be deleted from Atelier's DB. (This does not revoke the credential at the provider.)`)) return;
    setUi(s => ({ ...s, busy: id }));
    try {
      await deleteDistributionLink(id);
      await load();
      setUi(s => ({ ...s, busy: null, configOpen: null }));
    } catch (e) {
      setUi(s => ({ ...s, busy: null, saveError: { ...s.saveError, [id]: String(e).slice(0, 200) } }));
    }
  };

  if (!adapters) {
    return (
      <div className="settings-section">
        <div>
          <h2>Distribution</h2>
          <div className="hint">{loadError ?? "loading distribution adapters…"}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div>
        <h2>Distribution</h2>
        <div className="hint">
          Adapters that wire your project to real-world delivery: domain, payments, analytics, email.
          Each writes config into the project; the Implementer uses these when shipping.
        </div>
      </div>
      <div className="agents-group">
        {adapters.length === 0 && (
          <div className="agent-row-purpose" style={{ padding: "8px 0" }}>
            No adapters configured yet. Each adapter wires your project to one piece of distribution — domain, payments, analytics, or email.
          </div>
        )}
        {adapters.map((a) => {
          const link = linkFor(a.id);
          const isOpen = ui.configOpen === a.id;
          const verify = ui.verifyState[a.id];
          const write = ui.writeState[a.id];
          const saveErr = ui.saveError[a.id];
          return (
            <div key={a.id} className="agent-row">
              <div>
                <div className="agent-row-label">
                  {a.label}
                  <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                    · {CATEGORY_LABEL[a.category] ?? a.category}
                  </span>
                </div>
                <div className="agent-row-purpose">{a.purpose}</div>
              </div>
              <div className="agent-row-controls">
                {statusBadge(a.id)}
                <button
                  type="button"
                  className="impl-btn-secondary"
                  onClick={() => onToggleConfig(a.id)}
                  disabled={ui.busy === a.id}
                >
                  {isOpen ? "close" : link?.has_config ? "reconfigure" : "configure"}
                </button>
                <button
                  type="button"
                  className="impl-btn-secondary"
                  onClick={() => onVerify(a.id)}
                  disabled={!link?.has_config || verify?.running}
                  title="Real read-only API call to confirm credentials work"
                >
                  {verify?.running ? "verifying…" : verify?.result ? (verify.result.ok ? "✓ verified" : "✗ failed — verify") : "verify"}
                </button>
                <button
                  type="button"
                  className="impl-btn-secondary"
                  onClick={() => onWriteConfig(a.id)}
                  disabled={!link?.has_config || write?.running}
                  title="Stage config into <project>/.distribution/ for the Implementer to read at deploy-scaffold time (Phase 4)"
                >
                  {write?.running ? "writing…" : write?.result?.ok ? "✓ wrote config" : write?.result ? "✗ failed — retry" : "write config"}
                </button>
                <span className="agent-link-state unlinked" style={{ flexBasis: "100%", marginTop: 4, color: "var(--a-mute)" }}>
                  {a.detected.hint}
                </span>
                {verify?.result && (
                  <div className="agent-row-purpose" style={{
                    flexBasis: "100%", marginTop: 4,
                    color: verify.result.ok ? "var(--sem-blue, #4796E4)" : "var(--sem-orange, #E8A86A)",
                  }}>
                    {verify.result.ok ? "✓ " : "✗ "}{verify.result.detail}
                    {verify.result.latency_ms ? ` · ${verify.result.latency_ms}ms` : ""}
                    {verify.result.error ? ` · ${verify.result.error.slice(0, 120)}` : ""}
                  </div>
                )}
                {write?.result && (
                  <div className="agent-row-purpose" style={{
                    flexBasis: "100%", marginTop: 4,
                    color: write.result.ok ? "var(--sem-blue, #4796E4)" : "var(--sem-orange, #E8A86A)",
                  }}>
                    {write.result.ok ? "✓ " : "✗ "}
                    {write.result.ok
                      ? `wrote ${(write.result.filesWritten ?? []).length} file(s) into project`
                      : `write failed${write.result.error ? ` — ${write.result.error.slice(0, 140)}` : ""}`}
                  </div>
                )}
                {write?.result?.ok && (write.result.notes ?? []).length > 0 && (
                  <ul style={{
                    flexBasis: "100%", margin: "4px 0 0 0", paddingLeft: 18,
                    fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)",
                  }}>
                    {(write.result.notes ?? []).slice(0, 8).map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </div>
              {isOpen && (
                <div className="impl-diff-preview" style={{ gridColumn: "1 / -1" }}>
                  <DistributionConfigForm
                    fields={FIELD_SCHEMA[a.id] ?? []}
                    draft={ui.drafts[a.id] ?? {}}
                    onChange={(k, v) => onDraftChange(a.id, k, v)}
                    onSave={() => onSave(a.id)}
                    onDelete={link?.has_config ? () => onDelete(a.id) : undefined}
                    saving={ui.busy === a.id}
                    err={saveErr}
                    adapterId={a.id}
                    hasExisting={!!link?.has_config}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ConfigFormProps {
  fields: FieldDef[];
  draft: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  onDelete?: () => void;
  saving: boolean;
  err: string | null | undefined;
  adapterId: string;
  hasExisting: boolean;
}

function DistributionConfigForm({ fields, draft, onChange, onSave, onDelete, saving, err, adapterId, hasExisting }: ConfigFormProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "var(--a-ink-2)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
        configure {adapterId} <span style={{ color: "var(--a-accent)" }}>· credentials stored in atelier db (phase A: plaintext)</span>
      </div>

      {fields.map(f => {
        const val = draft[f.key] ?? "";
        const placeholder = f.placeholder ?? "";
        const isSecret = f.type === "password";
        if (f.type === "select" && f.options) {
          return (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
              {f.label}
              <select
                className="agent-provider-select"
                value={val}
                onChange={e => onChange(f.key, e.target.value)}
              >
                <option value="">—</option>
                {f.options.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              {f.hint && <span style={{ color: "var(--a-mute)" }}>{f.hint}</span>}
            </label>
          );
        }
        return (
          <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)" }}>
            {f.label}
            <input
              type={isSecret ? "password" : "text"}
              value={val}
              onChange={e => onChange(f.key, e.target.value)}
              className="agent-provider-select"
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
            />
            {f.hint && <span style={{ color: "var(--a-mute)" }}>{f.hint}</span>}
            {isSecret && hasExisting && val.length === 0 && (
              <span style={{ color: "var(--a-mute)" }}>leave blank to keep current saved value</span>
            )}
          </label>
        );
      })}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="impl-btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "saving…" : "save config"}
        </button>
        {onDelete && (
          <button className="impl-btn-secondary" onClick={onDelete} disabled={saving} title="remove this adapter's saved config from atelier's db">
            remove
          </button>
        )}
      </div>
      {err && <div className="impl-error">{err}</div>}
    </div>
  );
}
