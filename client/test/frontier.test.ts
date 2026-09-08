import { describe, expect, it } from 'vitest';
import {
  frontierEdgeKey,
  frontierEdgeSpan,
  frontierEdges,
  type FrontierDirection,
} from '../src/terrain/frontier.ts';

const CHUNK_COLS = 4;

function idx(cx: number, cy: number): number {
  return cy * CHUNK_COLS + cx;
}

function receivedOf(coords: ReadonlyArray<readonly [number, number]>): Set<number> {
  return new Set(coords.map(([cx, cy]) => idx(cx, cy)));
}

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
    const received = receivedOf([
      [1, 1],
      [2, 1],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 1, 1)).toEqual(['N', 'S', 'W']);
    expect(dirsOf(edges, 2, 1)).toEqual(['E', 'N', 'S']);
    expect(edges).toHaveLength(6);
  });

  it('treats the world boundary as frontier with no neighbour needed', () => {
    const received = receivedOf([[0, 0]]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 0, 0)).toEqual(['E', 'N', 'S', 'W']);
  });

  it('rings a hole of unreceived chunks inside revealed territory', () => {
    const received = receivedOf([
      [0, 0], [1, 0], [2, 0],
      [0, 1],         [2, 1],
      [0, 2], [1, 2], [2, 2],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);

    expect(dirsOf(edges, 1, 0)).toContain('S');
    expect(dirsOf(edges, 1, 2)).toContain('N');
    expect(dirsOf(edges, 0, 1)).toContain('E');
    expect(dirsOf(edges, 2, 1)).toContain('W');

    expect(edges.filter((e) => e.cx === 1 && e.cy === 1)).toHaveLength(0);

    for (const edge of edges) {
      expect(received.has(idx(edge.cx, edge.cy))).toBe(true);
    }
  });

  it('emits two distinct edges at a concave (inner) corner, not a merged one', () => {
    const received = receivedOf([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    const edges = frontierEdges(received, CHUNK_COLS);
    expect(dirsOf(edges, 1, 0)).toEqual(['E', 'N', 'S']);
    expect(dirsOf(edges, 0, 1)).toEqual(['E', 'S', 'W']);
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
    const north = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'N' });
    const east = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'E' });
    const south = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'S' });
    const west = frontierEdgeSpan({ cx: 2, cy: 3, dir: 'W' });

    expect([north.x1, north.z1]).toEqual([east.x0, east.z0]);
    expect([east.x1, east.z1]).toEqual([south.x0, south.z0]);
    expect([south.x1, south.z1]).toEqual([west.x0, west.z0]);
    expect([west.x1, west.z1]).toEqual([north.x0, north.z0]);

    expect(north.x1).not.toBe(north.x0);
    expect(east.z1).not.toBe(east.z0);
  });

  it('places adjacent chunks\' shared side at the identical coordinates', () => {
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
