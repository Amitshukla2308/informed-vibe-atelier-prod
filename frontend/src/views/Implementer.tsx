/**
 * Implementer view — full-page broadcast of in-flight + recent implementer runs.
 *
 * Was previously mounted above the Canvas grid (cluttered the canvas, which is
 * a full-screen tool). Lives at /implementer in the rail, below Now.
 *
 * Renders the existing ImplementerLiveFeed component inside a page chrome
 * that owns its own scroll, header strip, and breathing room.
 */

import { ImplementerLiveFeed } from "../components/ImplementerLiveFeed";

interface ImplementerProps {
  project: string;
}

export function Implementer({ project }: ImplementerProps) {
  return (
    <div className="implementer-view">
      <header className="implementer-view-head">
        <div className="implementer-view-titles">
          <h1 className="implementer-view-h">Implementer</h1>
          <p className="implementer-view-sub">
            live broadcast — every run, every phase, every diff
          </p>
        </div>
        <div className="implementer-view-meta">
          <span className="implementer-view-proj">
            <span className="implementer-view-proj-k">project</span>
            <span className="implementer-view-proj-v">{project || "—"}</span>
          </span>
        </div>
      </header>
      <div className="implementer-view-feed">
        <ImplementerLiveFeed project={project} />
      </div>
    </div>
  );
}
