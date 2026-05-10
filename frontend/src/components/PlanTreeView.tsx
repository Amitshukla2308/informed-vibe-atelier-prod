import { useMemo, useState } from "react";
import type { NodeMeta, NodeState } from "../lib/api";

/**
 * Plan Tree view — altitude-aware hierarchy.
 *
 * Project → Plane → Surface → Story/Epic → Task/Subtask
 *
 * Decision / Risk / Research / Artifact render as annotation chips on the
 * Surface or Story they're parented to. Unparented (or Project-parented)
 * annotations live in a top-level "Cross-cutting" section.
 *
 * Click a row to open the drawer (same onNodeClick the kanban + radial use).
 * Twisty toggles expand/collapse local subtree. Defaults expanded down to
 * Surface; Stories/Epics collapsed (the founder asks "what's the shape?",
 * not "every Task at once").
 */

type AnnotationKind = "Decision" | "Risk" | "Research" | "Artifact" | "Consultation";

interface Props {
  nodes: NodeMeta[];
  selected: string | null;
  onNodeClick: (id: string) => void;
}

function rollupTasks(tasks: NodeMeta[]): { done: number; total: number; blocked: number; review: number } {
  const total = tasks.length;
  let done = 0, blocked = 0, review = 0;
  for (const t of tasks) {
    if (t.state === "done") done += 1;
    else if (t.state === "blocked") blocked += 1;
    else if (t.state === "review") review += 1;
  }
  return { done, total, blocked, review };
}

function annotationColor(kind: AnnotationKind): string {
  switch (kind) {
    case "Decision":     return "var(--sem-blue, #6aa9d6)";
    case "Risk":         return "var(--sem-orange, #E8A86A)";
    case "Research":     return "var(--sem-purple, #b08acb)";
    case "Artifact":     return "var(--a-mute)";
    // Consultations share the "knowledge in progress" semantic with Research,
    // so they reuse the same purple. Distinct glyph keeps them legible.
    case "Consultation": return "var(--sem-purple, #b08acb)";
  }
}

function annotationGlyph(kind: AnnotationKind): string {
  switch (kind) {
    case "Decision":     return "◆";
    case "Risk":         return "▲";
    case "Research":     return "?";
    case "Artifact":     return "◇";
    case "Consultation": return "◑";
  }
}

export function PlanTreeView({ nodes, selected, onNodeClick }: Props) {
  // Memo-derived buckets. Recomputed only when the node list reference changes
  // (parent's fetchGraph drives this; cheap for ~100 nodes).
  const buckets = useMemo(() => {
    const project = nodes.find(n => n.kind === "Project") ?? null;
    const planes = nodes.filter(n => n.kind === "Plane");
    const surfaces = nodes.filter(n => n.kind === "Surface");
    const stories = nodes.filter(n => n.kind === "Story" || n.kind === "Epic");
    const tasks = nodes.filter(n => n.kind === "Task" || n.kind === "Subtask");
    const annotations = nodes.filter(n =>
      n.kind === "Decision" || n.kind === "Risk" || n.kind === "Research" || n.kind === "Artifact" || n.kind === "Consultation"
    );
    return { project, planes, surfaces, stories, tasks, annotations };
  }, [nodes]);

  const { project, planes, surfaces, stories, tasks, annotations } = buckets;

  function tasksUnder(parentId: string): NodeMeta[] {
    // Walk descendants by parent_id chain.
    const out: NodeMeta[] = [];
    const queue = [parentId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of tasks) {
        if (t.parent_id === id) {
          out.push(t);
          queue.push(t.id);
        }
      }
    }
    return out;
  }

  function storiesForSurface(surfaceId: string): NodeMeta[] {
    return stories.filter(s => (s.touches ?? []).includes(surfaceId));
  }

  function surfacesForPlane(planeId: string): NodeMeta[] {
    return surfaces.filter(s => s.parent_plane_id === planeId);
  }

  function annotationsForParent(parentId: string): NodeMeta[] {
    return annotations.filter(a => a.parent_id === parentId);
  }

  const rootAnnotations = useMemo(() => {
    const pid = project?.id;
    return annotations.filter(a => !a.parent_id || a.parent_id === pid);
  }, [annotations, project]);

  if (!project) {
    return (
      <div style={{ padding: 40, color: "var(--a-mute)", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textAlign: "center" }}>
        No Project node yet. Onboarding seeds one — if this canvas was
        scaffolded outside onboarding, ask Drafter to propose a Project.
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 20px", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-ink)" }}>
      <ProjectRow project={project} planeCount={planes.length} surfaceCount={surfaces.length} taskRollup={rollupTasks(tasks)} selected={selected} onNodeClick={onNodeClick} />

      <div style={{ marginLeft: 18, marginTop: 8, borderLeft: "1px solid var(--a-line)", paddingLeft: 14 }}>
        {planes.length === 0 ? (
          <EmptyRow text="no planes yet — Drafter proposes Plane(s) once the project layer is set" />
        ) : (
          planes.map(p => (
            <PlaneRow
              key={p.id}
              plane={p}
              surfaces={surfacesForPlane(p.id)}
              storiesForSurface={storiesForSurface}
              tasksUnder={tasksUnder}
              annotationsForParent={annotationsForParent}
              selected={selected}
              onNodeClick={onNodeClick}
            />
          ))
        )}

        {rootAnnotations.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ color: "var(--a-mute)", textTransform: "lowercase", letterSpacing: "0.06em", fontSize: "var(--t-1)", marginBottom: 4 }}>
              cross-cutting
            </div>
            <AnnotationStrip annotations={rootAnnotations} onNodeClick={onNodeClick} selected={selected} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────

