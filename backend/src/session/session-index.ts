/**
 * Session index — builds a unified view of all sessions for a project, blending
 *   data/sessions/<id>/raw.log                    (PTY transcript)
 *   projects/<name>/sessions/<ts>.md             (reflection artifacts)
 *
 * Used by Reflect view (chronological list, unreflected detection) and by the
 * reflection-worker (scans for sessions past the auto/semi-auto threshold).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { readSessionConversation } from "~/agent/providers";
import type { AgentProviderId } from "~/agent/providers";

export interface SessionEntry {
  sessionId: string;
  /** ISO start time — from JSONL first turn, or raw.log first [in] line, or fs ctime */
  startedAt: string;
  /** ISO end time — from JSONL last turn, or raw.log last line */
  endedAt: string;
  /** Total bytes in raw.log (kept for nostalgia + sorting heuristics) */
  rawBytes: number;
  /** User-submitted turn count (Enter-pressed messages) — read from provider JSONL */
  turnCount: number;
  /** True when a matching reflection artifact exists on disk */
  reflected: boolean;
  /** Path to reflection artifact if reflected */
  artifactPath?: string;
  /** Flavor line from artifact (one-sentence pickup) */
  flavor?: string;
  /** Approximate token count — sum of provider-reported usage, else rawBytes/4 */
  approxTokens?: number;
  /** First user message text (clipped to 140 chars) — gives a preview of what happened */
  firstUserLine?: string;
  /** Provider that wrote the structured conversation (claude | openai | gemini | ollama). */
  provider?: AgentProviderId;
  /** True if the provider's structured JSONL is present on disk. */
  hasStructuredLog?: boolean;
}

interface SessionMeta {
  sessionId: string;
  provider: AgentProviderId;
  projectName: string;
  projectCwd: string;
  bootMode?: string;
  startedAt: string;
  source: "atelier";
}

function readSessionMeta(sessionId: string): SessionMeta | null {
  const p = resolve(config.dataDir, "sessions", sessionId, "meta.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SessionMeta;
  } catch {
    return null;
  }
}

function parseLogHeadTail(rawPath: string): { startedAt: string; endedAt: string; turnCount: number; firstUserLine: string } {
  let startedAt = "";
  let endedAt = "";
  // xterm.js sends each keystroke as its own {type:"raw", data:"x"} message,
  // so each [in] line is ONE char. We reconstruct turns by concatenating the
  // per-char inputs until we hit the submit character (\r or \n), then that
  // buffer is ONE turn. Paste operations arrive as multi-char [in] lines — we
  // treat those as their own turn too (pastes usually end with \r anyway).
  let turnCount = 0;
  let firstUserLine = "";
  let buffer = "";
  try {
    const raw = readFileSync(rawPath, "utf-8");
    const lines = raw.split(/\n/);
    for (const line of lines) {
      // Use [\s\S]* not .* — JS regex's `.` does not match \r, and xterm writes
// bare \r into the log when the founder presses Enter. With .* we missed every
// Enter press, which broke turn counting (every real session looked empty).
const m = line.match(/^\[(in|out)\]\s(\S+)\s([\s\S]*)$/);
      if (!m) continue;
      if (!startedAt) startedAt = m[2];
      endedAt = m[2];
      if (m[1] !== "in") continue;
      // Strip any ANSI escape sequences that slipped into the log before the
      // write-side filter was in place. Real user input is plain chars + \r/\n.
      const chunk = stripAnsi(m[3]);
      if (!chunk) continue;
      // Skip single control keypresses (ctrl-c, arrow keys) — not typed text.
      if (chunk.length === 1 && chunk.charCodeAt(0) < 0x20 && chunk !== "\r" && chunk !== "\n" && chunk !== "\t") continue;
      buffer += chunk;
      // Enter = turn boundary. Record and reset.
      if (chunk.includes("\r") || chunk.includes("\n")) {
        const text = buffer.replace(/[\r\n\x00-\x1F\x7F]+/g, "").trim();
        if (text) {
          turnCount++;
          if (!firstUserLine) firstUserLine = text.slice(0, 140);
        }
        buffer = "";
      }
    }
    // Unclosed buffer (user typed but never pressed Enter) — don't count as a turn,
    // but still surface the partial as firstUserLine if we have nothing else.
    if (!firstUserLine && buffer.trim()) {
      const t = buffer.replace(/[\r\n\x00-\x1F\x7F]+/g, "").trim();
      if (t.length >= 3) firstUserLine = t.slice(0, 140);
    }
  } catch { /* unreadable log */ }
  return { startedAt, endedAt, turnCount, firstUserLine };
}

