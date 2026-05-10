/**
 * Atelier MCP Server — Canvas + brain verbs (stdio).
 *
 * Claude invokes these via --mcp-config + --strict-mcp-config. Together with the
 * --tools allowlist this forms L2 + L3 of the convergence defense.
 *
 * Uses @modelcontextprotocol/sdk v1.x API.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "~/config";
import {
  proposeNode,
  proposePlan,
  proposeEdge,
  listNodes,
  getNodeFull,
  getGraph,
  type NodeKind,
} from "~/project/canvas";
import { completeOnboarding } from "~/project/scaffold";
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { reflectSession } from "~/session/reflect";
import { computeRipple, formatRippleForLlm } from "~/ripple/ripple";

const server = new McpServer({ name: "atelier-mcp", version: "0.1.0-phase-a" });

const activeProject = () => config.agent.active_project;

// canvas.propose_node
server.registerTool(
  "canvas_propose_node",
  {
    title: "Propose a Canvas node",
    description: "Add a node to the Canvas. Requires a 2-word glanceable title plus the full intent. Atelier uses a 6-altitude shape (see docs/PROJECT_SHAPE.md): Project → Plane → Surface → Story|Epic → Task → Subtask. New Stories/Epics MUST set `touches` (Surface IDs); Tasks inherit the touched set from the parent Story/Epic. 'Project' kind should include `outcome` and `layer`; 'Plane' should include `plane_kind`; 'Surface' should include `parent_plane_id` and `manifest_globs`; 'Milestone' kind should include `target_date`.",
    inputSchema: {
      kind: z.enum(["Project", "Plane", "Surface", "Story", "Epic", "Task", "Subtask", "Decision", "Research", "Risk", "Artifact", "Milestone", "Theme", "Track", "Module"]).describe("Project = root (set `layer`: infra|middle|application). Plane = altitude 2 engineering plane (set `plane_kind`: frontend|backend|data|integration|cross-cutting). Surface = altitude 3 named region with file-pattern manifest (set `parent_plane_id`, `manifest_globs`, `surface_kind`). Story = altitude 4 forward-looking feature/ask/capability — frame as 'As a <user> I want <X> so <Y>' — set `touches: [Surface…]`. Epic = altitude 4 backward-looking issue/bug/regression/refactor — also requires `touches`. Task = altitude 5 engineering work; touched Surfaces inherit from parent. Subtask = altitude 6 atomic step. Decision = ADR-style commitment. Research = discovery node. Risk = open concern. Artifact = produced file/doc. Milestone = ship event with target_date. Theme/Track/Module are pre-altitude deprecated aliases — only used to load existing canvases."),
      title: z.string().describe("Max 2 words, ~40 chars. Glanceable label shown on the Canvas graph and in the hover card."),
      intent: z.string().describe("Full prose intent. Paragraphs OK. The canonical 'what this node is'."),
      parent_id: z.string().optional(),
      dependencies: z.array(z.string()).optional(),
      confidence: z.enum(["high", "medium", "low"]),
      priority: z.enum(["P0-now", "P1-soon", "P2-later", "P3-backlog"]).optional().describe("Founder-facing priority. Default P2-later. Distinct from confidence — this is about 'when', not 'how sure'."),
      cycle: z.string().optional().describe("Cycle tag: 'c1', 'c2', 'c1-discovery', 'c2-inbox', etc. Omit for backlog."),
      outcome: z.string().optional().describe("On Project kind only: one-sentence outcome statement. Example: 'first real user completes the audit flow and pays'. Ignored for other kinds."),
      target_date: z.string().optional().describe("On Milestone kind only: ISO date (YYYY-MM-DD) when this milestone is targeted to ship. Ignored for other kinds."),
      layer: z.enum(["infra", "middle", "application"]).optional().describe("On Project kind only: scaling tier set once at onboarding. infra = foundational infra; middle = platform/services; application = user-facing product. Drives which Planes are legal under it."),
      plane_kind: z.enum(["frontend", "backend", "data", "integration", "cross-cutting"]).optional().describe("On Plane kind only: which engineering plane this is. cross-cutting = logging/types/error-handling without a strict manifest."),
      parent_plane_id: z.string().optional().describe("On Surface kind only: id of the parent Plane node. Surfaces cannot exist without a Plane parent."),
      manifest_globs: z.array(z.string()).optional().describe("On Surface kind only: glob patterns this Surface owns. The Implementer's hallucination guard rejects writes outside this set. Example: ['frontend/src/views/Canvas.tsx', 'backend/src/project/canvas.ts']."),
      surface_kind: z.string().optional().describe("On Surface kind only: short founder-facing tag — 'now', 'canvas', 'agents', 'brain', 'settings', 'world', 'reflect', 'approvals', etc."),
      touches: z.array(z.string()).optional().describe("On Story/Epic kind: REQUIRED — list of Surface node ids this work touches. On Task/Subtask: optional, inherited from parent Story/Epic if omitted. Empty array on a Story/Epic blocks the convergence rule (cannot reach state: approved)."),
      lock_id: z.string().optional().describe("On Task/Subtask kind only: opaque cycle-task identifier ('s-1-t-7') Drafter assigns at draft time for queue ordering. Format: s-<cycle>-t-<seq>. Founder never sets this."),
      priority_score: z.number().optional().describe("On Task/Subtask kind only: 0.0–1.0 Drafter-computed urgency. Implementer queue sorts descending by this. Founder never sets this directly — they 'boost' or 'defer' which adjusts the score."),
      supersedes: z.string().optional().describe("On Task/Subtask kind only: id of the Task this one supersedes. The pivot mechanism — Drafter re-opens prior work without manual reopen."),
    },
  },
  async (args) => {
    const meta = proposeNode({
      project: activeProject(),
      kind: args.kind as NodeKind,
      title: args.title,
      intent: args.intent,
      parent_id: args.parent_id ?? null,
      dependencies: args.dependencies,
      confidence: args.confidence,
      priority: args.priority,
      cycle: args.cycle ?? null,
      outcome: args.outcome ?? null,
      target_date: args.target_date ?? null,
      layer: args.layer ?? null,
      plane_kind: args.plane_kind ?? null,
      parent_plane_id: args.parent_plane_id ?? null,
      manifest_globs: args.manifest_globs,
      surface_kind: args.surface_kind ?? null,
      touches: args.touches,
      lock_id: args.lock_id ?? null,
      priority_score: args.priority_score ?? null,
      supersedes: args.supersedes ?? null,
    });
    return {
      content: [
        {
          type: "text",
          text: `Added ${meta.kind} node "${meta.title}" (${meta.id}) — badge: ${meta.badge}, state: ${meta.state}.`,
        },
      ],
    };
  }
);

// canvas.propose_plan
server.registerTool(
  "canvas_propose_plan",
  {
    title: "Write or update a node's plan.md",
    description: "Plan structure: Intent / Non-goals / Acceptance / Dependencies / Budget / Planned artifacts.",
    inputSchema: {
      node_id: z.string(),
      plan_markdown: z.string(),
    },
  },
  async (args) => {
    const meta = proposePlan(activeProject(), args.node_id, args.plan_markdown);
    return { content: [{ type: "text", text: `Updated plan for ${meta.id}.` }] };
  }
);

// canvas.propose_edge
server.registerTool(
  "canvas_propose_edge",
  {
    title: "Propose a Canvas edge",
    description: "Relationships: depends-on, produces, changes, discussed-in, blocks, parent-child.",
    inputSchema: {
      from: z.string(),
      to: z.string(),
      kind: z.enum(["depends-on", "produces", "changes", "discussed-in", "blocks", "parent-child", "ships-in"]),
    },
  },
  async (args) => {
    proposeEdge(activeProject(), { from: args.from, to: args.to, kind: args.kind });
    return { content: [{ type: "text", text: `Edge ${args.kind}: ${args.from} → ${args.to}` }] };
  }
);

// project.complete_onboarding — Onboarder's explicit handoff. Flips project
// stage from "onboarding" → "pre-mvp" and sets the target ship date. After
// this, subsequent sessions load Drafter mode instead of Onboarder.
server.registerTool(
  "project_complete_onboarding",
  {
    title: "Complete onboarding + open cycle c1",
    description: "Called by Onboarder when the founder has approved shape + set a ship date. Flips the project's stage to pre-mvp so next session loads Drafter. Idempotent: re-running on an already-onboarded project updates only the ship date.",
    inputSchema: {
      target_ship_date: z.string().describe("ISO-8601 date (YYYY-MM-DD) when the first milestone is targeted to ship. Required — this is the cycle anchor."),
    },
  },
  async (args) => {
    const meta = completeOnboarding(activeProject(), args.target_ship_date);
    return {
      content: [
        {
          type: "text",
          text: `Project "${meta.name}" onboarding complete. Stage: ${meta.stage}. Target ship: ${meta.target_ship_date}. Next session will load Drafter mode.`,
        },
      ],
    };
  }
);

// canvas.query
server.registerTool(
  "canvas_query",
  {
    title: "Query Canvas nodes",
    description: "Returns nodes matching filter. Empty filter returns all.",
    inputSchema: {
      state: z.string().optional(),
      kind: z.string().optional(),
    },
  },
  async (args) => {
    let nodes = listNodes(activeProject());
    if (args.state) nodes = nodes.filter((n) => n.state === args.state);
    if (args.kind) nodes = nodes.filter((n) => n.kind === args.kind);
    return {
      content: [{ type: "text", text: JSON.stringify(nodes.map((n) => ({ id: n.id, kind: n.kind, intent: n.intent, state: n.state, badge: n.badge })), null, 2) }],
    };
  }
);

// canvas.get_node
server.registerTool(
  "canvas_get_node",
  {
    title: "Get full node detail",
    description: "Returns meta + plan.md for a node.",
    inputSchema: { node_id: z.string() },
  },
  async (args) => {
    const { meta, plan } = getNodeFull(activeProject(), args.node_id);
    return { content: [{ type: "text", text: `${JSON.stringify(meta, null, 2)}\n\n--- plan.md ---\n${plan}` }] };
  }
);

// brain.write_personal
server.registerTool(
  "brain_write_personal",
  {
    title: "Write to personal brain",
    description: "Confidence-tagged. High flows through; medium/low → review queue.",
    inputSchema: {
      category: z.enum(["preferences", "redirects", "axioms", "voice"]),
      content: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      rationale: z.string().optional(),
    },
  },
  async (args) => {
    const brainDir = resolve(config.atelierRoot, "brain/personal", config.agent.founder_name.toLowerCase());
    mkdirSync(brainDir, { recursive: true });
    const file = resolve(brainDir, `${args.category}.md`);
    const entry = `\n---\n**${new Date().toISOString()}** · confidence: ${args.confidence}\n\n${args.content}\n${args.rationale ? `\n_rationale: ${args.rationale}_\n` : ""}`;
    if (!existsSync(file)) writeFileSync(file, `# ${args.category}\n`);
    appendFileSync(file, entry);
    return { content: [{ type: "text", text: `Wrote to brain/personal/${config.agent.founder_name.toLowerCase()}/${args.category}.md (confidence: ${args.confidence}).` }] };
  }
);

// brain.query_personal
server.registerTool(
  "brain_query_personal",
  {
    title: "Query personal brain",
    description: "Read founder's personal brain layers.",
    inputSchema: { query: z.string() },
  },
  async (args) => {
    const brainDir = resolve(config.atelierRoot, "brain/personal", config.agent.founder_name.toLowerCase());
    const categories = ["preferences", "redirects", "axioms", "voice"];
    const out: string[] = [];
    for (const cat of categories) {
      const file = resolve(brainDir, `${cat}.md`);
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8");
        if (content.toLowerCase().includes(args.query.toLowerCase())) {
          out.push(`### ${cat}.md\n${content.slice(0, 2000)}`);
        }
      }
    }
    return { content: [{ type: "text", text: out.length ? out.join("\n\n") : "(nothing matching)" }] };
  }
);

// brain.query_general + brain.query_world — stubs reading from docs/
server.registerTool(
  "brain_query_general",
  {
    title: "Query general founder-brain",
    description: "Read-only universal patterns.",
    inputSchema: { query: z.string() },
  },
  async (args) => {
    const curriculum = resolve(config.docsDir, "CURRICULUM_FROM_V1.md");
    if (!existsSync(curriculum)) return { content: [{ type: "text", text: "(curriculum not yet authored)" }] };
    const content = readFileSync(curriculum, "utf-8");
    // naive substring grep for Phase A
    const lines = content.split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(args.query.toLowerCase())) {
        hits.push(lines.slice(Math.max(0, i - 2), i + 3).join("\n"));
      }
    }
    return { content: [{ type: "text", text: hits.slice(0, 10).join("\n\n---\n\n") || "(nothing matching)" }] };
  }
);

server.registerTool(
  "brain_query_world",
  {
    title: "Query world-layer",
    description: "External intel: competitors, industry, regulatory. Phase A: reads from docs/EXTRACTS_V1.md.",
    inputSchema: { topic: z.string() },
  },
  async (args) => {
    const extracts = resolve(config.docsDir, "EXTRACTS_V1.md");
    if (!existsSync(extracts)) return { content: [{ type: "text", text: "(world-layer empty)" }] };
    const content = readFileSync(extracts, "utf-8");
    const lines = content.split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(args.topic.toLowerCase())) {
        hits.push(lines.slice(Math.max(0, i - 2), i + 3).join("\n"));
      }
    }
    return { content: [{ type: "text", text: hits.slice(0, 10).join("\n\n---\n\n") || "(nothing matching)" }] };
  }
);

// session.checkpoint + session.end_with_reflection
server.registerTool(
  "session_checkpoint",
  {
    title: "Mark session checkpoint",
    description: "Note a meaningful point.",
    inputSchema: { summary: z.string() },
  },
  async (args) => {
    const sessionsDir = resolve(config.dataDir, "sessions");
    const file = resolve(sessionsDir, `checkpoints.jsonl`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), summary: args.summary }) + "\n");
    return { content: [{ type: "text", text: `Checkpointed: ${args.summary}` }] };
  }
);

server.registerTool(
  "session_end_with_reflection",
  {
    title: "Trigger reflection pass",
    description:
      "Six-lens crystallization (Engineer/Architect/Strategist/Economist/Scientist/Product). " +
      "Writes artifact to projects/<active>/sessions/<ts>.md and extracts agreement/disagreement signals to brain/personal/<founder>/.",
    inputSchema: {
      session_id: z
        .string()
        .describe("Session id whose raw.log to reflect on. Required — the MCP server has no WS context.")
        .optional(),
    },
  },
  async (args) => {
    const sessionId =
      args?.session_id ?? process.env.ATELIER_SESSION_ID ?? "";
    if (!sessionId) {
      return {
        content: [
          {
            type: "text",
            text: "Reflection failed: no session_id provided and ATELIER_SESSION_ID env var not set. Cannot locate raw.log.",
          },
        ],
      };
    }
    try {
      const result = await reflectSession({ sessionId });
      const suffix = result.used_fallback
        ? " (fallback template used — see backend/PHASE_A_BLOCKERS.md)"
        : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Reflection complete. Artifact: ${result.artifact_path}. ` +
              `Signals extracted: ${result.signals_extracted}.${suffix}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          { type: "text", text: `Reflection error: ${String(e).slice(0, 400)}` },
        ],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// OmniGraph temporal-query tools — let Claude query the founder's brain inline
// during a session. Each tool shells out to the omnigraph CLI; if the runner
// is missing the tool returns a helpful message rather than failing the call.
// ---------------------------------------------------------------------------

function findOmnigraphRunner(): { bin: string; argsPrefix: string[] } | null {
  // 1. PATH-resolved `omnigraph` (installed via pip from the standalone package).
  const which = spawnSync("which", ["omnigraph"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) {
    return { bin: which.stdout.trim(), argsPrefix: [] };
  }
  // 2. Vendored copy inside atelier-oss (the install-friendly default).
  // 3. Canonical informed-vibes layout.
  // 4. Legacy projects/ path (back-compat for non-OSS dev environments).
  const candidates = [
    resolve(config.atelierRoot, "omnigraph/src/omnigraph_cli.py"),
    resolve(process.env.HOME ?? "/root", "informed-vibes/active/omnigraph/src/omnigraph_cli.py"),
    resolve(process.env.HOME ?? "/root", "projects/omnigraph/src/omnigraph_cli.py"),
  ];
  for (const cliPy of candidates) {
    if (existsSync(cliPy)) {
      return { bin: "python3", argsPrefix: [cliPy] };
    }
  }
  return null;
}

function callOmnigraph(subcmd: string, extraArgs: string[]): string {
  const runner = findOmnigraphRunner();
  if (!runner) {
    return "(omnigraph CLI not found on PATH or at ~/informed-vibes/omnigraph)";
  }
  const args = [...runner.argsPrefix, subcmd, ...extraArgs];
  const r = spawnSync(runner.bin, args, { encoding: "utf-8", timeout: 60_000 });
  if (r.status !== 0) {
    const stderr = (r.stderr || "").trim().slice(0, 400);
    return `(omnigraph ${subcmd} exited ${r.status}: ${stderr || "no stderr"})`;
  }
  return (r.stdout || "").trim() || "(no output)";
}

server.registerTool(
  "omnigraph_open",
  {
    title: "List open decisions and unresolved concerns",
    description:
      "Returns the founder's still-open decisions (status: tentative/proposed/pending/etc.) " +
      "and unresolved concerns from across all 670+ AI sessions. Use to surface what's hanging " +
      "before suggesting new work.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  },
  async (args) => {
    const out = callOmnigraph("open", ["--limit", String(args.limit ?? 20)]);
    return { content: [{ type: "text", text: out.slice(0, 6000) }] };
  },
);

server.registerTool(
  "omnigraph_history",
  {
    title: "Decision history for an entity",
    description:
      "Chronological list of decisions touching a target_id (e.g. 'hyperretrieval', 'zeroclaw', " +
      "'fastbrick'). Each entry includes session, status, and proposition. Use to ground claims " +
      "about how the founder's thinking on this entity has evolved.",
    inputSchema: {
      target_id: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async (args) => {
    const out = callOmnigraph("history", [args.target_id, "--limit", String(args.limit ?? 30)]);
    return { content: [{ type: "text", text: out.slice(0, 6000) }] };
  },
);

server.registerTool(
  "omnigraph_supersession",
  {
    title: "Decision-flip chains across the corpus",
    description:
      "Returns entities whose decisions show status reversals (locked → reverted/overturned). " +
      "Use to detect when the founder is reconsidering a previously-locked decision.",
    inputSchema: {},
  },
  async () => {
    const out = callOmnigraph("supersession", []);
    return { content: [{ type: "text", text: out.slice(0, 6000) }] };
  },
);

server.registerTool(
  "omnigraph_draft_lens",
  {
    title: "Draft a domain-brain lens for the active project (or another)",
    description:
      "Generates `<kind>.draft.md` under `atelier/projects/<project>/domain_brain/`. " +
      "Use when the project's domain brain is missing a lens or the existing one feels " +
      "stale. Lens kinds: industry_map, customer_personas, current_conditions, " +
      "viability_verdict, open_questions. Never overwrites the hand-authored `<kind>.md`. " +
      "Callable by Drafter (during research) or by the founder via UI.",
    inputSchema: {
      kind: z.enum([
        "industry_map",
        "customer_personas",
        "current_conditions",
        "viability_verdict",
        "open_questions",
      ]),
      project: z.string().optional(),
    },
  },
  async (args) => {
    const project = args.project ?? activeProject();
    const projectRoot = resolve(config.projectsDir, project);
    if (!existsSync(projectRoot)) {
      return {
        content: [
          { type: "text", text: `Project root not found: ${projectRoot}` },
        ],
      };
    }
    const out = callOmnigraph("domain-brain", [
      "--project-root", projectRoot,
      "--draft", args.kind,
    ]);
    return {
      content: [
        {
          type: "text",
          text:
            `Drafted ${args.kind} for ${project}.\n` +
            `Output appears at projects/${project}/domain_brain/${args.kind}.draft.md.\n` +
            `Founder reviews + promotes to ${args.kind}.md when ready.\n\n` +
            `omnigraph response:\n${out.slice(0, 4000)}`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// OmniGraph ripple — co-change neighbors for a target file/module.
//
// Backed by og_artifacts/ripple/_index.json, emitted by
// omnigraph/scripts/emit_ripple.py from the HR co-change graph. Drafter
// uses this to atomize work without producing artifact-coupled Tasks
// that the coherence gate would block (a sibling of the cross-artifact
// gate — that catches DECLARED cross-references; ripple surfaces the
// IMPLICIT couplings Drafter doesn't even know to declare).
// ---------------------------------------------------------------------------
server.registerTool(
  "omnigraph_ripple_neighbors",
  {
    title: "Co-change neighbors for a target",
    description:
      "Return the modules/files that co-change with `target` based on the OmniGraph HR graph. " +
      "Useful before atomizing work: if a Task touches X, look up X's neighbors so dependent " +
      "Tasks get the right `depends-on` edges (Drafter's coherence rule). Returns null when no " +
      "ripple data is available — the founder hasn't run `emit_ripple.py` yet.",
    inputSchema: {
      target: z.string().describe("File path, module name, or canonical entity slug — must match exactly what HR cochange uses."),
      limit: z.number().int().min(1).max(50).optional().describe("Cap on neighbors returned (default 10, max 50)."),
    },
  },
  async (args) => {
    const limit = args.limit ?? 10;
    // Try the per-target shard first (cheap), fall back to scanning _index.json.
    const safe = (args.target ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
    const rippleRoot = resolve(config.atelierRoot, "og_artifacts", "ripple");
    const shardPath = resolve(rippleRoot, `${safe}.json`);
    const indexPath = resolve(rippleRoot, "_index.json");

    let neighbors: Array<{ module: string; weight: number }> | null = null;
    let criticality: unknown = null;
    let source = "";

    if (existsSync(shardPath)) {
      try {
        const shard = JSON.parse(readFileSync(shardPath, "utf-8"));
        neighbors = shard.neighbors ?? null;
        criticality = shard.criticality ?? null;
        source = shardPath;
      } catch { /* fall through to index */ }
    }

    if (!neighbors && existsSync(indexPath)) {
      try {
        const idx = JSON.parse(readFileSync(indexPath, "utf-8"));
        const edges = idx?.cochange?.edges ?? {};
        neighbors = edges[args.target] ?? null;
        criticality = idx?.criticality?.modules?.[args.target] ?? null;
        source = indexPath;
      } catch { /* nothing */ }
    }

    if (!neighbors) {
      return { content: [{ type: "text", text: `No ripple data for target='${args.target}'. Either the target string doesn't match HR's canonicalization, or emit_ripple.py hasn't been run for this atelier root.` }] };
    }

    const trimmed = neighbors.slice(0, limit);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          target: args.target,
          neighbors: trimmed,
          truncated: neighbors.length > trimmed.length ? neighbors.length - trimmed.length : 0,
          criticality,
          source,
        }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// omnigraph_ripple — live co-change graph from local git history.
