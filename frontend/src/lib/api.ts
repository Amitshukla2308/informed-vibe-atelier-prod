/**
 * Frontend API client.
 */

// Relative base — every API call goes through the SAME host the page is
// served from, then Vite's /api proxy (dev) or your reverse proxy (prod)
// rewrites /api/* to bare backend paths. This makes the app work identically
// over localhost, LAN ip, and tunnel without any per-environment config.
export const BASE_URL = import.meta.env.VITE_ATELIER_BASE ?? "/api";
export const WS_BASE = (() => {
  // Cutover-period override — point the frontend at a standalone Rust PTY
  // sidecar's hub (e.g. ws://localhost:3011). Takes precedence over
  // VITE_ATELIER_WS. The wire format is compatible, so no other code change
  // is required beyond this URL toggle.
  const cutover = (import.meta as { env?: { VITE_ATELIERAPP_WS_URL?: string } }).env?.VITE_ATELIERAPP_WS_URL;
  if (cutover) return cutover;
  const env = (import.meta as { env?: { VITE_ATELIER_WS?: string } }).env?.VITE_ATELIER_WS;
  if (env) return env;
  if (typeof window === "undefined") return "ws://localhost:3001";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
})();

export interface PreviousIdentity {
  agent_name: string;
  founder_name: string | null;
  org_name: string | null;
  active_project: string;
}

export interface OnboardingState {
  configured: boolean;
  logged_out?: boolean;
  agent_name: string | null;
  founder_name: string | null;
  active_project: string | null;
  org_name?: string | null;
  pickup_flavor?: string | null;
  provider?: string | null;
  previous_identity?: PreviousIdentity | null;
}

export interface ProjectListEntry {
  name: string;
  description: string;
  created_at: string | null;
  active: boolean;
}

export async function listProjects(): Promise<{ projects: ProjectListEntry[]; active: string | null }> {
  const r = await fetch(`${BASE_URL}/projects`);
  if (!r.ok) throw new Error(`projects ${r.status}`);
  return r.json();
}

export async function createProject(name: string, description: string, make_active = true): Promise<{ ok: boolean; created: boolean; name: string; active_project: string | null }> {
  const r = await fetch(`${BASE_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, make_active }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `projects POST ${r.status}`);
  }
  return r.json();
}

export async function switchProject(name: string): Promise<{ ok: boolean; active_project: string }> {
  const r = await fetch(`${BASE_URL}/projects/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `projects/switch ${r.status}`);
  }
  return r.json();
}

export async function updateOrgName(name: string): Promise<{ ok: boolean; org_name: string }> {
  const r = await fetch(`${BASE_URL}/org`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `org PATCH ${r.status}`);
  }
  return r.json();
}

/** @deprecated use logoutSoft — kept for call-site compatibility */
export async function resetOnboarding(): Promise<{ ok: boolean }> {
  return logoutSoft();
}

/** Soft logout — fires BOTH:
 *   1. POST /logout       → revokes the γ access-token cookie (httpOnly).
 *   2. POST /onboarding/logout → flips the legacy logged_out flag so /state
 *                                 returns previous_identity for the welcome-back screen.
 *  Either may not exist (legacy admin without a γ cookie, or γ user without
 *  a legacy config) — both calls are best-effort. credentials:'include' on
 *  the γ call so the server sees the cookie it's revoking. */
export async function logoutSoft(): Promise<{ ok: boolean }> {
  const calls: Promise<unknown>[] = [
    fetch(`${BASE_URL}/logout`, { method: "POST", credentials: "include" }).catch(() => undefined),
    fetch(`${BASE_URL}/onboarding/logout`, { method: "POST", credentials: "include" }).catch(() => undefined),
  ];
  await Promise.allSettled(calls);
  return { ok: true };
}

/** Resume a soft-logged-out identity. Clears the logout flag. */
export async function resumeIdentity(): Promise<{ ok: boolean } & Partial<PreviousIdentity>> {
  const r = await fetch(`${BASE_URL}/onboarding/resume`, { method: "POST" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `onboarding/resume ${r.status}`);
  }
  return r.json();
}

/** Hard reset — clears identity completely. Use for "start fresh" after soft logout. */
export async function wipeIdentity(): Promise<{ ok: boolean }> {
  const r = await fetch(`${BASE_URL}/onboarding/wipe`, { method: "POST" });
  if (!r.ok) throw new Error(`onboarding/wipe ${r.status}`);
  return r.json();
}

export async function getOnboardingState(): Promise<OnboardingState> {
  const r = await fetch(`${BASE_URL}/onboarding/state`);
  if (!r.ok) throw new Error(`onboarding/state ${r.status}`);
  return r.json();
}

export interface OnboardingPayload {
  agent_name: string;
  founder_name?: string;
  org_name: string;
  project_name: string;
  project_description: string;
  provider?: string;
}

export async function completeOnboarding(payload: OnboardingPayload): Promise<{ ok: boolean; project_created: boolean }> {
  const r = await fetch(`${BASE_URL}/onboarding/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`onboarding/complete ${r.status}`);
  return r.json();
}

export interface ReflectResult {
  artifact_path: string;
  signals_extracted: number;
  used_fallback?: boolean;
}

export async function endSessionWithReflection(sessionId: string): Promise<ReflectResult> {
  const r = await fetch(`${BASE_URL}/session/reflect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!r.ok) throw new Error(`session/reflect ${r.status}`);
  return r.json();
}

// ── Canvas CRUD ───────────────────────────────────────────────────────────────

// 6-altitude shape (see docs/PROJECT_SHAPE.md):
//   Project (1) → Plane (2) → Surface (3) → Story|Epic (4) → Task (5) → Subtask (6)
// Theme/Track/Module are pre-altitude vocabulary kept so existing canvases load.
export type NodeKind =
  | "Project"
  | "Plane"
  | "Surface"
  | "Story"
  | "Epic"
  | "Task"
  | "Subtask"
  | "Decision"
  | "Research"
  | "Risk"
  | "Artifact"
  | "Milestone"
  | "Consultation" // Session 4 (Pillar B) — meta-tracking node for off-platform expert
                   // conversations (lawyer / accountant / designer / govt desk). Atelier
                   // persists the question + answer; the conversation itself happens off-
                   // platform via email / slack / calendly / phone.
  | "Theme"   // @deprecated — outcome-grouped chunk
  | "Track"   // @deprecated — alias for Theme
  | "Module"; // @deprecated — alias for Story
