import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, MIN_HEIGHT, SEA_LEVEL, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  WATER_DEEP_STRATA_ALPHA,
  WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  WATER_DEPTH_FLOOR_WORLD_UNITS,
  WATER_DEPTH_SATURATION_WORLD_UNITS,
  WATER_MAX_ALPHA,
  WATER_MIN_ALPHA,
  WATER_SPECULAR_FACTOR_DEFAULT_BYTE,
  WATER_SPECULAR_FLOOR,
  depthAlphaByte,
  depthSpecularFactorByte,
  depthToSpecularFactor,
  depthToWaterAlpha,
  surfaceAlphaByte,
  waterDepthWorldUnits,
  writeWaterDepthTexels,
} from '../src/terrain/waterDepth.ts';

/** 64 cells = 4×4 chunks: matches test/mirror.test.ts's own convention. */
const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

describe('waterDepthWorldUnits', () => {
  it('is zero at the waterline', () => {
    expect(waterDepthWorldUnits(SEA_LEVEL)).toBe(0);
  });

  it('is zero (clamped) for dry land', () => {
    expect(waterDepthWorldUnits(1)).toBe(0);
    expect(waterDepthWorldUnits(500)).toBe(0);
  });

  it('reaches the full world-unit depth at MIN_HEIGHT', () => {
    // MIN_HEIGHT is the world's floor (the bottom of the Deep Strata lava
    // band) — the deepest a water column can ever be asked to render.
    expect(waterDepthWorldUnits(MIN_HEIGHT)).toBeGreaterThan(
      WATER_DEPTH_SATURATION_WORLD_UNITS,
    );
  });

  it('reaches exactly WATER_DEPTH_FLOOR_WORLD_UNITS at MIN_HEIGHT (2026-08-20 amendment)', () => {
    // waterDepth.ts's own deep-strata alpha ramp uses this exact equality
    // (both are `(SEA_COLUMN_BANDS + DEEP_STRATA_BANDS) * BAND_HEIGHT *
    // HEIGHT_WORLD_SCALE`, derived independently — MIN_HEIGHT from shared's
    // constants.ts, WATER_DEPTH_FLOOR_WORLD_UNITS from waterDepth.ts's own
    // copy of the same strata-stack constants) to know when the deep-strata
    // ramp has reached its own floor and should stop, not just approach it.
    expect(waterDepthWorldUnits(MIN_HEIGHT)).toBe(WATER_DEPTH_FLOOR_WORLD_UNITS);
  });
});