//
// Sibling of `omnigraph_ripple_neighbors` above. The neighbours tool reads a
// pre-emitted shard from og_artifacts/ripple/ (Drafter's pre-computed view).
// THIS tool computes ripple on the fly from `git log --name-only` so any
// agent can ask it without a prior emit step. Drafter calls it during
// atomization; Implementer calls it before declaring "Planned artifacts"
// complete to surface co-changes that weren't touched. TTL cache invalidates
// when git status shows >5 changed files in projectDir.
// ---------------------------------------------------------------------------
server.registerTool(
  "omnigraph_ripple",
  {
    title: "Live ripple — co-change graph from local git history",
    description:
      "Query the co-change graph: given a file path, return files that historically change together. Use during plan atomization (Drafter) or before declaring Planned artifacts complete (Implementer). Confidence is normalized 0-1; high confidence means strong historical coupling. Source is local `git log --name-only` over the last 180 days; cache invalidates on >5 changed files in `git status`. Returns up to `limit` neighbours sorted by confidence DESC.",
    inputSchema: {
      file_path: z.string().describe("File path relative to the atelier root (e.g. 'backend/src/agent/fixer.ts'). Absolute paths inside the atelier root are also accepted; outside paths return an empty result."),
      depth: z.number().int().min(1).max(3).optional().describe("1 = direct co-changes (default). 2 = transitive (neighbours' neighbours, dampened). 3 = grand-transitive (rarely useful)."),
      limit: z.number().int().min(1).max(50).optional().describe("Cap on neighbours returned (default 12, max 50)."),
    },
  },
  async (args) => {
    const depth = args.depth ?? 1;
    const limit = args.limit ?? 12;
    try {
      const ripple = await computeRipple(args.file_path, depth, config.atelierRoot, { limit });
      return { content: [{ type: "text", text: formatRippleForLlm(ripple) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Ripple computation failed: ${String(e).slice(0, 400)}. The git fallback may be unavailable in this projectDir.` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[atelier-mcp] ready on stdio");
