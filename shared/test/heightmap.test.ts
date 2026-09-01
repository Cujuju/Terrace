import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applyLevelFillBrush,
  applySculpt,
  bandOf,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  canSpreadBandTo,
  carveRange,
  cellIndex,
  cellX,
  cellY,
  createHeightmap,
  DEEP_BASALT_BANDS,
  DEEP_BASALT_DEPTH,
  DEEP_LAVA_BANDS,
  DEEP_LAVA_DEPTH,
  DEEP_OBSIDIAN_BANDS,
  DEEP_OBSIDIAN_DEPTH,
  DEEP_STRATA_BANDS,
  DEEP_STRATA_DEPTH,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  heightAt,
  isValidHeight,
  isWater,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  quantizeToBand,
  readSpans,
  RELAX_SLACK,
  SEA_COLUMN_BANDS,
  SEA_COLUMN_DEPTH,
  sculptDisplacementUnits,
  setColumn,
  smooth,
  SMOOTH_PASS_LIMIT,
  SMOOTH_SPREAD_CELLS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

/**
 * Cells a brush of this radius covers — the tight integer disc (2026-08-19):
 * dx² + dy² < radius·(radius−1), radius 1 the centre alone. Deliberately an
 * independent re-derivation, NOT an import of forEachFootprintOffset, so a
 * drift in the shipped footprint fails here instead of following it.
 */
function footprintOf(size: number, cx: number, cy: number, radius: number): Set<number> {
  const cells = new Set<number>();
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (radius > 1 && dx * dx + dy * dy >= radius * (radius - 1)) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      cells.add(y * size + x);
    }
  }
  return cells;
}

/** A deterministic non-flat map, so "unchanged" means something. */
function texturedMap(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let i = 0; i < map.cells.length; i++) {
    // Integer-only, well inside the height range, and varies in both axes.
    map.cells[i] = ((i * 7) % 23) - 11;
  }
  return map;
}

/** Asserts the gradient invariant over the whole map. */
/**
 * Bands from the sea to the ceiling — the number of level-fill strokes that
 * takes a plateau to MAX_HEIGHT. The #12 fixtures wanted "at the ceiling" and
 * "one band short of it" and said the literals 16 and 15, which meant that
 * only while a band was 64 units tall; re-terraced to 16 those plateaus stood
 * a quarter as high and stopped exercising the clamp they were built for.
 */
const CEILING_BANDS = MAX_HEIGHT / BAND_HEIGHT;

function expectGradientLimitHolds(map: Heightmap): void {
  // MAX_STEP + RELAX_SLACK, not MAX_STEP: relaxation splits a pair's excess
  // exactly in half so that it conserves height (#108), which leaves an odd
  // remainder of one unit standing in the pair. See RELAX_SLACK.
  const limit = MAX_STEP + RELAX_SLACK;
  const { size, cells } = map;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x < size - 1) {
        expect(Math.abs(cells[i] - cells[i + 1])).toBeLessThanOrEqual(limit);
      }
      if (y < size - 1) {
        expect(Math.abs(cells[i] - cells[i + size])).toBeLessThanOrEqual(limit);
      }
    }
  }
}

describe('createHeightmap', () => {
  it('allocates a zeroed size×size grid', () => {
    const map = createHeightmap(64);
    expect(map.size).toBe(64);
    expect(map.cells.length).toBe(64 * 64);
    expect(map.cells.every((h) => h === 0)).toBe(true);
  });

  it('rejects non-positive and non-integer sizes', () => {
    expect(() => createHeightmap(0)).toThrow(RangeError);
    expect(() => createHeightmap(-4)).toThrow(RangeError);
    expect(() => createHeightmap(2.5)).toThrow(RangeError);
  });
});

describe('water and terracing', () => {
  it('height <= 0 is water', () => {
    expect(isWater(0)).toBe(true);
    expect(isWater(-5)).toBe(true);
    expect(isWater(1)).toBe(false);
  });

  it('bands use floor division so underwater heights band correctly', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(BAND_HEIGHT - 1)).toBe(0);
    expect(bandOf(BAND_HEIGHT)).toBe(1);
    expect(bandOf(-1)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT - 1)).toBe(-2);
  });

  it('quantizes to the band floor', () => {
    expect(quantizeToBand(BAND_HEIGHT + 5)).toBe(BAND_HEIGHT);
    expect(quantizeToBand(-1)).toBe(-BAND_HEIGHT);
  });
});

describe('deep strata constants', () => {
  it('derives MIN_HEIGHT from the strata stack (Deep Strata, 2026-08-19)', () => {
    // The floor IS the bottom of the lava stratum: sea column (the pre-strata
    // −1024 floor, kept exactly so old snapshots are unchanged), then basalt,
    // obsidian, lava. Restating −1536 as a literal anywhere would let the
    // floor and the strata that define it drift apart — this is the pin.
    expect(SEA_COLUMN_DEPTH).toBe(MAX_HEIGHT);
    expect(DEEP_STRATA_DEPTH).toBe(
      DEEP_BASALT_DEPTH + DEEP_OBSIDIAN_DEPTH + DEEP_LAVA_DEPTH,
    );
    expect(MIN_HEIGHT).toBe(-(SEA_COLUMN_DEPTH + DEEP_STRATA_DEPTH));
    expect(MIN_HEIGHT).toBe(-1536);
    // Every pre-strata height remains valid: the old floor sits inside the
    // new range, so no stored world can have gone out of contract.
    expect(isValidHeight(-SEA_COLUMN_DEPTH)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT - 1)).toBe(false);
  });

  it('keeps the strata DEPTHS fixed while their band counts follow BAND_HEIGHT', () => {
    // THE 2026-08-20 CONTRACT, and the reason the four-times-finer terracing
    // could not move the seabed: a stratum's depth is the world-model fact and
    // its band count is a render consequence. Written the other way round — as
    // the band counts it used to be — re-terracing the world would have made
    // it four times shallower without a single test noticing.
    expect(SEA_COLUMN_BANDS).toBe(SEA_COLUMN_DEPTH / BAND_HEIGHT);
    expect(DEEP_BASALT_BANDS).toBe(DEEP_BASALT_DEPTH / BAND_HEIGHT);
    expect(DEEP_OBSIDIAN_BANDS).toBe(DEEP_OBSIDIAN_DEPTH / BAND_HEIGHT);
    expect(DEEP_LAVA_BANDS).toBe(DEEP_LAVA_DEPTH / BAND_HEIGHT);
    expect(DEEP_STRATA_BANDS).toBe(
      DEEP_BASALT_BANDS + DEEP_OBSIDIAN_BANDS + DEEP_LAVA_BANDS,
    );
    // Every boundary lands ON a band edge. A BAND_HEIGHT that did not divide
    // the stack evenly would put a material change part-way through a terrace,
    // where the palette has no stop to give it and the cap it colours is a
    // band — so this is the guard on any future re-terrace, not decoration.
    for (const bands of [
      SEA_COLUMN_BANDS,
      DEEP_BASALT_BANDS,
      DEEP_OBSIDIAN_BANDS,
      DEEP_LAVA_BANDS,
    ]) {
      expect(Number.isInteger(bands)).toBe(true);
    }
    // The crust keeps the 4 : 3 : 1 proportion the original band counts set.
    expect(DEEP_BASALT_DEPTH / DEEP_LAVA_DEPTH).toBe(4);
    expect(DEEP_OBSIDIAN_DEPTH / DEEP_LAVA_DEPTH).toBe(3);
  });

  it('scales the smoothing budget with the range AND the gradient limit', () => {
    // The relaxation travel bound follows both by derivation; if either side
    // of this drifts to a literal, the deepest cascades truncate. It doubled
    // on 2026-08-20 because MAX_STEP halved, not because the range moved, and
    // quadrupled again on 2026-08-21 because MAX_STEP is now a slope per WORLD
    // UNIT — the same 160 world units of travel, sampled four times as finely.
    expect(SMOOTH_SPREAD_CELLS).toBe(
      Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP),
    );
    expect(SMOOTH_SPREAD_CELLS).toBe(160 * WORLD_UNIT_CELLS);
  });
});

describe('applyBrush', () => {
  it('radius 1 is the point brush: exactly one cell, full amount', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 1, 64, changed);
    expect(changed.size).toBe(1);
    expect(heightAt(map, 16, 16)).toBe(64);
  });

  it('radius 2 applies linear falloff (full center, half at distance 1)', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 2, 64, changed);
    expect(heightAt(map, 16, 16)).toBe(64);
    // Orthogonal neighbors are the plus-shaped disc's distance-1 ring.
    expect(heightAt(map, 17, 16)).toBe(32);
    expect(heightAt(map, 16, 15)).toBe(32);
    // Diagonals are OUTSIDE the tight disc (2026-08-19 footprint decision:
    // dx²+dy² = 2 >= 2·1) — they used to receive 32 under floor(sqrt) < r.
    expect(heightAt(map, 17, 17)).toBe(0);
    // Distance 2 is outside a radius-2 brush.
    expect(heightAt(map, 18, 16)).toBe(0);
  });

  it('lowering mirrors raising exactly', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applyBrush(up, 16, 16, 3, 64, new Set());
    applyBrush(down, 16, 16, 3, -64, new Set());
    for (let i = 0; i < up.cells.length; i++) {
      expect(down.cells[i]).toBe(-up.cells[i] | 0); // | 0 folds -0 to 0 for Object.is
    }
  });

  it('clamps to MAX_HEIGHT', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    map.cells[8 * 16 + 8] = MAX_HEIGHT - 10;
    applyBrush(map, 8, 8, 1, 64, changed);
    expect(heightAt(map, 8, 8)).toBe(MAX_HEIGHT);
  });

  it('overhangs the map edge without throwing; off-map cells are skipped', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    applyBrush(map, 0, 0, 4, 64, changed);
    expect(heightAt(map, 0, 0)).toBe(64);
    expect(changed.size).toBeGreaterThan(0);
  });

  it('rejects out-of-bounds centers and invalid radii', () => {
    const map = createHeightmap(16);
    expect(() => applyBrush(map, -1, 0, 1, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 0, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, MAX_BRUSH_RADIUS + 1, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 2, 1.5, new Set())).toThrow(RangeError);
  });
});