const ANSI_RE = /\x1B(?:\[[0-9:;<=>?]*[ -/]*[@-~]|[@-_]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|.)/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Parse ISO-like timestamp from artifact filename `2026-04-21T05-34-40-817Z.md` */
function msFromArtifactName(filename: string): number | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/);
  if (!m) return null;
  const iso = `${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`;
  const t = Date.parse(iso);
  return isFinite(t) ? t : null;
}

function extractFlavor(content: string): string | undefined {
  // Preferred: `## Flavor\n<line>`
  const h2 = content.match(/^##\s+Flavor\s*\n+(.+?)$/m);
  if (h2 && h2[1].trim()) return h2[1].trim();
  // Fallback: inline "flavor:" style
  const inline = content.match(/(?:^|\n)[^\S\n]*flavor[:\s]+["'`]?([^"'\n`]{5,200})/i);
  return inline?.[1]?.trim();
}

// Legacy single-session lookup — kept for `getSessionEntry` callers that ask
// about one id. The main list view uses the greedy claim-based pass above.
function findArtifactForSession(project: string, sessionId: string, sessionEndedAtMs?: number): { path: string; flavor?: string } | null {
  const sessionsDir = resolve(config.projectsDir, project, "sessions");
  if (!existsSync(sessionsDir)) return null;
  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".md"));

  // Pass 1 — exact match on the machine-readable session-id comment we now stamp
  // in every new artifact.
  for (const f of files) {
    const p = resolve(sessionsDir, f);
    try {
      const content = readFileSync(p, "utf-8");
      if (content.includes(`atelier:session-id: ${sessionId}`)) {
        return { path: p, flavor: extractFlavor(content) };
      }
    } catch { /* next */ }
  }

  // Pass 2 — legacy artifacts without the comment. Match by timestamp proximity:
  // artifact filename timestamp should land within 10 minutes AFTER the session's
  // last PTY line (reflection writes happen shortly after session close).
  if (sessionEndedAtMs) {
    const WINDOW_MS = 10 * 60 * 1000;
    let best: { path: string; delta: number; content: string } | null = null;
    for (const f of files) {
      const artifactMs = msFromArtifactName(f);
      if (!artifactMs) continue;
      const delta = artifactMs - sessionEndedAtMs;
      if (delta < 0 || delta > WINDOW_MS) continue;
      if (!best || delta < best.delta) {
        try {
          const content = readFileSync(resolve(sessionsDir, f), "utf-8");
          best = { path: resolve(sessionsDir, f), delta, content };
        } catch { /* next */ }
      }
    }
    if (best) return { path: best.path, flavor: extractFlavor(best.content) };
  }

  return null;
}

/**
 * Load and pre-index every reflection artifact on disk, extracting session-id
 * (if stamped) and filename timestamp. Used by listProjectSessions to do a
 * single-pass matching — each artifact is "claimed" by at most ONE session,
 * which prevents the same reflection showing up as the flavor for N sessions.
 */
interface ArtifactIndex {
  path: string;
  filename: string;
  timestampMs: number | null;
  embeddedSessionId: string | null;
  flavor?: string;
  claimedBy?: string;
}

function loadArtifactIndex(project: string): ArtifactIndex[] {
  const sessionsDir = resolve(config.projectsDir, project, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".md"));
  return files.map(f => {
    const path = resolve(sessionsDir, f);
    let embeddedSessionId: string | null = null;
    let flavor: string | undefined;
    try {
      const content = readFileSync(path, "utf-8");
      const idMatch = content.match(/atelier:session-id:\s*(\S+)/);
      if (idMatch) embeddedSessionId = idMatch[1];
      flavor = extractFlavor(content);
    } catch { /* next */ }
    return {
      path,
      filename: f,
      timestampMs: msFromArtifactName(f),
      embeddedSessionId,
      flavor,
    };
  });
}

