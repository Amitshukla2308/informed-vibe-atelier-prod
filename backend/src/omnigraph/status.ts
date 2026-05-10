/**
 * OmniGraph ETL + constraint-flywheel status, for the Brain v2 surface.
 *
 * Exposes:
 *   - daemon state (PID + alive + last log mtime)
 *   - layer mtimes (global, personal, per-project)
 *   - constraint-flywheel state (compiled audit, pending events, stale flag,
 *     per-role file mtimes)
 *
 * Pure read; never blocks on the daemon.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { getDb } from "~/db";

const OMNIGRAPH_LOGS_DIR = process.env.OMNIGRAPH_LOGS_DIR
  ?? resolve(process.env.HOME ?? "", "informed-vibes/active/omnigraph/pilot/full/_logs");
const ETL_DAEMON_PID = resolve(OMNIGRAPH_LOGS_DIR, "etl_daemon.pid");
const ETL_DAEMON_LOG = resolve(OMNIGRAPH_LOGS_DIR, "etl_daemon.log");

function ogArtifactsDir(): string {
  return process.env.OMNIGRAPH_OUT_DIR ?? resolve(config.atelierRoot, "og_artifacts");
}

function statSafe(p: string): { mtime: string; bytes: number } | null {
  try {
    if (!existsSync(p)) return null;
    const s = statSync(p);
    return { mtime: s.mtime.toISOString(), bytes: s.size };
  } catch { return null; }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface OmnigraphStatus {
  daemon: {
    running: boolean;
    pid: number | null;
    lastRun: string | null;
    logPath: string;
  };
  layerMtimes: {
    global: string | null;
    personal: string | null;
    project: Record<string, string | null>;
  };
  constraints: {
    compiledAt: string | null;
    eventsCompiledTotal: number;
    pendingEvents: number;
    stale: boolean;
    perRole: Record<string, { mtime: string | null; bytes: number }>;
  };
}

export function omnigraphStatus(userId: string = "default"): OmnigraphStatus {
  // Daemon state
  let pid: number | null = null;
  let running = false;
  if (existsSync(ETL_DAEMON_PID)) {
    try {
      const n = Number(readFileSync(ETL_DAEMON_PID, "utf-8").trim());
      if (Number.isFinite(n)) {
        pid = n;
        running = isPidAlive(n);
      }
    } catch { /* leave defaults */ }
  }
  const logStat = statSafe(ETL_DAEMON_LOG);
  const lastRun = logStat?.mtime ?? null;

  // Layer mtimes
  const compiled = resolve(config.dataDir, "users", userId, "brain", "personal", "compiled");
  const globalStat = statSafe(resolve(compiled, "light_ir.global.xml"));
  const personalStat = statSafe(resolve(compiled, "light_ir.personal.xml"));

  // Mirror loader fallback for the user lookup
  let effective = userId;
  if (!globalStat && !personalStat && userId !== "default") {
    const fb = resolve(config.dataDir, "users", "default", "brain", "personal", "compiled");
    const fbG = statSafe(resolve(fb, "light_ir.global.xml"));
    const fbP = statSafe(resolve(fb, "light_ir.personal.xml"));
    if (fbG || fbP) effective = "default";
  }
  const effCompiled = resolve(config.dataDir, "users", effective, "brain", "personal", "compiled");
  const effGlobal = statSafe(resolve(effCompiled, "light_ir.global.xml"));
  const effPersonal = statSafe(resolve(effCompiled, "light_ir.personal.xml"));

  const projectMtimes: Record<string, string | null> = {};
  try {
    if (existsSync(config.projectsDir)) {
      for (const proj of readdirSync(config.projectsDir)) {
        const s = statSafe(resolve(config.projectsDir, proj, "brain.xml"));
        if (s) projectMtimes[proj] = s.mtime;
      }
    }
  } catch { /* nothing */ }

  // Constraint audit
  const constraintsDir = resolve(ogArtifactsDir(), "agent_constraints");
  const auditPath = resolve(constraintsDir, "_audit.json");
  let compiledAt: string | null = null;
  let eventsCompiledTotal = 0;
  if (existsSync(auditPath)) {
    try {
      const a = JSON.parse(readFileSync(auditPath, "utf-8"));
      compiledAt = typeof a.compiled_at === "string" ? a.compiled_at : null;
      eventsCompiledTotal = Number(a.events_total ?? 0);
    } catch { /* leave nulls */ }
  }

  // Per-role compiled-constraint files
  const perRole: Record<string, { mtime: string | null; bytes: number }> = {};
  if (existsSync(constraintsDir)) {
    try {
      for (const f of readdirSync(constraintsDir)) {
        if (!f.endsWith(".md")) continue;
        const role = f.replace(/\.md$/, "");
        const s = statSafe(resolve(constraintsDir, f));
        perRole[role] = { mtime: s?.mtime ?? null, bytes: s?.bytes ?? 0 };
      }
    } catch { /* nothing */ }
  }

  // Pending verifier events + stale check
  let pendingEvents = 0;
  let stale = false;
  try {
    const db = getDb();
    const pendingRow = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM canvas_node_events " +
      "WHERE kind='verifier_unverified' AND COALESCE(json_extract(payload, '$.acknowledged'), 0)=0"
    ).get();
    pendingEvents = Number(pendingRow?.n ?? 0);
    if (compiledAt) {
      const newerRow = db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM canvas_node_events " +
        "WHERE kind='verifier_unverified' " +
        "AND json_extract(payload, '$.acknowledged')=1 " +
        "AND created_at > ?"
      ).get(compiledAt);
      stale = Number(newerRow?.n ?? 0) > 0;
    }
  } catch { /* db unreachable; leave 0/false */ }

  return {
    daemon: { running, pid, lastRun, logPath: ETL_DAEMON_LOG },
    layerMtimes: {
      global: effGlobal?.mtime ?? null,
      personal: effPersonal?.mtime ?? null,
      project: projectMtimes,
    },
    constraints: { compiledAt, eventsCompiledTotal, pendingEvents, stale, perRole },
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

export function readAgentConstraints(role: string): AgentConstraintsView {
  const safeName = role.replace(/[^a-zA-Z0-9_-]/g, "");
  const empty: AgentConstraintsView = { role: safeName, exists: false, markdown: null, mtime: null, audit: null };
  if (!safeName) return empty;
  const constraintsDir = resolve(ogArtifactsDir(), "agent_constraints");
  const filePath = resolve(constraintsDir, `${safeName}.md`);
  const auditPath = resolve(constraintsDir, "_audit.json");
  if (!existsSync(filePath)) return empty;

  let markdown: string | null = null;
  let mtime: string | null = null;
  try {
    markdown = readFileSync(filePath, "utf-8");
    const s = statSync(filePath);
    mtime = s.mtime.toISOString();
  } catch { /* leave nulls */ }

  let audit: AgentConstraintsView["audit"] = null;
  if (existsSync(auditPath)) {
    try {
      const a = JSON.parse(readFileSync(auditPath, "utf-8"));
      audit = {
        compiledAt: typeof a.compiled_at === "string" ? a.compiled_at : null,
        eventsTotal: Number(a.events_total ?? 0),
        rules: Array.isArray(a.by_role?.[safeName]) ? a.by_role[safeName] : null,
      };
    } catch { /* nothing */ }
  }

  return { role: safeName, exists: true, markdown, mtime, audit };
}