describe('smooth', () => {
  it('restores the gradient limit after a spike', () => {
    const map = createHeightmap(64);
    const changed = new Set<number>();
    const i = 32 * 64 + 32;
    map.cells[i] = 512;
    changed.add(i);
    smooth(map, changed);
    expectGradientLimitHolds(map);
    // The spike must have spread, not vanished.
    expect(heightAt(map, 32, 32)).toBeGreaterThan(0);
  });

  it('leaves an already-smooth map untouched', () => {
    const map = createHeightmap(32);
    map.cells.fill(100);
    const before = map.cells.slice();
    const changed = new Set<number>([5 * 32 + 5]);
    smooth(map, changed);
    expect(map.cells).toEqual(before);
  });

  it('holds the invariant near the map edge', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    map.cells[0] = 512; // corner spike
    changed.add(0);
    smooth(map, changed);
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt (the full server/prediction operation)', () => {
  it('returns a diff that exactly matches the cells that changed', () => {
    const map = createHeightmap(64);
    const before = map.cells.slice();
    const diff = applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);

    const actuallyChanged = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) actuallyChanged.add(i);
    }
    const reported = new Set(diff.map((c) => c.y * 64 + c.x));
    // Every real change is reported (smoothing may also report cells it
    // touched and later returned to their original value — harmless).
    for (const i of actuallyChanged) expect(reported.has(i)).toBe(true);
    // Reported heights match the map.
    for (const c of diff) expect(c.h).toBe(heightAt(map, c.x, c.y));
    expectGradientLimitHolds(map);
  });

  it('diff is in ascending cell-index order (deterministic wire order)', () => {
    const map = createHeightmap(64);
    const diff = applySculpt(map, 32, 32, 3, DEFAULT_SCULPT_AMOUNT);
    const indices = diff.map((c) => c.y * 64 + c.x);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('is deterministic: identical inputs → identical maps and diffs', () => {
    const a = createHeightmap(64);
    const b = createHeightmap(64);
    const ops: Array<[number, number, number, number]> = [
      [32, 32, 2, 64], [33, 32, 3, 64], [30, 34, 1, -64], [32, 33, 4, 64],
    ];
    for (const [x, y, r, amt] of ops) {
      const da = applySculpt(a, x, y, r, amt);
      const db = applySculpt(b, x, y, r, amt);
      expect(da).toEqual(db);
    }
    expect(a.cells).toEqual(b.cells);
  });

  // AN EXPLICIT TIMEOUT, because this test's WORK is derived from constants
  // that have grown twice. STACKED_CLICKS is (MAX_HEIGHT * 6) /
  // DEFAULT_SCULPT_AMOUNT, so re-terracing (BAND_HEIGHT 64→16) multiplied the
  // loop by four and the quarter-cell re-sample widened what each of those
  // clicks touches. It now runs at ~5.0 s against vitest's 5 000 ms default —
  // i.e. it fails or passes depending on what else the machine is doing, which
  // made `pnpm test` flaky for everyone rather than telling anybody anything.
  //
  // Raising the budget is the honest fix for a test that is legitimately long;
  // whether it should still be doing this much work after the re-sample is a
  // separate question (issue #83), and one for whoever owns the re-sample.
  it('survives a ceiling-burying stack of sculpts: clamped, invariant intact', { timeout: 30_000 }, () => {
    // Six full ceilings of raw input, far more than the map can hold — which
    // is the point. STATED IN HEIGHT UNITS, not as a click count (it was the
    // literal 100): a click is one band, so at BAND_HEIGHT 16 a hundred clicks
    // deliver a quarter of the stress they used to and the mountain never got
    // built.
    const STACKED_CLICKS = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
    const map = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
    }
    expect(heightAt(map, 32, 32)).toBeLessThanOrEqual(MAX_HEIGHT);
    expectGradientLimitHolds(map);

    // IT ACTUALLY BUILT A MOUNTAIN — asserted on the PLAYER path since
    // 2026-08-29 (#108), and that is a correction of what this line was
    // measuring, not a weakening of it.
    //
    // The stack above runs the LIBRARY defaults (smooth / soft / spill 'free'
    // / anchor 'free' — the plugin-terraform path). It used to reach
    // MAX_HEIGHT from those 384 clicks, and it did so on manufactured height:
    // measured old vs new on this exact fixture (.sim-108/results.txt), the
    // brush delivered 18,432 height units and the map ended up holding
    // 3,686,396 — relaxation invented 99.5% of that mountain. With the
    // conserving split the same clicks build the hill those 18,432 units
    // actually pay for, and its peak is 87.
    //
    // What a PLAYER does is unchanged, bit for bit: WIRE_DEFAULT_SCULPT_OPTIONS
    // is anchored and band-contained, so a click's height lands in the
    // footprint instead of spilling, and a stack of them still reaches the
    // ceiling. Old and new both end at peak 1024 with a map total of 5,120 —
    // measured side by side. So the contract "clicks build a mountain" is
    // asserted where it is real.
    const player = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(player, 32, 32, 2, DEFAULT_SCULPT_AMOUNT, WIRE_DEFAULT_SCULPT_OPTIONS);
    }
    expect(heightAt(player, 32, 32)).toBe(MAX_HEIGHT);
  });

  it('one band-click on flat ground raises ONE crisp terrace and nothing else (the Godus contract)', () => {
    // SUPERSEDES "one band-click on flat ground spreads to neighbors (the
    // 'flow' feel)" (owner, 2026-08-20: "I don't want populace anymore. I want
    // godus" — one click, one crisp layer, no outward slump).
    //
    // The old test asserted the Populous signature: DEFAULT_SCULPT_AMOUNT was
    // 64 against a MAX_STEP of 32, so a single click ALWAYS violated the
    // gradient limit and relaxation had to push the excess outward, skirting
    // every click with a slope. A click is a band and the limit is a band per
    // WORLD UNIT, so one click lands exactly ON the limit — that is the whole
    // feel change, and it is a property of the two constants' relationship,
    // not of this callsite, so it is pinned as one here.
    expect(DEFAULT_SCULPT_AMOUNT).toBe(MAX_STEP * WORLD_UNIT_CELLS);

    // ASSERTED ON THE RENDERED BAND SINCE 2026-08-21, and that is the contract
    // rather than a weakening of it. "One crisp layer, no outward slump" is a
    // statement about what the player SEES, and what they see is bandOf(). The
    // re-sample put four cells inside a world unit, so the band a click lands
    // now descends to sea level over the four cells that make up the one world
    // unit of run the limit allows — 12, 8, 4, 0 — every one of which quantises
    // to band 0 and therefore draws at exactly the height an untouched cell
    // draws at. Asserting raw neighbour heights would pin the sampling density
    // instead of the feel.
    // THE POINT BRUSH, which is one WORLD UNIT of ground — the ladder's first
    // rung (client hudState's BRUSH_RADII), not shared's MIN_BRUSH_RADIUS. The
    // floor is the grid's own and is four times finer since the re-sample;
    // this promise was made about the brush a player actually holds.
    const map = createHeightmap(CHUNK_SIZE * 2);
    const centre = CHUNK_SIZE;
    const pointBrush = WORLD_UNIT_CELLS;
    applySculpt(map, centre, centre, pointBrush, DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, centre, centre)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(bandOf(heightAt(map, centre, centre))).toBe(1);
    for (let ring = pointBrush; ring <= pointBrush + WORLD_UNIT_CELLS; ring++) {
      for (const [dx, dy] of [[-ring, 0], [ring, 0], [0, -ring], [0, ring]] as const) {
        expect(bandOf(heightAt(map, centre + dx, centre + dy))).toBe(0);
      }
    }
    expectGradientLimitHolds(map);
  });
});

// ---------------------------------------------------------------------------
// Brush tools and edge profiles (decision 2026-08-14).
//
// The compatibility suite below is the load-bearing one: the whole change is
// only safe if an options-less call still means exactly what it meant before.
// ---------------------------------------------------------------------------

describe('applySculpt options — compatibility with the pre-2026-08-14 contract', () => {
  /** The same varied workload the determinism test uses, plus radius 4. */
  const OPS: Array<[number, number, number, number]> = [
    [32, 32, 2, 64], [33, 32, 3, 64], [30, 34, 1, -64],
    [32, 33, 4, 64], [20, 20, 4, -128], [32, 32, 1, 64],
  ];

  it('an ABSENT options argument is byte-identical to explicit smooth+soft', () => {
    const legacy = createHeightmap(64);
    const explicit = createHeightmap(64);

    for (const [x, y, r, amt] of OPS) {
      const legacyDiff = applySculpt(legacy, x, y, r, amt);
      const explicitDiff = applySculpt(explicit, x, y, r, amt, {
        tool: 'smooth',
        profile: 'soft',
        spill: 'free',
        anchor: 'free',
      });
      expect(legacyDiff).toEqual(explicitDiff);
      expect(legacy.cells).toEqual(explicit.cells);
    }
  });

  it('the library default is smooth+soft, NOT the wire default', () => {
    // Stated as a value so the compatibility promise is greppable, and so a
    // future edit to it fails here rather than silently re-tuning plugins.
    expect(LIBRARY_DEFAULT_SCULPT_OPTIONS).toEqual({
      tool: 'smooth',
      profile: 'soft',
      spill: 'free',
      anchor: 'free',
      targetBand: null,
      spanBand: null,
    });
  });

  it('the smooth tool reproduces the old brush→smooth→diff composition exactly', () => {
    // This test open-codes the pre-change implementation of applySculpt. If the
    // refactor ever changed the composition (order, the changed-set, the diff),
    // the two would part company here.
    const viaOptions = texturedMap(48);
    const viaOldSteps = texturedMap(48);

    for (const [x, y, r, amt] of [[24, 24, 3, 64], [24, 25, 1, -64]] as const) {
      const diff = applySculpt(viaOptions, x, y, r, amt, { tool: 'smooth', profile: 'soft' });

      const changed = new Set<number>();
      applyBrush(viaOldSteps, x, y, r, amt, changed);
      smooth(viaOldSteps, changed);
      const expected = Array.from(changed)
        .sort((a, b) => a - b)
        .map((i) => ({ x: i % 48, y: (i - (i % 48)) / 48, h: viaOldSteps.cells[i] }));

      expect(diff).toEqual(expected);
      expect(viaOptions.cells).toEqual(viaOldSteps.cells);
    }
  });

  it('applyBrush without a profile argument is the soft falloff', () => {
    const implicit = createHeightmap(32);
    const explicit = createHeightmap(32);
    applyBrush(implicit, 16, 16, 4, DEFAULT_SCULPT_AMOUNT, new Set());
    applyBrush(explicit, 16, 16, 4, DEFAULT_SCULPT_AMOUNT, new Set(), 'soft');
    expect(implicit.cells).toEqual(explicit.cells);
  });
});

describe('applySculpt — the stamp tool', () => {
  it('changes ONLY its footprint; every other cell is bit-identical', () => {
    const map = texturedMap(48);
    const before = map.cells.slice();
    const footprint = footprintOf(48, 24, 24, 3);

    applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });

    for (let i = 0; i < map.cells.length; i++) {
      if (footprint.has(i)) continue;
      expect(map.cells[i]).toBe(before[i]);
    }
    // ...and the footprint really did move (otherwise the above is vacuous).
    for (const i of footprint) expect(map.cells[i]).toBeGreaterThan(before[i]);
  });

  it('reports a diff confined to the footprint', () => {
    const map = texturedMap(48);
    const footprint = footprintOf(48, 24, 24, 4);
    const diff = applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    expect(diff.length).toBe(footprint.size);
    for (const c of diff) expect(footprint.has(c.y * 48 + c.x)).toBe(true);
  });

  it('stacks into a true vertical spire: N radius-1 stamps = N × amount', () => {
    const map = createHeightmap(32);
    const stacks = 5;
    for (let k = 0; k < stacks; k++) {
      applySculpt(map, 16, 16, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    }
    expect(heightAt(map, 16, 16)).toBe(stacks * DEFAULT_SCULPT_AMOUNT);
    // The neighbours never moved — this is the whole point of the tool.
    expect(heightAt(map, 15, 16)).toBe(0);
    expect(heightAt(map, 17, 16)).toBe(0);
    expect(heightAt(map, 16, 15)).toBe(0);
    expect(heightAt(map, 16, 17)).toBe(0);
    expect(heightAt(map, 15, 15)).toBe(0);
  });

  it('digs a sheer pit when lowering', () => {
    const map = createHeightmap(32);
    for (let k = 0; k < 3; k++) {
      applySculpt(map, 16, 16, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    }
    expect(heightAt(map, 16, 16)).toBe(-3 * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 17, 16)).toBe(0);
  });

  it('still clamps to the height range', () => {
    const high = createHeightmap(16);
    high.cells.fill(MAX_HEIGHT - 1);
    applySculpt(high, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(high, 8, 8)).toBe(MAX_HEIGHT);

    // THE BOTTOM OF THE WORLD IS BEDROCK_FLOOR + 1, not BEDROCK_FLOOR (issue
    // #129 step 4.4): the brushes write through moveSpanCeiling now, and a
    // column whose only span is emptied would be a column with no span at all,
    // which setColumn refuses. The remnant is a sixteenth of a band, so the
    // band, the drawn height and the picking march are unchanged — see
    // BEDROCK_REMNANT in columns.ts.
    const low = createHeightmap(16);
    low.cells.fill(MIN_HEIGHT + 1);
    applySculpt(low, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(low, 8, 8)).toBe(MIN_HEIGHT + 1);
    expect(quantizeToBand(heightAt(low, 8, 8))).toBe(MIN_HEIGHT);
  });
});

