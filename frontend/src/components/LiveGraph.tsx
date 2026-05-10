import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeMeta } from "../lib/api";
import { computeRingsAngles } from "../lib/canvas-layout";

interface Edge { from: string; to: string; kind: string; }

export type LiveGraphNode = NodeMeta & { ring: number; angle: number };

interface Props {
  project: string;
  baseUrl: string;
  // Fires from the pinned card's "open in canvas →" button — NOT on bare node click.
  // Bare click pins the card (internal state); the button propagates the intent up.
  onNodeClick?: (node: LiveGraphNode) => void;
}

export function LiveGraph({ project, baseUrl, onNodeClick }: Props) {
  const [nodes, setNodes] = useState<(NodeMeta & { ring: number; angle: number })[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 400 });
  // Pan + zoom state — same UX pattern as the full Canvas view
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // Track whether the current down→up cycle moved the cursor — lets us
  // distinguish a pan drag from a plain background click (for unpin).
  const wasDrag = useRef(false);

  // Esc dismisses a pinned card. Hover card doesn't need Esc — it dies on mouseleave.
  useEffect(() => {
    if (!pinned) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPinned(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  useEffect(() => {
    let cancelled = false;
    const refetch = () => {
      fetch(`${baseUrl}/canvas/graph?project=${encodeURIComponent(project)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          if (cancelled || !data?.nodes) { if (!cancelled) setLoading(false); return; }
          const ra = computeRingsAngles(data.nodes);
          setNodes(data.nodes.map((n: NodeMeta) => ({ ...n, ...(ra.get(n.id) ?? { ring: 3, angle: 0 }) })));
          setEdges(data.edges ?? []);
          setLoading(false);
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    };
    refetch();
    const poll = setInterval(refetch, 4000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [baseUrl, project]);

  useEffect(() => {
    function fit() {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return;
      setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    }
    fit();
    requestAnimationFrame(() => requestAnimationFrame(fit));
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;

  const pos = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    const cx = w / 2, cy = h / 2;
    const rings = {
      0: { rx: 0, ry: 0 },
      1: { rx: w * 0.18, ry: h * 0.16 },
      2: { rx: w * 0.34, ry: h * 0.32 },
      3: { rx: w * 0.44, ry: h * 0.44 },
    } as const;
    nodes.forEach(n => {
      if (n.ring === 0) { out[n.id] = { x: cx, y: cy }; return; }
      const ring = rings[n.ring as keyof typeof rings] ?? rings[3];
      const a = (n.angle ?? 0) * Math.PI / 180;
      out[n.id] = { x: cx + ring.rx * Math.cos(a - Math.PI / 2), y: cy + ring.ry * Math.sin(a - Math.PI / 2) };
    });
    return out;
  }, [nodes, w, h]);

  const badgeColor: Record<string, string> = {
    "done": "var(--sem-green)",
    "in-progress": "var(--sem-blue)",
    "blocked": "var(--sem-orange)",
    "review": "var(--sem-amber)",
    "proposed": "var(--sem-grey)",
    "drift": "var(--sem-red)",
    "auto": "var(--sem-plum)",
  };

  // Pinned takes priority: if a node is pinned, show the pinned card even
  // while hovering a different node (swapping would feel twitchy).
  const displayedNodeId = pinned ?? hover;
  const displayedNode = displayedNodeId ? nodes.find(n => n.id === displayedNodeId) ?? null : null;
  const isPinned = !!pinned && !!displayedNode && displayedNode.id === pinned;

  // Pan handlers — only the empty background drags; node/svg children don't
  const onDown = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName === "circle" || el.tagName === "g" || el.closest(".lg-node") || el.closest(".lg-peek-card")) return;
    wasDrag.current = false;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  }, [view.x, view.y]);
  const onMove = useCallback((e: React.MouseEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (!wasDrag.current && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) wasDrag.current = true;
    setView(v => ({ ...v, x: drag.current!.vx + dx, y: drag.current!.vy + dy }));
  }, []);
  const onUp = useCallback((e?: React.MouseEvent) => {
    // If the cursor didn't move meaningfully between down and up, treat as a
    // background click → unpin. Clicks that land inside a node or the peek card
    // are ignored by onDown so drag.current stays null; those don't reach here.
    if (drag.current && !wasDrag.current && e) {
      const t = e.target as HTMLElement;
      if (!t.closest(".lg-node") && !t.closest(".lg-peek-card")) {
        setPinned(null);
      }
    }
    drag.current = null;
    wasDrag.current = false;
  }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setView(v => ({ ...v, k: Math.max(0.5, Math.min(2.5, v.k * factor)) }));
  }, []);

  if (loading) {
    return (
      <div ref={wrapRef} style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase" }}>
        loading canvas…
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div ref={wrapRef} style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", textAlign: "center", lineHeight: 1.6 }}>
        canvas is empty<br />start talking — nodes appear here as carlsbert proposes them
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "absolute", inset: 0, overflow: "hidden", cursor: drag.current ? "grabbing" : "grab" }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={(e) => onUp(e)}
      onMouseLeave={() => onUp()}
      onWheel={onWheel}
    >
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
      >
        {[
          { rx: w * 0.18, ry: h * 0.16 },
          { rx: w * 0.34, ry: h * 0.32 },
          { rx: w * 0.44, ry: h * 0.44 },
        ].map((r, i) => (
          <ellipse key={i} cx={w / 2} cy={h / 2} rx={r.rx} ry={r.ry} fill="none" stroke="var(--a-line)" strokeWidth={1} strokeDasharray="2 4" opacity={0.4} />
        ))}
        {edges.map((e, i) => {
          const a = pos[e.from], b = pos[e.to]; if (!a || !b) return null;
          const isHot = hover && (e.from === hover || e.to === hover);
          const stroke = e.kind === "depends-on" ? "var(--a-accent)" : e.kind === "blocks" ? "var(--sem-orange)" : "var(--a-line-2)";
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={isHot ? 1.5 : 0.8} opacity={isHot ? 1 : 0.5} />;
        })}
        {nodes.map(n => {
          const p = pos[n.id]; if (!p) return null;
          const isHot = hover === n.id || pinned === n.id;
          const isPin = pinned === n.id;
          const color = badgeColor[n.badge] || "var(--a-line-2)";
          const r = n.ring === 0 ? 8 : isHot ? 7 : 5;
          return (
            <g
              key={n.id}
              className="lg-node"
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(h => h === n.id ? null : h)}
              onClick={(e) => {
                e.stopPropagation();
                // First click pins; same-node second click opens. Switching to a
                // different node while pinned just moves the pin.
                if (pinned === n.id) {
                  onNodeClick?.(n);
                } else {
                  setPinned(n.id);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <circle cx={p.x} cy={p.y} r={r + 4} fill="var(--a-page)" opacity={0.6} />
              <circle cx={p.x} cy={p.y} r={r} fill={color} stroke={isPin ? "var(--a-accent)" : isHot ? "var(--a-accent)" : "var(--a-page)"} strokeWidth={isPin ? 2.5 : isHot ? 2 : 1} />
            </g>
          );
        })}
      </svg>

      {displayedNode && (
        <div
          className="lg-peek-card"
          data-pinned={isPinned ? "1" : "0"}
          style={{
            position: "absolute", top: 44, left: 12, right: 12,
            background: "var(--a-paper)",
            border: isPinned ? "1px solid var(--a-accent)" : "1px solid var(--a-line-2)",
            borderRadius: 4,
            padding: "8px 12px",
            boxShadow: isPinned ? "0 6px 16px rgba(0,0,0,0.09)" : "0 4px 12px rgba(0,0,0,0.06)",
            pointerEvents: isPinned ? "auto" : "none",
            zIndex: 2,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", marginBottom: 3 }}>
            <span>{displayedNode.kind.toLowerCase()} · ring {displayedNode.ring} · {displayedNode.badge}</span>
            {isPinned && <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, color: "var(--a-accent)" }}>● pinned</span>}
          </div>
          <div style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", lineHeight: 1.4 }}>
            {displayedNode.intent.length > 180 ? displayedNode.intent.slice(0, 180) + "…" : displayedNode.intent}
          </div>
          {isPinned && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 6, borderTop: "1px dashed var(--a-line)" }}>
              <button
                onClick={(e) => { e.stopPropagation(); if (onNodeClick && displayedNode) { onNodeClick(displayedNode); setPinned(null); } }}
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "3px 10px", border: "1px solid var(--a-accent)", borderRadius: 3, background: "transparent", color: "var(--a-accent)", cursor: "pointer", textTransform: "lowercase" }}
              >
                open in canvas →
              </button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>click a dot again, or esc, to dismiss</span>
              <button
                onClick={(e) => { e.stopPropagation(); setPinned(null); }}
                aria-label="dismiss"
                style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--a-mute)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}
              >×</button>
            </div>
          )}
        </div>
      )}

      {/* Pan/zoom hint */}
      <div style={{ position: "absolute", bottom: 40, right: 12, display: "flex", gap: 4, zIndex: 3, pointerEvents: "auto" }}>
        <button
          onClick={(e) => { e.stopPropagation(); setView(v => ({ ...v, k: Math.min(2.5, v.k * 1.15) })); }}
          style={{ width: 24, height: 24, fontSize: 14, background: "var(--a-paper)", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)" }}>+</button>
        <button
          onClick={(e) => { e.stopPropagation(); setView(v => ({ ...v, k: Math.max(0.5, v.k * 0.87) })); }}
          style={{ width: 24, height: 24, fontSize: 14, background: "var(--a-paper)", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)" }}>−</button>
        <button
          onClick={(e) => { e.stopPropagation(); setView({ x: 0, y: 0, k: 1 }); }}
          style={{ height: 24, padding: "0 8px", fontSize: 10, fontFamily: "var(--font-mono)", background: "var(--a-paper)", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase" }}>reset</button>
      </div>
    </div>
  );
}
