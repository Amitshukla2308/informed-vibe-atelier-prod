/**
 * ShapeView — Mermaid-rendered architectural primer.
 *
 * Shows the 6-altitude shape of the project as one diagram:
 *
 *   Project → Plane(s) → Surface(s) → Story|Epic → Task → Subtask
 *
 * Empty layers are rendered as ghost placeholders ("(no Plane)") rather than
 * collapsed. Drafter's never-skip-layer rule depends on this — an empty
 * row is a *prompt to fill it*, not absence. (See agents/principles/drafter.md.)
 *
 * Two render modes:
 *   - compact  → counts per layer ("Plane × 2"), one box per layer.
 *                Drafter-friendly bird's-eye view.
 *   - expanded → every node rendered, parent_id edges drawn between layers.
 *                For walking the tree.
 *
 * Click a node → onNodeClick(id). Mermaid's `click` directive wires this.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import type { NodeMeta } from "../lib/api";

interface CanvasNode extends NodeMeta {
  ring: number;
  angle: number;
  pulse?: boolean;
}

interface Props {
  nodes: CanvasNode[];
  selected: string | null;
  onNodeClick: (id: string) => void;
}

// One row per altitude. The labels match Drafter principles + canvas docs.
type Altitude = { key: string; label: string; kinds: string[] };
const ALTITUDES: Altitude[] = [
  { key: "project", label: "Project",       kinds: ["Project"] },
  { key: "plane",   label: "Plane",         kinds: ["Plane"] },
  { key: "surface", label: "Surface",       kinds: ["Surface"] },
  { key: "story",   label: "Story / Epic",  kinds: ["Story", "Epic"] },
  { key: "task",    label: "Task",          kinds: ["Task"] },
  { key: "subtask", label: "Subtask",       kinds: ["Subtask"] },
];

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  flowchart: { curve: "basis", htmlLabels: true, padding: 8 },
  securityLevel: "loose", // needed for click handlers
});

// Sanitize a node id for mermaid identifiers.
function mid(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeLabel(s: string): string {
  return (s || "").replace(/"/g, "'").replace(/[\[\]{}]/g, "·").slice(0, 64);
}

function buildCompactDiagram(nodes: CanvasNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);

  const lines: string[] = ["flowchart TB"];
  let prev: string | null = null;
  for (const a of ALTITUDES) {
    const total = a.kinds.reduce((acc, k) => acc + (counts.get(k) ?? 0), 0);
    const id = `L_${a.key}`;
    const labelTxt = total === 0 ? `${a.label} · (none)` : `${a.label} · ×${total}`;
    if (total === 0) {
      lines.push(`  ${id}["${escapeLabel(labelTxt)}"]:::ghost`);
    } else {
      lines.push(`  ${id}["${escapeLabel(labelTxt)}"]:::layer`);
    }
    if (prev) lines.push(`  ${prev} --> ${id}`);
    prev = id;
  }
  lines.push("");
  lines.push("  classDef layer fill:#1e2330,stroke:#5a82c2,stroke-width:1px,color:#dce4f0");
  lines.push("  classDef ghost fill:#1a1a1a,stroke:#3a3a3a,stroke-dasharray:4 3,color:#666,font-style:italic");
  return lines.join("\n");
}

function buildExpandedDiagram(nodes: CanvasNode[]): string {
  const lines: string[] = ["flowchart TB"];
  for (const a of ALTITUDES) {
    const inLayer = nodes.filter(n => a.kinds.includes(n.kind));
    lines.push(`  subgraph ${a.key}["${a.label}"]`);
    lines.push("    direction LR");
    if (inLayer.length === 0) {
      const gid = `${a.key}_ghost`;
      lines.push(`    ${gid}["(no ${a.label})"]:::ghost`);
    } else {
      for (const n of inLayer) {
        const cls = n.kind === "Task" || n.kind === "Subtask" ? "runnable" : "container";
        const stateTag = n.state ? ` · ${n.state}` : "";
        lines.push(`    ${mid(n.id)}["${escapeLabel(n.title || n.kind)}${stateTag}"]:::${cls}`);
      }
    }
    lines.push("  end");
  }

  // Edges: parent_id between altitudes.
  const renderedIds = new Set(nodes.map(n => n.id));
  for (const n of nodes) {
    if (!n.parent_id) continue;
    if (!renderedIds.has(n.parent_id)) continue;
    lines.push(`  ${mid(n.parent_id)} --> ${mid(n.id)}`);
  }

  for (const n of nodes) {
    lines.push(`  click ${mid(n.id)} call atelierShapeNodeClick("${n.id}") "Open ${escapeLabel(n.title || n.kind)}"`);
  }

  lines.push("");
  lines.push("  classDef container fill:#1e2330,stroke:#5a82c2,stroke-width:1px,color:#dce4f0,stroke-dasharray:4 3");
  lines.push("  classDef runnable  fill:#1f3a2c,stroke:#6abf69,stroke-width:1.5px,color:#e8f0e0");
  lines.push("  classDef ghost     fill:#1a1a1a,stroke:#3a3a3a,stroke-dasharray:4 3,color:#666,font-style:italic");
  return lines.join("\n");
}

declare global {
  interface Window {
    atelierShapeNodeClick?: (id: string) => void;
  }
}

export function ShapeView({ nodes, onNodeClick }: Props) {
  const [mode, setMode] = useState<"compact" | "expanded">(() => {
    const saved = localStorage.getItem("atelier.shape.mode");
    return saved === "expanded" ? "expanded" : "compact";
  });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.atelierShapeNodeClick = (id: string) => onNodeClick(id);
    return () => { delete window.atelierShapeNodeClick; };
  }, [onNodeClick]);

  const diagram = useMemo(
    () => (mode === "compact" ? buildCompactDiagram(nodes) : buildExpandedDiagram(nodes)),
    [nodes, mode],
  );

  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;
    const el = containerRef.current;
    el.innerHTML = "";
    const id = "shape-diagram-" + Math.random().toString(36).slice(2, 8);
    mermaid.render(id, diagram).then(({ svg, bindFunctions }) => {
      if (cancelled) return;
      el.innerHTML = svg;
      if (bindFunctions) bindFunctions(el);
    }).catch((e) => {
      if (cancelled) return;
      el.innerHTML = `<pre style="color: var(--sem-orange, #E8A86A); padding: 12px;">Mermaid render error: ${String(e).slice(0, 240)}\n\n--- source ---\n${diagram}</pre>`;
    });
    return () => { cancelled = true; };
  }, [diagram]);

  const onModeChange = (next: "compact" | "expanded") => {
    setMode(next);
    localStorage.setItem("atelier.shape.mode", next);
  };

  return (
    <div className="shape-view" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{
        padding: "10px 16px",
        display: "flex",
        gap: 12,
        alignItems: "center",
        borderBottom: "1px solid var(--a-paper-3)",
        flexShrink: 0,
      }}>
        <h3 style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-ink-1)" }}>Shape</h3>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
          6 altitudes · empty layers shown as ghosts
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            type="button"
            className={`tweak-chip${mode === "compact" ? " on" : ""}`}
            onClick={() => onModeChange("compact")}
          >
            compact
          </button>
          <button
            type="button"
            className={`tweak-chip${mode === "expanded" ? " on" : ""}`}
            onClick={() => onModeChange("expanded")}
          >
            expanded
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: 16,
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-start",
        }}
      />
    </div>
  );
}