describe('applySculpt — edge profiles', () => {
  it('hard applies ONE flat delta across the whole footprint, edges included', () => {
    const map = createHeightmap(48);
    const radius = 4;
    const footprint = footprintOf(48, 24, 24, radius);

    applySculpt(map, 24, 24, radius, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    for (const i of footprint) expect(map.cells[i]).toBe(DEFAULT_SCULPT_AMOUNT);
    // The outermost ring of the footprint is at integer distance radius-1 = 3;
    // under the soft profile it would have received a quarter of the amount.
    expect(heightAt(map, 24 + (radius - 1), 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 24, 24 - (radius - 1))).toBe(DEFAULT_SCULPT_AMOUNT);
    // ...and nothing outside it moved.
    expect(heightAt(map, 24 + radius, 24)).toBe(0);
  });

  it('soft is unchanged: full amount at the centre, linear falloff outward', () => {
    const map = createHeightmap(48);
    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    // trunc(DEFAULT_SCULPT_AMOUNT * (4 - d) / 4) for d = 0..3 — the profile is
    // a SHAPE, so it is pinned as quarters of the click rather than as the
    // 64/48/32/16 the click used to be worth.
    expect(heightAt(map, 24, 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 25, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 3) / 4);
    expect(heightAt(map, 26, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 2) / 4);
    expect(heightAt(map, 27, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 1) / 4);
    expect(heightAt(map, 28, 24)).toBe(0);
  });

  it('radius 1 makes the two profiles identical on band-aligned ground', () => {
    // The footprint is the centre alone, so the falloff and the flat delta
    // coincide. Band-aligned ground is the qualifier the level fill adds (see
    // "the level-fill brush" below): off the band grid, hard snaps to the band
    // boundary while soft adds the full amount.
    const soft = createHeightmap(16);
    const hard = createHeightmap(16);
    applySculpt(soft, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applySculpt(hard, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(soft.cells).toEqual(hard.cells);
  });

  it('lowering mirrors raising under the hard profile too', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applySculpt(up, 16, 16, 3, 64, { tool: 'stamp', profile: 'hard' });
    applySculpt(down, 16, 16, 3, -64, { tool: 'stamp', profile: 'hard' });
    for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(-up.cells[i] | 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE LEVEL-FILL BRUSH — stamp + hard (owner request, 2026-08-14):
//   "I would also like the hard edge brush to only work at one level at a time
//    until it fills out everything at that level. So if I'm at level 2 and I'm
//    trying to fill out all the ground at a level 2, I don't want it to start
//    building level 3 until everything within that brush edge is level 2."
//
// These are CONTRACT tests: they exercise applySculpt (the one function both the
// server and the client's prediction store call), not the dispatch inside it.
// ────────────────────────────────────────────────────────────────────────────

/** stamp + hard: the one combination the level fill applies to. */
const LEVEL_FILL = { tool: 'stamp', profile: 'hard' } as const;

/**
 * Writes a 3×3 patch of BAND indices centred on (cx, cy) — exactly the
 * footprint of a radius-2 brush, the smallest footprint that can hold more than
 * one band and therefore the smallest one on which a level fill means anything.
 * Heights are written band-aligned (`band * BAND_HEIGHT`), which is the only
 * kind of terrain the stamp tool ever produces.
 */
function paintFootprint3x3(
  map: Heightmap,
  cx: number,
  cy: number,
  bands: readonly number[],
): void {
  for (let k = 0; k < bands.length; k++) {
    const dx = (k % 3) - 1;
    const dy = Math.floor(k / 3) - 1;
    map.cells[cellIndex(map, cx + dx, cy + dy)] = bands[k] * BAND_HEIGHT;
  }
}

/**
 * Paints the radius-2 footprint — the 5-cell plus the tight disc gives
 * (2026-08-19) — by compass position, in band units.
 */
function paintFootprintPlus(
  map: Heightmap,
  cx: number,
  cy: number,
  bands: { n: number; w: number; c: number; e: number; s: number },
): void {
  map.cells[cellIndex(map, cx, cy - 1)] = bands.n * BAND_HEIGHT;
  map.cells[cellIndex(map, cx - 1, cy)] = bands.w * BAND_HEIGHT;
  map.cells[cellIndex(map, cx, cy)] = bands.c * BAND_HEIGHT;
  map.cells[cellIndex(map, cx + 1, cy)] = bands.e * BAND_HEIGHT;
  map.cells[cellIndex(map, cx, cy + 1)] = bands.s * BAND_HEIGHT;
}

/** The same 3×3 patch read back as band indices, in the same order. */
function readFootprintBands3x3(map: Heightmap, cx: number, cy: number): number[] {
  const bands: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) bands.push(bandOf(heightAt(map, cx + dx, cy + dy)));
  }
  return bands;
}

describe('applySculpt — the level-fill brush (stamp + hard)', () => {
  it('fills the LOWEST band flat before it starts the next one', () => {
    const map = createHeightmap(16);
    // The owner's case, in miniature: ground at three different levels under
    // one brush. Level 3 must not start while level 2 still has holes in it.
    // The radius-2 footprint is the 5-cell plus (2026-08-19 disc), so the
    // fixture paints exactly those cells; the 3×3 read below still shows the
    // corners, which are OUTSIDE the brush and must never move from band 0.
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 2, s: 0 });

    // Stroke 1 — the band-0 cells come up one level. Everything already at or
    // above that level is left completely alone.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0,
                                                      1, 1, 2,
                                                      0, 1, 0]);

    // Stroke 2 — the lowest band under the brush is now 1, so THAT is the
    // level being filled. The cell already on band 2 still does not move.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 2, 0,
                                                      2, 2, 2,
                                                      0, 2, 0]);

    // Stroke 3 — only now, with the whole footprint level, does band 3 start.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 3, 0,
                                                      3, 3, 3,
                                                      0, 3, 0]);
  });

  it('never lifts a cell THROUGH the level being filled', () => {
    const map = createHeightmap(16);
    // One cell a single unit below the band floor, the rest already on it. A
    // full-amount stroke would carry that cell almost a whole band past the
    // level being filled — which is the step this brush exists to prevent.
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 8, 8)] = BAND_HEIGHT - 1;

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
    expect(heightAt(map, 7, 8)).toBe(BAND_HEIGHT); // already there: untouched
  });

  it('advances at most ONE band per stroke, whatever the amount', () => {
    // `amount` is server configuration and a plugin may modify it. Four bands'
    // worth of height still fills exactly one level: "don't start building
    // level 3" is a statement about levels, not about how hard the stroke hits.
    const map = createHeightmap(16);
    applySculpt(map, 8, 8, 2, 4 * BAND_HEIGHT, LEVEL_FILL);
    // The plus fills one band; the 3×3 read's corners are outside the brush.
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('on a FLAT footprint is exactly the old flat stamp: one band, uniformly', () => {
    // The natural reading of the request, and the compatibility claim that
    // matters: on ground that is already level — which is all a fresh world has
    // (docs/DESIGN.md genesis) — nothing about the brush changed. The two agree
    // because DEFAULT_SCULPT_AMOUNT is exactly BAND_HEIGHT.
    for (const band of [-3, -1, 0, 5]) {
      const levelled = createHeightmap(16);
      const flatDelta = createHeightmap(16);
      levelled.cells.fill(band * BAND_HEIGHT);
      flatDelta.cells.fill(band * BAND_HEIGHT);

      applySculpt(levelled, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applyBrush(flatDelta, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'hard');

      expect(levelled.cells).toEqual(flatDelta.cells);
      expect(heightAt(levelled, 8, 8)).toBe((band + 1) * BAND_HEIGHT);
    }
  });

  it('lowering is the same operation mirrored: the HIGHEST band, one level down', () => {
    const up = createHeightmap(16);
    const down = createHeightmap(16);
    paintFootprint3x3(up, 8, 8, [0, 1, 2,
                                 0, 1, 1,
                                 2, 0, 1]);
    paintFootprint3x3(down, 8, 8, [0, -1, -2,
                                   0, -1, -1,
                                   -2, 0, -1]);

    // Three strokes, so the mirror covers the whole progression: drain the
    // highest level flat, then the next one down, then the level below that.
    for (let stroke = 0; stroke < 3; stroke++) {
      applySculpt(up, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applySculpt(down, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      // `| 0` only to normalise JavaScript's -0 back to 0 — untouched cells
      // negate to -0, which Object.is separates from the 0 actually stored.
      for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(-up.cells[i] | 0);
    }
  });

  it('clamps at the top and the bottom of the height range', () => {
    // One unit below the ceiling: the fill reaches MAX_HEIGHT exactly.
    const nearTop = createHeightmap(16);
    nearTop.cells.fill(MAX_HEIGHT - 1);
    applySculpt(nearTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearTop, 8, 8)).toBe(MAX_HEIGHT);

    // AT the ceiling there is no level left to fill — the band above MAX_HEIGHT
    // is not a place this world has — so nothing moves and the diff is empty.
    const atTop = createHeightmap(16);
    atTop.cells.fill(MAX_HEIGHT);
    expect(applySculpt(atTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atTop.cells.every((h) => h === MAX_HEIGHT)).toBe(true);

    // Bottoms out one unit above the floor, for the reason the stamp test above
    // states: the world's lowest column still has a span in it.
    const nearFloor = createHeightmap(16);
    nearFloor.cells.fill(MIN_HEIGHT + 1);
    applySculpt(nearFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearFloor, 8, 8)).toBe(MIN_HEIGHT + 1);
    expect(quantizeToBand(heightAt(nearFloor, 8, 8))).toBe(MIN_HEIGHT);

    const atFloor = createHeightmap(16);
    atFloor.cells.fill(MIN_HEIGHT);
    expect(applySculpt(atFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atFloor.cells.every((h) => h === MIN_HEIGHT)).toBe(true);
  });

  it('reports only the cells it actually moved', () => {
    const map = createHeightmap(16);
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 1, s: 1 });
    // Four of the five footprint cells are already on the level being filled,
    // so the diff — which is what goes on the wire and what the client's
    // prediction reconciles against — names exactly the one that was not.
    expect(applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([
      { x: 8, y: 7, h: BAND_HEIGHT },
    ]);
  });

  it('changes nothing outside its footprint', () => {
    const map = texturedMap(48);
    const before = map.cells.slice();
    const footprint = footprintOf(48, 24, 24, 4);

    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (let i = 0; i < map.cells.length; i++) {
      if (footprint.has(i)) continue;
      expect(map.cells[i]).toBe(before[i]);
    }
    // And inside it, every cell is either untouched (already at or above the
    // level) or moved toward that level without passing it.
    let lowestBand = Number.POSITIVE_INFINITY;
    for (const i of footprint) lowestBand = Math.min(lowestBand, bandOf(before[i]));
    const target = (lowestBand + 1) * BAND_HEIGHT;
    for (const i of footprint) {
      const expected =
        before[i] >= target ? before[i] : Math.min(before[i] + DEFAULT_SCULPT_AMOUNT, target);
      expect(map.cells[i]).toBe(expected);
    }
  });

  it('surveys only in-bounds cells when the brush overhangs the map edge', () => {
    // Off-map cells are not ground, so they must not be surveyed as band-0
    // terrain that holds the fill back. All three in-bounds cells of this
    // corner brush (the plus loses its north and west arms off-map) sit on
    // band 1, so the stroke fills band 2 — if the missing cells counted as
    // band 0, nothing here would move at all.
    const map = createHeightmap(16);
    const corner = [[0, 0], [1, 0], [0, 1]] as const;
    for (const [x, y] of corner) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    // The old 3×3 footprint's fourth corner cell: outside the plus, so it
    // must hold whatever it started with even though the brush box covers it.
    map.cells[cellIndex(map, 1, 1)] = BAND_HEIGHT;

    applySculpt(map, 0, 0, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (const [x, y] of corner) expect(heightAt(map, x, y)).toBe(2 * BAND_HEIGHT);
    expect(heightAt(map, 1, 1)).toBe(BAND_HEIGHT);
  });

  it('at radius 1 snaps an off-grid cell onto the band boundary', () => {
    // The footprint is one cell, so its own band is the lowest one and the
    // target is the boundary above it. Only the smooth tool's relaxation makes
    // off-grid heights, so this is a corner case — but it is the terraced
    // answer, and it is why "radius 1 makes the two profiles identical" now
    // carries the qualifier "on band-aligned ground".
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = 10;
    applySculpt(map, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('lowering an off-grid cell drops it a RENDERED band, not to its own floor', () => {
    // A height OFF a band floor — one band up plus a few units — renders on
    // band 1, so one level down must leave it rendering on band 0. A perfect
    // negation mirror of the raise would instead drop it to the band-1 floor —
    // still band 1, a stroke with no visible effect. The half-open band
    // convention is the asymmetry, and it is the right one.
    //
    // The fixture height was the literal 70, which is BAND_HEIGHT + 6 only
    // while a band is 64 units; written that way it keeps meaning "just off
    // the band-1 floor" at any terracing, and the expected values below are
    // unchanged from when they were written.
    const OFF_BAND_FLOOR = 6;
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = BAND_HEIGHT + OFF_BAND_FLOOR;
    applySculpt(map, 8, 8, 1, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(OFF_BAND_FLOOR);
    expect(bandOf(heightAt(map, 8, 8))).toBe(0);
  });

  it('does nothing at all for a zero amount', () => {
    const map = texturedMap(16);
    const before = map.cells.slice();
    expect(applySculpt(map, 8, 8, 3, 0, LEVEL_FILL)).toEqual([]);
    expect(map.cells).toEqual(before);
  });

  it('soft is untouched; hard level-fills under BOTH tools (2026-08-19)', () => {
    const bands = [0, 1, 2, 0, 1, 1, 2, 0, 1];

    // stamp + soft — still the linear falloff, applied to every footprint cell
    // regardless of the band it sits on.
    const soft = createHeightmap(16);
    const softExpected = createHeightmap(16);
    paintFootprint3x3(soft, 8, 8, bands);
    paintFootprint3x3(softExpected, 8, 8, bands);
    applySculpt(soft, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applyBrush(softExpected, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'soft');
    expect(soft.cells).toEqual(softExpected.cells);

    // smooth + hard — LEVEL-FILL, then the relaxation pass ("fill, then
    // slump" — the 2026-08-19 supersession in applySculpt's doc). Before
    // that, this combination ran the flat delta, which lifted the footprint's
    // HIGHER-band cells up a band and made the neighbouring level's contour
    // retreat from the click — the owner report the supersession fixed.
    // Byte-compare against the two primitives composed by hand.
    const slumped = createHeightmap(16);
    const slumpedExpected = createHeightmap(16);
    paintFootprint3x3(slumped, 8, 8, bands);
    paintFootprint3x3(slumpedExpected, 8, 8, bands);
    applySculpt(slumped, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });
    const expectedChanged = new Set<number>();
    applyLevelFillBrush(slumpedExpected, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, expectedChanged);
    smooth(slumpedExpected, expectedChanged);
    expect(slumped.cells).toEqual(slumpedExpected.cells);
  });

  it('THE COMPLAINT AS A CONTRACT: a smooth+hard raise beside a higher level never lifts that level (2026-08-19)', () => {
    // A band-6 plain with a band-7 shelf crossing the right half of the
    // footprint — the owner's "clicking on level six" scenario. The stroke
    // must fill band 6 toward 7 and NEVER push any band-7 cell to band 8:
    // level seven may only ever EXPAND (via cells rising to it), never
    // contract away from the brush.
    const map = createHeightmap(32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        map.cells[y * 32 + x] = x >= 16 ? 7 * BAND_HEIGHT : 6 * BAND_HEIGHT;
      }
    }
    const sevenBefore = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (bandOf(map.cells[i]) === 7) sevenBefore.add(i);
    }

    // Footprint straddles the boundary (centre one cell into band 6, radius 3
    // reaches into the shelf). Explicit banded spill: the player-facing shape.
    applySculpt(map, 14, 16, 3, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
      spill: 'banded',
    });

    for (const i of sevenBefore) {
      expect(bandOf(map.cells[i])).toBeLessThanOrEqual(7);
    }
  });

  it('is deterministic: identical inputs → identical maps and diffs', () => {
    const a = texturedMap(32);
    const b = texturedMap(32);
    const strokes = [
      [16, 16, 4, DEFAULT_SCULPT_AMOUNT],
      [16, 16, 4, DEFAULT_SCULPT_AMOUNT],
      [15, 17, 2, -DEFAULT_SCULPT_AMOUNT],
      [16, 16, 3, DEFAULT_SCULPT_AMOUNT],
    ] as const;
    for (const [x, y, r, amount] of strokes) {
      expect(applySculpt(a, x, y, r, amount, LEVEL_FILL)).toEqual(
        applySculpt(b, x, y, r, amount, LEVEL_FILL),
      );
    }
    expect(a.cells).toEqual(b.cells);
  });

  it('rejects exactly what the plain brush rejects', () => {
    const map = createHeightmap(16);
    expect(() => applyLevelFillBrush(map, -1, 0, 2, 64, new Set<number>())).toThrow(RangeError);
    expect(() => applyLevelFillBrush(map, 8, 8, 0, 64, new Set<number>())).toThrow(RangeError);
    expect(() =>
      applyLevelFillBrush(map, 8, 8, MAX_BRUSH_RADIUS + 1, 64, new Set<number>()),
    ).toThrow(RangeError);
    expect(() => applyLevelFillBrush(map, 8, 8, 2, 1.5, new Set<number>())).toThrow(RangeError);
  });
});

describe('applySculpt — tools and profiles are orthogonal', () => {
  it('hard+smooth level-fills a plateau and then lets it slump', () => {
    // On band-aligned flat ground the level fill IS the old flat delta
    // (DESIGN.md: "On flat ground nothing changed"), so this test's numbers
    // survive the 2026-08-19 fill-then-slump supersession unchanged — what it
    // pins is the slump half: same fill, then relaxation pulls the edge out.
    // TWO strokes, not one (2026-08-20). DEFAULT_SCULPT_AMOUNT is now exactly
    // MAX_STEP, so a single stroke on flat ground leaves an edge sitting ON
    // the gradient limit and relaxation correctly has nothing to pull out —
    // the crisp-layer contract, pinned in the Godus test above. The SLUMP this
    // test is about needs an edge that actually EXCEEDS the limit, which is
    // what the second band gives it.
    const stamped = createHeightmap(64);
    const slumped = createHeightmap(64);
    const STAMP_HARD_OPTS = { tool: 'stamp', profile: 'hard' } as const;
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });

    // Same brush, so the plateau's edge is sheer before relaxation...
    expect(heightAt(stamped, 35, 32)).toBe(2 * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(stamped, 36, 32)).toBe(0);
    // ...and the smooth tool pulled that cliff outward instead.
    expect(heightAt(slumped, 36, 32)).toBeGreaterThan(0);
    expectGradientLimitHolds(slumped);
  });

  it('stays deterministic for every tool/profile combination', () => {
    for (const tool of ['stamp', 'smooth'] as const) {
      for (const profile of ['soft', 'hard'] as const) {
        const a = createHeightmap(64);
        const b = createHeightmap(64);
        for (const [x, y, r, amt] of [[32, 32, 3, 64], [33, 34, 2, -64]] as const) {
          expect(applySculpt(a, x, y, r, amt, { tool, profile })).toEqual(
            applySculpt(b, x, y, r, amt, { tool, profile }),
          );
        }
        expect(a.cells).toEqual(b.cells);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCULPT VOLUME — the number the mana plugin prices a sculpt by.
//
// The claim under test is not "this formula is implemented correctly", it is
// "this function agrees with applyBrush". So the primary test measures
// applyBrush's OWN output — the terrain it actually left behind — and compares
// the total to sculptDisplacementUnits, for every radius × profile the game
// ships. Re-deriving the expected sum with a copy of the formula would only
// prove the copy matched.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Σ |height change| over the whole map after one brush application: the volume
 * applyBrush moved, observed rather than predicted.
 */
function observedDisplacement(
  radius: number,
  profile: 'soft' | 'hard',
  amount: number,
): number {
  const size = 64;
  // A FLAT MID-RANGE map: every cell starts far enough from MIN_HEIGHT and
  // MAX_HEIGHT that nothing clamps, and the centre is far enough from the
  // border that nothing overhangs. Those are exactly the two exclusions
  // sculptDisplacementUnits documents, so this is the map on which "nominal"
  // and "actual" must coincide.
  const map = createHeightmap(size);
  const start = 128;
  map.cells.fill(start);

  applyBrush(map, 32, 32, radius, amount, new Set<number>(), profile);

  let total = 0;
  for (const h of map.cells) total += Math.abs(h - start);
  return total;
}

describe('sculptDisplacementUnits', () => {
  it('equals the volume applyBrush actually moves, for every radius × profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, profile, 'stamp')).toBe(
          observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('prices a lower exactly like the raise that undoes it', () => {
    // Volume is |delta| summed, so direction cannot make a sculpt cheaper —
    // otherwise digging would be the economical way to reshape a world.
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, profile, 'stamp')).toBe(
          observedDisplacement(radius, profile, -DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  /**
   * THE LITERAL TABLE. Deliberately hand-written numbers, not a formula: this is
   * the wall that stops a "harmless" refactor of the brush from silently
   * re-pricing the whole economy. Every value is height-units × cells, at
   * DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT = 16.
   *
   * RE-MEASURED 2026-08-20 for BAND_HEIGHT 16 (the previous BAND_HEIGHT 64
   * column is kept beside each value). The economy is priced in HEIGHT UNITS
   * and a click is now worth a quarter of what it was, so every price falls —
   * but NOT by a clean quarter everywhere: the soft profile truncates its
   * falloff per cell, and at a smaller amount those truncations bite harder
   * (radius 3 soft is 156, where a quarter of 652 would be 163). That is
   * exactly the kind of drift this table exists to catch, so the numbers are
   * measured rather than divided.
   *
   * Recomputed 2026-08-19 for the tight-disc footprint (the pre-disc square
   * numbers were 9/25/45 cells → soft 320/736/1280, hard 576/1600/2880):
   *
   *   radius  cells   soft (was, @64)     hard (was, @64)
   *      1      1        16  (  64)          16  (  64)
   *      2      5        48  ( 192)          80  ( 320)
   *      3     21       156  ( 652)         336  (1344)
   *      4     37       288  (1152)         592  (2368)
   */
  it('matches the published table of displacement volumes', () => {
    expect(sculptDisplacementUnits(1, 'soft', 'stamp')).toBe(16);
    expect(sculptDisplacementUnits(2, 'soft', 'stamp')).toBe(48);
    expect(sculptDisplacementUnits(3, 'soft', 'stamp')).toBe(156);
    expect(sculptDisplacementUnits(4, 'soft', 'stamp')).toBe(288);

    expect(sculptDisplacementUnits(1, 'hard', 'stamp')).toBe(16);
    expect(sculptDisplacementUnits(2, 'hard', 'stamp')).toBe(80);
    expect(sculptDisplacementUnits(3, 'hard', 'stamp')).toBe(336);
    expect(sculptDisplacementUnits(4, 'hard', 'stamp')).toBe(592);
  });

  it('is one band-cell at the point brush, where the two profiles coincide', () => {
    // The unit the price rate is denominated in: one band of height, one cell.
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'soft', 'stamp')).toBe(BAND_HEIGHT);
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'hard', 'stamp')).toBe(BAND_HEIGHT);
  });

  it('grows with radius, and hard never displaces less than soft', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius < MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius + 1, profile, 'stamp')).toBeGreaterThan(
          sculptDisplacementUnits(radius, profile, 'stamp'),
        );
      }
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, 'hard', 'stamp')).toBeGreaterThanOrEqual(
          sculptDisplacementUnits(radius, 'soft', 'stamp'),
        );
      }
    }
  });

  it('is a pure integer function of radius and profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        const units = sculptDisplacementUnits(radius, profile, 'stamp');
        expect(Number.isInteger(units)).toBe(true);
        // Called twice, same answer — no hidden state, nothing terrain-dependent.
        expect(sculptDisplacementUnits(radius, profile, 'stamp')).toBe(units);
      }
    }
  });

  it('rejects a radius the brush itself would reject', () => {
    for (const bad of [0, MAX_BRUSH_RADIUS + 1, 1.5, Number.NaN]) {
      expect(() => sculptDisplacementUnits(bad, 'soft', 'stamp')).toThrow(RangeError);
    }
  });

  it('ignores the relaxation spill, which stays deliberately free', () => {
    // The smooth tool REACHES FURTHER than its footprint: relaxation drags
    // terrain outside the brush and how far depends on the terrain that was
    // already there. None of that is priced — the function takes no `tool`
    // argument at all, so both tools cost the volume of the brush and nothing
    // else, exactly as the flat per-sculpt price it replaced also ignored the
    // spill. What follows is the evidence that there IS a spill being waived.
    // The ground starts one band ABOVE the footprint's own level so the stroke
    // below drives the edge past MAX_STEP and there is a spill to observe at
    // all; with DEFAULT_SCULPT_AMOUNT === MAX_STEP a stroke on flat ground
    // lands exactly on the limit and relaxation is correctly a no-op.
    const size = 64;
    const stampedCells = new Set<number>();
    const stamped = createHeightmap(size);
    stamped.cells.fill(8 * BAND_HEIGHT);
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');

    const slumped = createHeightmap(size);
    slumped.cells.fill(8 * BAND_HEIGHT);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    const slumpedDiff = applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
    });

    // The brush alone touched its 37 footprint cells; the same brush plus
    // relaxation touched strictly more of the world than that.
    expect(slumpedDiff.length).toBeGreaterThan(stampedCells.size);
    // And the price is the brush's volume either way — one number, no tool.
    expect(sculptDisplacementUnits(4, 'hard', 'stamp')).toBe(592);
  });

  it('prices a LEVEL FILL at the flat-delta volume, deliberately', () => {
    // stamp+hard (applyLevelFillBrush) moves less than the flat delta whenever
    // the ground under the brush is not already level, and is priced the same.
    // DECIDED 2026-08-14, for the reason the `clamping` exclusion exists and one
    // stronger: the mana plugin gates a stroke on the CLIENT before sending it
    // and the server charges the same number, so the price must be a pure
    // function of (radius, profile). A terrain-dependent price would be computed
    // from heights the client holds only as base-plus-predictions — and not at
    // all in a locked chunk — and the gate and the server would then disagree.
    const map = createHeightmap(32);
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 16, 16)] = 0; // one cell a band low

    const diff = applySculpt(map, 16, 16, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    // A one-cell edit, charged as the widest brush's whole footprint of flat
    // delta. That is the trade. The footprint is 749 cells since the
    // 2026-08-21 re-sample (37 before it — the same four world units of
    // ground, sampled sixteen times as densely), and mana's own rate moved by
    // the same square so the PRICE of that stroke is unchanged: see
    // plugins/mana/server/index.ts's MANA_PER_BAND_WORLD_UNIT_SQUARED.
    expect(diff).toHaveLength(1);
    expect(sculptDisplacementUnits(MAX_BRUSH_RADIUS, 'hard', 'stamp')).toBe(749 * BAND_HEIGHT);
  });
});

