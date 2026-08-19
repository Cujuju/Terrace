// Frontier boundary derivation: the chunk-grid edges between the player's
// revealed territory and everything beyond it.
//
// Pure and Three.js-free (like mirror.ts), so the boundary rule is unit-
// tested without a renderer — see test/frontier.test.ts.
//
// WHY THIS EXISTS (the frontier "skirt" inconsistency, diagnosed 2026-08-19).
// mirror.ts documents the old plan on purpose: cells of a never-received
// chunk stay at their allocated zero (SEA_LEVEL), so vertexGrid.ts — which
// samples one cell PAST a chunk's own border for contour continuity (SEAM
// CONTRACT S1 in that file) — reads a phantom sea-level neighbour there. A
// received chunk whose edge terrain sits ABOVE sea level then contours a real
// band boundary between its own height and that phantom zero, and the SAME
// skirt machinery that draws every interior terrace cliff (vertexGrid.ts's
// SKIRTS step) draws a wall there too — indistinguishable from any other
// cliff, because nothing marks it as a frontier. Where the edge terrain is
// AT or BELOW sea level instead (unraised ground, or still underwater), the
// real sample and the phantom sample land in the same band and no contour —
// so no skirt — is ever generated. That is the whole inconsistency: whether
// the frontier shows a cliff is an accident of the LOCAL HEIGHT at the edge,
// never a deliberate, uniform statement that "revealed territory ends here".
// — FIXED at the sampling layer since issue #22: mirror.sampleRenderHeight now
// pulls a sample in a never-received chunk back onto received terrain, so the
// accidental frontier cliff is no longer drawn at all and the mist built from
// this module is the frontier's ONLY rendering. The diagnosis above is kept
// because it documents why the fix lives in the sampler, not here.
//
// This module deliberately reads none of that. A frontier edge is a fact
// about the RECEIVED-CHUNK SET alone — never a height — which is what makes
// the mist curtain built from it consistent by construction: every side of
// every received chunk that does not lead into another received chunk gets
// exactly one segment, whatever the terrain does on either side of it.

import { CHUNK_SIZE } from '@terrace/shared';

export type FrontierDirection = 'N' | 'E' | 'S' | 'W';

/**
 * Fixed iteration order for every derivation and render pass that walks the
 * four sides of a chunk. Not load-bearing for correctness (the output is
 * sorted below regardless), but keeps emission order deterministic without
 * relying on object-key enumeration order.
 */
export const FRONTIER_DIRECTIONS: readonly FrontierDirection[] = ['N', 'E', 'S', 'W'];

/** Chunk-grid offset to the neighbour across each side. */
const NEIGHBOR_OFFSET: Readonly<Record<FrontierDirection, readonly [dx: number, dy: number]>> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

export interface FrontierEdge {
  readonly cx: number;
  readonly cy: number;
  readonly dir: FrontierDirection;
}

/** Stable identity for a frontier edge: (cx, cy, dir) never repeats. */
export function frontierEdgeKey(edge: FrontierEdge): string {
  return `${edge.cx},${edge.cy},${edge.dir}`;
}

/**
 * The exact set of chunk-grid sides that face away from revealed territory.
 *
 * A side belongs to the frontier iff its own chunk IS received and the
 * neighbour across that side is NOT — either because the neighbour chunk
 * exists but has not arrived, or because the side is the world's own outer
 * edge and has no neighbour at all. The outer rim of a fully revealed world
 * is frontier too, by the same rule as every inland edge: this function has
 * no special case for it, which is exactly the point (§ above).
 *
 * Concave shapes and holes fall out for free: a hole is simply chunks that
 * were never marked received, so every received chunk ringing it emits a
 * segment on the side facing in, and those segments compose into a closed
 * inner loop with no extra bookkeeping. Likewise a concave outer corner
 * emits two segments (not one merged one) from the chunk at the notch — both
 * correct, since a mist curtain needs no explicit polygon, only its edges.
 *
 * Iterates `received` in a fixed (row-major) chunk order and a fixed
 * direction order, regardless of the Set's insertion order — chunks arrive
 * in whatever order the network delivered them, and two callers handed the
 * same received set must get back the same array.
 */
export function frontierEdges(
  received: ReadonlySet<number>,
  chunkCols: number,
): FrontierEdge[] {
  const orderedIndices = Array.from(received).sort((a, b) => a - b);
  const edges: FrontierEdge[] = [];
  for (const idx of orderedIndices) {
    const cx = idx % chunkCols;
    const cy = (idx - cx) / chunkCols;
    for (const dir of FRONTIER_DIRECTIONS) {
      const [dx, dy] = NEIGHBOR_OFFSET[dir];
      const nx = cx + dx;
      const ny = cy + dy;
      const neighborInBounds = nx >= 0 && nx < chunkCols && ny >= 0 && ny < chunkCols;
      const neighborReceived = neighborInBounds && received.has(ny * chunkCols + nx);
      if (!neighborReceived) edges.push({ cx, cy, dir });
    }
  }
  return edges;
}

/** World-plane endpoints of one frontier edge's chunk side, in cell units. */
export interface FrontierEdgeSpan {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/**
 * The (x0,z0) -> (x1,z1) segment a frontier edge occupies, in the same
 * cell-unit world plane vertexGrid.ts builds terrain caps in: a chunk's
 * domain origin is (cx*CHUNK_SIZE, cy*CHUNK_SIZE) and it spans CHUNK_SIZE
 * cells on a side (see that file's SEAM CONTRACT S2). Walked clockwise
 * looking down +Y so a caller that wants a consistent outward-facing winding
 * has one; the fog curtain itself does not need it (rendered DoubleSide,
 * since a frontier can be viewed from outside the world too).
 */
export function frontierEdgeSpan(edge: FrontierEdge): FrontierEdgeSpan {
  const x0 = edge.cx * CHUNK_SIZE;
  const z0 = edge.cy * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;
  switch (edge.dir) {
    case 'N':
      return { x0, z0, x1, z1: z0 };
    case 'E':
      return { x0: x1, z0, x1, z1 };
    case 'S':
      return { x0: x1, z0: z1, x1: x0, z1 };
    case 'W':
      return { x0, z0: z1, x1: x0, z1: z0 };
  }
}