// Canvas reframe (2026-05-04): added "triage" + "archived". "abandoned" kept as
// a legacy alias for old meta.json rows; new emissions use "archived".
export type NodeState = "triage" | "proposed" | "approved" | "in-progress" | "review" | "done" | "blocked" | "archived" | "abandoned";
export type NodeBadge = "auto" | "proposed" | "in-progress" | "blocked" | "review" | "done" | "drift";
export type Priority = "P0-now" | "P1-soon" | "P2-later" | "P3-backlog";
export type Layer = "infra" | "middle" | "application";
export type PlaneKind = "frontend" | "backend" | "data" | "integration" | "cross-cutting";
export type SurfaceStatus = "proposed" | "active" | "deprecated";

export interface NodeMeta {
  id: string;
  kind: NodeKind;
  // 2-word glanceable label. Shown in graph hover labels + Canvas header.
  title: string;
  intent: string;
  state: NodeState;
  badge: NodeBadge;
  parent_id: string | null;
  dependencies: string[];
  confidence: "high" | "medium" | "low";
  proposed_by?: "drafter" | "founder" | "reflection-worker" | "system" | "scaffold";
  priority?: Priority;
  cycle?: string | null;
  outcome?: string | null;        // Project kind only
  target_date?: string | null;    // Milestone kind only
  // 6-altitude metadata. Only set on the kinds noted; undefined elsewhere.
  layer?: Layer | null;                  // Project only
  plane_kind?: PlaneKind | null;          // Plane only
  parent_plane_id?: string | null;        // Plane (=null) | Surface
  manifest_globs?: string[];              // Surface only — Implementer write gate
  surface_kind?: string | null;           // Surface only — founder-facing tag
  surface_status?: SurfaceStatus | null;  // Surface only
  touches?: string[];                     // Story | Epic | Task | Subtask
  lock_id?: string | null;                // Task | Subtask
  priority_score?: number | null;         // Task | Subtask — 0.0–1.0
  supersedes?: string | null;             // Task | Subtask — pivot target
  /** Auto-seeded altitude slot — Drafter renames or replaces, never adds alongside. */
  placeholder?: boolean;
  // Cofounder collaboration (Canvas reframe 2026-05-04, decisions §3). When
  // mark_for_discussion=true, the assigned user's next Drafter session reads
  // these and surfaces the agenda as the conversation seed.
  mark_for_discussion?: boolean;
  discussion_agenda?: string | null;
  assigned_to_user_id?: string | null;
  // Consultation kind only (Session 4 — Pillar B). Atelier persists the
  // off-platform expert conversation; the answer ripples into the brain
  // when filled.
  expert_role?: string | null;
  channel?: string | null;
  question?: string | null;
  answer?: string | null;
  deadline?: string | null;
  answered_at?: string | null;
  created_at: string;
  updated_at: string;
}

export async function createNode(baseUrl: string, project: string, payload: {
  kind: NodeKind;
  title: string;
  intent: string;
  parent_id?: string;
  confidence?: "high" | "medium" | "low";
}): Promise<NodeMeta> {
  const r = await fetch(`${baseUrl}/canvas/node?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`canvas/node POST ${r.status}`);
  return r.json();
}

export async function updateNode(baseUrl: string, project: string, id: string, updates: {
  title?: string;
  priority?: Priority;
  cycle?: string | null;
  outcome?: string | null;
  target_date?: string | null;
  intent?: string;
  state?: NodeState;
  badge?: NodeBadge;
  plan?: string;
  // 6-altitude metadata. Backend rejects per-kind, so a Story passing manifest_globs is a no-op.
  layer?: Layer | null;
  plane_kind?: PlaneKind | null;
  parent_plane_id?: string | null;
  manifest_globs?: string[];
  surface_kind?: string | null;
  surface_status?: SurfaceStatus | null;
  touches?: string[];
  lock_id?: string | null;
  priority_score?: number | null;
  supersedes?: string | null;
  cascade_summary?: string;
  // Cofounder discussion flow (Canvas reframe 2026-05-04, see docs/CANVAS_REFRAME_DECISIONS.md §3).
  mark_for_discussion?: boolean;
  discussion_agenda?: string | null;
  assigned_to_user_id?: string | null;
  // Consultation kind only (Session 4 — Pillar B). Atelier auto-stamps
  // answered_at on the route side when `answer` transitions null → non-null.
  expert_role?: string | null;
  channel?: string | null;
  question?: string | null;
  answer?: string | null;
  deadline?: string | null;
}): Promise<NodeMeta> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!r.ok) {
    // Surface convergence-rule violations (409) with their explanation so callers can
    // display the founder-readable "why" instead of a generic toast.
    let detail = "";
    try {
      const body = await r.json();
      detail = body?.error ?? "";
    } catch {
      /* non-JSON error body — ignore */
    }
    const err = new Error(`canvas/node PATCH ${r.status}${detail ? ` — ${detail}` : ""}`);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return r.json();
}

export async function createEdge(baseUrl: string, project: string, from: string, to: string, kind = "depends-on"): Promise<void> {
  const r = await fetch(`${baseUrl}/canvas/edge?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, kind }),
  });
  if (!r.ok) throw new Error(`canvas/edge POST ${r.status}`);
}

export interface NodeDetail {
  meta: NodeMeta;
  plan: string;
  discussions?: Array<{ file: string; entries: unknown[] }>;
}

export async function getNodeDetail(baseUrl: string, project: string, id: string): Promise<NodeDetail> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`canvas/node GET ${r.status}`);
  return r.json();
}

