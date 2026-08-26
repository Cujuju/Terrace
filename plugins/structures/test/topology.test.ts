// BOARD TOPOLOGY for the structures CA — the two rules that stop the CA
// starving against its own coastline (topology.ts + life.ts's neighbour
// counting). CONTRACT tests, in the same shape as structures.test.ts: each
// names a promise the topology makes and asserts it against the mechanism.
//
//   (a) PHANTOM WALL NEIGHBOURS — the scaled neighbour count is exactly
//       D·live + N·wall, in integers.
//   (b) LANDMASS LABELLING — 8-connected components of buildable ground, with
//       their bounding boxes.
//   (c) WRAP LOOKUP — a neighbour that would step off a landmass comes back in
//       at that landmass's OPPOSITE edge, not at the world's.
//   (d) THE POINT OF ALL OF IT — a lone plateau that starves to nothing under
//       hard-walled B3/S23 stays populated under the new topology.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { structureKey } from '../protocol.ts';
import {
  WALL_PHANTOM_DENOMINATOR,
  WALL_PHANTOM_NUMERATOR,
  scaledNeighborCount,
  stepGeneration,
  type LiveCellRecord,
} from '../server/life.ts';
import { computeLandmassLabels, wrappedNeighborIndex } from '../server/topology.ts';
import { isBuildableCell, type StructuresWorld } from '../server/suitability.ts';
import { worldWithTerrain } from './support/world.ts';

const LAND_BAND = 4;
const LAND_HEIGHT = LAND_BAND * BAND_HEIGHT;
const SEA_HEIGHT = SEA_LEVEL - BAND_HEIGHT;

function view(size: number, heightOf: (x: number, y: number) => number): StructuresWorld {
  const w = worldWithTerrain(size, heightOf);
  return {
    worldSize: w.size,
    chunksPerEdge: w.chunksPerEdge,
    heightAt: (x, y) => w.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
  };
}

/** A rectangle of dry, same-band land in an otherwise drowned world. */
function rectWorld(
  size: number,
  rects: ReadonlyArray<readonly [number, number, number, number]>,
): StructuresWorld {
  return view(size, (x, y) => {
    for (const [x0, y0, x1, y1] of rects) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return LAND_HEIGHT;
    }
    return SEA_HEIGHT;
  });
}

/**
 * Uniform dry land whose LOCKED set the caller may move between generations —
 * the one input to isBuildableCell that changes without any terrain diff.
 */
function unlockableWorld(size: number, locked: ReadonlySet<number>): StructuresWorld {
  const w = worldWithTerrain(size, () => LAND_HEIGHT);
  return {
    worldSize: w.size,
    chunksPerEdge: w.chunksPerEdge,
    heightAt: (x, y) => w.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => !locked.has(structureKey(x, y)) && w.isCellUnlocked(x, y),
  };
}

function boardOf(cells: ReadonlyArray<readonly [number, number]>): Map<number, LiveCellRecord> {
  const live = new Map<number, LiveCellRecord>();
  for (const [x, y] of cells) live.set(structureKey(x, y), { age: 0, tier: 0 });
  return live;
}

/** Every buildable cell of a world, row-major. */
function buildableCells(world: StructuresWorld): Array<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  for (let y = 0; y < world.worldSize; y++) {
    for (let x = 0; x < world.worldSize; x++) {
      if (isBuildableCell(world, x, y)) cells.push([x, y] as const);
    }
  }
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) PHANTOM WALL NEIGHBOURS — the arithmetic itself.

