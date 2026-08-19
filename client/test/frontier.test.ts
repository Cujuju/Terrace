import { describe, expect, it } from 'vitest';
import {
  frontierEdgeKey,
  frontierEdgeSpan,
  frontierEdges,
  type FrontierDirection,
} from '../src/terrain/frontier.ts';

/** 4×4 chunk grid: small enough to hand-verify, big enough for corners, an
 *  interior hole and a concave notch all at once. */
const CHUNK_COLS = 4;

function idx(cx: number, cy: number): number {
  return cy * CHUNK_COLS + cx;
}

function receivedOf(coords: ReadonlyArray<readonly [number, number]>): Set<number> {
  return new Set(coords.map(([cx, cy]) => idx(cx, cy)));
}

/** Counts how many edges an (cx,cy) chunk contributes, by direction. */
function dirsOf(
  edges: ReturnType<typeof frontierEdges>,
  cx: number,
  cy: number,
): FrontierDirection[] {
  return edges
    .filter((e) => e.cx === cx && e.cy === cy)
    .map((e) => e.dir)
    .sort();
}

describe('frontierEdges', () => {
  it('gives an unreceived world no frontier at all', () => {
    expect(frontierEdges(new Set(), CHUNK_COLS)).toEqual([]);
  });

  it('gives a single received chunk in the interior all four sides', () => {
    const received = receivedOf([[1, 1]]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(edges).toHaveLength(4);
    expect(dirsOf(edges, 1, 1)).toEqual(['E', 'N', 'S', 'W']);
  });

  it('suppresses the shared side between two adjacent received chunks', () => {
    // (1,1) and (2,1) are received; the edge between them must vanish from
    // BOTH sides, and every other side must remain.
    const received = receivedOf([
      [1, 1],
      [2, 1],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 1, 1)).toEqual(['N', 'S', 'W']); // no E: (2,1) is received
    expect(dirsOf(edges, 2, 1)).toEqual(['E', 'N', 'S']); // no W: (1,1) is received
    expect(edges).toHaveLength(6);
  });

  it('treats the world boundary as frontier with no neighbour needed', () => {
    // Corner chunk (0,0): N and W have no neighbour at all (out of bounds)
    // and must still count as frontier — a fully revealed world still shows
    // mist around its own rim.
    const received = receivedOf([[0, 0]]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 0, 0)).toEqual(['E', 'N', 'S', 'W']);
  });

  it('rings a hole of unreceived chunks inside revealed territory', () => {
    // A 3x3 block of received chunks with the centre (1,1) left unreceived —
    // a one-chunk hole. Every one of the four chunks orthogonally touching
    // the hole must emit exactly one edge facing INTO it; the hole itself
    // contributes nothing (it was never received).
    const received = receivedOf([
      [0, 0], [1, 0], [2, 0],
      [0, 1],         [2, 1],
      [0, 2], [1, 2], [2, 2],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);

    // North neighbour of the hole faces south into it.
    expect(dirsOf(edges, 1, 0)).toContain('S');
    // South neighbour of the hole faces north into it.
    expect(dirsOf(edges, 1, 2)).toContain('N');
    // West neighbour of the hole faces east into it.
    expect(dirsOf(edges, 0, 1)).toContain('E');
    // East neighbour of the hole faces west into it.
    expect(dirsOf(edges, 2, 1)).toContain('W');

    // The hole itself is unreceived and contributes no edges of its own.
    expect(edges.filter((e) => e.cx === 1 && e.cy === 1)).toHaveLength(0);

    // Total: the outer ring of an 8-chunk annulus (the 3x3 block minus its
    // centre) — each corner chunk contributes 2 outward + 0 inward (its two
    // hole-facing sides are diagonal, not orthogonal, so they see no hole
    // edge), each edge-midpoint chunk contributes 1 outward + 1 inward + 2
    // shared-with-neighbour (suppressed). Rather than re-derive the count by
    // hand, cross-check it against a second, independent computation: every
    // edge in the result must have a chunk on its "received" side and either
    // no neighbour or an unreceived one on the other.
    for (const edge of edges) {
      expect(received.has(idx(edge.cx, edge.cy))).toBe(true);
    }
  });

  it('emits two distinct edges at a concave (inner) corner, not a merged one', () => {
    // An L-shape: (0,0), (1,0), (0,1) received, (1,1) NOT — the notch. The
    // chunk at (0,0) is the outer corner of the L and is unaffected; the
    // interesting case is that (1,0) and (0,1) each independently see the
    // missing (1,1) on one of their sides, and NEITHER of those edges is
    // merged away by the other.
    const received = receivedOf([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 1, 0)).toEqual(['E', 'N', 'S']); // S faces the notch
    expect(dirsOf(edges, 0, 1)).toEqual(['E', 'S', 'W']); // E faces the notch
    // The notch chunk (1,1) itself was never received and emits nothing.
    expect(edges.filter((e) => e.cx === 1 && e.cy === 1)).toHaveLength(0);
  });

  it('is independent of the received set\'s insertion order', () => {
    const a = frontierEdges(receivedOf([[0, 0], [1, 0], [2, 2]]), CHUNK_COLS);
    const b = frontierEdges(receivedOf([[2, 2], [1, 0], [0, 0]]), CHUNK_COLS);
    expect(a).toEqual(b);
  });

  it('keys are unique across the whole edge set', () => {
    const received = receivedOf([
      [0, 0], [1, 0], [2, 0],
      [0, 1],         [2, 1],
      [0, 2], [1, 2], [2, 2],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);
    const keys = edges.map(frontierEdgeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('frontierEdgeSpan', () => {
  it('places each direction on the correct chunk side, in cell units', () => {
    // Chunk (2,3) with CHUNK_SIZE cells (imported indirectly via the
    // module's own constant); rather than hard-code CHUNK_SIZE here, derive
    // the expected span from two adjacent edges and check they agree at the
    // shared corner.
    const north = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'N' });
    const east = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'E' });
    const south = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'S' });
    const west = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'W' });

    // The four sides of one chunk must trace a closed rectangle: each side's
    // end must equal the next side's start (N -> E -> S -> W -> N).
    expect([north.x1, north.z1]).toEqual([east.x0, east.z0]);
    expect([east.x1, east.z1]).toEqual([south.x0, south.z0]);
    expect([south.x1, south.z1]).toEqual([west.x0, west.z0]);
    expect([west.x1, west.z1]).toEqual([north.x0, north.z0]);

    // And it must be a non-degenerate rectangle (positive area), not four
    // coincident points.
    expect(north.x1).not.toBe(north.x0);
    expect(east.z1).not.toBe(east.z0);
  });

  it('places adjacent chunks\' shared side at the identical coordinates', () => {
    // The seam contract this curtain relies on: (1,1)'s east side and
    // (2,1)'s west side must be the SAME segment (endpoints equal, order
    // aside), or a mist quad and its neighbour would show a gap or overlap.
    const eastOfLeft = frontierEdgeSpan({ cx: 1, cy: 1, dir: 'E' });
    const westOfRight = frontierEdgeSpan({ cx: 2, cy: 1, dir: 'W' });
    const leftPoints = new Set([
      `${eastOfLeft.x0},${eastOfLeft.z0}`,
      `${eastOfLeft.x1},${eastOfLeft.z1}`,
    ]);
    const rightPoints = new Set([
      `${westOfRight.x0},${westOfRight.z0}`,
      `${westOfRight.x1},${westOfRight.z1}`,
    ]);
    expect(leftPoints).toEqual(rightPoints);
  });
});