// ── Canvas comments + events (Canvas reframe 2026-05-04) ────────────────────

export interface NodeComment {
  id: number;
  author_user_id: string | null;
  author_role: string;
  body: string;
  created_at: string;
}

export async function listNodeComments(baseUrl: string, project: string, id: string): Promise<NodeComment[]> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}/comments?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`comments GET ${r.status}`);
  const data = await r.json();
  return (data.comments ?? []) as NodeComment[];
}

export async function postNodeComment(baseUrl: string, project: string, id: string, body: string, authorRole = "founder"): Promise<void> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}/comments?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, author_role: authorRole }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`comments POST ${r.status} ${txt}`);
  }
}

export interface NodeEvent {
  id: number;
  ts: string;
  agent: string;
  kind: string;
  payload: Record<string, unknown> | null;
}

export async function listNodeEvents(baseUrl: string, project: string, id: string, limit = 50): Promise<NodeEvent[]> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}/events?project=${encodeURIComponent(project)}&limit=${limit}`);
  if (!r.ok) throw new Error(`events GET ${r.status}`);
  const data = await r.json();
  return (data.events ?? []) as NodeEvent[];
}

export async function nudgeImplementer(baseUrl: string): Promise<{ ok: boolean; already_running: boolean; reason?: string }> {
  const r = await fetch(`${baseUrl}/implementer/auto-poller/tick`, { method: "POST" });
  if (!r.ok) throw new Error(`nudge POST ${r.status}`);
  return r.json();
}

export async function deleteNode(baseUrl: string, project: string, id: string): Promise<{ ok: boolean; removedEdges: number; orphanedChildren: number }> {
  const r = await fetch(`${baseUrl}/canvas/node/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`canvas/node DELETE ${r.status}`);
  return r.json();
}

// ── Researcher (Pillar A — world-grounding) ──────────────────────────────────

export interface ResearchRunResult {
  ok: boolean;
  status: "ok" | "skipped" | "error";
  /** Path under the atelier root, e.g. og_artifacts/brain/projects/Foo/research/abc-2026-…md */
  path?: string;
  confidence?: string | null;
  provider?: string;
  reason?: string;
}

/**
 * Run Researcher headlessly on a Canvas node. The backend writes the note
 * to og_artifacts/brain/projects/<P>/research/ and posts a comment on the
 * source node summarising it. Caller refreshes comments after this resolves.
 */
export async function runResearcher(
  baseUrl: string,
  project: string,
  nodeId: string,
  question: string,
  signal?: AbortSignal,
): Promise<ResearchRunResult> {
  const r = await fetch(`${baseUrl}/research/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ project, nodeId, question }),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`research/run ${r.status} ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// ── Ripple (Session 5, TODO #30) ─────────────────────────────────────────────

export interface RippleNeighbor {
  /** File path relative to atelier root. */
  path: string;
  /** 0–1 normalized co-change confidence (conditional probability with recency boost). */
  confidence: number;
  /** Days since the most recent commit that touched both files together. -1 if unknown. */
  last_change_distance: number;
  /** 1 = direct co-change, 2/3 = transitive (dampened). */
  depth: number;
}

export interface RippleResult {
  anchor: string;
  affected_files: RippleNeighbor[];
  graph_built_at: string;
  source: "git-fallback" | "use-ripple";
  cached: boolean;
}

/**
 * Query the live co-change graph for `file` (path relative to atelier root).
 * Workspace-level (not project-scoped). Used by the node drawer to surface
 * ripple awareness next to a Task / Subtask.
 */
export async function getRipple(
  baseUrl: string,
  file: string,
  depth: number = 1,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<RippleResult> {
  const qs = new URLSearchParams({ file, depth: String(depth), limit: String(limit) });
  const r = await fetch(`${baseUrl}/ripple?${qs.toString()}`, {
    credentials: "include",
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`ripple ${r.status} ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// ── Sessions (Reflect view) ──────────────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  rawBytes: number;
  turnCount: number;
  reflected: boolean;
  artifactPath?: string;
  flavor?: string;
  approxTokens?: number;
  firstUserLine?: string;
  /** False-done detector: false = session ran but left no transcript. */
  captured?: boolean;
}

export async function listSessions(project: string): Promise<SessionEntry[]> {
  const r = await fetch(`${BASE_URL}/sessions?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  const d = await r.json();
  return d.sessions ?? [];
}

export type TurnContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown; toolUseId?: string }
  | { type: "tool_result"; toolUseId?: string; output: string; isError?: boolean };

export interface NormalizedTurn {
  turnId: string;
  role: "user" | "assistant" | "tool";
  ts: string;
  blocks: TurnContentBlock[];
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  model?: string;
  stopReason?: string;
}

export interface SessionDetail {
  entry: SessionEntry;
  artifact: string | null;
  rawExcerpt: string;
  turns: NormalizedTurn[];
  toolCalls: Array<{ name: string; turnId: string; ts: string }>;
  /** Where the turns came from. "provider" = structured claude JSONL (full conversation);
   *  "raw-log-reconstruction" = legacy rebuild, user side only; "none" = nothing usable. */
  turnSource: "provider" | "raw-log-reconstruction" | "none";
}

export async function getSessionDetail(project: string, id: string): Promise<SessionDetail> {
  const r = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`sessions/${id} ${r.status}`);
  return r.json();
}

export async function reflectSessionNow(id: string): Promise<{ artifact_path: string; signals_extracted: number; used_fallback?: boolean }> {
  const r = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}/reflect`, { method: "POST" });
  if (!r.ok) throw new Error(`sessions/${id}/reflect ${r.status}`);
  return r.json();
}

export async function updateSessionArtifact(project: string, id: string, content: string): Promise<{ ok: boolean; path: string }> {
  const r = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}/artifact?project=${encodeURIComponent(project)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`sessions/${id}/artifact PATCH ${r.status}`);
  return r.json();
}

export async function deleteSessionArtifact(project: string, id: string): Promise<{ ok: boolean; path: string }> {
  const r = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}/artifact?project=${encodeURIComponent(project)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`sessions/${id}/artifact DELETE ${r.status}`);
  return r.json();
}

export type ContinueMode = "resume" | "summarize";

export interface ContinueResult {
  continuationId: string;
  mode: ContinueMode;
  briefMarkdown: string;
  resumeSessionId?: string;
  sourceSessionIds: string[];
  pendingPath: string;
}

export async function continueSessions(project: string, sessionIds: string[], mode: ContinueMode): Promise<ContinueResult> {
  const r = await fetch(`${BASE_URL}/sessions/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, sessionIds, mode }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `sessions/continue ${r.status}`);
  }
  return r.json();
}