describe('cellX/cellY — the exported inverse of cellIndex (#14)', () => {
  it('round-trips every cell of a small map', () => {
    const map = createHeightmap(7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const i = cellIndex(map, x, y);
        expect(cellX(map.size, i)).toBe(x);
        expect(cellY(map.size, i)).toBe(y);
      }
    }
  });
});

describe('smooth — cascades from stamped terrain (#12)', () => {
  const SIZE = 128;
  const C = SIZE / 2;
  const STAMP: SculptOptions = { tool: 'stamp', profile: 'hard' };
  const SMOOTH_HARD: SculptOptions = { tool: 'smooth', profile: 'hard' };

  /** Stamps `bands` level-fill strokes at (x, y), radius 4 — the player's default brush. */
  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, STAMP);
    }
  }

  it('one smooth stroke fully relaxes a 15-band stamped plateau (the pass-cap repro)', () => {
    // 15 strokes: plateau at 960, so the smooth stroke's own brush still moves
    // cells (changed is non-empty) and the cascade must converge inside
    // SMOOTH_PASS_LIMIT — the case the old 64-pass cap truncated.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('a fully clamped smooth stroke still relaxes the cliffs under the brush', () => {
    // 16 strokes: plateau at MAX_HEIGHT. The smooth stroke's brush is then
    // fully clamped (changed stays empty) — the old code early-returned and
    // left a 1024-unit cliff standing.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    expect(heightAt(map, C, C)).toBe(MAX_HEIGHT);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('converges across the full height range: MAX plateau beside a MIN moat', () => {
    // Worst single-stroke cascade a player can construct: full 2048-unit
    // relief within one brush's reach. Pins that SMOOTH_PASS_LIMIT's budget
    // (SMOOTH_PASSES_PER_SPREAD_CELL per cell of spread) covers the extreme.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    for (let s = 0; s < 16; s++) {
      applySculpt(map, C + 8, C, 4, -DEFAULT_SCULPT_AMOUNT, STAMP);
    }
    applySculpt(map, C + 4, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('reports a convergence-proving pass count strictly below the cap', () => {
    // smooth returns the number of adjusting passes; < SMOOTH_PASS_LIMIT
    // proves a clean pass ran. Drive the worst repro through the raw API.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt — banded spill containment (issue #26)', () => {
  /**
   * A terrace ledge like the owner's screenshot: a band-2 plateau (h=128)
   * stepping down band by band toward the south-east, every step already
   * respecting MAX_STEP so relaxation starts from a legal map.
   */
  function ledgeMap(size: number): Heightmap {
    const map = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = x + y;
        let h: number;
        if (t < 40) h = 128;
        else if (t === 40) h = 96;
        else if (t < 50) h = 64;
        else if (t === 50) h = 32;
        else h = 0;
        map.cells[cellIndex(map, x, y)] = h;
      }
    }
    return map;
  }

  const BANDED = { tool: 'smooth', profile: 'soft', spill: 'banded' } as const;
  // Centre one cell inside the plateau edge, radius 2 — the session's repro,
  // which under free spill pushes 12 outside cells across a band boundary.
  const CX = 20;
  const CY = 19;
  const RADIUS = 2;
  const STROKES = 6;

  it('never changes the rendered band of a cell outside the footprint (raising)', () => {
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    // Per-stroke outside movement: the containment contract has two phases —
    // early strokes still drag outside terrain (the fabric pull survives),
    // then the band caps fill and the spill SATURATES: later strokes move
    // nothing outside at all. Both phases are the contract, so both are
    // asserted, per stroke rather than as one accumulated count.
    const movedPerStroke: number[] = [];
    // 12 STROKES UNTIL 2026-08-29 (#108). Saturation is unchanged as a
    // contract but arrives later: relaxation used to hand the LOW cell of a
    // pair `ceil(e/2)` and now hands it `floor(e/2)`, so an outside cell fills
    // its band cap a little slower and needs a few more strokes to stop
    // moving. Measured: outside movement per stroke falls to 0 from stroke 15
    // and stays there (checked out to 40 strokes); 20 leaves headroom without
    // making the assertion meaningless.
    const strokes = 20;
    for (let s = 0; s < strokes; s++) {
      const preStroke = Int16Array.from(map.cells);
      applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      let moved = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (!fp.has(i) && map.cells[i] !== preStroke[i]) moved++;
      }
      movedPerStroke.push(moved);
    }
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
    // Phase 1: the containment is not "no spill at all".
    expect(movedPerStroke[0]).toBeGreaterThan(0);
    // Phase 2: the caps saturate and outside terrain stops moving entirely.
    expect(movedPerStroke[strokes - 1]).toBe(0);
  });

  it('never changes the rendered band of a cell outside the footprint (lowering)', () => {
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    for (let s = 0; s < STROKES; s++) {
      applySculpt(map, CX, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, BANDED);
    }
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('free spill on the same stroke DOES cross bands outside — the behaviour being contained', () => {
    // Sanity check on the fixture: without containment the same strokes leak
    // a new level outside the brush, so the two tests above are not vacuous.
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    for (let s = 0; s < STROKES; s++) {
      applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        ...BANDED,
        spill: 'free',
      });
    }
    let crossed = 0;
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      if (bandOf(map.cells[i]) !== bandOf(before[i])) crossed++;
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it('still converges within the pass budget when the cap binds', () => {
    const map = ledgeMap(64);
    const changed = new Set<number>();
    applyBrush(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT * 4, changed, 'hard');
    const fp = footprintOf(64, CX, CY, RADIUS);
    const passes = smooth(map, changed, undefined, fp);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
  });

  it('a capped ring never bleeds the mound: banded relaxation alone never nets negative', () => {
    // THE EROSION GUARD, as a relaxation-ONLY run so no brush delta can mask
    // the leak. If clamping were uncoupled — the free side shedding its half
    // while the capped side cannot absorb it — every pass would delete
    // terrain at the ring and the map total would fall. Coupled transfers
    // make every relaxation move net >= 0 for the map total (free pairs may
    // round +1 on an odd excess; banded pairs move both sides equally, net
    // 0), so pure relaxation must never lower the sum.
    const map = ledgeMap(64);
    const fp = footprintOf(64, CX, CY, RADIUS);
    // A hand-built spire on the footprint: tall enough that its ring binds
    // the caps hard and relaxation has many passes in which to leak.
    for (const i of fp) map.cells[i] += DEFAULT_SCULPT_AMOUNT * 8;
    const sum = (m: Heightmap) => m.cells.reduce((a, b) => a + b, 0);
    const before = sum(map);
    smooth(map, new Set<number>(), fp, fp);
    expect(sum(map) - before).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: identical banded strokes give identical maps and diffs', () => {
    const a = ledgeMap(64);
    const b = ledgeMap(64);
    for (let s = 0; s < STROKES; s++) {
      const da = applySculpt(a, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      const db = applySculpt(b, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      expect(da).toEqual(db);
    }
    expect(a.cells).toEqual(b.cells);
  });

  it('an explicit free spill is byte-identical to the pre-#26 absent-spill path', () => {
    // The compatibility contract, extended to the new field: plugins that
    // pass no options (or no spill) must keep the unbounded relaxation they
    // were tuned against, bit for bit.
    const absent = ledgeMap(64);
    const explicit = ledgeMap(64);
    for (let s = 0; s < STROKES; s++) {
      const da = applySculpt(absent, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'smooth',
        profile: 'soft',
      });
      const db = applySculpt(explicit, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'smooth',
        profile: 'soft',
        spill: 'free',
      });
      expect(da).toEqual(db);
    }
    expect(absent.cells).toEqual(explicit.cells);
  });

  /** Max gradient excess over MAX_STEP across the whole map. */
  function maxExcess(map: Heightmap): number {
    const { size, cells } = map;
    let worst = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (x < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + 1]) - MAX_STEP);
        if (y < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + size]) - MAX_STEP);
      }
    }
    return worst;
  }

  /** The #12 plateau: `bands` level-fill strokes at (x, y), radius 4. */
  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    }
  }

  const SMOOTH_HARD_BANDED = { tool: 'smooth', profile: 'hard', spill: 'banded' } as const;

  it('pins the standing residual of the #12 plateau scenario: 993 units of excess', () => {
    // The STANDING RESIDUAL made concrete (see movePair's doc): a plateau one
    // band short of the ceiling, smoothed with one banded stroke, leaves the
    // ring exceeding MAX_STEP by exactly this much — and banded relaxation can
    // never lower it (next test). A change to this number is a change to the
    // containment maths and must be deliberate.
    //
    // RE-MEASURED 2026-08-20, 871 → 978, and the re-terrace is the deliberate
    // change: the plateau is built from band-height strokes to a fixed
    // CEILING, so a finer band makes it 1008 units tall where it used to reach
    // 960, and the limit it is measured against halved with MAX_STEP. Taller
    // wall, tighter limit, larger standing excess.
    //
    // RE-MEASURED AGAIN 2026-08-21, 978 → 993, and the re-sample is again the
    // deliberate change — this time entirely through MAX_STEP, which is now a
    // slope per WORLD UNIT and so a quarter of what it was per cell. The wall
    // is the same height; the limit subtracted from it is 12 units lower, and
    // the residual is 15 units larger. Note the stroke is radius 4 CELLS here,
    // a quarter of a world unit: these scenarios pin the containment maths at
    // the grid's own scale, not a brush a player holds.
    //
    // RE-MEASURED AGAIN 2026-08-29, 993 → 987, and the conserving split (#108)
    // is the deliberate change. The relaxation now moves the SAME amount off
    // the high side that it puts on the low side, so the free cells inside the
    // footprint shed a little further before the caps outside stop them: six
    // more units come off the wall, and the standing excess is six smaller.
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(maxExcess(map)).toBe(987);
  });

  it('banded strokes can NEVER repair the standing ring — the excess does not fall', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    const standing = maxExcess(map);
    for (let s = 0; s < 20; s++) {
      applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    }
    expect(maxExcess(map)).toBeGreaterThanOrEqual(standing);
  });

  // The three #12 cascade scenarios, re-run banded (see the free-path
  // originals in 'smooth — cascades from stamped terrain (#12)'). The free
  // path's assertion — the gradient limit holds everywhere — is exactly what
  // banded gives up at the ring, so here the contract is: outside bands
  // untouched, and convergence stays inside the pass budget (measured: the
  // player-constructible cascades converge FASTER banded, 9 vs 67 passes,
  // because the caps stop the excess from travelling — see SMOOTH_PASS_LIMIT).
  it('#12 cascade, banded: one smooth stroke on a 15-band plateau', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: a fully clamped smooth stroke still relaxes under the brush', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS);
    expect(heightAt(map, 64, 64)).toBe(MAX_HEIGHT);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    const diff = applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    // The stroke still does its #12 job (relaxes SOMETHING despite the
    // clamped brush) without leaking a band outside the footprint.
    expect(diff.length).toBeGreaterThan(0);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: converges under the pass cap on the worst plateau (10 passes)', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed, undefined, footprintOf(128, 64, 64, 4));
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    // Pinned: the caps stop the excess from travelling, so banded converges in
    // single-digit passes where the free path needed dozens on this scenario.
    // (9 on the pre-disc square footprint; 8 after the 2026-08-19 tight disc
    // rounded the plateau's corners off; 2 since the 2026-08-20 re-terrace —
    // re-measured each time, never derived. It FELL because a band cap is now
    // a quarter as tall, so the banded relaxation runs out of room to move
    // anything after almost no work at all. 10 since the 2026-08-21 re-sample:
    // MAX_STEP is a slope per WORLD UNIT now, so a legal step is a quarter of
    // what it was and the same excess has to be walked out over four times the
    // cells before the band caps stop it.)
    //
    // 12 SINCE THE 2026-08-29 CONSERVING SPLIT (#108): the low side of a pair
    // now gains floor(e/2) rather than ceil(e/2), so an excess is walked out in
    // slightly smaller steps and two more passes run before nothing moves.
    // Still single-to-low-double digits, still far under the cap — the banded
    // path's cost characteristic is unchanged.
    expect(passes).toBe(12);
  });

  it('property: over random maps × radii × profiles, no outside cell ever changes band', () => {
    // Deterministic LCG so a failure reproduces exactly.
    let seed = 0x2f26;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 8; trial++) {
      const size = 48;
      const map = createHeightmap(size);
      for (let i = 0; i < map.cells.length; i++) {
        // anywhere in [MIN, MAX] — derived, so a range retune (Deep Strata
        // widened MIN_HEIGHT to −1536) keeps the property covering all of it
        map.cells[i] = (next() % (MAX_HEIGHT - MIN_HEIGHT + 1)) + MIN_HEIGHT;
      }
      for (let stroke = 0; stroke < 5; stroke++) {
        const cx = next() % size;
        const cy = next() % size;
        const radius = 1 + (next() % 4);
        const profile = next() % 2 === 0 ? 'soft' : 'hard';
        const amount = (next() % 2 === 0 ? 1 : -1) * DEFAULT_SCULPT_AMOUNT;
        const fp = footprintOf(size, cx, cy, radius);
        const before = Int16Array.from(map.cells);
        applySculpt(map, cx, cy, radius, amount, { tool: 'smooth', profile, spill: 'banded' });
        for (let i = 0; i < map.cells.length; i++) {
          if (!fp.has(i) && bandOf(map.cells[i]) !== bandOf(before[i])) {
            throw new Error(
              `trial ${trial} stroke ${stroke} (${cx},${cy}) r${radius} ${profile} ${amount}: ` +
              `cell ${i} band ${bandOf(before[i])} -> ${bandOf(map.cells[i])}`,
            );
          }
        }
      }
    }
  });
});

