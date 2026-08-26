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
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL } from '@terrace/shared';
import { structureKey } from '../protocol.ts';
import {
  GenerationSurvey,
  WALL_PHANTOM_DENOMINATOR,
  WALL_PHANTOM_NUMERATOR,
  scaledNeighborCount,
  stepGeneration,
  type LiveCellRecord,
} from '../server/life.ts';
import {
  computeLandmassLabels,
  computeLandmassLabelsFromBuildable,
  wrappedNeighborIndex,
  type LandmassBox,
  type LandmassLabels,
} from '../server/topology.ts';
import { isBuildableCell, type StructuresWorld } from '../server/suitability.ts';
import { worldWithTerrain } from './support/world.ts';

/** A skipIndex that is never a real cell — "no cell is excluded from this lookup". */
const NO_SKIP = -1;

/** One chunk per tick: the finest budget `GenerationSurvey.advance` accepts. */
const ONE_CHUNK_BUDGET = 1;

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

/** A board whose cells are already old enough to be tier-eligible. */
function agedBoardOf(
  cells: ReadonlyArray<readonly [number, number]>,
  age: number,
): Map<number, LiveCellRecord> {
  const live = new Map<number, LiveCellRecord>();
  for (const [x, y] of cells) live.set(structureKey(x, y), { age, tier: 0 });
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

// ─────────────────────────────────────────────────────────────────────────────
// (e) THE TIER GATE'S ARGUMENT (F3) — what STRUCTURE_UPGRADE_MIN_NEIGHBORS is
// actually counting once the board has a topology.
//
// The gate exists to tell a DENSE core from a sparse frontier cell, so the
// number it is handed has to be real live company. A phantom wall is not
// company (it is the absence of it, priced so the coastline does not starve),
// and a wrapped-in cell is company for the SURVIVAL rule's purposes without
// being a Moore neighbour anybody could point at. Feeding the gate the scaled
// count divided by the denominator conflated all three: three walls read as
// one whole neighbour.

describe('the tier gate counts real live Moore neighbours, not phantoms', () => {
  const SIZE = 32;
  const PLATEAU: readonly [number, number, number, number] = [2, 2, 21, 21];
  /** Comfortably past every tier's age threshold, so only the gate can refuse. */
  const OLD_ENOUGH = 10;

  it('refuses a teepee with 2 live neighbours and 3 wall slots', () => {
    // (4,12) is on the western edge of the buildable rectangle [4,19]²: its
    // three western Moore slots are wall. The wrap sends each of them to the
    // landmass's far edge, where nobody is home, so each contributes one
    // phantom unit — scaled 2·D + 3·N = 9, which divided by D is 3, exactly
    // the gate's threshold. It has two neighbours.
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const live = agedBoardOf([[4, 11], [4, 12], [4, 13]], OLD_ENOUGH);
    expect(scaledNeighborCount(live, labels, 4, 12)).toBe(
      2 * WALL_PHANTOM_DENOMINATOR + 3 * WALL_PHANTOM_NUMERATOR,
    );

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toEqual([]);
    expect(outcome.nextLive.get(structureKey(4, 12))!.tier).toBe(0);
  });

  it('advances a teepee with 3 live neighbours even though it is on a coastline', () => {
    // The same plateau with a two-cell spur at x = 1, which makes (3,12)
    // buildable while leaving (3,11) and (3,13) wall: (4,12) now has exactly
    // TWO wall slots, so three live neighbours still leave it under the
    // overpopulation ceiling (3·D + 2·N = 11 < 4·D).
    const world = rectWorld(SIZE, [PLATEAU, [1, 10, 1, 14]]);
    expect(isBuildableCell(world, 3, 12)).toBe(true);
    expect(isBuildableCell(world, 3, 11)).toBe(false);
    expect(isBuildableCell(world, 3, 13)).toBe(false);

    const labels = computeLandmassLabels(world);
    const live = agedBoardOf([[4, 11], [4, 12], [4, 13], [5, 12]], OLD_ENOUGH);
    expect(scaledNeighborCount(live, labels, 4, 12)).toBe(
      3 * WALL_PHANTOM_DENOMINATOR + 2 * WALL_PHANTOM_NUMERATOR,
    );

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toContainEqual({ x: 4, y: 12, tier: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) THE WRAP IS A LOOKUP, NOT A SCAN.
//
// The original wrap walked a row or a column of the landmass's bounding box
// per neighbour slot, so one generation cost O(coastline × worldSize) — worse
// on a comb or a ring, where the box is large and the land in it is thin. The
// labelling now carries, per landmass and per line, the first two and last two
// positions that landmass occupies, which is everything the inward scan could
// ever have returned.
//
// THIS TEST IS THE PROOF OF EQUIVALENCE, and it is written as one: the inward
// scan is reproduced below, verbatim in behaviour, and the shipped lookup must
// agree with it on every buildable cell of every fixture in this file, for all
// eight steps. It is not asserting a NEW answer — it is asserting that there
// is no new answer.

const MOORE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/** The pre-2026-08-25 inward row scan, kept here as the reference answer. */
function scanRowReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  y: number,
  step: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const start = step > 0 ? box.minX : box.maxX;
  for (let i = 0; i < width; i++) {
    const x = start + i * step;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

/** Its transpose. */
function scanColumnReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  x: number,
  step: number,
  selfIndex: number,
): number {
  const height = box.maxY - box.minY + 1;
  const start = step > 0 ? box.minY : box.maxY;
  for (let i = 0; i < height; i++) {
    const y = start + i * step;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

/** The diagonal corner case — unchanged in the shipped code, mirrored here. */
function scanDiagonalReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  stepX: number,
  stepY: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const span = width < height ? width : height;
  const startX = stepX > 0 ? box.minX : box.maxX;
  const startY = stepY > 0 ? box.minY : box.maxY;
  for (let i = 0; i < span; i++) {
    const x = startX + i * stepX;
    const y = startY + i * stepY;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

/** wrappedNeighborIndex as it was written, over the scans above. */
function wrappedNeighborIndexReference(
  labels: LandmassLabels,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number {
  const label = labels.labelAt(x, y);
  if (label < 0) return -1;

  const size = labels.worldSize;
  const nx = x + dx;
  const ny = y + dy;
  if (labels.labelAt(nx, ny) === label) return ny * size + nx;

  const box = labels.boxes[label]!;
  const selfIndex = y * size + x;

  if (dx !== 0 && ny >= box.minY && ny <= box.maxY) {
    const wrapped = scanRowReference(labels, label, box, ny, dx, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dy !== 0 && nx >= box.minX && nx <= box.maxX) {
    const wrapped = scanColumnReference(labels, label, box, nx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dx !== 0 && dy !== 0) {
    const wrapped = scanDiagonalReference(labels, label, box, dx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  return -1;
}

describe('the wrap lookup agrees with the inward scan it replaced', () => {
  const FIXTURES: ReadonlyArray<readonly [string, StructuresWorld]> = [
    ['one square plateau', rectWorld(32, [[2, 2, 21, 21]])],
    ['a diagonal isthmus', rectWorld(48, [[8, 8, 12, 12], [9, 9, 13, 13]])],
    ['two separate islands', rectWorld(48, [[2, 2, 13, 13], [30, 30, 43, 43]])],
    // A COMB: a long spine with teeth, so each landmass's bounding box is far
    // bigger than the land in it — the shape the scan was worst on, and the
    // one most likely to expose a difference between the two implementations.
    [
      'a comb',
      rectWorld(64, [
        [4, 4, 59, 12],
        [8, 12, 16, 40],
        [24, 12, 32, 40],
        [40, 12, 48, 40],
      ]),
    ],
    // A RING: a landmass whose bounding box centre is not on it at all, so a
    // wrap can enter a row the origin's own column never touches.
    [
      'a ring',
      rectWorld(64, [
        [6, 6, 45, 14],
        [6, 6, 14, 45],
        [37, 6, 45, 45],
        [6, 37, 45, 45],
      ]),
    ],
    ['a one-cell-wide spit', rectWorld(32, [[10, 4, 14, 27]])],
  ];

  for (const [name, world] of FIXTURES) {
    it(`is identical on ${name}, for every cell and every step`, () => {
      const labels = computeLandmassLabels(world);
      const cells = buildableCells(world);
      expect(cells.length).toBeGreaterThan(0); // the fixture is not empty
      for (const [x, y] of cells) {
        for (const [dx, dy] of MOORE_STEPS) {
          expect(wrappedNeighborIndex(labels, x, y, dx, dy)).toBe(
            wrappedNeighborIndexReference(labels, x, y, dx, dy),
          );
        }
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) LABELS FROM THE SWEEP'S OWN BITMAP — the board is surveyed ONCE per
//     generation, not twice. The labelling used to be taken with a whole-board
//     isBuildableCell prepass on the single tick a sweep starts, while the
//     scan beside it — which asks isBuildableCell exactly the same question
//     about exactly the same cells — was amortised across the whole
//     generation. The prepass is now gone: scanChunk records its own answers
//     into a bitmap, and the flood fill runs over that bitmap when the sweep
//     completes, producing the labelling the NEXT sweep reads.
//
//     Two promises, one per test below: the bitmap-fed labelling is the SAME
//     labelling (nothing about the topology changes, only when it is built),
//     and no tick of a warm sweep ever costs more than its own chunk.

describe('labels built from the sweep bitmap', () => {
  const SIZE = 64;
  // Three separated islands, so the labelling under test has more than one
  // component and more than one bounding box to get wrong.
  const ISLANDS: ReadonlyArray<readonly [number, number, number, number]> = [
    [2, 2, 21, 21],
    [30, 4, 45, 19],
    [8, 40, 15, 55],
  ];

  /** The board's buildability as a row-major bitmap — what scanChunk records. */
  function buildableBitmap(world: StructuresWorld): Uint8Array {
    const bitmap = new Uint8Array(world.worldSize * world.worldSize);
    for (let y = 0; y < world.worldSize; y++) {
      for (let x = 0; x < world.worldSize; x++) {
        if (isBuildableCell(world, x, y)) bitmap[y * world.worldSize + x] = 1;
      }
    }
    return bitmap;
  }

  it('equals the labelling computed from the world for the same board', () => {
    const world = rectWorld(SIZE, ISLANDS);
    const fromWorld = computeLandmassLabels(world);
    const fromBitmap = computeLandmassLabelsFromBuildable(SIZE, buildableBitmap(world));

    expect(fromBitmap.worldSize).toBe(fromWorld.worldSize);
    expect(fromBitmap.count).toBe(fromWorld.count);
    expect(fromBitmap.count).toBe(ISLANDS.length); // the fixture really is three boards
    expect(fromBitmap.boxes).toEqual(fromWorld.boxes);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        expect(fromBitmap.labelAt(x, y)).toBe(fromWorld.labelAt(x, y));
      }
    }

    // The wrap's O(1) extents too, not just the labels they are derived from:
    // both ends of every line of every landmass, and the runner-up each end
    // falls back to when the nearest entry is the cell that left (skipIndex).
    for (let label = 0; label < fromWorld.count; label++) {
      for (let line = 0; line < SIZE; line++) {
        for (const step of [1, -1]) {
          const row = fromWorld.rowEntry(label, line, step, NO_SKIP);
          expect(fromBitmap.rowEntry(label, line, step, NO_SKIP)).toBe(row);
          expect(fromBitmap.rowEntry(label, line, step, row)).toBe(
            fromWorld.rowEntry(label, line, step, row),
          );
          const column = fromWorld.columnEntry(label, line, step, NO_SKIP);
          expect(fromBitmap.columnEntry(label, line, step, NO_SKIP)).toBe(column);
          expect(fromBitmap.columnEntry(label, line, step, column)).toBe(
            fromWorld.columnEntry(label, line, step, column),
          );
        }
      }
    }
  });

  it('costs one chunk on every tick of a warm sweep, the first tick included', () => {
    // isBuildableCell asks isCellUnlocked exactly once, and nothing else in
    // this plugin does, so counting that call counts buildability surveys.
    let surveys = 0;
    const base = rectWorld(SIZE, ISLANDS);
    const world: StructuresWorld = {
      ...base,
      isCellUnlocked: (x, y) => {
        surveys++;
        return base.isCellUnlocked(x, y);
      },
    };
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    const cellsPerSweep = SIZE * SIZE;
    const cellsPerChunk = CHUNK_SIZE * CHUNK_SIZE;
    // An empty board: no cell has any live neighbour, so no survival, birth or
    // farmland check runs and the only buildability surveys in the sweep are
    // scanChunk's own one-per-cell wall test.
    const empty = new Map<number, LiveCellRecord>();

    // THE FIRST SWEEP OF A FRESH WORLD still labels from the world — there is
    // no previous sweep to have left a bitmap — so it surveys the board twice.
    const survey = new GenerationSurvey();
    let ticks = 0;
    let outcome = survey.advance(world, empty, ONE_CHUNK_BUDGET);
    while (outcome === null) {
      ticks++;
      outcome = survey.advance(world, empty, ONE_CHUNK_BUDGET);
    }
    ticks++;
    expect(ticks).toBe(totalChunks);
    expect(surveys).toBe(2 * cellsPerSweep);

    // THE SECOND SWEEP labels from the first's bitmap, so its opening tick
    // pays for its own chunk and nothing more.
    const beforeFirstTick = surveys;
    expect(survey.advance(world, empty, ONE_CHUNK_BUDGET)).toBeNull();
    expect(surveys - beforeFirstTick).toBe(cellsPerChunk);

    const beforeSecondTick = surveys;
    expect(survey.advance(world, empty, ONE_CHUNK_BUDGET)).toBeNull();
    expect(surveys - beforeSecondTick).toBe(cellsPerChunk);

    // And the sweep as a whole surveys the board exactly once.
    const afterFirstSweep = beforeFirstTick;
    let remaining = totalChunks - 2;
    while (remaining > 0) {
      survey.advance(world, empty, ONE_CHUNK_BUDGET);
      remaining--;
    }
    expect(surveys - afterFirstSweep).toBe(cellsPerSweep);
  });
});