// ── World (Phase C minimal) ──────────────────────────────────────────────────

export interface WorldEvent {
  id: string;
  when: string;
  watcher: string;
  title: string;
  body: string;
  source: string;
  severity?: "high" | "medium" | "low";
  surface?: "worth_revisiting" | "world_feed" | "silent";
  affectedNodeIds?: string[];
  disposition?: "open" | "dismissed" | "deferred" | "promoted";
  tags?: string[];
}

export async function listWorldEvents(days = 7): Promise<WorldEvent[]> {
  const r = await fetch(`${BASE_URL}/world/events?days=${days}`);
  if (!r.ok) return [];
  const d = await r.json();
  return d.events ?? [];
}

// ── Domain brain ─────────────────────────────────────────────────────────────

export interface DomainBrainFile {
  name: string;
  filename: string;
  content: string;
}

export async function getDomainBrain(baseUrl: string, project: string): Promise<DomainBrainFile[]> {
  const r = await fetch(`${baseUrl}/domain-brain?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`domain-brain ${r.status}`);
  const d = await r.json();
  return d.files ?? [];
}

// ── Brain v2 — 3-layer inspection + boot-prompt preview ───────────────────────
// The contract is "do not mix layers" (omnigraph/docs/ATELIER_OUTPUTS.md). The
// Brain surface treats each layer as a separate document and shows the
// merged-injection footprint only as the "what the agent actually receives"
// preview, never as the editing/inspection target.

export interface BrainLayerView {
  exists: boolean;
  path: string;
  xml: string | null;
  bytes: number;
  mtime: string | null;
  source: "user" | "default-fallback" | null;
}
export interface BrainProjectLayerView {
  exists: boolean;
  path: string;
  xml: string | null;
  bytes: number;
  mtime: string | null;
  source: "shared" | "per-user-fallback" | null;
  projectName: string;
  isShared: boolean;
}
export interface BrainInjectFlags {
  includeGlobal: boolean;
  includePersonal: boolean;
  includeProject: boolean;
}
export interface BrainInspection {
  userId: string;
  effectiveUserId: string;
  global: BrainLayerView;
  personal: BrainLayerView;
  project: BrainProjectLayerView | null;
  injectFlags: BrainInjectFlags;
  wrapperBytes: number;
  totalInjectedBytes: number;
  totalInjectedLayers: { global: boolean; personal: boolean; project: string | null };
}
export interface BrainPreview {
  markdown: string | null;
  bytes: number;
  layersLoaded: { global: boolean; personal: boolean; project: string | null };
  injectFlags: BrainInjectFlags;
}
export interface OmnigraphStatusResponse {
  daemon: { running: boolean; pid: number | null; lastRun: string | null; logPath: string };
  layerMtimes: { global: string | null; personal: string | null; project: Record<string, string | null> };
  constraints: {
    compiledAt: string | null;
    eventsCompiledTotal: number;
    pendingEvents: number;
    stale: boolean;
    perRole: Record<string, { mtime: string | null; bytes: number }>;
  };
}
export interface AgentConstraintsView {
  role: string;
  exists: boolean;
  markdown: string | null;
  mtime: string | null;
  audit: {
    compiledAt: string | null;
    eventsTotal: number;
    rules: Array<Record<string, unknown>> | null;
  } | null;
}

export async function getBrainInspection(baseUrl: string, project?: string): Promise<BrainInspection> {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const r = await fetch(`${baseUrl}/brain${q}`);
  if (!r.ok) throw new Error(`brain ${r.status}`);
  return r.json();
}
export async function getBrainPreview(baseUrl: string, project?: string): Promise<BrainPreview> {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const r = await fetch(`${baseUrl}/brain/preview${q}`);
  if (!r.ok) throw new Error(`brain/preview ${r.status}`);
  return r.json();
}
export async function getOmnigraphStatus(baseUrl: string): Promise<OmnigraphStatusResponse> {
  const r = await fetch(`${baseUrl}/omnigraph/status`);
  if (!r.ok) throw new Error(`omnigraph/status ${r.status}`);
  return r.json();
}
export async function getAgentConstraints(baseUrl: string, role: string): Promise<AgentConstraintsView> {
  const r = await fetch(`${baseUrl}/agent-constraints/${encodeURIComponent(role)}`);
  if (!r.ok) throw new Error(`agent-constraints ${r.status}`);
  return r.json();
}

// ── γ auth: users / invites / memberships ─────────────────────────────────────

export type AtelierRole = "admin" | "founder" | "technical" | "business" | "observer";

export interface AtelierUser {
  id: string;
  display_name: string;
  email: string | null;
}

export interface AtelierMembership {
  org_id: string;
  org_name: string;
  role: AtelierRole;
}

export interface MeResponse {
  user: AtelierUser | null;
  memberships: AtelierMembership[];
}

export interface InvitePreview {
  org: { id: string; name: string };
  role: AtelierRole;
  invited_by: string;
  intended_email: string | null;
  expires_at: string;
}

export interface InviteListEntry {
  token_hash: string;
  org_id: string;
  org_name: string;
  role: AtelierRole;
  intended_email: string | null;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  invited_by_name: string;
  redeemed_by_name: string | null;
}

export interface UserListEntry {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  last_seen_at: string | null;
  memberships: string | null;
}

// All fetches `credentials: "include"` so the atelier_at cookie rides with them.

export async function getMe(): Promise<MeResponse> {
  const r = await fetch(`${BASE_URL}/me`, { credentials: "include" });
  if (!r.ok) throw new Error(`me ${r.status}`);
  return r.json();
}

// Dev-mode one-shot: if no session cookie exists but exactly one user is in
// the DB (the legacy-migrated founder), the backend mints a cookie for them.
// Safe to call on every boot — backend no-ops when already authenticated.
export async function bootstrapSession(): Promise<{ ok: boolean; bootstrapped: boolean }> {
  const r = await fetch(`${BASE_URL}/bootstrap-session`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) {
    return { ok: false, bootstrapped: false };
  }
  return r.json();
}

export interface OrgListEntry {
  id: string;
  name: string;
  default_visibility: "members" | "all";
  role: "admin" | "member";
}
export async function changePassword(args: { current_password?: string; new_password: string }): Promise<void> {
  const r = await fetch(`${BASE_URL}/me/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `change-password ${r.status}`;
    throw new Error(msg);
  }
}

