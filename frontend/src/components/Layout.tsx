import { type ReactNode } from "react";

export type AppView = "now" | "canvas" | "domain-brain" | "settings" | "account";

const FULL_BLEED: AppView[] = ["now", "canvas"];

interface NavItem { id: AppView; label: string; d: string; }

const NAV: NavItem[] = [
  {
    id: "now", label: "Now",
    d: "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 6v6l4 2",
  },
  {
    id: "canvas", label: "Canvas",
    d: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  },
  {
    id: "domain-brain", label: "Domain Brain",
    d: "M12 2a7 7 0 0 1 7 7c0 2.6-1.4 4.9-3.5 6.2V17a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-1.8A7 7 0 0 1 12 2zM9 21h6M10 17v-2h4v2",
  },
  {
    id: "settings", label: "Settings",
    d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  },
  {
    id: "account", label: "Account",
    d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  },
];

interface Props {
  view: AppView;
  setView: (v: AppView) => void;
  agentName: string;
  founderName: string;
  activeProject: string;
  wsStatus?: string;
  children: ReactNode;
}

export function Layout({ view, setView, agentName, founderName, activeProject, wsStatus, children }: Props) {
  const fullBleed = FULL_BLEED.includes(view);

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark"><em>atelier</em></div>
        <div className="topbar-meta">
          — {agentName} · {activeProject}
        </div>
        <div className="topbar-right">
          {wsStatus && (
            <span
              className={`status-lamp ${wsStatus === "ready" ? "" : wsStatus === "connecting" ? "amber" : "rust"}`}
              title={wsStatus}
            />
          )}
          <span className="clock">{founderName}</span>
        </div>
      </header>

      <nav className="nav">
        <div className="nav-items">
          {NAV.map(({ id, label, d }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => setView(id)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                <path d={d} />
              </svg>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="nav-footer">
          <div className="row">pre-mvp · {activeProject}</div>
        </div>
      </nav>

      <main className={`main${fullBleed ? " main--full" : ""}`}>
        {children}
      </main>
    </div>
  );
}