export async function listProjectSessions(project: string): Promise<SessionEntry[]> {
  const sessionsRoot = resolve(config.dataDir, "sessions");
  if (!existsSync(sessionsRoot)) return [];

  const artifactIndex = loadArtifactIndex(project);
  const projectCwd = resolve(config.projectsDir, project);

  // First pass — for each Atelier session dir, prefer structured JSONL from the
  // provider (Claude Code); fall back to raw.log parsing only when JSONL is
  // missing (legacy sessions predating this fix, or provider not available).
  const rawEntries: Array<{
    sessionId: string;
    startedAt: string;
    endedAtIso: string;
    endedAtMs: number;
    rawBytes: number;
    turnCount: number;
    firstUserLine?: string;
    provider?: AgentProviderId;
    hasStructuredLog?: boolean;
    approxTokens?: number;
  }> = [];

  for (const sessionId of readdirSync(sessionsRoot)) {
    const dir = resolve(sessionsRoot, sessionId);
    let stats;
    try { stats = statSync(dir); } catch { continue; }
    if (!stats.isDirectory()) continue;

    const rawPath = resolve(dir, "raw.log");
    const rawBytes = existsSync(rawPath) ? statSync(rawPath).size : 0;

    const meta = readSessionMeta(sessionId);
    // Trust meta.json's recorded cwd; for legacy sessions w/o meta, use current
    // project's cwd as a best-effort assumption.
    const cwd = meta?.projectCwd ?? projectCwd;
    const providerId: AgentProviderId = meta?.provider ?? "claude";

    // Try provider-structured read first
    const conv = await readSessionConversation(sessionId, cwd, providerId);

    if (conv) {
      const totalTokens = conv.turns.reduce(
        (sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0),
        0,
      );
      rawEntries.push({
        sessionId,
        startedAt: conv.startedAt || meta?.startedAt || stats.ctime.toISOString(),
        endedAtIso: conv.endedAt || stats.mtime.toISOString(),
        endedAtMs: conv.endedAt ? Date.parse(conv.endedAt) : stats.mtime.getTime(),
        rawBytes,
        turnCount: conv.userTurnCount,
        firstUserLine: conv.firstUserLine,
        provider: providerId,
        hasStructuredLog: true,
        approxTokens: totalTokens > 0 ? totalTokens : Math.round(rawBytes / 4),
      });
      continue;
    }

    // Legacy fallback — no structured log available. Use raw.log heuristics.
    if (!existsSync(rawPath)) continue;
    const { startedAt, endedAt, turnCount, firstUserLine } = parseLogHeadTail(rawPath);
    rawEntries.push({
      sessionId,
      startedAt: startedAt || meta?.startedAt || stats.ctime.toISOString(),
      endedAtIso: endedAt || stats.mtime.toISOString(),
      endedAtMs: endedAt ? Date.parse(endedAt) : stats.mtime.getTime(),
      rawBytes,
      turnCount,
      firstUserLine: firstUserLine || undefined,
      provider: providerId,
      hasStructuredLog: false,
      approxTokens: Math.round(rawBytes / 4),
    });
  }

  // Pass A — exact match on the session-id comment (every NEW artifact has this).
  for (const art of artifactIndex) {
    if (art.claimedBy || !art.embeddedSessionId) continue;
    const match = rawEntries.find(e => e.sessionId === art.embeddedSessionId);
    if (match) art.claimedBy = match.sessionId;
  }

  // Pass B — timestamp proximity for legacy artifacts without a session-id stamp.
  // Each legacy artifact is claimed by the closest unclaimed session whose log
  // ended within 10 minutes BEFORE the artifact was written. Greedy, smallest-
  // delta first, one session per artifact.
  const claimedSessions = new Set<string>(artifactIndex.filter(a => a.claimedBy).map(a => a.claimedBy!));
  const WINDOW_MS = 10 * 60 * 1000;
  const legacyArtifacts = artifactIndex
    .filter(a => !a.claimedBy && a.timestampMs)
    .sort((a, b) => (b.timestampMs! - a.timestampMs!));
  for (const art of legacyArtifacts) {
    const candidates = rawEntries
      .filter(e => !claimedSessions.has(e.sessionId)
        && e.endedAtMs
        && art.timestampMs! >= e.endedAtMs
        // Only real sessions (≥1 submitted turn) can claim a legacy artifact.
        // Otherwise empty WS-connection sessions absorb reflections they had
        // nothing to do with, producing "0 real, 8 reflected" paradoxes.
        && e.turnCount > 0)
      .map(e => ({ e, delta: art.timestampMs! - e.endedAtMs }))
      .filter(x => x.delta <= WINDOW_MS)
      .sort((a, b) => a.delta - b.delta);
    if (candidates.length === 0) continue;
    art.claimedBy = candidates[0].e.sessionId;
    claimedSessions.add(art.claimedBy);
  }

  // Now compose final session entries with at most one artifact per session.
  const entries: SessionEntry[] = rawEntries.map(e => {
    const art = artifactIndex.find(a => a.claimedBy === e.sessionId);
    return {
      sessionId: e.sessionId,
      startedAt: e.startedAt,
      endedAt: e.endedAtIso,
      rawBytes: e.rawBytes,
      turnCount: e.turnCount,
      reflected: !!art,
      artifactPath: art?.path,
      flavor: art?.flavor,
      approxTokens: e.approxTokens,
      firstUserLine: e.firstUserLine,
      provider: e.provider,
      hasStructuredLog: e.hasStructuredLog,
    };
  });

  entries.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
  return entries;
}