export async function adminResetPassword(user_id: string): Promise<{ temp_password: string }> {
  const r = await fetch(`${BASE_URL}/admin/users/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ user_id }),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `reset-password ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

export interface AccessRequest {
  id: string;
  display_name: string;
  email: string | null;
  requested_at: string;
  status: "pending";
}
export async function listAccessRequests(): Promise<AccessRequest[]> {
  const r = await fetch(`${BASE_URL}/admin/access-requests`, { credentials: "include" });
  if (!r.ok) throw new Error(`access-requests ${r.status}`);
  return (await r.json()).requests;
}

export interface DecideAccessReq {
  user_id: string;
  action: "approve" | "reject";
  org_id?: string;
  role?: "admin" | "member";
  project_ids?: string[];
  project_role?: "editor" | "viewer";
  contributor_kind?: "founder" | "technical" | "business" | "observer";
}
export async function decideAccessRequest(req: DecideAccessReq): Promise<void> {
  const r = await fetch(`${BASE_URL}/admin/access-requests/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `decide ${r.status}`;
    throw new Error(msg);
  }
}

export async function listOrgs(): Promise<OrgListEntry[]> {
  const r = await fetch(`${BASE_URL}/orgs`, { credentials: "include" });
  if (!r.ok) throw new Error(`orgs ${r.status}`);
  return (await r.json()).orgs;
}

export interface OrgProjectEntry {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  created_at: string;
  archived_at: string | null;
  role: "admin" | "editor" | "viewer";
}
export async function listOrgProjects(orgId: string): Promise<OrgProjectEntry[]> {
  const r = await fetch(`${BASE_URL}/orgs/${encodeURIComponent(orgId)}/projects`, { credentials: "include" });
  if (!r.ok) throw new Error(`org/${orgId}/projects ${r.status}`);
  return (await r.json()).projects;
}

export async function logout(): Promise<void> {
  await fetch(`${BASE_URL}/logout`, { method: "POST", credentials: "include" });
}

export async function getInvitePreview(token: string): Promise<InvitePreview> {
  const r = await fetch(`${BASE_URL}/join?inv=${encodeURIComponent(token)}`, { credentials: "include" });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `join ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

export async function claimInvite(payload: { inv: string; display_name: string; email?: string }): Promise<{ user: AtelierUser; org_id: string; role: AtelierRole }> {
  const r = await fetch(`${BASE_URL}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `claim ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

export async function createInvite(payload: { org_id: string; roles: AtelierRole[]; intended_email?: string; ttl_days?: number }): Promise<{ invite_token: string; expires_at: string; org_id: string; roles: AtelierRole[] }> {
  const r = await fetch(`${BASE_URL}/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `invite ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

export interface ClaudeLinkStatus {
  linked: boolean;
  linked_at?: string;
  size_bytes?: number;
  shape?: "credentials" | "legacy-config";
}

export async function getClaudeLinkStatus(): Promise<ClaudeLinkStatus> {
  const r = await fetch(`${BASE_URL}/me/claude-link/status`, { credentials: "include" });
  if (!r.ok) throw new Error(`claude-link/status ${r.status}`);
  return r.json();
}

export async function uploadClaudeCredentials(credentialsJson: string): Promise<{ ok: boolean; recognized_shape: boolean; shape: string }> {
  const r = await fetch(`${BASE_URL}/me/claude-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ credentials_json: credentialsJson }),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `claude-link ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

export async function unlinkClaude(): Promise<void> {
  await fetch(`${BASE_URL}/me/claude-link/unlink`, { method: "POST", credentials: "include" });
}

export async function removeUserFromOrg(user_id: string, org_id: string): Promise<void> {
  const r = await fetch(`${BASE_URL}/admin/users/remove-from-org`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ user_id, org_id }),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? `remove ${r.status}`;
    throw new Error(msg);
  }
}

export async function adminListUsers(): Promise<UserListEntry[]> {
  const r = await fetch(`${BASE_URL}/admin/users`, { credentials: "include" });
  if (!r.ok) throw new Error(`admin/users ${r.status}`);
  return (await r.json()).users;
}

export async function adminListInvites(): Promise<InviteListEntry[]> {
  const r = await fetch(`${BASE_URL}/admin/invites`, { credentials: "include" });
  if (!r.ok) throw new Error(`admin/invites ${r.status}`);
  return (await r.json()).invites;
}

export async function adminRevokeInvite(token_hash: string): Promise<void> {
  const r = await fetch(`${BASE_URL}/admin/invites/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token_hash }),
  });
  if (!r.ok) throw new Error(`revoke ${r.status}`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Implementer + agent settings + activity feed                                */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ImplementerAllocation {
  verdict: "qwen" | "hand_back" | string;
  reason: string;
  confidence: number;
  elapsed_s: number;
  tokens_in: number;
  tokens_out: number;
}

export interface ImplementerExecutionEntry {
  timestamp: string;
  branch: string;
  worktreePath: string;
  diff_bytes: number;
  files_touched: string[];
  tsc_ok: boolean;
  tsc_tail: string;
  qwen_exit_code: number;
  qwen_response: string;
  tokens_in: number;
  tokens_out: number;
  tools_called: number;
  /** "local" or "repo"; older entries omit it (default "repo"). */
  mode?: "local" | "repo";
  /** Local-mode run dir (absolute path), null in repo mode. */
  run_dir?: string | null;
  /** Repo-mode commit SHA, null otherwise. */
  commit?: string | null;
  allocation: ImplementerAllocation;
}

export interface ImplementerStatusResponse {
  nodeId: string;
  project: string;
  state: string;
  badge: string;
  branch: string | null;
  last_run: ImplementerExecutionEntry | null;
  ledger_entries: number;
  ledger_tail: unknown[];
  /** Sandbox strategy. "repo" = git worktree in projectMeta.repo_path;
   *  "local" = hardlinked snapshot under <project>/.implementer-runs/. */
  mode?: "local" | "repo";
  /** Local-mode run dir (absolute), null in repo mode. */
  run_dir?: string | null;
  /** Local-mode summary.json contents (parsed), null in repo mode. */
  summary?: {
    files: string[];
    diff_bytes: number;
    mode: "local";
    run_dir: string;
    project_root: string;
    branch: string;
    finished_at: string;
  } | null;
}

export interface ImplementerRunsListEntry {
  nodeId: string;
  project: string;
  timestamp: string;
  state: string;
  mode: "local" | "repo";
  diff_bytes: number;
  files: string[];
  branch: string | null;
  reason: string | null;
}

export interface ImplementerRunResult {
  nodeId: string;
  branch: string;
  worktreePath: string;
  finalState: "review" | "blocked";
  reason: string;
  allocation: ImplementerAllocation;
  run: ImplementerExecutionEntry | null;
  diffBytes: number;
  tscOk: boolean;
}

export async function getImplementerStatus(_baseUrl: string, project: string, nodeId: string): Promise<ImplementerStatusResponse> {
  const r = await fetch(
    `${BASE_URL}/implementer/status/${encodeURIComponent(project)}/${encodeURIComponent(nodeId)}`,
    { credentials: "include" },
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

export async function getImplementerDiff(
  _baseUrl: string, project: string, nodeId: string,
): Promise<{ nodeId: string; branch: string; base: string; files: string[]; stat: string; diff: string }> {
  const r = await fetch(
    `${BASE_URL}/implementer/diff/${encodeURIComponent(project)}/${encodeURIComponent(nodeId)}`,
    { credentials: "include" },
  );
  if (!r.ok) throw new Error(`diff ${r.status}`);
  return r.json();
}

export async function runImplementer(_baseUrl: string, project: string, nodeId: string, timeoutMs?: number): Promise<ImplementerRunResult> {
  const r = await fetch(`${BASE_URL}/implementer/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ project, nodeId, timeoutMs }),
  });
  if (!r.ok) throw new Error(`run ${r.status}`);
  return r.json();
}

export async function approveImplementer(_baseUrl: string, project: string, nodeId: string): Promise<{ ok: boolean; mergedInto?: string; nodeState?: string; error?: string }> {
  const r = await fetch(
    `${BASE_URL}/implementer/approve/${encodeURIComponent(project)}/${encodeURIComponent(nodeId)}`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: `approve ${r.status}` }));
    throw new Error(body.error ?? `approve ${r.status}`);
  }
  return r.json();
}

export async function rejectImplementer(_baseUrl: string, project: string, nodeId: string, reason?: string): Promise<{ ok: boolean; nodeState?: string }> {
  const r = await fetch(
    `${BASE_URL}/implementer/reject/${encodeURIComponent(project)}/${encodeURIComponent(nodeId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ reason }),
    },
  );
  if (!r.ok) throw new Error(`reject ${r.status}`);
  return r.json();
}

export async function seniorReviewImplementer(_baseUrl: string, project: string, nodeId: string): Promise<{ ok: boolean; provider: string; elapsed_s: number; exit_code: number; report: string }> {
  const r = await fetch(
    `${BASE_URL}/implementer/senior_review/${encodeURIComponent(project)}/${encodeURIComponent(nodeId)}`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok) throw new Error(`senior_review ${r.status}`);
  return r.json();
}

export async function listImplementerRuns(project?: string, limit = 20): Promise<{ runs: ImplementerRunsListEntry[] }> {
  const qs = new URLSearchParams();
  if (project) qs.set("project", project);
  qs.set("limit", String(limit));
  const r = await fetch(`${BASE_URL}/implementer/runs?${qs.toString()}`, { credentials: "include" });
  if (!r.ok) throw new Error(`runs ${r.status}`);
  return r.json();
}

/* Agent settings + provider linking ----------------------------------------- */

export type AgentName = "drafter" | "fixer" | "researcher" | "allocator" | "implementer" | "senior_reviewer" | "reflect";
export type AgentMode = "manual" | "semi_auto" | "auto";

export interface AgentConfig {
  agent_name: AgentName;
  mode: AgentMode;
  provider: string;
  updated_at: string;
}

export interface ProviderLink {
  provider: string;
  status: "linked" | "unlinked" | "expired";
  bin_path: string | null;
  base_url: string | null;
  model_id: string | null;
  api_key_env: string | null;
  notes: string | null;
  linked_at: string | null;
  updated_at: string;
}

export interface DetectedProvider {
  provider: string;
  available: boolean;
  hint: string;
}

export interface KnownProvider {
  id: string;
  label: string;
  kind: "cli" | "api";
}

export interface AgentSettingsResponse {
  configs: AgentConfig[];
  links: ProviderLink[];
  known_providers: KnownProvider[];
  detected: DetectedProvider[];
  agent_modes: AgentMode[];
  agent_names: AgentName[];
}

export async function getAgentSettings(): Promise<AgentSettingsResponse> {
  const r = await fetch(`${BASE_URL}/settings/agents`, { credentials: "include" });
  if (!r.ok) throw new Error(`agent settings ${r.status}`);
  return r.json();
}

export async function updateAgentSetting(agent: AgentName, mode: AgentMode, provider: string): Promise<{ ok: boolean; config: AgentConfig }> {
  const r = await fetch(`${BASE_URL}/settings/agents/${encodeURIComponent(agent)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mode, provider }),
  });
  if (!r.ok) throw new Error(`agent setting update ${r.status}`);
  return r.json();
}

