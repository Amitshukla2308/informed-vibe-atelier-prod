/**
 * Canvas layout helper — shared by LiveGraph (Now pane) and Canvas (full view).
 *
 * Picks the "real" root (most descendants) when multiple orphan Project nodes
 * exist, BFS-assigns rings 0→3 from that root, then evenly distributes angles
 * per ring so nodes don't cluster. Orphans/disconnected nodes land at ring 3
 * so the real tree dominates the layout.
 */

import type { NodeMeta } from "./api";

export interface RingAngle { ring: number; angle: number; }

export function computeRingsAngles(nodes: NodeMeta[]): Map<string, RingAngle> {
  const result = new Map<string, RingAngle>();
  if (nodes.length === 0) return result;

  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent_id) {
      if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, []);
      childrenOf.get(n.parent_id)!.push(n.id);
    }
  }

  // Root candidates = nodes with no parent. Of those, prefer the one with the
  // most descendants — this avoids an orphan duplicate Project being chosen as
  // root and pushing the real tree out to ring 3.
  const roots = nodes.filter(n => !n.parent_id);
  function countDescendants(id: string, seen: Set<string> = new Set()): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = childrenOf.get(id) ?? [];
    return kids.length + kids.reduce((s, k) => s + countDescendants(k, seen), 0);
  }
  const primaryRoot =
    roots.length === 0
      ? nodes[0]
      : roots.reduce((best, n) => countDescendants(n.id) > countDescendants(best.id) ? n : best, roots[0]);

  // BFS from primary root assigning rings 0..3
  const queue: Array<{ id: string; ring: number }> = [{ id: primaryRoot.id, ring: 0 }];
  while (queue.length > 0) {
    const { id, ring } = queue.shift()!;
    if (result.has(id)) continue;
    result.set(id, { ring, angle: 0 });
    for (const cid of childrenOf.get(id) ?? []) {
      if (!result.has(cid)) queue.push({ id: cid, ring: Math.min(ring + 1, 3) });
    }
  }

  // Unreached nodes (orphans, disconnected components) → ring 3
  for (const n of nodes) {
    if (!result.has(n.id)) result.set(n.id, { ring: 3, angle: 0 });
  }

  // Distribute angles evenly per ring
  const byRing = new Map<number, string[]>([[0, []], [1, []], [2, []], [3, []]]);
  for (const [id, { ring }] of result) byRing.get(ring)!.push(id);
  for (const [ring, ids] of byRing) {
    const N = ids.length;
    ids.forEach((id, i) => {
      const angle = ring === 0 && N === 1 ? 0 : (i * 360) / Math.max(N, 1);
      result.set(id, { ring, angle });
    });
  }

  return result;
}