describe('forEachFootprintOffset — the tight-disc footprint (2026-08-19)', () => {
  function offsets(radius: number): string[] {
    const out: string[] = [];
    forEachFootprintOffset(radius, (dx, dy) => out.push(`${dx},${dy}`));
    return out;
  }

  it('radius 1 is the centre cell alone', () => {
    expect(offsets(1)).toEqual(['0,0']);
  });

  it('radius 2 is the 5-cell plus — the old 3×3 minus its corners', () => {
    expect(new Set(offsets(2))).toEqual(new Set(['0,0', '1,0', '-1,0', '0,1', '0,-1']));
  });

  it('radius 3 is the 21-cell disc — 5×5 minus its 4 corners', () => {
    const cells = new Set(offsets(3));
    expect(cells.size).toBe(21);
    for (const corner of ['2,2', '2,-2', '-2,2', '-2,-2']) expect(cells.has(corner)).toBe(false);
    for (const kept of ['2,1', '1,2', '2,0', '0,2', '1,1']) expect(cells.has(kept)).toBe(true);
  });

  it('radius 4 is the 37-cell rounded octagon', () => {
    const cells = new Set(offsets(4));
    expect(cells.size).toBe(37);
    // The ring the rounding removes vs keeps, spelled out: dx²+dy² < 12.
    for (const gone of ['3,2', '2,3', '3,3', '-3,2', '2,-3', '-3,-3']) {
      expect(cells.has(gone)).toBe(false);
    }
    for (const kept of ['3,0', '0,3', '3,1', '1,3', '2,2', '-3,-1']) {
      expect(cells.has(kept)).toBe(true);
    }
  });

  it('scan order is row-major ascending, unchanged by the disc rule', () => {
    const seen = offsets(3);
    const sorted = [...seen].sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number);
      const [bx, by] = b.split(',').map(Number);
      return ay - by || ax - bx;
    });
    expect(seen).toEqual(sorted);
  });
});