function ProjectRow({ project, planeCount, surfaceCount, taskRollup, selected, onNodeClick }: {
  project: NodeMeta;
  planeCount: number;
  surfaceCount: number;
  taskRollup: ReturnType<typeof rollupTasks>;
  selected: string | null;
  onNodeClick: (id: string) => void;
}) {
  const sel = selected === project.id;
  return (
    <button
      type="button"
      onClick={() => onNodeClick(project.id)}
      style={{
        display: "flex", alignItems: "baseline", gap: 8, width: "100%",
        textAlign: "left", padding: "6px 8px", borderRadius: 4,
        background: sel ? "color-mix(in srgb, var(--a-accent) 12%, transparent)" : "transparent",
        border: sel ? "1px solid var(--a-accent)" : "1px solid transparent",
        color: "var(--a-ink)", cursor: "pointer", fontFamily: "var(--font-mono)",
      }}
    >
      <span style={{ color: "var(--a-mute)", fontSize: "var(--t-1)" }}>project</span>
      <strong style={{ fontSize: "var(--t-3)" }}>{project.title || project.intent.slice(0, 40)}</strong>
      {project.layer && <KindChip label={project.layer} />}
      <span style={{ marginLeft: "auto", color: "var(--a-mute)", fontSize: "var(--t-1)" }}>
        {planeCount} planes · {surfaceCount} surfaces · {taskRollup.done}/{taskRollup.total} tasks done
        {taskRollup.review > 0 && ` · ${taskRollup.review} need accept`}
        {taskRollup.blocked > 0 && ` · ${taskRollup.blocked} blocked`}
      </span>
    </button>
  );
}

