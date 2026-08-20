// Depth-derived water translucency: the pure numeric core behind the sea's
// per-cell alpha. render/water.ts owns the Three.js DataTexture and shader
// patch that consume this; everything here is plain arithmetic over the
// TerrainMirror, so it is unit-testable without a GL context (design doc §8
// — no headless GL rig ships; pure-numbers modules are the tested half of a
// render feature, matching plugins/weather/client/sky.ts vs rig.ts).
//
// THE BUG THIS REPLACES. render/water.ts drew the sea as one flat plane at a
// CONSTANT opacity (0.62) regardless of what was underneath: a knee-deep
// shelf and a 1536-unit dig to the Deep Strata lava floor (shared/src/
// constants.ts's MIN_HEIGHT) rendered identically. Confirmed by screenshotting
// the actual owner-dug lava crater in server/data/world.db through the live
// client (2026-08-19): the sea over it rendered as a flat, textureless sheet
// with no trace of the self-lit lava band directly beneath, even though
// terrain/capEmission.ts already draws that band at full unlit brightness
// (isEmissivePaletteIndex) — the geometry and colour were never the problem,
// the water hiding them was.
//
// THE FIX'S SHAPE. Alpha becomes a function of the WATER COLUMN'S depth at
// each cell — clear at the waterline, richening through the ordinary sea
// column, then capped (not climbing further) for anything deeper. The cap is
// the load-bearing decision: it is what lets a self-lit lava band 1536 units
// down still contribute a visible fraction of its raw colour to the final
// pixel, rather than being asymptotically smothered the way a realistic
// (uncapped) light-attenuation curve would smother it.

import { BAND_HEIGHT, CHUNK_SIZE, SEA_COLUMN_BANDS, SEA_LEVEL, chunksPerEdge } from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../config.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';

/**
 * Alpha at zero water-column depth — the waterline itself, and any cell right
 * at it (a freshly-flooded band-0 flat, the rim of a shelf). Low but not
 * zero: a literal 0 would make the shallowest water invisible, which reads as
 * "no sea" rather than "shallow sea" and contradicts water.ts's own still-sea
 * legibility goal. 0.1 is a thin, readable film — enough to tell a player
 * they are looking through water, not at dry sand.
 */
export const WATER_MIN_ALPHA = 0.1;

/**
 * Alpha ceiling: no cell, however deep, is drawn more opaque than this.
 *
 * Deliberately BELOW the old flat constant it replaces (0.62, see water.ts's
 * WATER_COLOR/history) rather than merely matching it. That old value is the
 * root cause this module exists to fix — screenshotted proof (see the header)
 * is that 0.62 already reads as fully opaque over the Deep Strata lava band,
 * so a ceiling that only matched it would "fix" the shallow end and leave the
 * deep end exactly as broken. 0.55 keeps ordinary deep water clearly reading
 * as water (not washed out) while leaving a self-lit palette entry (raw,
 * un-dimmed colour — see terrain/capEmission.ts's isEmissivePaletteIndex)
 * ~45% direct show-through, which is enough contrast for a saturated glow to
 * read against the near-black rock at the same ceiling beside it.
 */
export const WATER_MAX_ALPHA = 0.55;

/**
 * World-unit water-column depth at which the curve reaches WATER_MAX_ALPHA.
 * Pinned to the bottom of the ORDINARY sea column (shared's SEA_COLUMN_BANDS,
 * 16 bands) rather than to the world's true floor (MIN_HEIGHT, 24 bands
 * further down through the Deep Strata crust). Two consequences, both
 * intended:
 *
 *   - every depth an unmodified genesis ocean or an everyday dig reaches gets
 *     the full richening curve, so "a shelf reads as a shelf and a trench
 *     reads as a trench" holds exactly where players spend most of their
 *     time;
 *   - every depth PAST it (basalt, obsidian, the lava floor) rides the same
 *     flat WATER_MAX_ALPHA ceiling rather than climbing toward opaque. This
 *     produces a visible kink in the curve exactly at the sea column's floor
 *     — deliberate, not a rounding artefact: terrain/bandColors.ts makes the
 *     identical choice for colour at this same boundary (the first basalt
 *     stop is brighter than the blue floor above it, "because the material
 *     change is the message"). The water's alpha curve states the same
 *     regime change the palette already does.
 */
