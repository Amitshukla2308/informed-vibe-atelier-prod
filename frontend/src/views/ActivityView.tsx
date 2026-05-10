/**
 * ActivityView — Activity firehose (Canvas reframe, 2026-05-04).
 *
 * One-line-per-event log of every canvas_node_event for the active project.
 * Newest first. Click a line → opens that node's drawer (parent passes a
 * `onOpenNode` handler that reuses the existing NodeDetail surface).
 *
 * Polls /canvas/events every 4s with `since=<lastSeenId>` for new events;
 * on first mount fetches the most recent 100. No WebSocket — the same
 * notifications-socket already streams `implementer.event` frames in
 * real-time elsewhere; this view is the persistent ledger that survives
 * reloads.
 *
 * See docs/CANVAS_REFRAME_DECISIONS.md §4.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_URL } from "../lib/api";

interface ActivityEvent {
  id: number;
  project: string;
  node_id: string;
  ts: string;
  agent: string;
  kind: string;
  payload: Record<string, unknown> | null;
}

interface Props {
  project: string;
  onOpenNode: (nodeId: string) => void;
}

const POLL_MS = 4000;
const PAGE_SIZE = 200;

function formatRelative(ts: string): string {
  const t = new Date(ts).getTime();
  const dt = Math.max(0, Date.now() - t) / 1000;
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function eventGlyph(kind: string): string {
  if (kind.startsWith("impl-completed")) return "✓";
  if (kind.startsWith("impl-blocked")) return "✗";
  if (kind.startsWith("impl-started")) return "▶";
  if (kind.startsWith("impl-")) return "·";
  if (kind === "comment") return "💬";
  if (kind === "create") return "+";
  if (kind === "state") return "→";
  if (kind === "discuss") return "💬";
  if (kind === "resolve") return "✓";
  return "·";
}

function eventSummary(e: ActivityEvent): string {
  const p = e.payload ?? {};
  if (e.kind.startsWith("impl-")) {
    const phase = e.kind.slice("impl-".length);
    const reason = (p as { reason?: string }).reason;
    const summary = (p as { summary?: string }).summary;
    if (reason) return `${phase}: ${reason}`;
    if (summary) return `${phase}: ${summary}`;
    return phase;
  }
  if (e.kind === "comment") {
    const body = (p as { body?: string }).body ?? "";
    return body.slice(0, 200);
  }
  return "";
}

export function ActivityView({ project, onOpenNode }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);

  const fetchSince = useCallback(async (since: number) => {
    try {
      const r = await fetch(
        `${BASE_URL}/canvas/events?project=${encodeURIComponent(project)}&since=${since}&limit=${PAGE_SIZE}`,
      );
      if (!r.ok) {
        setError(`fetch failed: ${r.status}`);
        return;
      }
      const data = (await r.json()) as { events?: ActivityEvent[]; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      const fresh = data.events ?? [];
      if (fresh.length === 0) return;
      // Backend returns DESC by id; merge into existing newest-first list,
      // dedup by id, keep newest 500 to bound memory.
      setEvents(prev => {
        const seen = new Set(prev.map(e => e.id));
        const merged = [...fresh.filter(e => !seen.has(e.id)), ...prev];
        merged.sort((a, b) => b.id - a.id);
        return merged.slice(0, 500);
      });
      sinceRef.current = Math.max(sinceRef.current, ...fresh.map(e => e.id));
      setError(null);
    } catch (e) {
      setError(String(e).slice(0, 200));
    }
  }, [project]);

  // Initial fetch + 4s polling.
  useEffect(() => {
    sinceRef.current = 0;
    setEvents([]);
    void fetchSince(0);
    const id = window.setInterval(() => {
      void fetchSince(sinceRef.current);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [project, fetchSince]);

  return (
    <div className="activity-view" style={{ padding: 20, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "1rem", color: "var(--a-ink)" }}>
          activity · {events.length} events
        </h2>
        {error && (
          <span style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
            {error}
          </span>
        )}
      </div>
      {events.length === 0 && !error && (
        <div style={{ color: "var(--a-mute)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
          No events yet. Run something — flip the auto-poller, click "Run implementer" on a node, or create a card.
        </div>
      )}
      <ul className="activity-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {events.map(e => (
          <li
            key={e.id}
            onClick={() => onOpenNode(e.node_id)}
            style={{
              display: "grid",
              gridTemplateColumns: "70px 90px 16px 100px 1fr",
              gap: 8,
              padding: "6px 0",
              borderBottom: "1px solid var(--a-line)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: "0.8rem",
              alignItems: "baseline",
            }}
          >
            <span style={{ color: "var(--a-mute)" }}>{formatRelative(e.ts)}</span>
            <span style={{ color: "var(--a-ink)" }}>{e.agent}</span>
            <span style={{ textAlign: "center" }}>{eventGlyph(e.kind)}</span>
            <span style={{ color: "var(--a-mute)" }}>{e.node_id.slice(0, 14)}…</span>
            <span style={{ color: "var(--a-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {eventSummary(e)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