describe('phantom wall neighbours (scaled neighbour arithmetic)', () => {
  // A 32×32 world with one 20×20 plateau: buildable ground is the inner
  // 16×16 square, [4, 19]² (the footprint survey eats
  // FOOTPRINT_CHECK_RADIUS_CELLS of margin on every side), so both a wall-free
  // interior cell and a wall-flanked corner cell exist on the same board.
  const SIZE = 32;
  const PLATEAU: readonly [number, number, number, number] = [2, 2, 21, 21];

  it('counts a live neighbour as exactly one denominator unit', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    // (12,12) is deep inside the plateau: all eight Moore neighbours buildable.
    const live = boardOf([[11, 12], [13, 12]]);
    expect(scaledNeighborCount(live, labels, 12, 12)).toBe(2 * WALL_PHANTOM_DENOMINATOR);
  });

  it('counts a wall neighbour that delivers nobody as exactly one numerator unit', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    // (4,4) is the plateau's buildable north-west corner: five of its eight
    // Moore neighbours are wall, and against an empty board none of them
    // delivers anyone (wrapped or not), so all five are phantoms.
    expect(isBuildableCell(world, 4, 4)).toBe(true);
    expect(isBuildableCell(world, 3, 4)).toBe(false);
    expect(scaledNeighborCount(new Map<number, LiveCellRecord>(), labels, 4, 4)).toBe(
      5 * WALL_PHANTOM_NUMERATOR,
    );
  });

  it('counts a live cell reached THROUGH a wrap as a full live neighbour, not a phantom', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    // Stepping west from (4,4) leaves the landmass and re-enters at its
    // eastern edge on the same row, (19,4). That slot now delivers a live
    // cell, so it is worth D and NOT the phantom — the other four wall slots
    // still deliver nobody.
    const live = boardOf([[19, 4]]);
    expect(scaledNeighborCount(live, labels, 4, 4)).toBe(
      WALL_PHANTOM_DENOMINATOR + 4 * WALL_PHANTOM_NUMERATOR,
    );
  });

  it('is D·live + N·wall on a landmass with no wrap targets', () => {
    // A single 5×5 plateau leaves exactly ONE buildable cell (its centre).
    // Every one of that cell's Moore neighbours is wall, and the landmass is
    // one cell wide, so no wrap can find a DIFFERENT cell of the same
    // landmass: all eight are phantoms.
    const world = rectWorld(SIZE, [[8, 8, 12, 12]]);
    expect(buildableCells(world)).toEqual([[10, 10]]);
    const labels = computeLandmassLabels(world);
    const empty = new Map<number, LiveCellRecord>();
    expect(scaledNeighborCount(empty, labels, 10, 10)).toBe(8 * WALL_PHANTOM_NUMERATOR);
  });

  it('keeps the fraction a proper one — a wall is worth less than a live cell', () => {
    expect(WALL_PHANTOM_NUMERATOR).toBeGreaterThan(0);
    expect(WALL_PHANTOM_NUMERATOR).toBeLessThan(WALL_PHANTOM_DENOMINATOR);
  });

  it('leaves open-ground B3/S23 exactly as it was', () => {
    // A blinker in the middle of a big plateau still oscillates, and a block
    // is still stable: away from walls the scaled count is D·live and the
    // scaled thresholds are D·(the old ones).
    const world = rectWorld(48, [[4, 4, 35, 35]]);
    const blinker = boardOf([[19, 20], [20, 20], [21, 20]]);
    const next = stepGeneration(world, blinker).nextLive;
    expect(new Set(next.keys())).toEqual(
      new Set([structureKey(20, 19), structureKey(20, 20), structureKey(20, 21)]),
    );

    const block = boardOf([[20, 20], [21, 20], [20, 21], [21, 21]]);
    const afterBlock = stepGeneration(world, block).nextLive;
    expect(new Set(afterBlock.keys())).toEqual(new Set(block.keys()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) LANDMASS LABELLING.

describe('landmass labelling', () => {
  it('gives two separated plateaus two different labels, with their own boxes', () => {
    const world = rectWorld(48, [[2, 2, 13, 13], [30, 30, 41, 41]]);
    const labels = computeLandmassLabels(world);
    expect(labels.count).toBe(2);

    // Buildable ground is the plateau inset by the footprint survey radius.
    const a = labels.labelAt(6, 6);
    const b = labels.labelAt(35, 35);
    expect(a).toBe(0); // row-major scan order: the north-west landmass first
    expect(b).toBe(1);
    expect(a).not.toBe(b);

    const boxA = labels.boxes[a];
    const boxB = labels.boxes[b];
    expect(boxA.minX).toBeLessThan(boxB.minX);
    expect(boxA.maxX).toBeLessThan(boxB.minX);
    // Every cell inside a box that carries the box's label is buildable.
    for (let y = boxA.minY; y <= boxA.maxY; y++) {
      for (let x = boxA.minX; x <= boxA.maxX; x++) {
        expect(labels.labelAt(x, y)).toBe(a);
        expect(isBuildableCell(world, x, y)).toBe(true);
      }
    }
  });

  it('labels water and out-of-bounds as no landmass at all', () => {
    const world = rectWorld(48, [[2, 2, 13, 13]]);
    const labels = computeLandmassLabels(world);
    expect(labels.labelAt(24, 24)).toBe(-1);
    expect(labels.labelAt(-1, 6)).toBe(-1);
    expect(labels.labelAt(48, 6)).toBe(-1);
    expect(labels.labelAt(6, -1)).toBe(-1);
  });

  it('is 8-connected: two cells touching only at a diagonal are ONE landmass', () => {
    // Two 5×5 patches of dry land, offset by (1,1). The footprint survey
    // (suitability.ts) erodes each to a single buildable cell — (10,10) and
    // (11,11) — and the two cells between them, (10,11) and (11,10), are NOT
    // buildable. So the buildable board is exactly two diagonal neighbours: a
    // 4-connected labeller would call them two landmasses.
    const world = rectWorld(48, [[8, 8, 12, 12], [9, 9, 13, 13]]);
    expect(buildableCells(world)).toEqual([[10, 10], [11, 11]]);
    const labels = computeLandmassLabels(world);
    expect(labels.labelAt(10, 10)).toBe(0);
    expect(labels.labelAt(11, 11)).toBe(0);
    expect(labels.count).toBe(1);
    expect(labels.boxes[0]).toEqual({ minX: 10, maxX: 11, minY: 10, maxY: 11 });
  });

  it('is a pure function of the terrain: the same world labels identically twice', () => {
    const world = rectWorld(48, [[2, 2, 13, 13]]);
    const first = computeLandmassLabels(world);
    const second = computeLandmassLabels(world);
    expect(second).not.toBe(first); // a fresh labelling every call — no cache
    // …and identical, because the terrain did not move.
    expect(second.count).toBe(first.count);
    for (let y = 0; y < world.worldSize; y++) {
      for (let x = 0; x < world.worldSize; x++) {
        expect(second.labelAt(x, y)).toBe(first.labelAt(x, y));
      }
    }
  });

  /**
   * THE STALE-LABEL BUG (F1). isBuildableCell depends on three things that can
   * move: the terrain, the UNLOCKED set, and another plugin's reservations.
   * Only the first of those produces a CellDiff, so a labelling that is
   * invalidated by terrain alone can disagree with isBuildableCell about a
   * cell that just unlocked — and an unlabelled cell is a cell
   * wrappedNeighborIndex refuses to answer for at all (label -1 returns -1 on
   * every one of its eight slots), so it can never be born and a live cell
   * standing there would survive forever on a board that says it is nowhere.
   *
   * The fix is that there is no cross-generation labelling to go stale: every
   * sweep labels the world it is about to scan.
   */
  it('sees a cell that UNLOCKS between two generations, with no terrain diff', () => {
    const SIZE = 32;
    const locked = new Set<number>([structureKey(11, 11)]);
    const world = unlockableWorld(SIZE, locked);

    // An L-triomino on open ground: each of its three cells has exactly 2 live
    // neighbours (so all three survive, generation after generation), and the
    // square's fourth corner has exactly 3 — born the moment it is allowed to be.
    let live: ReadonlyMap<number, LiveCellRecord> = boardOf([[10, 10], [11, 10], [10, 11]]);

    const first = stepGeneration(world, live);
    expect(first.born).toEqual([]); // (11,11) is locked ground: not buildable
    live = first.nextLive;
    expect(live.size).toBe(3);

    // THE ONLY THING THAT MOVES. No height changes anywhere, so nothing
    // reports a terrain diff — the sole signal the old cache listened to.
    locked.clear();

    const second = stepGeneration(world, live);
    expect(second.born).toEqual([{ x: 11, y: 11, tier: 0 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) WRAP LOOKUP.

describe('per-landmass wrap', () => {
  const SIZE = 48;
  const PLATEAU: readonly [number, number, number, number] = [10, 10, 29, 29];

  function labelsAndBox() {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const box = labels.boxes[labels.labelAt(20, 20)];
    return { world, labels, box };
  }

  it('an in-landmass neighbour is returned directly, unwrapped', () => {
    const { labels } = labelsAndBox();
    const idx = wrappedNeighborIndex(labels, 20, 20, 1, 0);
    expect(idx).toBe(20 * SIZE + 21);
  });

  it('stepping east off the landmass re-enters at its WESTERN edge, same row', () => {
    const { labels, box } = labelsAndBox();
    const y = 20;
    const idx = wrappedNeighborIndex(labels, box.maxX, y, 1, 0);
    expect(idx).toBe(y * SIZE + box.minX);
    // Not the world's edge — the landmass's.
    expect(box.minX).toBeGreaterThan(0);
  });

  it('stepping north off the landmass re-enters at its SOUTHERN edge, same column', () => {
    const { labels, box } = labelsAndBox();
    const x = 20;
    const idx = wrappedNeighborIndex(labels, x, box.minY, 0, -1);
    expect(idx).toBe(box.maxY * SIZE + x);
  });

  it('a diagonal step off a corner re-enters at the opposite corner', () => {
    const { labels, box } = labelsAndBox();
    const idx = wrappedNeighborIndex(labels, box.maxX, box.maxY, 1, 1);
    expect(idx).toBe(box.minY * SIZE + box.minX);
  });

  it('never returns the cell itself, and returns -1 when the landmass has no target', () => {
    // The one-buildable-cell landmass again: every direction is a dead end.
    const world = rectWorld(SIZE, [[8, 8, 12, 12]]);
    const labels = computeLandmassLabels(world);
    expect(wrappedNeighborIndex(labels, 10, 10, 1, 0)).toBe(-1);
    expect(wrappedNeighborIndex(labels, 10, 10, -1, -1)).toBe(-1);
  });

  it('returns -1 for a cell that is not on a landmass at all', () => {
    const { labels } = labelsAndBox();
    expect(wrappedNeighborIndex(labels, 0, 0, 1, 0)).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) THE POINT: a lone plateau that starves under hard walls stays alive.

/**
 * The control: classic B3/S23 with terrain as HARD walls and no phantom, no
 * wrap — the rule exactly as it stood before this change, written out here so
 * the comparison is against a real stepper rather than against a flag.
 */
function stepClassic(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  buildable: ReadonlyArray<readonly [number, number]>,
): Map<number, LiveCellRecord> {
  const next = new Map<number, LiveCellRecord>();
  for (const [x, y] of buildable) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (live.has(structureKey(x + dx, y + dy))) n++;
      }
    }
    const key = structureKey(x, y);
    const current = live.get(key);
    if (current !== undefined ? n === 2 || n === 3 : n === 3) {
      next.set(key, { age: current === undefined ? 0 : current.age + 1, tier: 0 });
    }
  }
  return next;
}

describe('a lone plateau under the new topology', () => {
  const SIZE = 32;
  // 12×12 of dry land → an 8×8 buildable island, the shape of a real world's
  // small headland: every one of its cells is within two of the water, which
  // is the whole starvation case.
  const ISLAND: readonly [number, number, number, number] = [10, 10, 21, 21];
  /**
   * 50 — comfortably past the control's death (hard-walled B3/S23 starves this
   * island out at generation 19) and well short of where the new topology
   * would need watching: it is still populated and still changing at 400.
   */
  const GENERATIONS = 50;
  /** An R-pentomino, anchored inside the island's buildable interior. */
  const SEED: ReadonlyArray<readonly [number, number]> = [
    [15, 14], [16, 14], [14, 15], [15, 15], [15, 16],
  ];

  it('dies out under hard-walled B3/S23 (the control)', () => {
    const world = rectWorld(SIZE, [ISLAND]);
    const buildable = buildableCells(world);
    let live: ReadonlyMap<number, LiveCellRecord> = boardOf(SEED);
    let died = false;
    for (let g = 0; g < GENERATIONS; g++) {
      live = stepClassic(world, live, buildable);
      if (live.size === 0) {
        died = true;
        break;
      }
    }
    expect(died).toBe(true);
  });

  it('stays alive for all 50 with phantom walls and per-landmass wrap', () => {
    const world = rectWorld(SIZE, [ISLAND]);
    let live: ReadonlyMap<number, LiveCellRecord> = boardOf(SEED);
    for (let g = 0; g < GENERATIONS; g++) {
      live = stepGeneration(world, live).nextLive;
      expect(live.size).toBeGreaterThan(0);
    }
    // Alive, and not saturated into "every cell is a house" either.
    const buildable = buildableCells(world).length;
    expect(live.size).toBeLessThan(buildable);
  });
});