export async function updateProviderLink(provider: string, fields: Partial<ProviderLink>): Promise<{ ok: boolean; link: ProviderLink }> {
  const r = await fetch(`${BASE_URL}/settings/providers/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`provider link update ${r.status}`);
  return r.json();
}

export interface ProviderVerifyResult {
  ok: boolean;
  latency_ms: number;
  detail: string;
  error?: string;
}

export async function verifyProvider(provider: string, overrides: Partial<ProviderLink> = {}): Promise<ProviderVerifyResult> {
  const r = await fetch(`${BASE_URL}/settings/providers/${encodeURIComponent(provider)}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(overrides),
  });
  if (!r.ok) throw new Error(`verify ${r.status}`);
  return r.json();
}

/* Recent activity + ETL status ---------------------------------------------- */

export interface ActivityRun {
  project: string;
  node_id: string;
  timestamp: string;
  branch: string;
  diff_bytes: number;
  tsc_ok: boolean;
  qwen_exit_code: number;
  files_touched: string[];
  allocation_verdict: string;
}

export interface ActivityBlocker {
  timestamp: string;
  reason: string;
  block: string;
}

export type ActivityAgent = "drafter" | "allocator" | "implementer" | "senior_reviewer" | "reflect" | "system";

export interface UnifiedActivityRow {
  agent: ActivityAgent;
  timestamp: string;
  project: string | null;
  ref_id: string | null;
  summary: string;
  status: "ok" | "blocked" | "info";
  details?: Record<string, unknown>;
}

