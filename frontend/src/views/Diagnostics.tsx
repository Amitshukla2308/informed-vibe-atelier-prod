/**
 * Diagnostics — moved out of /home (R3 Batch B). The /home <details> block
 * was already gated, but founders shouldn't have to expand a disclosure to
 * find the daemon PID, ETL pipeline diagram, or per-source folder counts.
 *
 * This page is the *engineering view* of OmniGraph: paths, PIDs, pipeline
 * stages, and per-provider source counts. The /home summary stays — this is
 * the deeper read for when something looks off.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getEtlStatus, getOgStats,
  type EtlStatusResponse, type OgStatsResponse,
} from "../lib/api";

const ETL_STEPS: Array<{ num: string; name: string; desc: string }> = [
  { num: "01", name: "sources",      desc: "Claude Code · Gemini · Cline · Antigravity transcripts" },
  { num: "02", name: "extract",      desc: "Qwen 5-phase grounded extraction → MentionEvents + Decisions" },
  { num: "03", name: "vault",        desc: "Per-entity Markdown · backlinks · YAML frontmatter" },
  { num: "04", name: "meta-profile", desc: "Cross-session aggregation → global_profile.json" },
  { num: "05", name: "light-IR",     desc: "Compile to XML · 3-layer brain (global/personal/project)" },
  { num: "06", name: "boot inject",  desc: "Atelier loads brain into every PTY session start" },
];

export function Diagnostics() {
  const [etl, setEtl] = useState<EtlStatusResponse | null>(null);
  const [stats, setStats] = useState<OgStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [e, og] = await Promise.all([
        getEtlStatus().catch(() => null),
        getOgStats().catch(() => null),
      ]);
      if (e) setEtl(e);
      if (og) setStats(og);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const daemonHealthy = etl?.daemon?.alive ?? false;
  const lastCycle = etl?.daemon?.last_cycle ?? null;

  return (
    <div className="reflection-root" tabIndex={0} role="region" aria-label="Diagnostics">
      <header className="reflection-head">
        <div>
          <div className="kicker">diagnostics · omnigraph</div>
          <h1>Under the hood.</h1>
          <div className="subtitle">PIDs, paths, ETL stages, and source folder counts. Everything that used to live behind <code>show diagnostics</code> on /home.</div>
        </div>
      </header>

      {loading && !etl && !stats && (
        <section style={{ marginTop: 28 }}>
          <div className="skeleton-line" style={{ width: "60%", height: 16 }} />
          <div className="skeleton-line" style={{ width: "75%", height: 14, marginTop: 10 }} />
          <div className="skeleton-line" style={{ width: "50%", height: 14, marginTop: 8 }} />
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <div className="etl-pipeline-head">
          <span className="etl-pipeline-title">Daemon</span>
          <span className="etl-pipeline-status">
            {daemonHealthy
              ? <>alive · pid {etl?.daemon.pid}</>
              : <>idle</>}
          </span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", marginTop: 6 }}>
          {lastCycle ? <>last cycle: {lastCycle.slice(-90)}</> : <>no cycle recorded yet</>}
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <div className="etl-pipeline-head">
          <span className="etl-pipeline-title">Pipeline (6 stages)</span>
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
      </section>

      {stats && (
        <section style={{ marginTop: 28 }}>
          <div className="etl-pipeline-head">
            <span className="etl-pipeline-title">Artifact counts</span>
          </div>
          <div className="impl-stats" style={{ marginTop: 10 }}>
            <div>
              <div className="impl-stat-label">brains compiled</div>
              <div className="impl-stat-value">{stats.brain.count}</div>
            </div>
            <div>
              <div className="impl-stat-label">vault entities</div>
              <div className="impl-stat-value">{stats.vault.count.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">conversations</div>
              <div className="impl-stat-value">{stats.pilot_full.count.toLocaleString()}</div>
            </div>
            <div>
              <div className="impl-stat-label">ledger files</div>
              <div className="impl-stat-value">{stats.ledger.count}</div>
            </div>
            <div>
              <div className="impl-stat-label">agents compiled</div>
              <div className="impl-stat-value">{stats.agents.count}</div>
            </div>
          </div>
        </section>
      )}

      {etl?.providers && etl.providers.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <div className="etl-pipeline-head">
            <span className="etl-pipeline-title">Source folders</span>
            <span className="etl-pipeline-status">
              root: <code>{etl.ai_conv_root}</code>{" "}
              {etl.ai_conv_present ? "" : <span style={{ color: "var(--sem-orange, #E8A86A)" }}>(missing)</span>}
            </span>
          </div>
          <div className="etl-flow" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginTop: 10 }}>
            {etl.providers.map((p) => (
              <div key={p.provider} className="etl-step" title={p.sourceDir}>
                <div className="etl-step-num">{p.exists ? "found" : "missing"}</div>
                <div className="etl-step-name">{p.provider}</div>
                <div className="etl-step-desc">
                  src {p.sourceCount} · done {p.doneCount} ·{" "}
                  <span style={{ color: p.pendingCount > 0 ? "var(--sem-orange, #E8A86A)" : "var(--a-mute)" }}>
                    pending {p.pendingCount}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{ marginTop: 28, marginBottom: 60 }}>
        <div className="etl-pipeline-head">
          <span className="etl-pipeline-title">How to start the watcher</span>
        </div>
        <div className="etl-howto" style={{ marginTop: 8 }}>
          OmniGraph runs as a background substrate next to Atelier. To start the watcher:
          {" "}<code>cd path/to/omnigraph &amp;&amp; python scripts/etl_daemon.py --interval 600 --no-hook</code>{" "}
          (polls provider transcripts every 10 min). Brain artifacts land at{" "}
          <code>og_artifacts/brain/&#123;global,personal,projects&#125;</code>; Atelier injects them on every session boot.
        </div>
      </section>
    </div>
  );
}

export default Diagnostics;