describe('the clicked-cell anchor (owner decision 2026-08-19)', () => {
  /** Wire-style options minus the relaxation, so the BRUSH contract is bare. */
  const STAMP_SOFT_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'soft', anchor: 'clicked' };
  const STAMP_HARD_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'hard', anchor: 'clicked' };

  /**
   * The owner's complaint as a fixture: clicking a band-6 tread whose brush
   * overlaps ground both lower (band 5) and higher (band 7). Centre at 400
   * (band 6) ⇒ a raise targets 7·64 = 448 and nothing under the brush may
   * cross it.
   */
  /**
   * Within-band offsets for the ledge fixture: a quarter of the way up the
   * band, an eighth, and just off its floor.
   *
   * FRACTIONS OF THE BAND, not the literals 16/10/2 they used to be. Those
   * sat strictly inside a band only while a band was 64 units tall; re-terraced
   * to 16, the first one equalled a WHOLE band and the fixture's "band 6"
   * ground silently became band 7, which is precisely the distinction every
   * assertion below turns on.
   */
  const LEDGE_MID_OFFSET = Math.floor(BAND_HEIGHT / 4);
  const LEDGE_LOW_OFFSET = Math.floor(BAND_HEIGHT / 8);
  const LEDGE_FLOOR_OFFSET = 1;

  function unevenLedge(): { map: Heightmap; lower: number[]; higher: number[] } {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT + LEDGE_MID_OFFSET); // band 6
    const lower: number[] = [];
    const higher: number[] = [];
    forEachFootprintOffset(3, (dx, dy) => {
      if (dy < -1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 5 * BAND_HEIGHT + LEDGE_LOW_OFFSET; // band 5
        lower.push(i);
      } else if (dy > 1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 7 * BAND_HEIGHT + LEDGE_FLOOR_OFFSET; // band 7
        higher.push(i);
      }
    });
    return { map, lower, higher };
  }

  it('raising never lifts ANY footprint cell past the level above the clicked cell', () => {
    const { map, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);

    for (let i = 0; i < map.cells.length; i++) {
      // No cell the stroke moved ends past the target...
      if (map.cells[i] !== before[i]) expect(map.cells[i]).toBeLessThanOrEqual(target);
      // ...and nothing anywhere ends above where it started unless it was
      // below the target (i.e. the periphery can never be pushed past the
      // level the player clicked).
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
    // The band-7 cells under the brush are byte-untouched — the exact cells
    // the pre-anchor brush used to shove toward band 8.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

  it('the periphery never ends above the centre when the ground under it started lower', () => {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT); // band-aligned band 6, everywhere
    // Hold the stroke: several anchored raises. Each stroke re-anchors to the
    // centre's NEW band (the centre climbs one band per stroke), and after
    // every one of them the falloff cells trail the centre — never pass it.
    for (let s = 0; s < 4; s++) {
      applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);
      const centre = heightAt(map, 16, 16);
      forEachFootprintOffset(3, (dx, dy) => {
        expect(heightAt(map, 16 + dx, 16 + dy)).toBeLessThanOrEqual(centre);
      });
    }
    expect(heightAt(map, 16, 16)).toBe((6 + 4) * BAND_HEIGHT);
  });

  it('lowering mirrors: nothing under the brush drops past the level below the clicked cell', () => {
    const { map, lower } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const floor = 5 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);

    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) expect(map.cells[i]).toBeGreaterThanOrEqual(floor);
      expect(map.cells[i]).toBeGreaterThanOrEqual(Math.min(before[i], floor));
    }
    // The band-5 cells sit LEDGE_LOW_OFFSET above their floor, so they may
    // descend to it but the ones already at or below it would be untouched;
    // here they move by at most that offset — never below the band-5 floor.
    for (const i of lower) expect(map.cells[i]).toBeGreaterThanOrEqual(floor);
  });

  it('hard + clicked anchors the level fill to the clicked band, not the footprint minimum', () => {
    const { map, lower, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_ANCHORED);

    // Band-5 holes rise by the full amount toward the CLICKED level — they do
    // not hold the fill back the way the surveyed ('free') fill has it.
    for (const i of lower) expect(map.cells[i]).toBe(before[i] + DEFAULT_SCULPT_AMOUNT);
    // Band-6 ground reaches the target exactly: a click from the band-6 ledge
    // caps at the clicked level rather than overshooting it.
    expect(heightAt(map, 16, 16)).toBe(target);
    // Band-7 ground under the brush is byte-untouched.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

  // ── The anchor must survive the relaxation pass (owner bug report
  // 2026-08-19, "smooth, soft appears to be broken"). The wire options every
  // player stroke actually carries: smooth + banded + clicked. Before the fix
  // the anchored BRUSH honoured the ceiling and the relaxation immediately
  // broke it — eroding the protected higher terrace down ("it sometimes
  // resets top layers") and lifting just-raised ground past the clicked
  // level. These pin the composed stroke, not the brush pass alone. ──
  const WIRE_SMOOTH_SOFT: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  it('smooth+soft raising: the higher terrace under the brush survives the RELAXATION too', () => {
    const { map, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    // The band-7 cells are byte-untouched by the WHOLE stroke — brush AND
    // relaxation. This is the exact cell set the pre-fix relaxation eroded.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
    // And nothing anywhere ends above the clicked ceiling unless it started
    // there — relaxation may no longer carry ground past the anchor.
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
  });

  it('smooth+soft lowering mirrors: cells below the anchored floor are byte-untouched', () => {
    const { map, lower } = unevenLedge();
    // Deepen the band-5 pocket to band 4 so the fixture holds ground BELOW
    // the lowering target (band-5 floor = 320) — the mirror of `higher`.
    const deepened: number[] = [];
    for (const i of lower) {
      map.cells[i] = 4 * BAND_HEIGHT + 8; // band 4 (264), below the 320 floor
      deepened.push(i);
    }
    const before = Int16Array.from(map.cells);
    const floor = 5 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    for (const i of deepened) expect(map.cells[i]).toBe(before[i]);
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeGreaterThanOrEqual(Math.min(before[i], floor));
    }
  });

  it('widening the world floor works: wall cells inside the footprint still descend', () => {
    // A pit already at MIN_HEIGHT with a wall through the footprint — the
    // owner's "make the bottom larger" situation. Lowering anchored at the
    // pit floor targets MIN_HEIGHT (one band down, clamped), so the wall
    // cells must keep moving down while the floor cells stay put.
    const map = createHeightmap(32);
    map.cells.fill(MIN_HEIGHT + 4 * BAND_HEIGHT); // wall ground, 4 bands up
    const floorCells: number[] = [];
    forEachFootprintOffset(3, (dx, dy) => {
      if (dx <= 0) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = MIN_HEIGHT;
        floorCells.push(i);
      }
    });
    const before = Int16Array.from(map.cells);

    const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    // The stroke is NOT a no-op: the wall half of the footprint descended.
    expect(diff.length).toBeGreaterThan(0);
    let wallMoved = 0;
    forEachFootprintOffset(3, (dx, dy) => {
      const i = cellIndex(map, 16 + dx, 16 + dy);
      if (before[i] > MIN_HEIGHT && map.cells[i] < before[i]) wallMoved++;
    });
    expect(wallMoved).toBeGreaterThan(0);
    // And nothing anywhere is below the world floor.
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }
  });

  it('a footprint entirely at the world floor is a true no-op: empty diff, both profiles, both tools', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (const tool of ['stamp', 'smooth'] as const) {
        const map = createHeightmap(32);
        map.cells.fill(MIN_HEIGHT);
        const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, {
          tool,
          profile,
          spill: 'banded',
          anchor: 'clicked',
        });
        expect(diff).toEqual([]);
      }
    }
  });

  it('anchored wire options are deterministic: two identical runs, identical worlds', () => {
    const runs: Int16Array[] = [];
    for (let run = 0; run < 2; run++) {
      const map = createHeightmap(48);
      for (let i = 0; i < map.cells.length; i++) map.cells[i] = ((i * 37) % 9 - 4) * BAND_HEIGHT;
      const wire: SculptOptions = { tool: 'smooth', profile: 'soft', spill: 'banded', anchor: 'clicked', targetBand: null, spanBand: null };
      applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 26, 23, 4, -DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 24, 24, 2, DEFAULT_SCULPT_AMOUNT, wire);
      runs.push(Int16Array.from(map.cells));
    }
    expect(runs[0]).toEqual(runs[1]);
  });
});

/**
 * A PLAYER STROKE MAY NOT UNDO ITSELF (owner bug report 2026-08-22, "shift
 * click lowering does not always work").
 *
 * THE CONTRACT, not the arithmetic that implements it: whatever the brush
 * writes at a footprint cell, the relaxation pass that follows it in the SAME
 * stroke may carry further in the stroke's direction but never back past. That
 * is one rule and it is the same rule both ways, so both ways are tested here
 * — the bug was precisely that the two ends of the interval were the world's
 * limits rather than the stroke's own result, which let a lowering stroke's
 * relaxation refill the pit the brush had just dug.
 *
 * Tested on terrain stated in WORLD units, not per cell: the failure needed
 * ground with real pre-existing slope for relaxation to have anything to pull
 * in from, and flat ground hides it completely (a flat-ground stroke is
 * already gradient-legal at every radius the picker offers, so no relaxation
 * fires at all).
 */
describe('a player stroke is never undone by its own relaxation (2026-08-22)', () => {
  const WORLD = 128;

  /** Rolling ground whose wavelengths are world distances, so the slopes are
   * the ones the game is tuned around whatever a cell is worth. */
  const rollingHills = (): Heightmap => {
    const map = createHeightmap(WORLD);
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const wx = x / WORLD_UNIT_CELLS;
        const wy = y / WORLD_UNIT_CELLS;
        map.cells[y * WORLD + x] = Math.round(
          (Math.sin(wx / 9) * Math.cos(wy / 7) * 6 + Math.sin((wx + wy) / 13) * 4) *
            BAND_HEIGHT,
        );
      }
    }
    return map;
  };

  /** What a player sculpt actually sends (protocol's WIRE defaults + smooth). */
  const wireSmooth: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  /** The radii the HUD's brush ladder offers, in cells: 1-4 world units. */
  const LADDER = [1, 2, 3, 4].map((worldUnits) => worldUnits * WORLD_UNIT_CELLS);

  for (const radius of LADDER) {
    for (const dir of [1, -1] as const) {
      const way = dir > 0 ? 'raises' : 'lowers';
      it(`one click ${way} the clicked cell by a band at radius ${radius}`, () => {
        // A spread of sites rather than one: the defect was terrain-dependent,
        // and a single lucky cell proves nothing about the rule.
        for (let t = 0; t < 60; t++) {
          const map = rollingHills();
          const cx = 30 + ((t * 11) % 68);
          const cy = 30 + ((t * 17) % 68);
          const centre = cellIndex(map, cx, cy);
          const before = quantizeToBand(map.cells[centre]);

          applySculpt(map, cx, cy, radius, dir * DEFAULT_SCULPT_AMOUNT, wireSmooth);

          const after = quantizeToBand(map.cells[centre]);
          expect(after).toBe(before + dir * BAND_HEIGHT);
        }
      });
    }
  }

  it('relaxation never carries the CLICKED cell back past the brush', () => {
    // The bound is on the ONE cell the stroke promises — the cell the player
    // aimed at — and deliberately not on the whole footprint. Bounding every
    // footprint cell also holds the click, but freezes the footprint (an
    // anchored stroke leaves most of it sitting exactly on the target) and,
    // through issue #26's coupled transfer, its neighbours too: `smooth` then
    // moves nothing outside its own footprint and IS `stamp`. The next test
    // pins the spill that narrowness buys.
    for (const dir of [1, -1] as const) {
      for (const radius of LADDER) {
        const brushed = rollingHills();
        const relaxed = rollingHills();
        const cx = 61;
        const cy = 47;
        const centre = cellIndex(brushed, cx, cy);
        const amount = dir * DEFAULT_SCULPT_AMOUNT;
        // The same stroke with the relaxation pass off, and with it on.
        applySculpt(brushed, cx, cy, radius, amount, { ...wireSmooth, tool: 'stamp' });
        applySculpt(relaxed, cx, cy, radius, amount, wireSmooth);

        if (dir > 0) {
          expect(relaxed.cells[centre]).toBeGreaterThanOrEqual(brushed.cells[centre]);
        } else {
          expect(relaxed.cells[centre]).toBeLessThanOrEqual(brushed.cells[centre]);
        }
      }
    }
  });

  it('still spills beyond its footprint — smooth has not become stamp', () => {
    // The regression this guards is the one the first attempt at the fix
    // caused: a bound wide enough to freeze the footprint silently turns the
    // smooth tool into the stamp tool, which no test then in the tree caught
    // at a player-selectable radius.
    for (const radius of LADDER) {
      const map = rollingHills();
      const before = Int16Array.from(map.cells);
      const cx = 61;
      const cy = 47;
      const footprint = new Set<number>();
      forEachFootprintOffset(radius, (dx, dy) => {
        footprint.add(cellIndex(map, cx + dx, cy + dy));
      });

      applySculpt(map, cx, cy, radius, DEFAULT_SCULPT_AMOUNT, wireSmooth);

      let movedOutside = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i] !== before[i] && !footprint.has(i)) movedOutside++;
      }
      expect(movedOutside).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE DRAG ANCHOR (`anchor: 'band'`, owner decision 2026-08-23: the drag tool
// owns the horizontal). Tested at the CONTRACT level — canSpreadBandTo and
// applySculpt — rather than through the client input that will call them, so
// these pin the rule itself and not one caller's wiring of it.
// ────────────────────────────────────────────────────────────────────────────

/** A flat map at `height`, with a square block raised to `blockHeight`. */
function mapWithPlateau(
  size: number,
  height: number,
  blockHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ReturnType<typeof createHeightmap> {
  const map = createHeightmap(size);
  map.cells.fill(height);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) map.cells[cellIndex(map, x, y)] = blockHeight;
  }
  return map;
}

describe('canSpreadBandTo — the drag anchor’s adjacency rule', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;

  it('is true beside ground already at the band, in all eight directions', () => {
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const) {
      const map = createHeightmap(16);
      map.cells.fill(0);
      map.cells[cellIndex(map, 8 + dx, 8 + dy)] = HIGH;
      expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
    }
  });

  it('is true beside ground ABOVE the band — a lip may spread off a taller shelf', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 9, 8)] = HIGH + BAND_HEIGHT * 4;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
  });

  it('is false in open ground — a forged band conjures no height', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('is false two cells away — the band creeps one cell at a time', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 10, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
    expect(canSpreadBandTo(map, 9, 8, BAND)).toBe(true);
  });

  it('ignores the cell’s OWN height — adjacency is about neighbours', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 8, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('treats off-map neighbours as absent — the world border holds nothing up', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(false);
    map.cells[cellIndex(map, 1, 1)] = HIGH;
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(true);
  });
});