export interface RecentActivityResponse {
  activity: UnifiedActivityRow[];
  runs: ActivityRun[];          // legacy field (= filtered activity)
  audits: unknown[];
  errors: ActivityBlocker[];
}

export async function getRecentActivity(limit = 20): Promise<RecentActivityResponse> {
  const r = await fetch(`${BASE_URL}/activity/recent?limit=${limit}`, { credentials: "include" });
  if (!r.ok) throw new Error(`recent activity ${r.status}`);
  return r.json();
}

export interface EtlProviderInfo {
  provider: string;
  sourceDir: string;
  pattern: string;
  exists: boolean;
  sourceCount: number;
  doneCount: number;
  pendingCount: number;
  lastSessionAt: string | null;
}

export interface EtlStatusResponse {
  daemon: { pid: number | null; alive: boolean; last_cycle: string | null; log_size_bytes: number };
  gpu_lock: unknown;
  omnigraph_root: string;
  omnigraph_present: boolean;
  ai_conv_root: string;
  ai_conv_present: boolean;
  providers: EtlProviderInfo[];
}

export async function getEtlStatus(): Promise<EtlStatusResponse> {
  const r = await fetch(`${BASE_URL}/activity/etl-status`);
  if (!r.ok) throw new Error(`etl status ${r.status}`);
  return r.json();
}

export interface OgStatBucket {
  name: string;
  count: number;
  size_bytes: number;
  newest_at: string | null;
}

export interface OgStatsResponse {
  og_artifacts_root: string;
  og_artifacts_present: boolean;
  user_brain_root: string;
  brain: OgStatBucket;
  vault: OgStatBucket;
  ledger: OgStatBucket;
  agents: OgStatBucket;
  pilot_full: OgStatBucket;
  last_session_run_at: string | null;
}

export async function getOgStats(): Promise<OgStatsResponse> {
  const r = await fetch(`${BASE_URL}/activity/og-stats`);
  if (!r.ok) throw new Error(`og stats ${r.status}`);
  return r.json();
}

/* Terminal v2 (ttyd-direct, reverse-proxied) -------------------------------- */

export interface TerminalV2Availability {
  available: boolean;
  reasons: string[];
}

export interface TerminalV2Session {
  ok: true;
  sessionId: string;
  port: number;
  url: string;           // host-only (http://127.0.0.1:<port>/) — diagnostics
  wsUrl: string;         // host-only — diagnostics
  // Relative path served via the Atelier backend proxy. Works from any
  // device that can reach Atelier (LAN, Cloudflare tunnel, mobile). The
  // iframe must use this; absolute fields above only work on the host.
  proxyUrl: string;
}

export async function getTerminalV2Availability(): Promise<TerminalV2Availability> {
  const r = await fetch(`${BASE_URL}/terminal-v2/availability`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`availability ${r.status}`);
  return r.json();
}

export async function startTerminalV2(sessionId: string, agent: string = "drafter"): Promise<TerminalV2Session | { ok: false; reason: string }> {
  const r = await fetch(`${BASE_URL}/terminal-v2/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ sessionId, agent }),
  });
  return r.json();
}

export async function stopTerminalV2(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch(`${BASE_URL}/terminal-v2/stop/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    credentials: "include",
  });
  return r.json();
}

export async function getTerminalV2Status(sessionId: string): Promise<{ active: boolean } & Partial<TerminalV2Session>> {
  const r = await fetch(`${BASE_URL}/terminal-v2/status/${encodeURIComponent(sessionId)}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

// ── Implementer queue (Backlog view) ────────────────────────────────────────
export interface QueueRow {
  id: string;
  title: string;
  kind: string;
  state: string;
  parent_id: string | null;
  touches: string[];
  priority_score: number;
  lock_id: string | null;
  topo_ready: boolean;
  surface_heat: number | null;
  artifact_count: number;
  author_age_days: number;
  score: number;
  explanation: string;
  coherence_blocked: string | null;
}

export async function getImplementerQueue(project: string): Promise<{ project: string; queue: QueueRow[] }> {
  const r = await fetch(`${BASE_URL}/implementer/queue?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`queue ${r.status}`);
  return r.json();
}