function PlaneRow({ plane, surfaces, storiesForSurface, tasksUnder, annotationsForParent, selected, onNodeClick }: {
  plane: NodeMeta;
  surfaces: NodeMeta[];
  storiesForSurface: (id: string) => NodeMeta[];
  tasksUnder: (id: string) => NodeMeta[];
  annotationsForParent: (id: string) => NodeMeta[];
  selected: string | null;
  onNodeClick: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const sel = selected === plane.id;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Twisty open={open} onClick={() => setOpen(o => !o)} />
        <button
          type="button"
          onClick={() => onNodeClick(plane.id)}
          style={{
            flex: 1, display: "flex", alignItems: "baseline", gap: 8, textAlign: "left",
            padding: "4px 6px", borderRadius: 3, cursor: "pointer", background: "transparent",
            border: sel ? "1px solid var(--a-accent)" : "1px solid transparent",
            color: "var(--a-ink)", fontFamily: "var(--font-mono)",
          }}
        >
          <KindChip label="plane" />
          <strong>{plane.plane_kind ?? plane.title ?? "plane"}</strong>
          <span style={{ marginLeft: "auto", color: "var(--a-mute)", fontSize: "var(--t-1)" }}>
            {surfaces.length} surface{surfaces.length === 1 ? "" : "s"}
          </span>
        </button>
      </div>
      {open && (
        <div style={{ marginLeft: 18, borderLeft: "1px solid var(--a-line)", paddingLeft: 14 }}>
          {surfaces.length === 0 ? (
            <EmptyRow text="no surfaces — propose one to anchor stories" />
          ) : (
            surfaces.map(s => (
              <SurfaceRow
                key={s.id}
                surface={s}
                stories={storiesForSurface(s.id)}
                tasksUnder={tasksUnder}
                annotationsForParent={annotationsForParent}
                selected={selected}
                onNodeClick={onNodeClick}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SurfaceRow({ surface, stories, tasksUnder, annotationsForParent, selected, onNodeClick }: {
  surface: NodeMeta;
  stories: NodeMeta[];
  tasksUnder: (id: string) => NodeMeta[];
  annotationsForParent: (id: string) => NodeMeta[];
  selected: string | null;
  onNodeClick: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const sel = selected === surface.id;
  const annotations = annotationsForParent(surface.id);
  // Surface task rollup = union of tasks under each Story.
  const allTasks = stories.flatMap(s => tasksUnder(s.id));
  const r = rollupTasks(allTasks);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Twisty open={open} onClick={() => setOpen(o => !o)} />
        <button
          type="button"
          onClick={() => onNodeClick(surface.id)}
          style={{
            flex: 1, display: "flex", alignItems: "baseline", gap: 8, textAlign: "left",
            padding: "3px 6px", borderRadius: 3, cursor: "pointer", background: "transparent",
            border: sel ? "1px solid var(--a-accent)" : "1px solid transparent",
            color: "var(--a-ink)", fontFamily: "var(--font-mono)",
            opacity: surface.surface_status === "deprecated" ? 0.55 : 1,
          }}
        >
          <KindChip label="surface" />
          <strong>{surface.surface_kind ?? surface.title}</strong>
          {surface.surface_status === "deprecated" && (
            <span style={{ color: "var(--sem-orange, #E8A86A)", fontSize: "var(--t-1)" }}>deprecated</span>
          )}
          <span style={{ marginLeft: "auto", color: "var(--a-mute)", fontSize: "var(--t-1)" }}>
            {stories.length} stor{stories.length === 1 ? "y" : "ies"}
            {r.total > 0 && ` · ${r.done}/${r.total} tasks done`}
            {r.review > 0 && ` · ${r.review} review`}
            {r.blocked > 0 && ` · ${r.blocked} blocked`}
          </span>
        </button>
      </div>
      {annotations.length > 0 && (
        <div style={{ marginLeft: 32, marginTop: 2 }}>
          <AnnotationStrip annotations={annotations} onNodeClick={onNodeClick} selected={selected} />
        </div>
      )}
      {open && (
        <div style={{ marginLeft: 18, borderLeft: "1px solid var(--a-line)", paddingLeft: 14 }}>
          {stories.length === 0 ? (
            <EmptyRow text="no stories yet — Drafter proposes Story/Epic with this surface in touches[]" />
          ) : (
            stories.map(s => (
              <StoryRow
                key={s.id}
                story={s}
                taskRollup={rollupTasks(tasksUnder(s.id))}
                annotations={annotationsForParent(s.id)}
                selected={selected}
                onNodeClick={onNodeClick}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function StoryRow({ story, taskRollup, annotations, selected, onNodeClick }: {
  story: NodeMeta;
  taskRollup: ReturnType<typeof rollupTasks>;
  annotations: NodeMeta[];
  selected: string | null;
  onNodeClick: (id: string) => void;
}) {
  const sel = selected === story.id;
  return (
    <div style={{ marginTop: 2 }}>
      <button
        type="button"
        onClick={() => onNodeClick(story.id)}
        style={{
          display: "flex", alignItems: "baseline", gap: 8, width: "100%", textAlign: "left",
          padding: "3px 6px", borderRadius: 3, cursor: "pointer", background: "transparent",
          border: sel ? "1px solid var(--a-accent)" : "1px solid transparent",
          color: "var(--a-ink)", fontFamily: "var(--font-mono)",
        }}
      >
        <KindChip label={story.kind.toLowerCase()} />
        <span>{story.title || story.intent.slice(0, 60)}</span>
        <StateChip state={story.state} />
        <span style={{ marginLeft: "auto", color: "var(--a-mute)", fontSize: "var(--t-1)" }}>
          {taskRollup.total > 0 ? `${taskRollup.done}/${taskRollup.total} tasks` : "no tasks"}
          {taskRollup.review > 0 && ` · ${taskRollup.review} review`}
          {taskRollup.blocked > 0 && ` · ${taskRollup.blocked} blocked`}
        </span>
      </button>
      {annotations.length > 0 && (
        <div style={{ marginLeft: 22, marginTop: 1 }}>
          <AnnotationStrip annotations={annotations} onNodeClick={onNodeClick} selected={selected} />
        </div>
      )}
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────

function Twisty({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "collapse" : "expand"}
      style={{
        width: 16, height: 16, padding: 0, lineHeight: 1, fontSize: "0.7rem",
        background: "transparent", border: 0, color: "var(--a-mute)",
        cursor: "pointer", fontFamily: "var(--font-mono)",
      }}
    >{open ? "▾" : "▸"}</button>
  );
}

function KindChip({ label }: { label: string }) {
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 3, background: "var(--a-paper-2)",
      color: "var(--a-mute)", fontSize: "0.62rem", letterSpacing: "0.06em",
      textTransform: "lowercase",
    }}>{label}</span>
  );
}

function StateChip({ state }: { state: NodeState }) {
  if (!state || state === "done") return null;
  const color =
    state === "blocked" ? "var(--sem-orange, #E8A86A)" :
    state === "review" ? "var(--sem-blue, #6aa9d6)" :
    state === "in-progress" ? "var(--a-accent)" :
    "var(--a-mute)";
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 3, fontSize: "0.62rem",
      letterSpacing: "0.04em", textTransform: "lowercase",
      color, border: `1px solid ${color}`,
    }}>{state}</span>
  );
}

function AnnotationStrip({ annotations, onNodeClick, selected }: {
  annotations: NodeMeta[];
  onNodeClick: (id: string) => void;
  selected: string | null;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {annotations.map(a => {
        const sel = selected === a.id;
        const color = annotationColor(a.kind as AnnotationKind);
        const glyph = annotationGlyph(a.kind as AnnotationKind);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onNodeClick(a.id)}
            title={`${a.kind}: ${a.intent.slice(0, 200)}`}
            style={{
              display: "inline-flex", alignItems: "baseline", gap: 4,
              padding: "1px 7px", borderRadius: 3, cursor: "pointer",
              background: sel ? "color-mix(in srgb, var(--a-accent) 12%, transparent)" : "transparent",
              border: `1px solid ${color}`,
              color, fontFamily: "var(--font-mono)", fontSize: "0.66rem",
            }}
          >
            <span aria-hidden>{glyph}</span>
            <span>{a.kind.toLowerCase()}</span>
            <span style={{ color: "var(--a-mute)", marginLeft: 2 }}>
              {(a.title || a.intent).slice(0, 32)}{(a.title || a.intent).length > 32 ? "…" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div style={{ padding: "4px 0", color: "var(--a-mute)", fontStyle: "italic", fontSize: "var(--t-1)" }}>
      {text}
    </div>
  );
}