describe('applySculpt with the drag anchor — a band extends sideways', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;
  /** What the client sends for a drag: one cell, stamp + hard, band-anchored. */
  const DRAG = { tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'band' } as const;

  it('pulls the grabbed band onto the cell beside it, and stops AT it', () => {
    // A plateau at band 3 filling the left half; drag its lip one cell right.
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff.length).toBe(1);
    // ONE INTENT ARRIVES (owner decision 2026-08-23). The cell levels with the
    // terrace it was dragged from — all three bands — rather than climbing one
    // band per pass, which would mean sweeping the same ground three times.
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
    // And it stops there: repeating the drag on an arrived cell moves nothing,
    // so a held drag cannot walk a terrace upward.
    const again = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(again).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
  });

  it('is a NO-OP on a cell that touches no such ground — the anti-cheat rule', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    const before = [...map.cells];
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect([...map.cells]).toEqual(before);
  });

  it('never touches ground already at or above the grabbed band', () => {
    // The cell being dragged onto is HIGHER than the band being dragged: a
    // drag stops at a higher band's edge, it does not strip it (owner rule).
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const tall = (BAND + 4) * BAND_HEIGHT;
    map.cells[cellIndex(map, 8, 8)] = tall;
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(tall);
  });

  it('targets the GRABBED band, not one band off the cell under the cursor', () => {
    // This is the whole difference from `anchor: 'clicked'`. Ground at band 0
    // beside a band-6 shelf: the drag climbs to band 6 and STOPS — it is
    // levelling with the terrace it grabbed. A clicked-anchored stroke has no
    // such destination: it re-derives "one band above where I am now" every
    // repeat, so it climbs straight past the shelf and keeps going. That is
    // the stamp working correctly and it is why the drag needed a new anchor
    // rather than a wider one.
    const grabbed = 6;
    const map = createHeightmap(16);
    map.cells.fill(0);
    for (let y = 0; y < 16; y++) map.cells[cellIndex(map, 7, y)] = grabbed * BAND_HEIGHT;
    applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: grabbed,
    });
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(grabbed * BAND_HEIGHT);

    const clicked = createHeightmap(16);
    clicked.cells.fill(0);
    for (let y = 0; y < 16; y++) clicked.cells[cellIndex(clicked, 7, y)] = grabbed * BAND_HEIGHT;
    for (let i = 0; i < 20; i++) {
      applySculpt(clicked, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'clicked',
      });
    }
    expect(bandOf(clicked.cells[cellIndex(clicked, 8, 8)]!)).toBeGreaterThan(grabbed);
  });

  it('walks: each intent’s result is what makes the next one legal', () => {
    // Drag straight out across open ground, one cell per intent, as the client
    // input's path walk does. The lip must advance by exactly one cell a time.
    const map = mapWithPlateau(24, 0, HIGH, 0, 0, 7, 23);
    for (let x = 8; x < 14; x++) {
      // One intent per cell, exactly what the client's path walk emits.
      applySculpt(map, x, 12, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        ...DRAG,
        targetBand: BAND,
      });
      expect(map.cells[cellIndex(map, x, 12)]).toBe(HIGH);
      // The cell beyond is untouched until the drag reaches it.
      expect(map.cells[cellIndex(map, x + 1, 12)]).toBe(0);
    }
  });
});

describe('relaxation conserves height exactly (issue #108)', () => {
  /**
   * A cliff: the west half of the map at `height`, the east half at 0, with
   * NOTHING else done to it — no brush, no spill bounds, no anchor. This is
   * the #108 measurement fixture, and it is deliberately bare: the leak being
   * pinned here is relaxation's own arithmetic, so anything a brush might add
   * or subtract would only muddy the sum.
   */
  function cliffMap(size: number, height: number): Heightmap {
    const map = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) {
        map.cells[cellIndex(map, x, y)] = height;
      }
    }
    return map;
  }

  /** Every cell of the raised half — the seed the cascade starts from. */
  function cliffSeed(map: Heightmap, height: number): Set<number> {
    const seed = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] === height) seed.add(i);
    }
    return seed;
  }

  /** A single cell at MAX_HEIGHT on an otherwise flat map. */
  function spireMap(size: number): Heightmap {
    const map = createHeightmap(size);
    map.cells[cellIndex(map, size >> 1, size >> 1)] = MAX_HEIGHT;
    return map;
  }

  /** The whole map's height, as an exact integer — the quantity #108 is about. */
  function mapTotal(map: Heightmap): number {
    let total = 0;
    for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
    return total;
  }

  /** The #108 measurement heights. Conservation must hold on all of them. */
  const CLIFF_HEIGHTS = [100, 401, 1000];

  /**
   * The heights whose cascade also fits inside SMOOTH_PASS_LIMIT. 1000 does
   * not — see the truncation test below, which pins that boundary rather than
   * hiding it by not testing it.
   */
  const CONVERGING_CLIFF_HEIGHTS = [100, 401];

  /**
   * An explicit budget for the cliff fixtures. The tallest of them relaxes for
   * SMOOTH_PASS_LIMIT passes over a 128² map — seconds of real arithmetic, and
   * more than vitest's 5 000 ms default once `pnpm test` is running every
   * package's suite at once. Long by design, not slow by accident.
   */
  const CLIFF_TIMEOUT_MS = 30_000;

  for (const height of CLIFF_HEIGHTS) {
    it(`invents nothing relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const before = mapTotal(map);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      // EXACT, not approximate. Relaxation is closed over the map — every unit
      // it moves comes off a neighbour — so the only correct difference is 0.
      // Before the even split (#108) a 401-unit cliff manufactured 1,666,592
      // units here, 50.7% of the map's total, purely from the odd remainder of
      // `e >> 1` being handed to the low cell and taken off nobody.
      expect(mapTotal(map)).toBe(before);
    });
  }

  for (const height of CONVERGING_CLIFF_HEIGHTS) {
    it(`converges relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      const passes = smooth(map, new Set(seed), seed);
      // Strictly below the cap proves a clean pass ran, i.e. the sweep stopped
      // because nothing moved and not because it ran out of budget. This is
      // the property a bare even split threatened (#108 measured it spinning
      // to the cap) and RELAX_SLACK restores: an excess of 1 is legal, so
      // e >= 2 for every pair that is touched at all and both sides move at
      // least 1 — every counted move is progress.
      expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    });
  }

  it('invents nothing relaxing a full-height spire', () => {
    const map = spireMap(128);
    const before = mapTotal(map);
    const seed = new Set([cellIndex(map, 64, 64)]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
  });

  it('converges relaxing a full-height spire', () => {
    const map = spireMap(128);
    const seed = new Set([cellIndex(map, 64, 64)]);
    expect(smooth(map, new Set(seed), seed)).toBeLessThan(SMOOTH_PASS_LIMIT);
  });

  it('leaves every pair inside the gradient limit plus the slack', { timeout: CLIFF_TIMEOUT_MS }, () => {
    // The invariant relaxation now guarantees. The slack is the odd remainder
    // that STAYS in the pair rather than being invented into the low cell:
    // a pair sitting at MAX_STEP + 1 is at rest, by construction of the
    // trigger, and is the price of exact conservation.
    for (const height of CONVERGING_CLIFF_HEIGHTS) {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      expectGradientLimitHolds(map);
    }
  });

  it('runs out of pass budget on a 1000-unit cliff — the known boundary', { timeout: CLIFF_TIMEOUT_MS }, () => {
    // NAMED, NOT HIDDEN. Conservation costs passes: the fill on the low side
    // is no longer invented, so every unit of the ramp has to be walked down
    // off the plateau, and a cascade takes roughly four times as many passes
    // as it did. Measured on this fixture (.sim-108/results.txt): 841 passes
    // under the old manufacturing rule, ~7205 under this one — it DOES
    // converge, and leaves a max gradient of 5, but only when given the budget.
    // At SMOOTH_PASS_LIMIT = 2560 the sweep is truncated instead.
    //
    // WHAT THAT MEANS AND DOES NOT MEAN. SMOOTH_PASS_LIMIT is a bound on the
    // authoritative server's CPU per intent, not a promise of convergence, and
    // that bound is unchanged — the worst case still costs exactly the cap.
    // What grew is the set of scenarios that reach it, and the residual is the
    // one already documented on SMOOTH_PASS_LIMIT: the gradient invariant is
    // locally violated until a later edit resumes relaxation. Every
    // PLAYER-CONSTRUCTIBLE cascade still converges far under the cap (the #12
    // stress tests above, and the banded worst case at 12 passes); a 1000-unit
    // vertical cliff is a synthetic fixture, roughly 62 stamped bands of sheer
    // wall, not a stroke.
    const map = cliffMap(128, 1000);
    const seed = cliffSeed(map, 1000);
    expect(smooth(map, new Set(seed), seed)).toBe(SMOOTH_PASS_LIMIT);
  });

  it('is deterministic: identical input, identical output', { timeout: CLIFF_TIMEOUT_MS }, () => {
    // The determinism contract (constants.ts) restated against the new
    // arithmetic — server and client must agree bit for bit.
    const a = cliffMap(128, 401);
    const b = cliffMap(128, 401);
    const seedA = cliffSeed(a, 401);
    const seedB = cliffSeed(b, 401);
    const passesA = smooth(a, new Set(seedA), seedA);
    const passesB = smooth(b, new Set(seedB), seedB);
    expect(passesA).toBe(passesB);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
  });

  /**
   * GENESIS-SHAPED GROUND: band-quantised plateaus on a coarse lattice — the
   * exact shape `World.createFresh` writes (every cell `bands * BAND_HEIGHT`
   * off a noise lattice, never smoothed), so neighbouring plateaus meet in
   * SHEER whole-band steps of 16, 32 or 48 units against a gradient limit of 5.
   *
   * WHY THE FIXTURE IS BUILT HERE RATHER THAN IMPORTED: `shared/` may not
   * import from `server/`, and the property under test is not genesis's noise —
   * it is that the ground a fresh world ships is ALREADY over-steep everywhere,
   * which is what makes a player's first smooth stroke on it a real cascade
   * instead of a no-op. The hash is integer-only and fixed, so the fixture is
   * identical on every machine.
   */
  function genesisTerraces(size: number): Heightmap {
    const map = createHeightmap(size);
    const LATTICE_CELLS = 16;
    const BAND_SPREAD = 7;
    const LOWEST_BAND = -2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = Math.floor(x / LATTICE_CELLS);
        const gy = Math.floor(y / LATTICE_CELLS);
        let h = (gx * 73856093) ^ (gy * 19349663);
        h = (h ^ (h >>> 13)) >>> 0;
        map.cells[cellIndex(map, x, y)] = ((h % BAND_SPREAD) + LOWEST_BAND) * BAND_HEIGHT;
      }
    }
    return map;
  }

  /** The footprint of a brush, as `smooth`'s spill-free / bbox-seed set. */
  function brushFootprint(map: Heightmap, cx: number, cy: number, radius: number): Set<number> {
    const cells = new Set<number>();
    forEachFootprintOffset(radius, (dx, dy) => {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.size || y >= map.size) return;
      cells.add(cellIndex(map, x, y));
    });
    return cells;
  }

  /** Solid material in the world: every span's thickness, layered columns included. */
  function mapVolume(map: Heightmap): number {
    let volume = 0;
    for (let y = 0; y < map.size; y++) {
      for (let x = 0; x < map.size; x++) {
        for (const span of readSpans(map, x, y)) volume += span.ceiling - span.floor;
      }
    }
    return volume;
  }

  const TERRACE_SIZE = 96;
  const TERRACE_CENTRE = 48;

  it('the PLAYER smooth tool on genesis terraces: real cascade, pinned', () => {
    // SUPERSEDES the "what a player does is unchanged, bit for bit" claim that
    // used to be asserted with WIRE_DEFAULT_SCULPT_OPTIONS alone. That default
    // is the STAMP (shared/src/protocol.ts), and a stamp never relaxes — so the
    // assertion could not have failed however the relaxation changed, which
    // makes it no evidence at all. The player's SMOOTH tool is the one that
    // reaches this code, and on the ground a fresh world actually ships it
    // moves real cells. Pinned rather than asserted equal to anything: the
    // point is that the behaviour is known, not that it is unchanged.
    const map = genesisTerraces(TERRACE_SIZE);
    const before = Int16Array.from(map.cells);
    const PLAYER_SMOOTH: SculptOptions = { ...WIRE_DEFAULT_SCULPT_OPTIONS, tool: 'smooth' };

    const diff = applySculpt(
      map,
      TERRACE_CENTRE,
      TERRACE_CENTRE,
      4,
      DEFAULT_SCULPT_AMOUNT,
      PLAYER_SMOOTH,
    );
    let moved = 0;
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) moved++;
    }
    // Measured 2026-08-29 (.sim-108/probe3.mjs). Every cell the diff reports is
    // a cell that really moved, and the stroke is band-contained, so this is a
    // brush-sized edit and not a world-wide regrade.
    expect(diff.length).toBe(37);
    expect(moved).toBe(37);

    // AND IT SETTLES rather than eating the hillside: successive strokes on the
    // same spot keep touching more ground (the terrace steps around it are
    // still over-steep) but each one is bounded by its own footprint's band
    // caps, so the count grows slowly instead of exploding.
    const counts = [diff.length];
    for (let stroke = 0; stroke < 3; stroke++) {
      counts.push(
        applySculpt(map, TERRACE_CENTRE, TERRACE_CENTRE, 4, DEFAULT_SCULPT_AMOUNT, PLAYER_SMOOTH)
          .length,
      );
    }
    expect(counts).toEqual([37, 58, 74, 94]);
  });

  it('the relaxation pass conserves height exactly on the FREE path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const seed = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), seed);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the BANDED path', () => {
    // The player's containment (issue #26): every cell outside the footprint is
    // capped to its pre-stroke band, so movePair takes the COUPLED-CLAMP branch
    // — the one whose `t` is the whole reason conservation had to be argued for
    // separately here.
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the ANCHORED path', () => {
    // The clicked-cell anchor (2026-08-19): footprint cells carry their own
    // interval, which takes precedence over the footprint's blanket freedom and
    // drives the same coupled clamp from the other side.
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const anchorBounds = new Map<number, { lo: number; hi: number }>();
    for (const i of footprint) {
      const h = map.cells[i]!;
      anchorBounds.set(i, { lo: h - BAND_HEIGHT, hi: h + BAND_HEIGHT });
    }
    const passes = smooth(map, new Set(), footprint, footprint, anchorBounds);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the LAYERED path conserves SOLID VOLUME; its cells-sum is not a conserved quantity', () => {
    // KNOWN RESIDUAL, PRE-EXISTING, PINNED RATHER THAN FIXED (issues #108 and
    // #129 step 4.6). On a world holding a layered column the pass relaxes a
    // VIEW of the grasped layer's ceilings and commits it through
    // `moveSpanCeiling`; `map.cells` holds only the TOP span's ceiling, so a
    // stroke that moves a LOWER span changes the world's solid material not at
    // all while changing the sum of `map.cells` by an amount that depends on
    // the column shapes it touched. That sum is therefore the wrong invariant
    // to assert on this path, and the right one — material — holds exactly.
    const ROOF_GAP_BANDS = 8;
    const map = genesisTerraces(TERRACE_SIZE);
    for (let y = 40; y < 56; y++) {
      for (let x = 40; x < 56; x++) {
        const floorHeight = map.cells[cellIndex(map, x, y)]!;
        setColumn(map, x, y, [
          { floor: BEDROCK_FLOOR, ceiling: floorHeight },
          {
            floor: floorHeight + ROOF_GAP_BANDS * BAND_HEIGHT,
            ceiling: floorHeight + (ROOF_GAP_BANDS + 1) * BAND_HEIGHT,
          },
        ]);
      }
    }
    const volumeBefore = mapVolume(map);
    const cellsBefore = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    // The invariant that means something on this path.
    expect(mapVolume(map)).toBe(volumeBefore);
    // And the one that does not, pinned so a change in it is noticed and
    // explained rather than discovered as a mystery. Measured 2026-08-29
    // (.sim-108/probe3.mjs); it is NEGATIVE because the roofed columns' top
    // ceilings are untouched while the ground under them moves.
    expect(mapTotal(map) - cellsBefore).toBe(-1408);
  });

  it('pins the free-spill peak: 384 library-default clicks build a hill of 87', () => {
    // The number the conserving split leaves for a plugin-style stroke: the
    // library default is smooth + FREE spill + FREE anchor, so a stacked click
    // spills its height outward instead of holding it under the brush. Under
    // the old rule the same 384 clicks reached MAX_HEIGHT — on manufactured
    // height: the brush delivered 18,432 units and the map ended up holding
    // 3,686,396 (.sim-108/results.txt). Now the map holds exactly the 18,432
    // the brush paid for, and the peak that buys is 87.
    const STACKED_CLICKS = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
    const map = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
    }
    expect(heightAt(map, 32, 32)).toBe(87);
    expect(mapTotal(map)).toBe(18_432);
  });

  it('never moves a pair APART when a span cap is already violated (the movePair guard)', () => {
    // THE FAILURE MODE. movePair's coupled clamp takes `t = min(dropCap,
    // riseCap)` and moves BOTH sides by it. Both caps are differences against a
    // bound the capture is supposed to have put on the far side of the cell, so
    // the comment there argued they could never be negative — but that is an
    // argument about the caller, and a SPAN cap is built from the column rather
    // than captured: `spanCaps.lo` is `spanLowestBandHeight`, the lowest BAND
    // BOUNDARY at or above the span's floor, which for an UNDRAWN span (one
    // thinner than a band, falling between two boundaries) is ABOVE the span's
    // own ceiling. `dropCap` is then negative, and `drop = rise = t` with t < 0
    // RAISES the high cell and LOWERS the low one: the pair ends steeper than
    // it started and the sweep counts that as progress.
    //
    // Measured before the guard (.sim-108/probe3.mjs): the layered cell rose
    // from 14 to 16 against a neighbour at 0 — a pair at 14 pushed to 16.
    const map = createHeightmap(16);
    const UNDRAWN_FLOOR = 10;
    const UNDRAWN_CEILING = 14; // < BAND_HEIGHT: no band boundary inside the span
    setColumn(map, 8, 8, [
      { floor: BEDROCK_FLOOR, ceiling: -100 },
      { floor: UNDRAWN_FLOOR, ceiling: UNDRAWN_CEILING },
    ]);
    const layered = cellIndex(map, 8, 8);
    const neighbour = cellIndex(map, 9, 8);
    const before = Int16Array.from(map.cells);
    const seed = new Set([layered, neighbour]);

    smooth(map, new Set(), seed);

    // The pair is REFUSED, which is what the coupled clamp already reports for
    // "not even one unit fits" — and refusal is the only correct answer: it
    // leaves the world exactly as it found it.
    expect(map.cells[layered]).toBe(UNDRAWN_CEILING);
    expect(Array.from(map.cells)).toEqual(Array.from(before));
  });

  it('invents nothing scouring a head out of steep ground (issue #239)', () => {
    // The mudslide head scour, reduced to its core: lower a centre cell hard
    // and let the relaxation answer. #239's symptom was that the surroundings
    // rose as much as the centre fell, so the plugin measured net >= 0 and
    // abandoned the slide. The sum below is the reason that could happen.
    const map = createHeightmap(128);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = 512;
    const centre = cellIndex(map, 64, 64);
    map.cells[centre] = 512 - 64;
    const before = mapTotal(map);
    const seed = new Set([centre]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
    // And the scour is still a NET REMOVAL at the head, which is what the
    // plugin measures to decide the slide carries a load at all.
    expect(map.cells[centre]!).toBeLessThan(512);
  });
});
describe('smooth builds the layer view only where the sweep meets a layered column', () => {
  const SIZE = 64;
  /** Flat ground, high enough to carve a gap out of the middle of it. */
  const GROUND_BAND = 10;
  /**
   * The carved column, in the corner opposite the stroke. The gap spans four
   * bands because `isGapDrawn` folds a shallow opening back into one span —
   * this has to leave a column that really holds two spans, not one.
   */
  const CARVED_X = 1;
  const CARVED_Y = 1;
  const CARVE_FLOOR_BAND = 2;
  const CARVE_ROOF_BAND = 6;
  /** The stroke, ~46 cells away from the carve and radius+cascade nowhere near it. */
  const FAR_X = 48;
  const FAR_Y = 48;
  const STROKE_RADIUS = 8;
  const SMOOTH_STROKE: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  function flatWorld(carved: boolean): Heightmap {
    const map = createHeightmap(SIZE);
    map.cells.fill(GROUND_BAND * BAND_HEIGHT);
    if (carved) {
      carveRange(
        map,
        CARVED_X,
        CARVED_Y,
        CARVE_FLOOR_BAND * BAND_HEIGHT,
        CARVE_ROOF_BAND * BAND_HEIGHT,
      );
    }
    return map;
  }

  /**
   * Counts the whole-grid copies the sculpt makes. `map.cells.slice()` in
   * buildLayerView is the only one on this path, so this counts layer views —
   * the cost the stroke is supposed to pay only when it meets a layered column.
   */
  function countGridCopies(map: Heightmap): () => number {
    let copies = 0;
    const real = map.cells.slice.bind(map.cells);
    Object.defineProperty(map.cells, 'slice', {
      configurable: true,
      // Arguments forwarded: since #275 the view copies a BAND of rows
      // (`slice(base, end)`), not the whole grid, and a stub that dropped the
      // range would hand the sweep an array indexed from the wrong origin.
      value: (...args: readonly number[]): Int16Array => {
        copies++;
        return real(...args);
      },
    });
    return () => copies;
  }

  it('a carve in the far corner costs a distant stroke nothing, and changes nothing', () => {
    // Pre-2026-08-29 the test was `map.columnSpans.size === 0` — a GLOBAL
    // fact — so one carve anywhere made every later smooth stroke copy and
    // clear the whole grid, whatever it was actually sweeping.
    const carved = flatWorld(true);
    expect(carved.columnSpans.size).toBe(1);
    const copies = countGridCopies(carved);
    const carvedDiff = applySculpt(carved, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(0);

    // And skipping the view is exact, not an approximation: the identical
    // stroke on an uncarved world produces the identical diff.
    const plain = flatWorld(false);
    const plainDiff = applySculpt(plain, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(carvedDiff).toEqual(plainDiff);
    expect(carvedDiff.length).toBeGreaterThan(0);
  });

  it('a stroke whose sweep does reach the carved column still relaxes a view', () => {
    const carved = flatWorld(true);
    const copies = countGridCopies(carved);
    applySculpt(carved, CARVED_X + STROKE_RADIUS, CARVED_Y + STROKE_RADIUS, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(1);
  });
});

describe('applySculpt — carve grasped at the bottom of the world', () => {
  const SIZE = 32;
  const PIT_X = 10;
  const PIT_Y = 10;
  /**
   * The second rung of the HUD's brush sizes, and the smallest radius whose
   * footprint reaches a NEIGHBOUR of the pit — the cell that still has material
   * at the world's bottom band for the cut to take away. Radius 1 is a one-cell
   * footprint and hides the bug.
   */
  const RADIUS = 2;

  it('refuses the whole stroke rather than cutting a column off its bedrock', () => {
    const map = createHeightmap(SIZE);
    // The pick that mints `spanBand: MIN_BAND` is an ordinary one: the floor of
    // a pit dug all the way down, whose horizontal face reports the band of its
    // own cap. Dig it with plain lower strokes, the way a player would.
    const strokes = Math.ceil((0 - MIN_HEIGHT) / DEFAULT_SCULPT_AMOUNT);
    for (let n = 0; n < strokes; n++) {
      applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp',
        profile: 'hard',
      });
    }
    expect(heightAt(map, PIT_X, PIT_Y)).toBe(MIN_HEIGHT + 1);

    // The cut would leave every neighbour of the pit floored above
    // BEDROCK_FLOOR — a column standing on nothing, which setColumn refuses —
    // so the stroke must be a no-op, not a RangeError thrown out of the
    // server's message handler and the client's prediction alike.
    const before = Int16Array.from(map.cells);
    const diff = applySculpt(map, PIT_X, PIT_Y, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: MIN_BAND,
    });

    expect(diff).toEqual([]);
    expect(map.cells).toEqual(before);
    expect(map.columnSpans.size).toBe(0);
  });
});

