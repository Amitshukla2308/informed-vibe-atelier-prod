/**
 * Settings + activity HTTP endpoints — wired into routes/http.ts.
 *
 * Routes:
 *   GET  /settings/agents              — { configs: [4 rows], links: [...], known_providers: [...] }
 *   POST /settings/agents/:agent_name  — { mode, provider } updates one row
 *   POST /settings/providers/:provider — { bin_path?, base_url?, model_id?, api_key_env?, status? }
 *   GET  /activity/recent              — last N implementer runs + recent errors
 *   GET  /activity/etl-status          — OG ETL daemon liveness + last cycle
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_NAMES, AGENT_MODES, KNOWN_PROVIDERS,
  type AgentName, type AgentMode,
  getAgentConfigs, setAgentConfig, getProviderLinks, upsertProviderLink,
} from "./agents";
import { getDb } from "~/db";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* -------------------------------------------------------------------------- */
/* /settings/agents                                                            */
/* -------------------------------------------------------------------------- */

export function handleGetAgentSettings(userId: string): Response {
  const configs = getAgentConfigs(userId);
  const links = getProviderLinks(userId);

  // Auto-detect: for CLI providers, if a known binary is on PATH or matches
  // env-var, mark `linked` even if no DB row exists yet. This is a one-time
  // visual hint, not a DB write — UI can still ask the user to "Confirm link".
  const detectable = inferProviderAvailability();

  return json({
    configs,
    links,
    known_providers: KNOWN_PROVIDERS,
    detected: detectable,
    agent_modes: AGENT_MODES,
    agent_names: AGENT_NAMES,
  });
}

export async function handleSetAgentSettings(userId: string, agent: string, body: unknown): Promise<Response> {
  if (!AGENT_NAMES.includes(agent as AgentName)) {
    return json({ error: `unknown agent: ${agent}` }, 400);
  }
  const b = (body ?? {}) as { mode?: string; provider?: string };
  const mode = (b.mode ?? "manual") as AgentMode;
  const provider = b.provider ?? "qwen-code";
  if (!AGENT_MODES.includes(mode)) return json({ error: `unknown mode: ${mode}` }, 400);
  const updated = setAgentConfig(userId, agent as AgentName, mode, provider);
  return json({ ok: true, config: updated });
}

/* -------------------------------------------------------------------------- */
/* /settings/providers/:provider/verify                                       */
/* -------------------------------------------------------------------------- */
/* Headless connectivity probe — for CLI providers spawn `<bin> --version`
 * (or equivalent) with a short timeout; for API providers hit the configured
 * base_url's /v1/models or equivalent. Returns {ok, latency_ms, detail, error}.
 *
 * Founder clicks "verify" in Settings → Agents per provider. If a provider's
 * link form is open, the form's draft values are used; otherwise the saved
 * provider_links record. Read-only — does not mutate config.
 */

interface VerifyResult {
  ok: boolean;
  latency_ms: number;
  detail: string;
  error?: string;
}

export async function handleVerifyProvider(provider: string, body: unknown): Promise<Response> {
  const overrides = (body ?? {}) as { bin_path?: string; base_url?: string; api_key_env?: string };
  const t0 = Date.now();
  try {
    const result = await runVerifyProbe(provider, overrides);
    return json({ ...result, latency_ms: Date.now() - t0 });
  } catch (e) {
    return json({
      ok: false,
      latency_ms: Date.now() - t0,
      detail: "verify crashed",
      error: String(e).slice(0, 300),
    });
  }
}

