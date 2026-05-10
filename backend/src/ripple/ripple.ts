/**
 * Ripple — co-change graph computed from local git history.
 *
 * Session 5 (TODO #30): exposes `computeRipple()` for the MCP tool
 * `omnigraph_ripple`, the HTTP endpoint `/ripple`, the Drafter atomization
 * loop, and the Implementer post-run "did you miss a co-change?" check.
 *
 * Implementation notes:
 *   - Source of truth is `git log --name-only` over the last 180 days, run
 *     in `projectDir`. No external use-ripple binary required — the project
 *     ships a Python whl + an MCP server, neither of which is reachable
 *     from this Bun process today. We compute co-change in TS directly so
 *     the surface is reliable regardless of the founder's HR install state.
 *   - confidence(0..1) = co_count / max(1, anchor_count) — the conditional
 *     probability "given file changed, the other file changed too", clipped.
 *     Recency boost: confidence *= 0.85 + 0.15 * recency where recency is
 *     1.0 if last_co_change ≤ 14d, decaying to 0 at 180d. This weights
 *     recent coupling above stale historical noise.
 *   - last_change_distance = days since the most recent commit that touched
 *     both anchor and neighbour together. -1 if unknown.
 *   - depth=2 expands by walking each depth-1 neighbour's neighbours (after
 *     dedup of the anchor + already-included paths) and dampening their
 *     confidence by 0.6 (the "transitive coupling" factor). Empirically
 *     keeps the result list tight; depth=3 explodes too fast on real repos.
 *   - In-process TTL cache: keyed by `projectDir`. Invalidates when
 *     `git status --porcelain` shows >5 changed files (the project has
 *     drifted enough that the graph is stale). Cache also expires after
 *     30 minutes regardless. Cheap to check status before serving cached;
 *     git rebuild is the slow part, not the status check.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RippleNeighbor {
  /** Path relative to projectDir. */
  path: string;
  /** 0..1, normalized co-change conditional probability with recency boost. */
  confidence: number;
  /** Days since the most recent commit that touched both files. -1 if unknown. */
  last_change_distance: number;
  /** Depth at which this neighbour was found (1 = direct co-change, 2 = transitive). */
  depth: number;
}

export interface RippleResult {
  /** Anchor path, normalized relative to projectDir. */
  anchor: string;
  /** Top neighbours ordered by confidence DESC. */
  affected_files: RippleNeighbor[];
  /** ISO 8601 timestamp the underlying graph was built. */
  graph_built_at: string;
  /** Implementation source. "git-fallback" today; "use-ripple" if we wire HR. */
  source: "git-fallback" | "use-ripple";
  /** True iff the cached graph was used (no rebuild). */
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CachedGraph {
  builtAt: number; // epoch ms
  builtAtIso: string;
  /** anchor file → list of {neighbour, co_count, last_co_ts (epoch s), anchor_count} */
  edges: Map<string, Array<{ neighbour: string; coCount: number; lastCoEpoch: number }>>;
  /** anchor file → number of commits that touched it. Used as the conditional-prob denominator. */
  freq: Map<string, number>;
  /** Most recent commit epoch in the log. Used for recency normalisation. */
  headEpoch: number;
}

const CACHE = new Map<string, CachedGraph>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min hard expire
const STATUS_INVALIDATION_THRESHOLD = 5; // > 5 changed files in git status → rebuild

function cacheStillFresh(projectDir: string): CachedGraph | null {
  const cached = CACHE.get(projectDir);
  if (!cached) return null;
  if (Date.now() - cached.builtAt > CACHE_TTL_MS) return null;
  // Check git status. If too many changed files, the graph is drifting.
  const status = spawnSync("git", ["-C", projectDir, "status", "--porcelain"], {
    encoding: "utf-8",
    timeout: 4000,
  });
  if (status.status !== 0) {
    // git status failed (not a repo, etc) — treat as fresh; don't churn.
    return cached;
  }
  const changed = status.stdout.split("\n").filter((l) => l.trim().length > 0).length;
  if (changed > STATUS_INVALIDATION_THRESHOLD) return null;
  return cached;
}

// ---------------------------------------------------------------------------
// Graph build
// ---------------------------------------------------------------------------

function isSourceLikePath(p: string): boolean {
  if (!p || p.length > 240) return false;
  if (p.includes("\0")) return false;
  // Skip common non-source paths that explode the graph with noise.
  if (/(^|\/)(node_modules|\.git|dist|build|target|venv|\.venv|__pycache__)\//.test(p)) return false;
  if (/^data\/.*\.(jsonl|sqlite|db|wal|shm)$/.test(p)) return false;
  return true;
}

function buildGraph(projectDir: string): CachedGraph {
  // git log --name-only --pretty=format:COMMIT:%H:%ct over last 180 days, no merges.
  const result = spawnSync(
    "git",
    [
      "-C",
      projectDir,
      "log",
      "--name-only",
      "--pretty=format:COMMIT:%H:%ct",
      "--no-merges",
      "--since=180.days.ago",
    ],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );

  const builtAtIso = new Date().toISOString();
  const edges = new Map<string, Array<{ neighbour: string; coCount: number; lastCoEpoch: number }>>();
  const freq = new Map<string, number>();
  let headEpoch = 0;

  if (result.status !== 0 || !result.stdout) {
    // Not a git repo, or git failed. Empty graph; let caller decide.
    return { builtAt: Date.now(), builtAtIso, edges, freq, headEpoch };
  }

  // Parse into commits: [{epoch, files: string[]}].
  const commits: Array<{ epoch: number; files: string[] }> = [];
  let cur: { epoch: number; files: string[] } | null = null;
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("COMMIT:")) {
      if (cur) commits.push(cur);
      const parts = line.split(":");
      // COMMIT:<sha>:<epoch>
      const epoch = Number(parts[2] ?? 0);
      cur = { epoch, files: [] };
      if (epoch > headEpoch) headEpoch = epoch;
      continue;
    }
    if (!line) continue;
    if (!cur) continue;
    if (!isSourceLikePath(line)) continue;
    cur.files.push(line);
  }
  if (cur) commits.push(cur);

