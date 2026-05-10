/**
 * Home — OmniGraph ETL diagram + Recent Activity feed + Agent-mode chips.
 *
 * Self-contained: fetches /settings/agents, /activity/recent, /activity/etl-status
 * on mount and refreshes every 30s. Renders three ordered blocks under the
 * existing dash-grid:
 *   1. Configured agent-mode chips (one per agent)
 *   2. ETL pipeline diagram (sources → extract → vault → meta → light-IR → boot)
 *   3. Recent activity feed (implementer runs + audits + errors)
 */

import { useCallback, useEffect, useState } from "react";
import {
  getAgentSettings, getRecentActivity, getEtlStatus, getOgStats,
  type AgentSettingsResponse, type RecentActivityResponse, type EtlStatusResponse,
  type OgStatsResponse, type ActivityAgent,
} from "../lib/api";

const AGENT_TAG_LABEL: Record<ActivityAgent, string> = {
  drafter: "drafter",
  allocator: "allocator",
  implementer: "implementer",
  senior_reviewer: "senior",
  reflect: "reflect",
  system: "system",
};

const ETL_STEPS: Array<{ num: string; name: string; desc: string }> = [
  { num: "01", name: "sources",      desc: "Claude Code · Gemini · Cline · Antigravity transcripts" },
  { num: "02", name: "extract",      desc: "Qwen 5-phase grounded extraction → MentionEvents + Decisions" },
  { num: "03", name: "vault",        desc: "Per-entity Markdown · backlinks · YAML frontmatter" },
  { num: "04", name: "meta-profile", desc: "Cross-session aggregation → global_profile.json" },
  { num: "05", name: "light-IR",     desc: "Compile to XML · 3-layer brain (global/personal/project)" },
  { num: "06", name: "boot inject",  desc: "Atelier loads brain into every PTY session start" },
];