async function runVerifyProbe(provider: string, overrides: { bin_path?: string; base_url?: string; api_key_env?: string }): Promise<VerifyResult> {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

  // CLI providers — spawn the binary with a quick flag
  if (provider === "claude" || provider === "gemini" || provider === "qwen-code") {
    const fallbackBin: Record<string, string> = {
      claude:      process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`,
      gemini:      process.env.GEMINI_BIN ?? "gemini",
      "qwen-code": process.env.QWEN_BIN   ?? "qwen",
    };
    const bin = overrides.bin_path || fallbackBin[provider];
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 8000 });
    if (r.error) return { ok: false, latency_ms: 0, detail: `binary not runnable`, error: String(r.error).slice(0, 200) };
    if (r.status !== 0) return { ok: false, latency_ms: 0, detail: `--version exit ${r.status}`, error: (r.stderr || "").slice(0, 200) };
    const version = (r.stdout || "").trim().split("\n")[0].slice(0, 120);
    return { ok: true, latency_ms: 0, detail: `${provider} ${version} at ${bin}` };
  }

  // API providers — HTTP probe with API key from env if needed
  const baseUrl = overrides.base_url || providerDefaultBase(provider);
  if (!baseUrl) return { ok: false, latency_ms: 0, detail: "no base_url configured" };

  const probeUrl = baseUrl.replace(/\/$/, "") + "/v1/models";
  const apiKeyEnv = overrides.api_key_env;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (provider === "anthropic-api" && apiKey) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(probeUrl, { method: "GET", headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, latency_ms: 0, detail: `${probeUrl} → HTTP ${r.status}`, error: text.slice(0, 200) };
    }
    let modelCount = 0;
    try {
      const data = await r.json() as { data?: unknown[]; models?: unknown[] };
      modelCount = (data.data?.length ?? data.models?.length ?? 0);
    } catch { /* ignore parse errors */ }
    return {
      ok: true,
      latency_ms: 0,
      detail: `${probeUrl} → HTTP 200${modelCount ? ` · ${modelCount} models` : ""}${apiKey ? "" : " (no key sent)"}`,
    };
  } catch (e) {
    return { ok: false, latency_ms: 0, detail: `${probeUrl} unreachable`, error: String(e).slice(0, 200) };
  }
}

function providerDefaultBase(provider: string): string | null {
  switch (provider) {
    case "openai-api":     return "https://api.openai.com";
    case "anthropic-api":  return "https://api.anthropic.com";
    case "lm-studio":      return process.env.QWEN_BASE_URL ?? "http://localhost:1234";
    default:               return null;
  }
}

export async function handleSetProviderLink(userId: string, provider: string, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields: Parameters<typeof upsertProviderLink>[2] = {};
  if (typeof b.bin_path === "string") fields.bin_path = b.bin_path;
  if (typeof b.base_url === "string") fields.base_url = b.base_url;
  if (typeof b.model_id === "string") fields.model_id = b.model_id;
  if (typeof b.api_key_env === "string") fields.api_key_env = b.api_key_env;
  if (typeof b.notes === "string") fields.notes = b.notes;
  if (typeof b.status === "string" && (b.status === "linked" || b.status === "unlinked" || b.status === "expired")) {
    fields.status = b.status;
  }
  const updated = upsertProviderLink(userId, provider, fields);
  return json({ ok: true, link: updated });
}

interface DetectedAvailability {
  provider: string;
  available: boolean;
  detected_at?: string;
  hint: string;
}

function inferProviderAvailability(): DetectedAvailability[] {
  const out: DetectedAvailability[] = [];
  const checks: Array<{ id: string; envBin?: string; default?: string; envBaseUrl?: string }> = [
    { id: "claude",       envBin: "CLAUDE_BIN",       default: `${process.env.HOME}/.local/bin/claude` },
    { id: "gemini",       envBin: "GEMINI_BIN",       default: "gemini" },
    { id: "qwen-code",    envBin: "QWEN_BIN",         default: "qwen" },
    { id: "lm-studio",    envBaseUrl: "QWEN_BASE_URL" },
    { id: "openai-api",   envBaseUrl: "OPENAI_API_KEY" }, // existence of env var
    { id: "anthropic-api",envBaseUrl: "ANTHROPIC_API_KEY" },
  ];
  for (const c of checks) {
    if (c.envBin) {
      const path = process.env[c.envBin] ?? c.default;
      const ok = path ? existsBinary(path) : false;
      out.push({
        provider: c.id,
        available: ok,
        hint: ok ? `binary present at ${path}` : `set env ${c.envBin} or install`,
      });
    } else if (c.envBaseUrl) {
      const v = process.env[c.envBaseUrl];
      out.push({
        provider: c.id,
        available: !!v,
        hint: v ? `env ${c.envBaseUrl} set` : `set env ${c.envBaseUrl}`,
      });
    }
  }
  return out;
}

function existsBinary(path: string): boolean {
  if (path.includes("/")) {
    return existsSync(path);
  }
  // PATH-relative — try `which` via env PATH walk.
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    if (existsSync(resolve(dir, path))) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* /activity/recent                                                            */
/* -------------------------------------------------------------------------- */

interface UnifiedActivityRow {
  agent: "drafter" | "allocator" | "implementer" | "senior_reviewer" | "reflect" | "system";
  timestamp: string;
  project: string | null;
  ref_id: string | null;       // node id, session id, or null
  summary: string;
  status: "ok" | "blocked" | "info";
  details?: Record<string, unknown>;
}

export function handleRecentActivity(userId: string, limitParam: string | null): Response {
  const limit = Math.min(50, Math.max(1, Number(limitParam) || 20));
  const db = getDb();

  const rows: UnifiedActivityRow[] = [];

  // Implementer + Allocator: from per-node execution.jsonl files (one row
  // per implementer run, plus a separate row per senior_review event).
  for (const r of readRecentImplementerRuns(200)) {
    const ok = r.qwen_exit_code === 0 && r.tsc_ok;
    rows.push({
      agent: r.allocation_verdict === "qwen" ? "implementer" : "allocator",
      timestamp: r.timestamp,
      project: r.project,
      ref_id: r.node_id,
      summary: r.allocation_verdict === "qwen"
        ? `${r.diff_bytes.toLocaleString()}B diff, ${r.files_touched.length} files on ${r.branch}`
        : `hand_back: ${r.allocation_verdict}`,
      status: ok ? "ok" : "blocked",
      details: { branch: r.branch, files: r.files_touched, exit: r.qwen_exit_code, tsc: r.tsc_ok },
    });
  }
  for (const r of readRecentSeniorReviews(50)) rows.push(r);

  // Drafter activity = recent canvas node mutations (proposeNode / updateNodeMeta
  // / updateNodePlan all touch updated_at). Walk projects/<P>/canvas/nodes/.
  for (const r of readRecentDrafterMutations(50)) rows.push(r);

  // Reflect activity = projects/<P>/sessions/*.md files — one row per
  // reflection artifact (file mtime is the run time).
  for (const r of readRecentReflectArtifacts(50)) rows.push(r);

  // App errors — PHASE_A_BLOCKERS.md plus tail of /tmp/atelier-backend.log.
  const errors = [
    ...readRecentBlockers(5),
    ...readRecentBackendLogErrors(5),
  ];

  // Audit log (auth events, settings changes — already written by /auth and
  // /settings endpoints).
  const audits = db.query(
    `SELECT id, action, target_type, target_id, details_json, created_at
       FROM audit_log
      WHERE user_id = ? OR user_id IS NULL
      ORDER BY created_at DESC
      LIMIT ?`,
  ).all(userId, limit) as Array<{ id: string; action: string; target_type: string; target_id: string; details_json: string; created_at: string }>;
  for (const a of audits) {
    rows.push({
      agent: "system",
      timestamp: a.created_at,
      project: null,
      ref_id: a.target_id,
      summary: `${a.action} · ${a.target_type}`,
      status: "info",
    });
  }

  // Sort + clip.
  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const clipped = rows.slice(0, limit);

  // Legacy fields (`runs`, `audits`) preserved for any older caller; new
  // callers consume `activity` for the unified per-agent feed.
  return json({
    activity: clipped,
    runs: clipped.filter((r) => r.agent === "implementer" || r.agent === "allocator"),
    audits,
    errors,
  });
}

interface RecentRun {
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

function readRecentImplementerRuns(limit: number): RecentRun[] {
  const projectsRoot = resolve(import.meta.dir, "..", "..", "..", "projects");
  const entries: RecentRun[] = [];
  if (!existsSync(projectsRoot)) return entries;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const projectDir of readdirSync(projectsRoot)) {
    const nodesDir = resolve(projectsRoot, projectDir, "canvas", "nodes");
    if (!existsSync(nodesDir)) continue;
    for (const nodeId of readdirSync(nodesDir)) {
      const exec = resolve(nodesDir, nodeId, "execution.jsonl");
      if (!existsSync(exec)) continue;
      const lines = readFileSync(exec, "utf-8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (!e?.timestamp) continue;
          entries.push({
            project: projectDir,
            node_id: nodeId,
            timestamp: e.timestamp,
            branch: e.branch ?? "",
            diff_bytes: e.diff_bytes ?? 0,
            tsc_ok: !!e.tsc_ok,
            qwen_exit_code: e.qwen_exit_code ?? 0,
            files_touched: e.files_touched ?? [],
            allocation_verdict: e.allocation?.verdict ?? "unknown",
          });
        } catch {
          /* skip malformed line */
        }
      }
    }
  }
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return entries.slice(0, limit);
}

interface BlockerEntry {
  timestamp: string;
  reason: string;
  block: string;
}

function readRecentSeniorReviews(limit: number): UnifiedActivityRow[] {
  const projectsRoot = resolve(import.meta.dir, "..", "..", "..", "projects");
  const out: UnifiedActivityRow[] = [];
  if (!existsSync(projectsRoot)) return out;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const projectDir of readdirSync(projectsRoot)) {
    const nodesDir = resolve(projectsRoot, projectDir, "canvas", "nodes");
    if (!existsSync(nodesDir)) continue;
    for (const nodeId of readdirSync(nodesDir)) {
      const exec = resolve(nodesDir, nodeId, "execution.jsonl");
      if (!existsSync(exec)) continue;
      for (const line of readFileSync(exec, "utf-8").split(/\r?\n/).filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e?.event === "senior_review") {
            out.push({
              agent: "senior_reviewer",
              timestamp: e.timestamp,
              project: projectDir,
              ref_id: nodeId,
              summary: `review via ${e.provider} · exit ${e.exit_code} · ${(e.elapsed_s ?? 0).toFixed?.(1) ?? e.elapsed_s}s`,
              status: e.exit_code === 0 ? "ok" : "blocked",
            });
          }
        } catch { /* skip */ }
      }
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out.slice(0, limit);
}

function readRecentDrafterMutations(limit: number): UnifiedActivityRow[] {
  const projectsRoot = resolve(import.meta.dir, "..", "..", "..", "projects");
  const out: UnifiedActivityRow[] = [];
  if (!existsSync(projectsRoot)) return out;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const projectDir of readdirSync(projectsRoot)) {
    const nodesDir = resolve(projectsRoot, projectDir, "canvas", "nodes");
    if (!existsSync(nodesDir)) continue;
    for (const nodeId of readdirSync(nodesDir)) {
      const meta = resolve(nodesDir, nodeId, "meta.json");
      if (!existsSync(meta)) continue;
      try {
        const m = JSON.parse(readFileSync(meta, "utf-8"));
        const ts = (m.updated_at as string) ?? (m.created_at as string);
        if (!ts) continue;
        // Only count nodes the agent proposed/updated (skip founder-authored).
        const proposedBy = (m.proposed_by as string) ?? "";
        if (proposedBy !== "drafter" && proposedBy !== "reflection-worker") continue;
        out.push({
          agent: "drafter",
          timestamp: ts,
          project: projectDir,
          ref_id: nodeId,
          summary: `${m.kind ?? "Node"} · "${(m.title ?? "(untitled)").toString().slice(0, 32)}" · ${m.state}`,
          status: m.state === "blocked" ? "blocked" : "ok",
        });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out.slice(0, limit);
}

function readRecentReflectArtifacts(limit: number): UnifiedActivityRow[] {
  const projectsRoot = resolve(import.meta.dir, "..", "..", "..", "projects");
  const out: UnifiedActivityRow[] = [];
  if (!existsSync(projectsRoot)) return out;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const projectDir of readdirSync(projectsRoot)) {
    const sessionsDir = resolve(projectsRoot, projectDir, "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const s = statSync(resolve(sessionsDir, f));
        out.push({
          agent: "reflect",
          timestamp: new Date(s.mtimeMs).toISOString(),
          project: projectDir,
          ref_id: f.replace(/\.md$/, ""),
          summary: `six-lens crystallization · ${(s.size / 1024).toFixed(1)} KB`,
          status: "ok",
        });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out.slice(0, limit);
}

function readRecentBackendLogErrors(limit: number): BlockerEntry[] {
  // Tail /tmp/atelier-backend.log for recent error lines. The atelier-restart
  // script is the canonical pidfile + log path; if the user runs the backend
  // a different way, this just returns nothing.
  const log = "/tmp/atelier-backend.log";
  if (!existsSync(log)) return [];
  const out: BlockerEntry[] = [];
  try {
    const lines = readFileSync(log, "utf-8").split(/\r?\n/).slice(-2000);
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (/(\[error\]|bridge init failed|ENOENT|TypeError|ReferenceError|Uncaught)/.test(ln)) {
        out.push({ timestamp: new Date().toISOString(), reason: ln.slice(0, 240), block: ln.slice(0, 800) });
        if (out.length >= limit) break;
      }
    }
  } catch { /* ignore */ }
  return out;
}

function readRecentBlockers(limit: number): BlockerEntry[] {
  const p = resolve(import.meta.dir, "..", "..", "PHASE_A_BLOCKERS.md");
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf-8");
  const out: BlockerEntry[] = [];
  // Match blocks: "## <iso-ts> — <reason>\n... up to next ##"
  const re = /^## (\d{4}-\d{2}-\d{2}T[\d:.Z-]+)\s+—\s+(.+)\n([\s\S]*?)(?=^## |\Z)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ timestamp: m[1], reason: m[2].trim(), block: m[3].trim().slice(0, 600) });
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* /activity/etl-status                                                        */
/* -------------------------------------------------------------------------- */

interface ProviderSourceInfo {
  provider: string;
  sourceDir: string;
  pattern: string;
  exists: boolean;
  sourceCount: number;
  doneCount: number;
  pendingCount: number;
  lastSessionAt: string | null;
}

const ATELIER_ROOT_FOR_ETL = resolve(import.meta.dir, "..", "..", "..");
const OMNIGRAPH_ROOT = resolve(ATELIER_ROOT_FOR_ETL, "..", "omnigraph");
const AI_CONV_DIR = resolve(ATELIER_ROOT_FOR_ETL, "..", "ai_conversations");

// Mirror of omnigraph/scripts/etl_daemon.py PROVIDER_SOURCES — kept in sync
// with that file. Surfaces in the Home UI so the founder sees exactly which
// folders the daemon polls.
const PROVIDER_SOURCES: Array<{ provider: string; subPath: string; pattern: string }> = [
  { provider: "claude_desktop", subPath: "Anthropic_ClaudeDesktop/data",       pattern: "* (dirs)" },
  { provider: "claude_code",    subPath: "Anthropic_ClaudeCode/conversations", pattern: "*.jsonl" },
  { provider: "gemini_cli",     subPath: "Google_GeminiCLI/conversations",     pattern: "*.json" },
  { provider: "cline",          subPath: "Cline/conversations",                pattern: "*.json" },
  { provider: "antigravity",    subPath: "Google_Antigravity/brain",           pattern: "* (dirs)" },
];

function probeProvider(p: typeof PROVIDER_SOURCES[number]): ProviderSourceInfo {
  const sourceDir = resolve(AI_CONV_DIR, p.subPath);
  const exists = existsSync(sourceDir);
  let sourceCount = 0;
  let lastSessionAt: string | null = null;
  if (exists) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      let mostRecent = 0;
      for (const e of entries) {
        const isDir = e.isDirectory();
        if (p.pattern.startsWith("*.jsonl") && (!e.name.endsWith(".jsonl") || isDir)) continue;
        if (p.pattern.startsWith("*.json") && p.pattern !== "*.jsonl" && (!e.name.endsWith(".json") || isDir)) continue;
        if (p.pattern.includes("dirs)") && !isDir) continue;
        sourceCount++;
        try {
          const s = statSync(resolve(sourceDir, e.name));
          if (s.mtimeMs > mostRecent) mostRecent = s.mtimeMs;
        } catch { /* skip */ }
      }
      if (mostRecent > 0) lastSessionAt = new Date(mostRecent).toISOString();
    } catch { /* dir gone */ }
  }

  // doneCount = entries in pilot/full/<provider>/*.json (extracted)
  const outDir = resolve(OMNIGRAPH_ROOT, "pilot", "full", p.provider);
  let doneCount = 0;
  if (existsSync(outDir)) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      doneCount = readdirSync(outDir).filter((f) => f.endsWith(".json")).length;
    } catch { /* ignore */ }
  }
  const pendingCount = Math.max(0, sourceCount - doneCount);
  return { provider: p.provider, sourceDir, pattern: p.pattern, exists, sourceCount, doneCount, pendingCount, lastSessionAt };
}

export function handleEtlStatus(): Response {
  const pidFile = resolve(OMNIGRAPH_ROOT, "pilot", "full", "_logs", "etl_daemon.pid");
  const logFile = resolve(OMNIGRAPH_ROOT, "pilot", "full", "_logs", "etl_daemon.log");
  const lockFile = resolve(process.env.HOME ?? "/", ".omnigraph", "gpu.lock");

  let pid: number | null = null;
  let alive = false;
  if (existsSync(pidFile)) {
    pid = Number(readFileSync(pidFile, "utf-8").trim()) || null;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
  }

  let lastCycle: string | null = null;
  if (existsSync(logFile)) {
    const tail = readFileSync(logFile, "utf-8").trim().split("\n").slice(-20);
    const cycleLine = [...tail].reverse().find((l) => /cycle done/.test(l));
    if (cycleLine) lastCycle = cycleLine;
  }

  let gpuLock: unknown = null;
  if (existsSync(lockFile)) {
    try { gpuLock = JSON.parse(readFileSync(lockFile, "utf-8")); } catch { gpuLock = null; }
  }

  let logSize = 0;
  if (existsSync(logFile)) {
    try { logSize = statSync(logFile).size; } catch { /* ignore */ }
  }

  const providers = PROVIDER_SOURCES.map(probeProvider);

  return json({
    daemon: { pid, alive, last_cycle: lastCycle, log_size_bytes: logSize },
    gpu_lock: gpuLock,
    omnigraph_root: OMNIGRAPH_ROOT,
    omnigraph_present: existsSync(OMNIGRAPH_ROOT),
    ai_conv_root: AI_CONV_DIR,
    ai_conv_present: existsSync(AI_CONV_DIR),
    providers,
  });
}

/* -------------------------------------------------------------------------- */
/* /activity/og-stats                                                          */
/* -------------------------------------------------------------------------- */

interface OgArtifactStat {
  name: string;
  count: number;
  size_bytes: number;
  newest_at: string | null;
}

export function handleOgStats(): Response {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  // Two roots to look at: legacy data/users/<uid>/brain/personal/compiled
  // (today's actual write target), and og_artifacts/ (forthcoming plan-step-1
  // location). We surface both so the founder sees what's live.
  const userRoot = resolve(ATELIER_ROOT_FOR_ETL, "data", "users");
  const ogRoot = process.env.OG_ARTIFACTS_DIR
    ? resolve(process.env.OG_ARTIFACTS_DIR)
    : resolve(ATELIER_ROOT_FOR_ETL, "og_artifacts");

  function statBucket(dir: string, predicate: (f: string) => boolean): OgArtifactStat {
    if (!existsSync(dir)) return { name: dir, count: 0, size_bytes: 0, newest_at: null };
    let count = 0, size = 0, newest = 0;
    const walk = (d: string) => {
      try {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const abs = resolve(d, e.name);
          if (e.isDirectory()) walk(abs);
          else if (predicate(e.name)) {
            try {
              const s = statSync(abs);
              count++; size += s.size;
              if (s.mtimeMs > newest) newest = s.mtimeMs;
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    };
    walk(dir);
    return { name: dir, count, size_bytes: size, newest_at: newest > 0 ? new Date(newest).toISOString() : null };
  }

  // Brain layers — count the compiled XML files across all user dirs.
  const brain = statBucket(userRoot, (f) => f.endsWith(".xml") && (f.startsWith("light_ir.") || f === "brain.xml" || f === "personal.xml" || f === "global.xml" || f === "project.xml"));
  // Vault entities — entities/*.md per user
  const vault = statBucket(userRoot, (f) => f.endsWith(".md"));
  // Ledger — og_artifacts/ledger/*.jsonl
  const ledger = statBucket(resolve(ogRoot, "ledger"), (f) => f.endsWith(".jsonl"));
  // Compiled agent principles XMLs — og_artifacts/agents/*.compiled.xml
  const agents = statBucket(resolve(ogRoot, "agents"), (f) => f.endsWith(".compiled.xml"));
  // Pilot full — total per-session JSONs across all providers
  const pilotFull = statBucket(resolve(OMNIGRAPH_ROOT, "pilot", "full"), (f) => f.endsWith(".json") && !f.startsWith("_"));

  // Last session run — max mtime across pilot/full/<provider>/*.json
  let lastSessionRunAt: string | null = pilotFull.newest_at;

  return json({
    og_artifacts_root: ogRoot,
    og_artifacts_present: existsSync(ogRoot),
    user_brain_root: userRoot,
    brain,
    vault,
    ledger,
    agents,
    pilot_full: pilotFull,
    last_session_run_at: lastSessionRunAt,
  });
}
