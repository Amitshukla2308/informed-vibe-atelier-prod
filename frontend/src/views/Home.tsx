import { useEffect, useState } from "react";
import {
  listProjects, createProject, switchProject, listSessions,
  type ProjectListEntry, type SessionEntry,
} from "../lib/api";
import { HomeOmnigraphSection } from "../components/HomeOmnigraphSection";
import { FirstRunTour, isTourDismissed } from "../components/FirstRunTour";

interface Props {
  agentName: string;
  founderName: string;
  activeProject: string;
  orgName: string | null;
  onEnterWorkspace: () => void;
  onActiveProjectChanged: (name: string) => void;
  onOrgNameChanged: (name: string) => void;
  onGoto: (view: "canvas" | "brain" | "approvals" | "world" | "reflect" | "settings") => void;
}

/* Tiny inline SVG icons (matches the rest of the app's style — no lucide dep). */
const I = {
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 5l11 7-11 7V5z" />
    </svg>
  ),
  layout: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3 8-8" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  cog: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  ),
  bot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M9 12h.01M15 12h.01M12 3v4M8 19l1 2M16 19l-1 2" />
    </svg>
  ),
  branch: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="6" cy="18" r="2" />
      <path d="M6 8v8M18 16v-2a4 4 0 0 0-4-4H8" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3z" />
      <path d="M10 21h4" />
    </svg>
  ),
  hash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />
    </svg>
  ),
};

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60); if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);  if (hr  < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);  if (mo  < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function greet(): string {
  const h = new Date().getHours();
  if (h < 5)  return "still up";
  if (h < 12) return "good morning";
  if (h < 17) return "good afternoon";
  if (h < 21) return "good evening";
  return "good evening";
}

export function Home({
  agentName, founderName, activeProject, orgName,
  onEnterWorkspace, onActiveProjectChanged, onGoto,
}: Props) {
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [newProj, setNewProj] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // R3.7 — initialLoading flips to false once the first listProjects()/listSessions() resolves.
  // Skeleton renders only during this first-paint window (then never again until route remount).
  const [initialLoading, setInitialLoading] = useState(true);

  // First-run tour: show once per device when the founder lands on Home with
  // either no project or zero recent sessions. Skip in QA runs (?qa=1) so
  // Playwright assertions don't get blocked by the modal. Decision is deferred
  // until initial data has loaded — otherwise we'd render-then-hide on every
  // mount for founders who already have a project + session, causing a flash.
  const [showTour, setShowTour] = useState<boolean>(false);
  useEffect(() => {
    if (initialLoading) return;
    try {
      const isQa = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("qa") === "1";
      if (isQa) return;
      if (isTourDismissed()) return;
      const hasProject = !!activeProject;
      const hasSession = sessions.length > 0;
      if (hasProject && hasSession) return;
      setShowTour(true);
    } catch { /* no-op */ }
  }, [initialLoading, activeProject, sessions.length]);

  function loadAll() {
    const p = listProjects().then(r => setProjects(r.projects)).catch(() => { /* no-op */ });
    const s = activeProject
      ? listSessions(activeProject).then(setSessions).catch(() => setSessions([]))
      : Promise.resolve();
    Promise.allSettled([p, s]).finally(() => setInitialLoading(false));
  }
  useEffect(loadAll, [activeProject]);

  async function doSwitch(name: string) {
    if (name === activeProject) { onEnterWorkspace(); return; }
    setBusy(name);
    setError(null);
    try {
      await switchProject(name);
      onActiveProjectChanged(name);
      loadAll();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function doCreate() {
    const name = newProj.name.trim();
    if (!name) return;
    setBusy("__create");
    setError(null);
    try {
      const r = await createProject(name, newProj.description.trim(), true);
      setNewProj({ name: "", description: "" });
      setCreating(false);
      loadAll();
      if (r.active_project) onActiveProjectChanged(r.active_project);
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  const recent = sessions.slice(0, 3);
  const totalTurns = sessions.reduce((acc, s) => acc + (s.turnCount ?? 0), 0);
  const lastSession = sessions[0];
  const initial = (founderName || "?").trim().charAt(0).toUpperCase();

  const quickActions: { label: string; key: "now" | "canvas" | "approvals" | "settings"; icon: React.ReactNode; tone: string }[] = [
    { label: "New session",      key: "now",        icon: I.play,   tone: "moss" },
    { label: "View canvas",      key: "canvas",     icon: I.layout, tone: "terra" },
    { label: "Check approvals",  key: "approvals",  icon: I.check,  tone: "gold" },
    { label: "Settings",         key: "settings",   icon: I.cog,    tone: "stone" },
  ];

  return (
    <div className="dash">
      {showTour && (
        <FirstRunTour
          onClose={() => setShowTour(false)}
          onGoto={onGoto}
        />
      )}
      {/* R3.7 — initial-load skeleton band (only while first projects/sessions fetch is in flight) */}
      {initialLoading && (
        <div aria-busy="true" aria-label="Loading dashboard" style={{ padding: "8px 0 16px" }}>
          <div className="skeleton-line" style={{ width: "44%", height: 22 }} />
          <div className="skeleton-line" style={{ width: "70%", marginTop: 10 }} />
        </div>
      )}
      <div className="dash-grid">
        {/* ── Left column ───────────────────────────────────────────── */}
        <div className="dash-col">
          {/* Welcome card */}
          <div className="dash-card">
            <h2 className="dash-greet">
              {greet()}, <em>{(founderName || "you").split(" ")[0]}</em>
            </h2>
            <p className="dash-greet-sub">
              {agentName
                ? <>{agentName} is paired to <b>{activeProject || "no project"}</b>{lastSession ? <> · last touched {timeAgo(lastSession.endedAt || lastSession.startedAt)}</> : null}.</>
                : "no agent paired yet."}
            </p>
            <div className="dash-stats">
              <div className="dash-stat" data-tone="terra">
                <span className="dash-stat-icon">{I.hash}</span>
                <span className="dash-stat-value">{sessions.length}</span>
                <span className="dash-stat-label">sessions</span>
              </div>
              <div className="dash-stat" data-tone="moss">
                <span className="dash-stat-icon">{I.branch}</span>
                <span className="dash-stat-value">{totalTurns}</span>
                <span className="dash-stat-label">turns total</span>
              </div>
              <div className="dash-stat" data-tone="gold">
                <span className="dash-stat-icon">{I.bell}</span>
                <span className="dash-stat-value">{recent.filter(s => !s.reflected).length}</span>
                <span className="dash-stat-label">unreflected</span>
              </div>
            </div>
          </div>

          {/* Active project card */}
          <div className="dash-card">
            <div className="dash-active-head">
              <h3 className="dash-h3">{activeProject || "no active project"}</h3>
              <span className="dash-pill dash-pill-live">
                <span className="dash-pill-dot" />Live
              </span>
            </div>
            <div className="dash-active-meta">
              {orgName ? <><span className="dash-mute">{orgName}</span><span className="dash-dot-sep">·</span></> : null}
              <span className="dash-mute">canvas · brain · sessions all wired</span>
            </div>
            <div className="dash-active-actions">
              <button className="dash-btn-primary" onClick={onEnterWorkspace}>
                <span>open workspace</span>
                <span className="dash-arrow">→</span>
              </button>
              <button className="dash-btn-ghost" onClick={() => onGoto("canvas")}>view canvas</button>
              <button className="dash-btn-ghost" onClick={() => onGoto("reflect")}>past sessions</button>
            </div>
          </div>

          {/* Recent sessions */}
          <div>
            <div className="dash-section-label">Recent sessions</div>
            {recent.length === 0 ? (
              <div className="dash-empty">no sessions yet — start one from <b>now</b>.</div>
            ) : (
              <div className="dash-sessions">
                {recent.map((s, i) => (
                  <button
                    key={s.sessionId}
                    className="dash-session"
                    onClick={() => onGoto("reflect")}
                  >
                    <span className="dash-session-num">#{sessions.length - i}</span>
                    <span className="dash-session-title">
                      {s.firstUserLine?.slice(0, 70) || s.flavor || "untitled session"}
                    </span>
                    <span className="dash-session-meta">
                      {s.turnCount ?? 0} turns
                      <span className="dash-dot-sep">·</span>
                      {timeAgo(s.endedAt || s.startedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right column ──────────────────────────────────────────── */}
        <div className="dash-col">
          {/* Identity card */}
          <div className="dash-card dash-identity">
            <div className="dash-avatar">{initial}</div>
            <div className="dash-identity-name">{founderName || "you"}</div>
            <div className="dash-identity-role">Founder · {orgName || "no workspace"}</div>
            <div className="dash-divider" />
            <div className="dash-identity-row">
              <span className="dash-identity-icon">{I.bot}</span>
              <span className="dash-identity-agent">{agentName || "no agent"}</span>
            </div>
          </div>

          {/* Quick actions grid */}
          <div className="dash-actions">
            {quickActions.map(a => (
              <button
                key={a.key}
                className="dash-action"
                data-tone={a.tone}
                onClick={() => a.key === "now" ? onEnterWorkspace() : onGoto(a.key)}
              >
                <span className="dash-action-icon">{a.icon}</span>
                <span className="dash-action-label">{a.label}</span>
              </button>
            ))}
          </div>

          {/* Projects list */}
          <div className="dash-card">
            <div className="dash-section-label" style={{ marginBottom: 10 }}>
              Projects
              <button
                className="dash-link"
                onClick={() => setCreating(v => !v)}
                style={{ marginLeft: "auto" }}
                aria-label={creating ? "Cancel new project" : "Create new project"}
                title={creating ? "Cancel" : "Create a new project"}
              >{creating ? "cancel" : "+ new project"}</button>
            </div>
            {creating && (
              <div className="dash-create">
                <input
                  autoFocus
                  placeholder="project name"
                  value={newProj.name}
                  onChange={e => setNewProj({ ...newProj, name: e.target.value })}
                  onKeyDown={e => { if (e.key === "Enter" && newProj.name.trim()) doCreate(); }}
                />
                <input
                  placeholder="one-line description (optional)"
                  value={newProj.description}
                  onChange={e => setNewProj({ ...newProj, description: e.target.value })}
                />
                <button
                  className="dash-btn-primary dash-btn-small"
                  onClick={doCreate}
                  disabled={!newProj.name.trim() || busy === "__create"}
                >{busy === "__create" ? "creating…" : "create + switch"}</button>
              </div>
            )}
            <div className="dash-projects">
              {projects.length === 0 ? (
                <div className="dash-empty dash-empty-small">no projects yet</div>
              ) : projects.map(p => {
                const isActive = p.name === activeProject;
                return (
                  <button
                    key={p.name}
                    className={`dash-project ${isActive ? "is-active" : ""}`}
                    onClick={() => doSwitch(p.name)}
                    disabled={busy === p.name}
                  >
                    <span className="dash-project-dot" />
                    <span className="dash-project-name">{p.name}</span>
                    {isActive && <span className="dash-project-meta">active</span>}
                    {busy === p.name && <span className="dash-project-meta">switching…</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <HomeOmnigraphSection onGoto={onGoto as (v: "settings") => void} />

      {error && <div className="dash-error">error · {error}</div>}
    </div>
  );
}
