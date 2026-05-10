import { useEffect, useRef } from "react";

/* Brainspace — a quiet neural field. The visitor should feel like they're
 * floating *inside* a brain, not watching fireworks above one. So:
 *
 *   - High node density at low intensity (you're surrounded by cells, not
 *     looking at distant stars).
 *   - Three parallax layers (far / mid / near) with slow ambient drift,
 *     giving genuine depth instead of flat motion.
 *   - Cool tissue palette: cyans, violets, soft whites — with occasional
 *     warm sparks. Pinks and reds are rare; they read as alarm in the field
 *     rather than baseline.
 *   - Synapses are thin and stable; pulses travel slowly with long fading
 *     tails — closer to an axon firing than a flare.
 *   - Chain propagation is uncommon (≈15%), so the field stays atmospheric
 *     instead of cascading into bursts.
 *   - Soft fog layers drift independently in the background, simulating
 *     diffuse tissue glow you can't quite focus on.
 */

type Kind = "axon" | "violet" | "cyan" | "amber" | "lime";

const COLORS: Record<Kind, [number, number, number]> = {
  axon:   [200, 220, 245], // pale white-blue, the dominant tissue color
  violet: [232, 144, 96],
  cyan:   [125, 211, 252],
  amber:  [243, 200, 130], // warm but muted, reads as "warmth" not "fire"
  lime:   [170, 220, 150],
};

const KIND_DIST: { kind: Kind; w: number }[] = [
  { kind: "axon",   w: 0.55 },
  { kind: "violet", w: 0.22 },
  { kind: "cyan",   w: 0.13 },
  { kind: "amber",  w: 0.06 },
  { kind: "lime",   w: 0.04 },
];

function pickKind(): Kind {
  const r = Math.random();
  let acc = 0;
  for (const { kind, w } of KIND_DIST) {
    acc += w;
    if (r < acc) return kind;
  }
  return "axon";
}

type Layer = 0 | 1 | 2; // 0 = far, 2 = near

interface Node {
  id: number;
  x: number;
  y: number;
  layer: Layer;
  vx: number;
  vy: number;
  size: number;
  baseAlpha: number;
  kind: Kind;
  activation: number;
  neighbors: number[];
}

interface Pulse {
  src: number;
  dst: number;
  t: number;
  speed: number;
  color: Kind;
  life: number;
}

interface FogBlob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: Kind;
}

interface ParticlesProps {
  count?: number;
  linkDistance?: number;
  speed?: number;
  className?: string;
}