describe('depthToWaterAlpha', () => {
  it('is WATER_MIN_ALPHA at zero depth — clear at the waterline', () => {
    expect(depthToWaterAlpha(0)).toBe(WATER_MIN_ALPHA);
  });

  it('clamps negative depth to WATER_MIN_ALPHA (defensive, not an expected input)', () => {
    expect(depthToWaterAlpha(-5)).toBe(WATER_MIN_ALPHA);
  });

  it('reaches exactly WATER_MAX_ALPHA at the saturation depth', () => {
    expect(depthToWaterAlpha(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBeCloseTo(
      WATER_MAX_ALPHA,
      10,
    );
  });

  // AMENDMENT (2026-08-20): "does not climb past WATER_MAX_ALPHA beyond the
  // saturation depth" and "is monotonically non-decreasing ... past
  // saturation" — the two tests that stood here — pinned the PRE-fix shape
  // (flat forever past the sea-column floor). That flatness is exactly the
  // second half of the milky-water bug this session fixes (see
  // waterDepth.ts's WATER_DEEP_STRATA_ALPHA comment): capped-but-flat alpha
  // over seven bands of near-black crust still reads as one smooth dark
  // sheet. Replaced below with tests pinning the new three-segment shape:
  // rises to the cap, then descends again past it, never re-climbing.

  it('descends from WATER_MAX_ALPHA back down to WATER_DEEP_STRATA_ALPHA past the saturation depth', () => {
    // The load-bearing behaviour, now the OPPOSITE of the pre-2026-08-20
    // shape: a lava-floor dig (MIN_HEIGHT) must read as THINNER water than
    // the ordinary sea floor directly above it, not the same or thicker —
    // that is what lets the crust's own colour and the lava glow read
    // through (see the module comment).
    const atSaturation = depthToWaterAlpha(WATER_DEPTH_SATURATION_WORLD_UNITS);
    const atFloor = depthToWaterAlpha(waterDepthWorldUnits(MIN_HEIGHT));
    expect(atSaturation).toBe(WATER_MAX_ALPHA);
    expect(atFloor).toBe(WATER_DEEP_STRATA_ALPHA);
    expect(atFloor).toBeLessThan(atSaturation);
  });

  it('holds flat at WATER_DEEP_STRATA_ALPHA for any depth at or beyond the world floor', () => {
    // MIN_HEIGHT IS the floor in practice, but the function stays total and
    // does not extrapolate past the sign change for a hypothetically deeper
    // input (defensive, see the function's own doc comment).
    expect(depthToWaterAlpha(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBe(WATER_DEEP_STRATA_ALPHA);
    expect(depthToWaterAlpha(WATER_DEPTH_FLOOR_WORLD_UNITS * 2)).toBe(WATER_DEEP_STRATA_ALPHA);
  });

  it('is monotonically non-decreasing with depth up to saturation — shallow behaviour unchanged', () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      depthToWaterAlpha((i / 39) * WATER_DEPTH_SATURATION_WORLD_UNITS),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });

  it('is monotonically non-increasing with depth from saturation to the world floor', () => {
    const samples = Array.from({ length: 40 }, (_, i) => {
      const t = i / 39;
      const depth =
        WATER_DEPTH_SATURATION_WORLD_UNITS +
        t * (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
      return depthToWaterAlpha(depth);
    });
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it('the ceiling sits below the pre-fix flat opacity (0.62) it replaces', () => {
    // Regression pin for the actual bug: the old constant already rendered
    // fully opaque over the Deep Strata lava band (see water.ts's header), so
    // a ceiling that only matched it would leave the deep end exactly as
    // broken. It must be strictly lower.
    expect(WATER_MAX_ALPHA).toBeLessThan(0.62);
  });

  it('WATER_MIN_ALPHA is a thin, visible film — not fully transparent', () => {
    expect(WATER_MIN_ALPHA).toBeGreaterThan(0);
    expect(WATER_MIN_ALPHA).toBeLessThan(WATER_MAX_ALPHA);
  });

  it('WATER_DEEP_STRATA_ALPHA sits strictly between WATER_MIN_ALPHA and WATER_MAX_ALPHA', () => {
    // Per its own comment: below the sea-column plateau (so the crust reads
    // as thinner-watered than an ordinary deep trench) but above the
    // waterline value (so the deepest dig still unambiguously reads as
    // underwater, not a dry pit).
    expect(WATER_DEEP_STRATA_ALPHA).toBeGreaterThan(WATER_MIN_ALPHA);
    expect(WATER_DEEP_STRATA_ALPHA).toBeLessThan(WATER_MAX_ALPHA);
  });
});

describe('depthToSpecularFactor', () => {
  it('is 1 (full sheen) at zero depth', () => {
    expect(depthToSpecularFactor(0)).toBe(1);
  });

  it('clamps negative depth to 1 (defensive, not an expected input)', () => {
    expect(depthToSpecularFactor(-5)).toBe(1);
  });

  // REGRESSION (2026-08-20, same-day owner report): the first shipped curve
  // ramped from depth 0, so it reached WATER_SPECULAR_FLOOR already AT
  // WATER_DEPTH_SATURATION_WORLD_UNITS — meaning ordinary shallow/mid-depth
  // sea (every depth in the normal sea column) lost sun-sheen too, not just
  // the Deep Strata tail. The two tests below replace the ones that pinned
  // that wrong shape; see waterDepth.ts's "SPECULAR SUPPRESSION"/CORRECTION
  // comments for the full account.

  it('is exactly 1 (byte-identical to pre-fix) for every depth up to and including the sea-column floor', () => {
    const samples = [
      0,
      1,
      WATER_DEPTH_SATURATION_WORLD_UNITS / 2,
      WATER_DEPTH_SATURATION_WORLD_UNITS - 1e-9,
      WATER_DEPTH_SATURATION_WORLD_UNITS,
    ];
    for (const depth of samples) expect(depthToSpecularFactor(depth)).toBe(1);
  });

  it('reaches exactly WATER_SPECULAR_FLOOR at the world floor, not at the sea-column floor', () => {
    expect(depthToSpecularFactor(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBeCloseTo(
      WATER_SPECULAR_FLOOR,
      10,
    );
    // And explicitly NOT at the sea-column floor — the exact regression.
    expect(depthToSpecularFactor(WATER_DEPTH_SATURATION_WORLD_UNITS)).not.toBeCloseTo(
      WATER_SPECULAR_FLOOR,
      2,
    );
  });

  it('holds at WATER_SPECULAR_FLOOR for every depth beyond the world floor', () => {
    // The property depthToWaterAlpha's own curve cannot offer past its cap
    // (see waterDepth.ts's "SPECULAR SUPPRESSION" comment): this curve never
    // climbs back up once past the world floor — the crater floor must not
    // read as MORE sheen-suppressed than a spot just inside the seabed and
    // less than one just past it; it must read the SAME, fully suppressed.
    expect(depthToSpecularFactor(waterDepthWorldUnits(MIN_HEIGHT))).toBe(WATER_SPECULAR_FLOOR);
    expect(depthToSpecularFactor(WATER_DEPTH_FLOOR_WORLD_UNITS * 2)).toBe(WATER_SPECULAR_FLOOR);
  });

  it('is monotonically non-increasing with depth up to and past the world floor', () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      depthToSpecularFactor((i / 39) * WATER_DEPTH_FLOOR_WORLD_UNITS * 2),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it('WATER_SPECULAR_FLOOR is a small but non-zero floor', () => {
    expect(WATER_SPECULAR_FLOOR).toBeGreaterThan(0);
    expect(WATER_SPECULAR_FLOOR).toBeLessThan(1);
  });
});

describe('depthSpecularFactorByte / WATER_SPECULAR_FACTOR_DEFAULT_BYTE', () => {
  it('quantises depthToSpecularFactor into a 0..255 byte', () => {
    expect(depthSpecularFactorByte(0)).toBe(255);
    expect(depthSpecularFactorByte(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBe(255);
    expect(depthSpecularFactorByte(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBe(
      Math.round(WATER_SPECULAR_FLOOR * 255),
    );
  });

  it('the default fill byte matches zero depth, so an unwritten texel reads as full sheen, not pre-suppressed', () => {
    expect(WATER_SPECULAR_FACTOR_DEFAULT_BYTE).toBe(depthSpecularFactorByte(0));
    expect(WATER_SPECULAR_FACTOR_DEFAULT_BYTE).toBe(255);
  });
});

describe('depthAlphaByte / WATER_DEPTH_ALPHA_DEFAULT_BYTE', () => {
  it('quantises depthToWaterAlpha into a 0..255 byte', () => {
    expect(depthAlphaByte(0)).toBe(Math.round(WATER_MIN_ALPHA * 255));
    expect(depthAlphaByte(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBe(
      Math.round(WATER_MAX_ALPHA * 255),
    );
  });

  it('the default fill byte matches zero depth, so an unwritten texel reads as shallow water, not a hole', () => {
    expect(WATER_DEPTH_ALPHA_DEFAULT_BYTE).toBe(depthAlphaByte(0));
    expect(WATER_DEPTH_ALPHA_DEFAULT_BYTE).toBeGreaterThan(0);
  });
});

describe('writeWaterDepthTexels', () => {
  it('writes only the cells inside the given dirty chunks', () => {
    const mirror = createTerrainMirror(WORLD);
    // Chunk (1,0): flat at MIN_HEIGHT — the deepest possible dig.
    // Chunk (0,0) is left untouched (default height 0, i.e. the waterline).
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const SENTINEL = 77; // recognisably not any real depth-alpha byte
    const out = new Uint8Array(WORLD * WORLD).fill(SENTINEL);
    writeWaterDepthTexels(out, WORLD, mirror, [/* chunk (1,0) */ 1]);

    // AMENDMENT (2026-08-20): MIN_HEIGHT is now the FAR end of the deep-
    // strata ramp (see depthToWaterAlpha), so the cell reads
    // WATER_DEEP_STRATA_ALPHA, not the WATER_MAX_ALPHA plateau a
    // pre-Deep-Strata-fix dig would have hit — the old assertion here
    // (`maxAlphaByte`) pinned the exact flat-ceiling behaviour this session
    // fixed.
    const deepStrataAlphaByte = Math.round(WATER_DEEP_STRATA_ALPHA * 255);
    // Inside the dirty chunk (cells CHUNK_SIZE..2*CHUNK_SIZE-1 on x): the
    // lava-floor depth is past the plateau and rides the deep-strata floor.
    expect(out[0 * WORLD + CHUNK_SIZE]).toBe(deepStrataAlphaByte);
    expect(out[(CHUNK_SIZE - 1) * WORLD + (2 * CHUNK_SIZE - 1)]).toBe(deepStrataAlphaByte);
    // Outside the dirty set entirely: untouched.
    expect(out[0]).toBe(SENTINEL);
    expect(out[WORLD * WORLD - 1]).toBe(SENTINEL);
  });

  it('writes the specular-factor buffer in the same pass when given one', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const SENTINEL = 77;
    const out = new Uint8Array(WORLD * WORLD).fill(SENTINEL);
    const specularOut = new Uint8Array(WORLD * WORLD).fill(SENTINEL);
    writeWaterDepthTexels(out, WORLD, mirror, [/* chunk (1,0) */ 1], specularOut);

    const floorSpecularByte = Math.round(WATER_SPECULAR_FLOOR * 255);
    expect(specularOut[0 * WORLD + CHUNK_SIZE]).toBe(floorSpecularByte);
    expect(specularOut[(CHUNK_SIZE - 1) * WORLD + (2 * CHUNK_SIZE - 1)]).toBe(floorSpecularByte);
    // Outside the dirty set entirely: untouched, same contract as `out`.
    expect(specularOut[0]).toBe(SENTINEL);
    expect(specularOut[WORLD * WORLD - 1]).toBe(SENTINEL);
  });

  it('leaves specularOut untouched (and does not throw) when omitted', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });
    const out = new Uint8Array(WORLD * WORLD);
    expect(() => writeWaterDepthTexels(out, WORLD, mirror, [1])).not.toThrow();
  });

  // ADDED (2026-08-20, east-coast investigation): render/water.ts's real
  // buffers are never sentinel-filled — createDepthTexture fills a fresh
  // allocation with the DEFAULT byte (see water.ts's createDepthTexture /
  // WATER_DEPTH_ALPHA_DEFAULT_BYTE, WATER_SPECULAR_FACTOR_DEFAULT_BYTE), and
  // every subsequent `refresh` only patches the dirty chunks a snapshot or
  // edit actually touched — exactly water.ts's own refresh() contract
  // (Water interface doc comment). A cell in a chunk that has NEVER been
  // revealed to this client (open ocean far from any player's explored
  // footprint, most of a fresh world) therefore keeps the default byte
  // forever, not a leftover sentinel — this test pins that directly, using
  // the SAME default bytes the real factory uses, rather than an arbitrary
  // SENTINEL, so a future change to either default's value or to the
  // "only touch dirty chunks" contract fails this test instead of only
  // showing up as a rendering symptom.
  it('a never-written texel keeps the real default byte after a partial refresh, in both buffers', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    // Mirrors water.ts's createDepthTexture(worldSize, defaultByte) exactly:
    // a fresh allocation is filled with the default, not zero.
    const out = new Uint8Array(WORLD * WORLD).fill(WATER_DEPTH_ALPHA_DEFAULT_BYTE);
    const specularOut = new Uint8Array(WORLD * WORLD).fill(WATER_SPECULAR_FACTOR_DEFAULT_BYTE);
    writeWaterDepthTexels(out, WORLD, mirror, [/* only chunk (1,0) */ 1], specularOut);

    // Chunk (2,0) — never in any dirty set, standing in for open ocean past
    // the frontier of what any player has ever revealed: must still read as
    // ordinary shallow water (alpha) and full sheen (specular), NOT as a
    // hole (byte 0) or any other value.
    const untouchedCell = 0 * WORLD + (2 * CHUNK_SIZE);
    expect(out[untouchedCell]).toBe(WATER_DEPTH_ALPHA_DEFAULT_BYTE);
    expect(out[untouchedCell]).not.toBe(0);
    expect(specularOut[untouchedCell]).toBe(WATER_SPECULAR_FACTOR_DEFAULT_BYTE);
    expect(specularOut[untouchedCell]).not.toBe(0);
  });
});

describe('surfaceAlphaByte — dry land is not drawn as sea (2026-08-20)', () => {
  it('draws no water at all over a band-0 dry flat', () => {
    // The bug: heights 1..BAND_HEIGHT-1 are DRY (design record Q3) but render
    // at exactly SEA_LEVEL (quantizeToBand), underneath a sea plane lifted just
    // above it — so the fringe every shoreline is made of wore a water film and
    // anything standing there read as wading.
    expect(surfaceAlphaByte(SEA_LEVEL + 1)).toBe(0);
    expect(surfaceAlphaByte(BAND_HEIGHT - 1)).toBe(0);
    expect(surfaceAlphaByte(BAND_HEIGHT)).toBe(0);
  });

  it('still draws the thin film over water at zero depth', () => {
    // The asymmetry is deliberate: a cell at exactly SEA_LEVEL is water, and a
    // sea with no film at the waterline reads as "no sea" rather than "shallow".
    expect(surfaceAlphaByte(SEA_LEVEL)).toBe(depthAlphaByte(0));
    expect(surfaceAlphaByte(SEA_LEVEL)).toBeGreaterThan(0);
  });

  it('is unchanged from the depth curve for every submerged height', () => {
    for (const height of [SEA_LEVEL - 1, -BAND_HEIGHT, -BAND_HEIGHT * 8, MIN_HEIGHT]) {
      expect(surfaceAlphaByte(height)).toBe(depthAlphaByte(waterDepthWorldUnits(height)));
    }
  });
});