  // Cap mega-commits — they contribute mostly noise to co-change.
  const MAX_FILES_PER_COMMIT = 40;

  // Pass 1: count per-file commit frequency.
  for (const c of commits) {
    if (c.files.length === 0 || c.files.length > MAX_FILES_PER_COMMIT) continue;
    const seen = new Set<string>();
    for (const f of c.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      freq.set(f, (freq.get(f) ?? 0) + 1);
    }
  }

  // Pass 2: build pairs. Only include files that appear ≥2 times overall —
  // singletons can't carry a meaningful co-change signal.
  const pairCount = new Map<string, number>();
  const pairLastEpoch = new Map<string, number>();
  for (const c of commits) {
    if (c.files.length < 2 || c.files.length > MAX_FILES_PER_COMMIT) continue;
    const distinct = [...new Set(c.files)].filter((f) => (freq.get(f) ?? 0) >= 2);
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const a = distinct[i];
        const b = distinct[j];
        const key = a < b ? `${a}\t${b}` : `${b}\t${a}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        const prev = pairLastEpoch.get(key) ?? 0;
        if (c.epoch > prev) pairLastEpoch.set(key, c.epoch);
      }
    }
  }

  // Materialize edges: for each anchor, list its neighbours (both directions).
  for (const [key, count] of pairCount.entries()) {
    const [a, b] = key.split("\t");
    const lastEpoch = pairLastEpoch.get(key) ?? 0;
    if (!edges.has(a)) edges.set(a, []);
    if (!edges.has(b)) edges.set(b, []);
    edges.get(a)!.push({ neighbour: b, coCount: count, lastCoEpoch: lastEpoch });
    edges.get(b)!.push({ neighbour: a, coCount: count, lastCoEpoch: lastEpoch });
  }

  return { builtAt: Date.now(), builtAtIso, edges, freq, headEpoch };
}

function getOrBuild(projectDir: string): CachedGraph {
  const cached = cacheStillFresh(projectDir);
  if (cached) return cached;
  const g = buildGraph(projectDir);
  CACHE.set(projectDir, g);
  return g;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Normalize a caller-supplied file path to a project-relative form (no leading ./). */
export function normalizeAnchor(filePath: string, projectDir: string): string {
  if (!filePath) return "";
  if (isAbsolute(filePath)) {
    const rel = pathRelative(projectDir, filePath);
    if (rel.startsWith("..")) return filePath; // outside project; pass through
    return rel.replace(/\\/g, "/");
  }
  return filePath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Score a single neighbour given the cached graph. */
function scoreNeighbour(
  anchorFreq: number,
  coCount: number,
  lastCoEpoch: number,
  headEpoch: number,
): { confidence: number; lastChangeDistance: number } {
  const condProb = anchorFreq > 0 ? Math.min(1, coCount / anchorFreq) : 0;
  // Recency: 1.0 within 14 days, linear decay to 0 at 180 days.
  const NOW = Math.floor(Date.now() / 1000);
  const ageDays =
    lastCoEpoch > 0 ? Math.max(0, Math.floor((NOW - lastCoEpoch) / 86400)) : -1;
  let recency = 1.0;
  if (ageDays < 0) recency = 0.5; // unknown — assume mid
  else if (ageDays <= 14) recency = 1.0;
  else if (ageDays >= 180) recency = 0.0;
  else recency = 1 - (ageDays - 14) / (180 - 14);
  const score = condProb * (0.85 + 0.15 * recency);
  void headEpoch; // headEpoch reserved for future global decay if needed
  return {
    confidence: Math.max(0, Math.min(1, score)),
    lastChangeDistance: ageDays,
  };
}

export interface ComputeRippleOptions {
  /** Maximum neighbours returned. Default 12. */
  limit?: number;
  /**
   * If true, force a graph rebuild for projectDir, ignoring cache.
   * The HTTP endpoint exposes this as ?force=1 for diagnostics.
   */
  force?: boolean;
}

export async function computeRipple(
  filePath: string,
  depth: number = 1,
  projectDir: string,
  opts: ComputeRippleOptions = {},
): Promise<RippleResult> {
  const limit = opts.limit ?? 12;
  const clampedDepth = Math.max(1, Math.min(3, Math.floor(depth)));
  const anchor = normalizeAnchor(filePath, projectDir);

  if (!existsSync(projectDir)) {
    return {
      anchor,
      affected_files: [],
      graph_built_at: new Date().toISOString(),
      source: "git-fallback",
      cached: false,
    };
  }

  if (opts.force) CACHE.delete(projectDir);
  const graph = getOrBuild(projectDir);

  const wasCached = !opts.force && CACHE.get(projectDir) === graph && Date.now() - graph.builtAt > 100;

  const anchorFreq = graph.freq.get(anchor) ?? 0;
  const directEdges = graph.edges.get(anchor) ?? [];

  // Depth 1.
  const seen = new Set<string>([anchor]);
  const out: RippleNeighbor[] = [];

  for (const edge of directEdges) {
    if (seen.has(edge.neighbour)) continue;
    const { confidence, lastChangeDistance } = scoreNeighbour(
      anchorFreq,
      edge.coCount,
      edge.lastCoEpoch,
      graph.headEpoch,
    );
    if (confidence <= 0) continue;
    seen.add(edge.neighbour);
    out.push({
      path: edge.neighbour,
      confidence,
      last_change_distance: lastChangeDistance,
      depth: 1,
    });
  }

  // Depth 2 and 3: walk neighbours' neighbours, dampened.
  let frontier = out.slice(); // current depth-1 set
  for (let d = 2; d <= clampedDepth; d++) {
    const nextFrontier: RippleNeighbor[] = [];
    const damp = d === 2 ? 0.6 : 0.36;
    for (const node of frontier) {
      const childFreq = graph.freq.get(node.path) ?? 0;
      const childEdges = graph.edges.get(node.path) ?? [];
      for (const edge of childEdges) {
        if (seen.has(edge.neighbour)) continue;
        const { confidence, lastChangeDistance } = scoreNeighbour(
          childFreq,
          edge.coCount,
          edge.lastCoEpoch,
          graph.headEpoch,
        );
        const finalConf = confidence * damp;
        if (finalConf <= 0.05) continue; // floor on transitive coupling
        seen.add(edge.neighbour);
        const neighbour: RippleNeighbor = {
          path: edge.neighbour,
          confidence: finalConf,
          last_change_distance: lastChangeDistance,
          depth: d,
        };
        out.push(neighbour);
        nextFrontier.push(neighbour);
      }
    }
    frontier = nextFrontier;
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return {
    anchor,
    affected_files: out.slice(0, limit),
    graph_built_at: graph.builtAtIso,
    source: "git-fallback",
    cached: wasCached,
  };
}

/** Format a RippleResult into LLM-friendly plain text (no raw JSON dump). */
export function formatRippleForLlm(result: RippleResult): string {
  if (result.affected_files.length === 0) {
    return `No co-change signal for "${result.anchor}". The file either has no commit history yet, or has only changed in isolation. graph_built_at=${result.graph_built_at} source=${result.source}.`;
  }
  const lines: string[] = [];
  lines.push(`Co-change neighbours for ${result.anchor}:`);
  lines.push(`(graph_built_at=${result.graph_built_at} source=${result.source}${result.cached ? " cached" : ""})`);
  lines.push("");
  for (const n of result.affected_files) {
    const pct = Math.round(n.confidence * 100);
    const dist = n.last_change_distance < 0 ? "?" : `${n.last_change_distance}d ago`;
    const tag = n.depth === 1 ? "direct" : `transitive(d=${n.depth})`;
    lines.push(`  · ${n.path}  —  confidence ${pct}%  (${dist}, ${tag})`);
  }
  if (result.affected_files.length > 5) {
    lines.push("");
    lines.push(`Note: ${result.affected_files.length} co-change files at depth ${Math.max(...result.affected_files.map(n=>n.depth))}. If this is a Task scope, consider whether more of these need to be in 'touches' or 'Planned artifacts'.`);
  }
  return lines.join("\n");
}

/** Diagnostic helper used by smoke tests. */
export function _resetRippleCache(): void {
  CACHE.clear();
}