export function Particles({
  count = 320,
  linkDistance = 90,
  speed = 0.05,
  className = "",
}: ParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let dpr = window.devicePixelRatio || 1;
    let w = 0;
    let h = 0;
    let nodes: Node[] = [];
    let pulses: Pulse[] = [];
    let fog: FogBlob[] = [];
    let raf = 0;
    let last = performance.now();
    let nextFire = performance.now() + 200;
    let neighborTick = 0;
    let breath = 0; // 0..1 looping for ambient brightness modulation

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function spawn(id: number): Node {
      // Layer distribution: more density in mid + far, fewer near (foreground
      // would otherwise dominate visually)
      const r = Math.random();
      const layer: Layer = r < 0.45 ? 0 : r < 0.85 ? 1 : 2;
      const layerSpeed = layer === 2 ? 1.0 : layer === 1 ? 0.65 : 0.4;
      const layerSize = layer === 2 ? 1.6 : layer === 1 ? 1.0 : 0.6;
      const layerAlpha = layer === 2 ? 0.55 : layer === 1 ? 0.32 : 0.18;
      return {
        id,
        x: Math.random() * w,
        y: Math.random() * h,
        layer,
        vx: (Math.random() - 0.5) * speed * layerSpeed,
        vy: (Math.random() - 0.5) * speed * layerSpeed - 0.012,
        size: layerSize * (0.7 + Math.random() * 0.6),
        baseAlpha: layerAlpha,
        kind: pickKind(),
        activation: 0,
        neighbors: [],
      };
    }

    function spawnFog(): FogBlob {
      const kinds: Kind[] = ["axon", "violet", "cyan"];
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.012,
        vy: (Math.random() - 0.5) * 0.012,
        r: 220 + Math.random() * 260,
        color: kinds[Math.floor(Math.random() * kinds.length)],
      };
    }

    function recomputeNeighbors() {
      const max2 = linkDistance * linkDistance;
      for (const n of nodes) n.neighbors = [];
      // Only connect within same or adjacent layers — distant layers
      // shouldn't have visible synapses, that breaks the depth illusion
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (Math.abs(a.layer - b.layer) > 1) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy < max2) {
            a.neighbors.push(j);
            b.neighbors.push(i);
          }
        }
      }
    }

    function fire(srcId: number, color: Kind, life: number) {
      const src = nodes[srcId];
      if (!src) return;
      src.activation = Math.min(1, src.activation + 0.7);
      const pool = src.neighbors.slice();
      // Most fires send a single pulse — chain rarely
      const want = Math.min(pool.length, Math.random() < 0.75 ? 1 : 2);
      for (let i = 0; i < want; i++) {
        if (pool.length === 0 || pulses.length > 60) break;
        const idx = Math.floor(Math.random() * pool.length);
        const dst = pool.splice(idx, 1)[0];
        pulses.push({
          src: srcId,
          dst,
          t: 0,
          speed: 0.0007 + Math.random() * 0.0006, // ~1.5–2.4s edge traversal
          color,
          life,
        });
      }
    }

    function rgb(kind: Kind, alpha: number): string {
      const [r, g, b] = COLORS[kind];
      return `rgba(${r}, ${g}, ${b}, ${Math.max(0, alpha).toFixed(3)})`;
    }

    function step(now: number) {
      const dt = Math.min(64, now - last);
      last = now;
      breath = (breath + dt * 0.00012) % 1;
      const breathBoost = 0.5 + 0.5 * Math.sin(breath * Math.PI * 2);

      ctx!.clearRect(0, 0, w, h);

      // Drifting fog layer first — far depth cue
      ctx!.globalCompositeOperation = "lighter";
      for (const f of fog) {
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.x < -f.r) f.x = w + f.r;
        else if (f.x > w + f.r) f.x = -f.r;
        if (f.y < -f.r) f.y = h + f.r;
        else if (f.y > h + f.r) f.y = -f.r;

        const grad = ctx!.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
        const a = 0.045 + breathBoost * 0.025;
        grad.addColorStop(0, rgb(f.color, a));
        grad.addColorStop(0.5, rgb(f.color, a * 0.4));
        grad.addColorStop(1, rgb(f.color, 0));
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";

      // Drift + decay
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (n.x < -10) n.x = w + 10;
        else if (n.x > w + 10) n.x = -10;
        if (n.y < -10) n.y = h + 10;
        else if (n.y > h + 10) n.y = -10;
        n.activation *= Math.pow(0.992, dt);
      }

      neighborTick += dt;
      if (neighborTick > 380) {
        neighborTick = 0;
        recomputeNeighbors();
      }

      // Random firing — frequent but small. Bias toward mid+near layers
      // so the visible action is in your "depth of field," not far away.
      if (now > nextFire) {
        const layerWeights = [0.15, 0.45, 0.40];
        const r = Math.random();
        let pickLayer: Layer = 1;
        if (r < layerWeights[0]) pickLayer = 0;
        else if (r < layerWeights[0] + layerWeights[1]) pickLayer = 1;
        else pickLayer = 2;
        const pool: number[] = [];
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].layer === pickLayer) pool.push(i);
        }
        if (pool.length > 0) {
          const idx = pool[Math.floor(Math.random() * pool.length)];
          fire(idx, nodes[idx].kind, 1);
        }
        nextFire = now + 78 + Math.random() * 200;
      }

      // Synapses — drawn first as the resting baseline of the field
      const max = linkDistance;
      ctx!.lineWidth = 0.4;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (const j of a.neighbors) {
          if (j <= i) continue;
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const t = 1 - d / max;
          if (t <= 0) continue;
          const layerMin = Math.min(a.layer, b.layer);
          const layerAlpha = layerMin === 2 ? 0.10 : layerMin === 1 ? 0.06 : 0.035;
          ctx!.strokeStyle = `rgba(180, 200, 240, ${(t * layerAlpha).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      // Pulses — slow traveling lights along synapses
      ctx!.globalCompositeOperation = "lighter";
      const surviving: Pulse[] = [];
      for (const p of pulses) {
        p.t += p.speed * dt;
        const src = nodes[p.src];
        const dst = nodes[p.dst];
        if (!src || !dst) continue;

        const px = src.x + (dst.x - src.x) * p.t;
        const py = src.y + (dst.y - src.y) * p.t;

        // Long fading tail — gives the "current flowing along axon" feel
        const tailFrom = Math.max(0, p.t - 0.35);
        const tx = src.x + (dst.x - src.x) * tailFrom;
        const ty = src.y + (dst.y - src.y) * tailFrom;
        const grad = ctx!.createLinearGradient(tx, ty, px, py);
        grad.addColorStop(0, rgb(p.color, 0));
        grad.addColorStop(0.7, rgb(p.color, 0.18));
        grad.addColorStop(1, rgb(p.color, 0.55));
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1.0;
        ctx!.beginPath();
        ctx!.moveTo(tx, ty);
        ctx!.lineTo(px, py);
        ctx!.stroke();

        // Soft leading head — small and gentle, not a firework
        const r = 3.5;
        const dotGrad = ctx!.createRadialGradient(px, py, 0, px, py, r);
        dotGrad.addColorStop(0, rgb(p.color, 0.7));
        dotGrad.addColorStop(0.5, rgb(p.color, 0.25));
        dotGrad.addColorStop(1, rgb(p.color, 0));
        ctx!.fillStyle = dotGrad;
        ctx!.beginPath();
        ctx!.arc(px, py, r, 0, Math.PI * 2);
        ctx!.fill();

        if (p.t < 1) {
          surviving.push(p);
        } else {
          dst.activation = Math.min(1, dst.activation + 0.55);
          // Rare propagation — most pulses just arrive and rest
          if (p.life > 0 && Math.random() < 0.18) {
            fire(p.dst, p.color, p.life - 1);
          }
        }
      }
      pulses = surviving;

      // Nodes — small, dim baseline; activation adds a soft halo
      for (const n of nodes) {
        const baseA = n.baseAlpha + breathBoost * 0.04 * (n.layer + 1) * 0.25;
        const actBoost = n.activation;

        // Halo only when active — at rest, nodes are tiny points
        if (actBoost > 0.05) {
          const haloR = (n.size + actBoost * 3.5) * 4.5;
          const halo = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, haloR);
          halo.addColorStop(0, rgb(n.kind, 0.45 * actBoost));
          halo.addColorStop(0.4, rgb(n.kind, 0.16 * actBoost));
          halo.addColorStop(1, rgb(n.kind, 0));
          ctx!.fillStyle = halo;
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, haloR, 0, Math.PI * 2);
          ctx!.fill();
        }

        // Tiny resting body — what the field looks like when nothing's firing
        ctx!.fillStyle = rgb(n.kind, baseA + actBoost * 0.5);
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.size + actBoost * 0.8, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";

      raf = requestAnimationFrame(step);
    }

    function init() {
      resize();
      nodes = Array.from({ length: count }, (_, i) => spawn(i));
      pulses = [];
      // 5 ambient fog blobs — provides depth without dominating
      fog = Array.from({ length: 5 }, () => spawnFog());
      recomputeNeighbors();
    }

    init();
    raf = requestAnimationFrame(step);
    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [count, linkDistance, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