export async function getSessionEntry(project: string, sessionId: string): Promise<SessionEntry | null> {
  const list = await listProjectSessions(project);
  return list.find(e => e.sessionId === sessionId) ?? null;
}

/**
 * Reconstruct user-side turns from a raw.log for legacy sessions that predate
 * Claude Code's structured JSONL on this host. Assistant side can't be rebuilt
 * cleanly from PTY byte streams — caller should flag the result as user-only.
 */
import type { NormalizedTurn } from "~/agent/providers";
export function reconstructUserTurnsFromRawLog(sessionId: string): NormalizedTurn[] {
  const rawPath = resolve(config.dataDir, "sessions", sessionId, "raw.log");
  if (!existsSync(rawPath)) return [];
  const raw = readFileSync(rawPath, "utf-8");
  const lines = raw.split("\n");
  const turns: NormalizedTurn[] = [];
  let buffer = "";
  let turnStartedAt = "";
  for (const line of lines) {
    const m = line.match(/^\[(in|out)\]\s(\S+)\s([\s\S]*)$/);
    if (!m || m[1] !== "in") continue;
    const ts = m[2];
    const chunk = stripAnsi(m[3]);
    if (!chunk) continue;
    // skip single control keypresses
    if (chunk.length === 1 && chunk.charCodeAt(0) < 0x20 && chunk !== "\r" && chunk !== "\n" && chunk !== "\t") continue;
    if (!turnStartedAt) turnStartedAt = ts;
    if (chunk.includes("\r") || chunk.includes("\n")) {
      const text = (buffer + chunk).replace(/[\r\n\x00-\x1F\x7F]+/g, " ").trim();
      if (text.length >= 2) {
        turns.push({
          turnId: `legacy_${sessionId.slice(0, 8)}_${turns.length}`,
          role: "user",
          ts: turnStartedAt,
          blocks: [{ type: "text", text }],
        });
      }
      buffer = "";
      turnStartedAt = "";
    } else {
      buffer += chunk;
    }
  }
  return turns;
}

export function getSessionRawExcerpt(sessionId: string, maxLines = 120): string {
  const rawPath = resolve(config.dataDir, "sessions", sessionId, "raw.log");
  if (!existsSync(rawPath)) return "";
  try {
    const raw = readFileSync(rawPath, "utf-8");
    // Extract just the content of each [in]/[out] line, strip ANSI, drop noise
    const lines = raw.split(/\r?\n/);
    const cleaned: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\[(in|out)\]\s+(\S+)\s(.*)$/);
      if (!m) continue;
      const who = m[1];
      const t = m[2].slice(11, 19); // HH:MM:SS
      const body = stripAnsi(m[3]).trim();
      if (!body) continue;
      // Collapse very long output lines
      const snippet = body.length > 200 ? body.slice(0, 200) + "…" : body;
      cleaned.push(`${t}  ${who === "in" ? "→ " : "  "}${snippet}`);
    }
    if (cleaned.length === 0) return "(raw log contains no readable content — probably a dead WS connection)";
    const head = cleaned.slice(0, 20);
    const tail = cleaned.slice(-Math.max(0, maxLines - 20));
    const snippet = cleaned.length <= maxLines ? cleaned : [...head, "  …  ", ...tail];
    return snippet.join("\n");
  } catch {
    return "";
  }
}

export async function getSessionArtifact(project: string, sessionId: string): Promise<string | null> {
  const entry = (await listProjectSessions(project)).find(e => e.sessionId === sessionId);
  if (!entry?.artifactPath) return null;
  try { return readFileSync(entry.artifactPath, "utf-8"); } catch { return null; }
}

export async function getSessionArtifactPath(project: string, sessionId: string): Promise<string | null> {
  const entry = (await listProjectSessions(project)).find(e => e.sessionId === sessionId);
  return entry?.artifactPath ?? null;
}

