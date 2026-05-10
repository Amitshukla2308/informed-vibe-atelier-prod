/**
 * World watcher infrastructure (Phase C minimal).
 *
 * Today this is schema + storage only — no live watchers polling. Founder (or
 * carlsbert via MCP) can write events directly via the event-write endpoint,
 * which is enough to test the Reflect "Zone 3 · Brain & World deltas" and the
 * curation prompt's Axis A (world pressure) once wired.
 *
 * Watcher definitions live at `agents/watchers.yaml` (read-only for now);
 * emitted events append to `data/world/events/<YYYY-MM-DD>.jsonl`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { config } from "~/config";

export interface WatcherDef {
  /** Logical name, e.g. "space/proptech" or "domain/fastbrick-rera". */
  name: string;
  /** Human summary of what this watcher looks for. */
  description: string;
  /** Kind — "rss" | "webpage" | "manual" (manual = founder + agent push events directly). */
  kind: "rss" | "webpage" | "manual";
  /** For rss/webpage: source URL. For manual: absent. */
  source?: string;
  /** Tags to pre-label emitted events with. */
  tags?: string[];
}

export interface WorldEvent {
  /** Monotonic id. */
  id: string;
  /** ISO timestamp when the event was observed. */
  when: string;
  /** Watcher name that produced it. */
  watcher: string;
  /** Event title (short). */
  title: string;
  /** Event body. */
  body: string;
  /** Source URL / reference. */
  source: string;
  /** Severity as scored by world-relevance prompt (filled lazily). */
  severity?: "high" | "medium" | "low";
  /** Where this event surfaced (set by scoring). */
  surface?: "worth_revisiting" | "world_feed" | "silent";
  /** Canvas node ids the event was tied to at scoring time. */
  affectedNodeIds?: string[];
  /** Founder disposition. */
  disposition?: "open" | "dismissed" | "deferred" | "promoted";
  /** Auxiliary tags. */
  tags?: string[];
}

function eventsDir(): string {
  const d = resolve(config.dataDir, "world/events");
  mkdirSync(d, { recursive: true });
  return d;
}

function watcherConfigPath(): string {
  return resolve(config.agentsDir, "watchers.yaml");
}

function ensureWatcherFile(): void {
  const p = watcherConfigPath();
  if (existsSync(p)) return;
  const seed = `# World watchers — what Atelier monitors on the founder's behalf.
#
# Phase C bootstrap: no live pollers yet. Founder / agent can write events via
# POST /world/event, and scored events surface in Reflect Zone 1 + World view.
#
# When active watchers ship, each entry becomes a polling target.

watchers:
  - name: manual
    description: Events the founder or carlsbert write directly (no polling).
    kind: manual
    tags: [manual]
`;
  try {
    require("node:fs").writeFileSync(p, seed, "utf-8");
  } catch { /* ignore */ }
}

export function listWatchers(): WatcherDef[] {
  ensureWatcherFile();
  try {
    const raw = readFileSync(watcherConfigPath(), "utf-8");
    const parsed = YAML.parse(raw) as { watchers?: WatcherDef[] };
    return parsed?.watchers ?? [];
  } catch {
    return [];
  }
}

function dayKey(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().slice(0, 10);
}

export function writeEvent(partial: Omit<WorldEvent, "id"> & { id?: string }): WorldEvent {
  const event: WorldEvent = {
    id: partial.id ?? `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    when: partial.when ?? new Date().toISOString(),
    watcher: partial.watcher,
    title: partial.title,
    body: partial.body,
    source: partial.source,
    severity: partial.severity,
    surface: partial.surface,
    affectedNodeIds: partial.affectedNodeIds,
    disposition: partial.disposition ?? "open",
    tags: partial.tags,
  };
  const file = resolve(eventsDir(), `${dayKey(event.when)}.jsonl`);
  appendFileSync(file, JSON.stringify(event) + "\n");
  return event;
}

export function listRecentEvents(days = 7): WorldEvent[] {
  const dir = eventsDir();
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const out: WorldEvent[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = resolve(dir, f);
    try {
      const raw = readFileSync(path, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as WorldEvent;
          if (new Date(evt.when).getTime() >= cutoff) out.push(evt);
        } catch { /* skip bad line */ }
      }
    } catch { /* skip bad file */ }
  }
  out.sort((a, b) => (a.when < b.when ? 1 : -1));
  return out;
}