export function HomeOmnigraphSection({ onGoto }: { onGoto?: (view: "settings") => void }) {
  const [settings, setSettings] = useState<AgentSettingsResponse | null>(null);
  const [activity, setActivity] = useState<RecentActivityResponse | null>(null);
  const [etl, setEtl] = useState<EtlStatusResponse | null>(null);
  const [stats, setStats] = useState<OgStatsResponse | null>(null);
  const [errorOpen, setErrorOpen] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, a, e, og] = await Promise.all([
        getAgentSettings().catch(() => null),
        getRecentActivity(25).catch(() => null),
        getEtlStatus().catch(() => null),
        getOgStats().catch(() => null),
      ]);
      if (s) setSettings(s);
      if (a) setActivity(a);
      if (e) setEtl(e);
      if (og) setStats(og);
    } catch { /* swallow */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const daemonHealthy = etl?.daemon?.alive ?? false;
  const lastCycle = etl?.daemon?.last_cycle ?? null;

  return (
    <section className="dash-omnigraph">
      {/* Agent mode chips */}
      {settings && (
        <div>
          <div className="etl-pipeline-head" style={{ borderBottom: "none", marginBottom: 6 }}>
            <span className="etl-pipeline-title">Agents at work</span>
            {onGoto && (
              <button className="impl-btn-secondary" onClick={() => onGoto("settings")}>
                edit in settings
              </button>
            )}
          </div>
          <div className="home-agent-chips">
            {settings.configs.map((c) => (
              <span key={c.agent_name} className="home-agent-chip" title={`${c.agent_name} · ${c.mode} · ${c.provider}`}>
                <strong>{c.agent_name}</strong>
                <span className="home-agent-chip-mode">{c.mode.replace("_", "-")}</span>
                <span className="home-agent-chip-prov">via {c.provider}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* OmniGraph hero — founder-readable summary first; diagnostics live behind a details toggle below.
          Earlier copy exposed PIDs, absolute paths, and shell commands as primary content (TODO 2026-04-27 #1
          critical). Now we lead with what it does and whether it's working, and gate the plumbing. */}
      <div className="etl-pipeline">
        <div className="etl-pipeline-head">
          <span className="etl-pipeline-title">Your context, kept warm in the background</span>
          <span className="etl-pipeline-status">
            {etl?.omnigraph_present === false
              ? <span style={{ color: "var(--sem-orange, #E8A86A)" }}>not detected</span>
              : daemonHealthy
                ? <>watching · <span style={{ color: "var(--a-accent)" }}>healthy</span></>
                : <span style={{ color: "var(--sem-orange, #E8A86A)" }}>paused</span>}
          </span>
        </div>

        {/* Plain-language summary — what the founder needs, no plumbing */}
        <div style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", lineHeight: 1.55, color: "var(--a-ink-2)", padding: "4px 0 14px" }}>
          {etl?.omnigraph_present === false ? (
            <>OmniGraph isn't installed yet. When it is, every conversation you have with Claude / Gemini is read in the background and distilled into a brain that loads on every new session — so you stop re-explaining yourself.</>
          ) : daemonHealthy ? (
            <>Every chat you have with Claude, Gemini, Cline, or Antigravity is being summarized in the background and folded into a personal brain. Atelier reads that brain at the start of every new session — so the agent already knows your taste, your active projects, and the calls you've already made.</>
          ) : (
            <>OmniGraph is installed but the watcher isn't running right now, so new chats won't be folded into your brain until it's restarted. Existing brain artifacts still load on session start.</>
          )}
        </div>

        {/* High-signal numbers, founder-named — no PIDs, no paths */}
        {stats && (
          <div className="impl-stats" style={{ marginTop: 4 }}>
            <div>
              <div className="impl-stat-label">brains compiled</div>
              <div className="impl-stat-value">{stats.brain.count}</div>
            </div>
            <div>
              <div className="impl-stat-label">people · projects · ideas tracked</div>
              <div className="impl-stat-value">{stats.vault.count.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">conversations digested</div>
              <div className="impl-stat-value">{stats.pilot_full.count.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">last refresh</div>
              <div className="impl-stat-value" style={{ fontSize: "var(--t-2)" }}>
                {stats.last_session_run_at ? relTime(stats.last_session_run_at) : "—"}
              </div>
            </div>
          </div>
        )}

        {/* Diagnostics — gated behind a disclosure so founders only see plumbing if they ask for it.
            R3.6: also link to the full /settings/diagnostics page (extracted out of /home for engineers
            who want the deeper read without expanding a disclosure). */}
        <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <a
            href="/settings/diagnostics"
            onClick={(e) => {
              e.preventDefault();
              window.history.pushState({}, "", "/settings/diagnostics");
              window.dispatchEvent(new Event("atelier:navigate"));
            }}
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-accent)", textTransform: "lowercase", textDecoration: "none", borderBottom: "1px solid var(--a-accent)", paddingBottom: 1 }}
          >
            open full diagnostics →
          </a>
        </div>
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", letterSpacing: "0.06em", padding: "4px 0" }}>
            show diagnostics inline (paths, daemon pid, pipeline steps, source folders)
          </summary>
          <div style={{ marginTop: 10, paddingLeft: 4, borderLeft: "2px solid var(--a-line)", paddingTop: 4 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", marginBottom: 8 }}>
              {daemonHealthy
                ? <>daemon alive · pid {etl?.daemon.pid}</>
                : <>daemon idle</>}
            </div>

            <div className="etl-flow">
              {ETL_STEPS.map((s) => (
                <div key={s.num} className="etl-step" title={s.desc}>
                  <div className="etl-step-num">{s.num}</div>
                  <div className="etl-step-name">{s.name}</div>
                  <div className="etl-step-desc">{s.desc}</div>
                </div>
              ))}
            </div>

            {/* Artifact stats — engineering-named, kept here for diagnostics view */}
            {stats && (
              <div className="impl-stats" style={{ marginTop: 14 }}>
                <div>
                  <div className="impl-stat-label">ledger files</div>
                  <div className="impl-stat-value">{stats.ledger.count}</div>
                </div>
                <div>
                  <div className="impl-stat-label">agent compiled</div>
                  <div className="impl-stat-value">{stats.agents.count}</div>
                </div>
              </div>
            )}

            {etl?.providers && etl.providers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="etl-pipeline-status" style={{ marginBottom: 4 }}>
                  source folders polled · root: <code>{etl.ai_conv_root}</code>{" "}
                  {etl.ai_conv_present ? "" : <span style={{ color: "var(--sem-orange, #E8A86A)" }}>(missing)</span>}
                </div>
                <div className="etl-flow" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
                  {etl.providers.map((p) => (
                    <div key={p.provider} className="etl-step" title={p.sourceDir}>
                      <div className="etl-step-num">{p.exists ? "found" : "missing"}</div>
                      <div className="etl-step-name">{p.provider}</div>
                      <div className="etl-step-desc">
                        src {p.sourceCount} · done {p.doneCount} ·{" "}
                        <span style={{ color: p.pendingCount > 0 ? "var(--sem-orange, #E8A86A)" : "var(--a-mute)" }}>
                          pending {p.pendingCount}
                        </span>
                        {p.lastSessionAt && <div style={{ marginTop: 2, color: "var(--a-mute-2)" }}>{relTime(p.lastSessionAt)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="etl-howto" style={{ marginTop: 10 }}>
              Run as a background substrate next to Atelier. To start the watcher:
              {" "}<code>cd path/to/omnigraph &amp;&amp; python scripts/etl_daemon.py --interval 600 --no-hook</code>{" "}
              (polls provider transcripts every 10 min). Brain artifacts land at{" "}
              <code>og_artifacts/brain/&#123;global,personal,projects&#125;</code>; Atelier injects them on every session boot.
              {lastCycle && <div style={{ marginTop: 6, color: "var(--a-mute)" }}>last cycle: {lastCycle.slice(-90)}</div>}
            </div>
          </div>
        </details>
      </div>

      {/* Unified all-agent recent activity feed */}
      <div className="activity-feed">
        <div className="activity-feed-head">
          <span className="etl-pipeline-title">Recent activity · all agents</span>
          <span className="etl-pipeline-status">
            {activity
              ? `${activity.activity.length} events · ${activity.errors.length} errors`
              : "loading…"}
          </span>
        </div>
        {activity && activity.activity.length === 0 && activity.errors.length === 0 && (
          <div className="impl-card-empty">
            No agent activity yet. Drafter, Implementer, Senior-reviewer, and Reflect events all surface here as they happen.
          </div>
        )}
        {activity?.activity.map((row, i) => (
          <div key={`act-${i}-${row.timestamp}`} className={`activity-row${row.status === "blocked" ? " error" : ""}`}>
            <span className="activity-when">{relTime(row.timestamp)}</span>
            <span className="activity-msg">
              <strong>{AGENT_TAG_LABEL[row.agent]}</strong>
              {row.project && <> · {row.project}</>}
              {row.ref_id && <> · {row.ref_id.slice(0, 24)}</>}
              {" — "}{row.summary}
            </span>
            <span className={`activity-tag${row.status === "blocked" ? " failed" : ""}`}>
              {row.status}
            </span>
          </div>
        ))}
        {activity?.errors.map((err, i) => (
          <div key={`err-${i}`} className="activity-row error">
            <span className="activity-when">{relTime(err.timestamp)}</span>
            <span className="activity-msg">
              <strong>error</strong> — {err.reason}
              {errorOpen === i && (
                <pre className="impl-pre" style={{ marginTop: 4 }}>{err.block}</pre>
              )}
            </span>
            <span
              className="activity-tag failed"
              style={{ cursor: "pointer" }}
              onClick={() => setErrorOpen(errorOpen === i ? null : i)}
            >
              {errorOpen === i ? "hide" : "expand"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso.slice(0, 16);
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60); if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60); if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24); if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}