// ── Implementer coherence gate ──────────────────────────────────────────────
export interface CoherenceViolation {
  kind: "missing-depends-on" | "duplicate-producer";
  consumerNodeId: string;
  artifact: string;
  producerNodeIds: string[];
  message: string;
}

export async function getCoherence(project: string): Promise<{ project: string; violations: CoherenceViolation[]; count: number }> {
  const r = await fetch(`${BASE_URL}/implementer/coherence?project=${encodeURIComponent(project)}`);
  if (!r.ok) throw new Error(`coherence ${r.status}`);
  return r.json();
}

// ── Implementer auto-poller ─────────────────────────────────────────────────
export interface AutoPollerStatus {
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
  running: boolean;
}

export async function getImplementerAutoPoller(): Promise<AutoPollerStatus> {
  const r = await fetch(`${BASE_URL}/implementer/auto-poller`);
  if (!r.ok) throw new Error(`auto-poller GET ${r.status}`);
  return r.json();
}

export async function setImplementerAutoPoller(
  patch: { enabled?: boolean; dry_run?: boolean; interval_ms?: number }
): Promise<{ ok: boolean } & AutoPollerStatus> {
  const r = await fetch(`${BASE_URL}/implementer/auto-poller`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `auto-poller POST ${r.status}`);
  }
  return r.json();
}

// ── Verifier constraints (A2 flywheel) ───────────────────────────────────────
// The 7-agent set is the source of truth (drafter / fixer / researcher /
// allocator / implementer / senior_reviewer / reflect). Settings reads it
// from /settings/agents.agent_names; Approvals derives its grouping from the
// same response. The union below catches all currently-known emitters; new
// agents will need a one-line addition.
export type VerifierConstraintRole =
  | "drafter"
  | "fixer"
  | "researcher"
  | "allocator"
  | "implementer"
  | "senior_reviewer"
  | "reflect"
  | "system"
  | "cofounder"
  | "founder";

export interface VerifierConstraint {
  event_id: number;
  project: string;
  node_id: string;
  ts: string;
  agent_role: VerifierConstraintRole;
  axiom: string;
  evidence: string;
  suggested_constraint: string;
  acknowledged: boolean;
  rejected: boolean;
}

export async function listVerifierConstraints(project: string): Promise<{ constraints: VerifierConstraint[] }> {
  const r = await fetch(`${BASE_URL}/verifier-constraints?project=${encodeURIComponent(project)}`, { credentials: "include" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `verifier-constraints GET ${r.status}`);
  }
  return r.json();
}

export async function acceptVerifierConstraint(eventId: number, editedConstraint?: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${BASE_URL}/verifier-constraints/${eventId}/accept`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(editedConstraint ? { edited_constraint: editedConstraint } : {}),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `verifier-constraint accept ${r.status}`);
  }
  return r.json();
}

export async function rejectVerifierConstraint(eventId: number): Promise<{ ok: boolean }> {
  const r = await fetch(`${BASE_URL}/verifier-constraints/${eventId}/reject`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `verifier-constraint reject ${r.status}`);
  }
  return r.json();
}

/* Distribution adapters (Pillar C — go-live cliff) -------------------------- */

export type DistributionCategory = "dns" | "payments" | "analytics" | "email";
export type DistributionLinkStatus = "configured" | "verified" | "failed" | "unconfigured";

export interface DistributionAdapterEntry {
  id: string;
  category: DistributionCategory;
  label: string;
  purpose: string;
  detected: { available: boolean; hint: string };
}

export interface DistributionLink {
  adapter_id: string;
  project: string | null;
  status: DistributionLinkStatus;
  config: Record<string, unknown> | null;
  has_config: boolean;
  last_verified_at: string | null;
  last_verify_detail: string | null;
  last_verify_ok: boolean;
  last_config_written_at: string | null;
  updated_at: string;
}

export interface DistributionVerifyResult {
  ok: boolean;
  detail: string;
  latency_ms?: number;
  error?: string;
}

export interface DistributionWriteConfigResult {
  ok: boolean;
  filesWritten?: string[];
  notes?: string[];
  error?: string;
}

export async function listDistributionAdapters(): Promise<{ adapters: DistributionAdapterEntry[] }> {
  const r = await fetch(`${BASE_URL}/distribution/adapters`, { credentials: "include" });
  if (!r.ok) throw new Error(`distribution adapters ${r.status}`);
  return r.json();
}

export async function listDistributionLinks(): Promise<{ links: DistributionLink[] }> {
  const r = await fetch(`${BASE_URL}/distribution/links`, { credentials: "include" });
  if (!r.ok) throw new Error(`distribution links ${r.status}`);
  return r.json();
}

export async function upsertDistributionLink(
  adapterId: string,
  config: Record<string, unknown>,
  project?: string | null,
): Promise<{ ok: boolean; link: DistributionLink }> {
  const r = await fetch(`${BASE_URL}/distribution/links/${encodeURIComponent(adapterId)}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, project: project ?? null }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error(err.error ?? `distribution link upsert ${r.status}`);
  }
  return r.json();
}

export async function verifyDistributionLink(adapterId: string): Promise<DistributionVerifyResult> {
  const r = await fetch(`${BASE_URL}/distribution/links/${encodeURIComponent(adapterId)}/verify`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) {
    return { ok: false, detail: `HTTP ${r.status}`, error: await r.text().catch(() => "") };
  }
  return r.json();
}

export async function writeDistributionConfig(adapterId: string, project?: string): Promise<DistributionWriteConfigResult> {
  const r = await fetch(`${BASE_URL}/distribution/links/${encodeURIComponent(adapterId)}/write-config`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(project ? { project } : {}),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `${r.status}` }));
    return { ok: false, error: err.error ?? `HTTP ${r.status}` };
  }
  return r.json();
}

export async function deleteDistributionLink(adapterId: string): Promise<{ ok: boolean; removed: boolean }> {
  const r = await fetch(`${BASE_URL}/distribution/links/${encodeURIComponent(adapterId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`distribution link delete ${r.status}`);
  return r.json();
}