export const WATER_DEPTH_SATURATION_WORLD_UNITS =
  SEA_COLUMN_BANDS * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Water-column depth in WORLD units for a raw stored height. Zero for any
 * height at or above SEA_LEVEL (dry land has no water column at all — the
 * value is never sampled there in practice, since the water plane fails the
 * depth test over dry terrain, but clamping here keeps the function total).
 */
export function waterDepthWorldUnits(height: number): number {
  return Math.max(0, SEA_LEVEL - height) * HEIGHT_WORLD_SCALE;
}

/**
 * The alpha curve itself: linear from (0, WATER_MIN_ALPHA) up to
 * (WATER_DEPTH_SATURATION_WORLD_UNITS, WATER_MAX_ALPHA), flat beyond.
 *
 * Linear, not exponential: an exponential (Beer-Lambert) attenuation is the
 * physically literal choice for light through a medium, but it asymptotes
 * toward full opacity rather than ever truly capping — exactly the behaviour
 * this module exists to avoid at the deep end. A clamped linear ramp reaches
 * its ceiling at a named, finite depth and states in one straight line what
 * the comments above already argue for in prose.
 */
export function depthToWaterAlpha(depthWorldUnits: number): number {
  if (depthWorldUnits <= 0) return WATER_MIN_ALPHA;
  const t =
    depthWorldUnits >= WATER_DEPTH_SATURATION_WORLD_UNITS
      ? 1
      : depthWorldUnits / WATER_DEPTH_SATURATION_WORLD_UNITS;
  return WATER_MIN_ALPHA + (WATER_MAX_ALPHA - WATER_MIN_ALPHA) * t;
}

/** Alpha is packed into an 8-bit UNORM texture channel (see water.ts). */
const WATER_DEPTH_ALPHA_BYTE_MAX = 255;

/** depthToWaterAlpha, quantised to the byte the depth texture actually stores. */
export function depthAlphaByte(depthWorldUnits: number): number {
  return Math.round(depthToWaterAlpha(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

/**
 * The byte a freshly (re)allocated depth texture is filled with before any
 * chunk has written into it — i.e. depthAlphaByte for a zero-depth cell, so
 * an as-yet-unwritten texel (a cell in a chunk nobody has revealed) reads
 * exactly as shallow water would, rather than as a hole (byte 0 = fully
 * transparent) punched in the sea.
 */
export const WATER_DEPTH_ALPHA_DEFAULT_BYTE = depthAlphaByte(0);

/**
 * Writes depth-alpha texels for every cell inside `dirtyChunks` into `out` —
 * a worldSize×worldSize, row-major byte buffer, the exact layout
 * render/water.ts uploads as a DataTexture. Cells outside those chunks are
 * left untouched, matching the patch-in-place contract every other terrain
 * consumer of a dirty-chunk set follows (render/terrainMeshes.ts,
 * render/frontierFog.ts): a stroke that dirties a handful of chunks costs a
 * few thousand byte writes, not a world-sized rescan.
 *
 * Reads through `sampleHeight` (not sampleRenderHeight): the depth texture is
 * a fact about the water column, which exists whether or not a chunk has
 * been revealed to THIS client, so it takes the raw mirror value the same
 * way picking and prediction do.
 */
export function writeWaterDepthTexels(
  out: Uint8Array,
  worldSize: number,
  mirror: TerrainMirror,
  dirtyChunks: Iterable<number>,
): void {
  const chunkCols = chunksPerEdge(worldSize);
  for (const chunkIdx of dirtyChunks) {
    const cx = chunkIdx % chunkCols;
    const cy = Math.floor(chunkIdx / chunkCols);
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
      const row = y * worldSize;
      for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
        out[row + x] = depthAlphaByte(waterDepthWorldUnits(sampleHeight(mirror, x, y)));
      }
    }
  }
}