describe('a soft drag bites its rim at the disc diagonals too (issue #152)', () => {
  const SIZE = 64;
  /** Band-1 ground for the pull to spread out of; everything west of it is band 0. */
  const PLATEAU_X = 40;
  const TARGET_BAND = 1;
  const RADIUS = 4;
  /**
   * A PINNED WITNESS. At this centre the ragged rim's noise refuses the offset
   * below, and no chain of refused cells joins it to the `dist === RADIUS - 1`
   * ring — so seeding the flood from that ring alone never reached it, and it
   * was admitted as an enclave and filled. `cellNoise` is a deterministic
   * function of position, so the case is stable; it was found by sweeping every
   * centre of this fixture and diffing the two seeding rules.
   */
  const CX = 37;
  const CY = 17;
  /**
   * On the disc's BOUNDARY — its west neighbour (-3, 2) is outside a radius-4
   * disc (9 + 4 >= 4·3) — while its `dist` is floor(sqrt(8)) = 2, not the
   * outermost 3. That gap between "touches the outside" and "is on the
   * outermost ring" is the whole defect.
   */
  const BOUNDARY_DX = -2;
  const BOUNDARY_DY = 2;

  it('leaves a refused boundary cell bitten rather than filling it as an enclave', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = PLATEAU_X; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    }

    applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'soft',
      targetBand: TARGET_BAND,
    });

    // The pull did happen: the disc is mostly at the grabbed band.
    expect(heightAt(map, CX, CY)).toBe(BAND_HEIGHT);
    // And the rim kept its bite, which is the point of the ragged profile.
    expect(heightAt(map, CX + BOUNDARY_DX, CY + BOUNDARY_DY)).toBe(0);
  });
});

describe('a pull carries the one level under it and no further', () => {
  const SIZE = 64;
  /** Cells per tread, wide enough that a step is a step and not a cliff. */
  const TREAD_CELLS = 2;
  const TOP_BAND = 3;
  /** The first tread's west edge; everything west of it stands at TOP_BAND. */
  const STAIR_X = 20;
  const CY = 32;
  const RADIUS = 2;

  /** The staircase: TOP_BAND, then one band down every TREAD_CELLS cells. */
  const bandAtX = (x: number): number =>
    x < STAIR_X ? TOP_BAND : Math.max(0, TOP_BAND - (Math.floor((x - STAIR_X) / TREAD_CELLS) + 1));

  it('pushes the step below the grabbed band, and leaves the one under that', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = bandAtX(x) * BAND_HEIGHT;
    }

    applySculpt(map, STAIR_X, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'hard',
      targetBand: TOP_BAND,
    });

    // The pull itself: the grabbed band took the tread it was pulled across.
    expect(bandOf(heightAt(map, STAIR_X, CY))).toBe(TOP_BAND);
    // The step immediately below is CARRIED — it gives ground rather than
    // being swallowed, which is the whole reason pushLowerLayers exists.
    expect(bandOf(heightAt(map, STAIR_X + TREAD_CELLS, CY))).toBe(TOP_BAND - 1);
    // And the chain stops there (owner, 2026-08-24): the level under THAT was
    // crowded by the cascade, not by the player's own fill, so it does not
    // move — one gesture, one level. A cascade that fed each level's push into
    // the next one's entitlement is the ladder the lip can never catch up to.
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS - 1, CY))).toBe(TOP_BAND - 2);
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS, CY))).toBe(TOP_BAND - 3);
  });
});
