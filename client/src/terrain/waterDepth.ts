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

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEEP_STRATA_BANDS,
  SEA_COLUMN_BANDS,
  SEA_LEVEL,
  chunksPerEdge,
} from '@terrace/shared';
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
 * AMENDMENT (2026-08-20, Deep Strata milky-water follow-up). The plateau
 * above was the whole story until an A/B screenshot test (hide the sea
 * plane vs. not, over the owner-dug lava crater) isolated a SECOND half of
 * the same bug that WATER_MAX_ALPHA alone does not fix: even capped at
 * 0.55, flat alpha over the seven-band-deep crust show-through is enough
 * for the water surface's own lit sheen (see water.ts's WATER_ROUGHNESS) to
 * dominate the pixel — 45% of near-black obsidian is still ~black, so the
 * terracing and the muted lava band both read as one smooth dark drape with
 * the sun's specular sheen drifting across it like cloud.
 *
 * The fix mirrors terrain/bandColors.ts's OWN answer to the identical
 * boundary: "the first basalt stop is BRIGHTER than the blue floor, because
 * the material change is the message." Here that means the water THINS
 * again once it is standing over crust rather than seabed — alpha ramps
 * back DOWN, past WATER_DEPTH_SATURATION_WORLD_UNITS, to a new lower floor
 * at the world's true bottom (WATER_DEEP_STRATA_ALPHA below). That lets
 * more of the crust's own colour and the lava band's self-lit glow (see
 * terrain/capEmission.ts) reach the pixel exactly where digging that deep
 * is supposed to feel like arriving somewhere.
 */

/**
 * Alpha floor for the FULL depth of the Deep Strata crust (world's true
 * floor, MIN_HEIGHT — see WATER_DEPTH_FLOOR_WORLD_UNITS below). Chosen
 * BELOW WATER_MAX_ALPHA (0.55) but still ABOVE WATER_MIN_ALPHA (0.1):
 * enough of a drop from the sea-column plateau that the crust's own colour
 * and the lava glow read clearly through the water (judged against the
 * before/after crater screenshots — see the module header), while staying
 * above the waterline's near-transparent value so the deepest dig still
 * unambiguously reads as "underwater", not "dry pit". 0.35 sits roughly
 * midway between the two and was the value that cleared both screenshot
 * checks: basalt/obsidian terracing distinguishable, lava patch clearly
 * orange and bigger than at the 0.55 plateau.
 */
export const WATER_DEEP_STRATA_ALPHA = 0.35;

/**
 * World-unit water-column depth at the world's absolute floor (MIN_HEIGHT,
 * the bottom of the lava band) — the far end of the new deep-strata ramp.
 * Derived from shared's own strata-stack constants (SEA_COLUMN_BANDS +
 * DEEP_STRATA_BANDS), never a hardcoded band count, so a future crust
 * change (another basalt band, a deeper lava floor) moves this ramp's floor
 * automatically instead of silently going stale — the same discipline
 * WATER_DEPTH_SATURATION_WORLD_UNITS above already follows for the
 * sea-column boundary. Equal to -MIN_HEIGHT * HEIGHT_WORLD_SCALE, but
 * spelled out from the strata bands (like bandColors.ts's SEABED_DEPTH_STOPS)
 * rather than importing MIN_HEIGHT and negating it, so the two files that
 * both encode "the world's floor, in stops/units" read the same way.
 */
export const WATER_DEPTH_FLOOR_WORLD_UNITS =
  (SEA_COLUMN_BANDS + DEEP_STRATA_BANDS) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

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
 * (WATER_DEPTH_SATURATION_WORLD_UNITS, WATER_MAX_ALPHA) — THREE segments,
 * not two.
 *
 * Linear, not exponential: an exponential (Beer-Lambert) attenuation is the
 * physically literal choice for light through a medium, but it asymptotes
 * toward full opacity rather than ever truly capping — exactly the behaviour
 * this module exists to avoid at the deep end. A clamped linear ramp reaches
 * its ceiling at a named, finite depth and states in one straight line what
 * the comments above already argue for in prose.
 *
 * AMENDMENT (2026-08-20): "flat beyond" the plateau is no longer the whole
 * story — see WATER_DEEP_STRATA_ALPHA's comment above for why. Past the
 * sea-column floor the curve ramps back DOWN, linearly again for the same
 * reason the first segment is linear, to WATER_DEEP_STRATA_ALPHA at
 * WATER_DEPTH_FLOOR_WORLD_UNITS (the world's true floor), then holds flat
 * for any depth beyond that (there is no such depth in practice — MIN_HEIGHT
 * IS the floor — but the function stays total and monotone-safe past it
 * rather than extrapolating past the sign change).
 */
export function depthToWaterAlpha(depthWorldUnits: number): number {
  if (depthWorldUnits <= 0) return WATER_MIN_ALPHA;
  if (depthWorldUnits <= WATER_DEPTH_SATURATION_WORLD_UNITS) {
    const t = depthWorldUnits / WATER_DEPTH_SATURATION_WORLD_UNITS;
    return WATER_MIN_ALPHA + (WATER_MAX_ALPHA - WATER_MIN_ALPHA) * t;
  }
  if (depthWorldUnits >= WATER_DEPTH_FLOOR_WORLD_UNITS) return WATER_DEEP_STRATA_ALPHA;
  const t =
    (depthWorldUnits - WATER_DEPTH_SATURATION_WORLD_UNITS) /
    (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
  return WATER_MAX_ALPHA + (WATER_DEEP_STRATA_ALPHA - WATER_MAX_ALPHA) * t;
}

/**
 * SPECULAR SUPPRESSION (2026-08-20, the other half of the same milky-water
 * bug — see render/water.ts's makeDepthAware). The alpha ramp above governs
 * how much of the TERRAIN's colour shows through; it says nothing about the
 * water SURFACE's own lit sheen (WATER_ROUGHNESS's broad sun highlight),
 * which is the half of the bug that reads as drifting cloud over the deep
 * pit rather than a flat dark drape. That sheen needs its own depth-derived
 * factor, and it CANNOT reuse depthToWaterAlpha's own output value directly:
 * that curve is deliberately non-monotonic past the sea-column floor (the
 * amendment above), so alpha alone cannot tell "shallow" apart from "past
 * the cap" — both can produce the same byte. A specular factor built by
 * inverting alpha would therefore let the sun-sheen partially RETURN at the
 * world's true floor relative to the sea-column floor directly above it —
 * exactly backwards, since the crater floor is where the artefact is worst.
 * This curve is deliberately its own monotone ramp instead: full sheen in
 * shallow water, falling to a floor by the SAME sea-column-floor depth the
 * alpha ramp plateaus at, then HOLDING at that floor for every depth beyond
 * (never rising back up, unlike alpha). It is written by the same
 * writeWaterDepthTexels pass below, from the same per-cell depth value, into
 * a texel next to the alpha one — "the same depth texel" in the sense that
 * matters (one depth fact, one write pass, one fragment-shader lookup site
 * in water.ts), just not literally the same byte, because a byte that must
 * do both jobs cannot do either correctly once the alpha ramp stops being
 * monotonic.
 *
 * CORRECTION (2026-08-20, same-day regression report): the shape described
 * two paragraphs up — ramping from depth 0 — was WRONG and shipped briefly.
 * "Full sheen in shallow water, falling to a floor BY the sea-column floor"
 * means the ramp spans the ENTIRE ordinary sea column (0 to
 * WATER_DEPTH_SATURATION_WORLD_UNITS is EVERY depth an unmodified genesis
 * ocean or an everyday dig ever reaches — see that constant's own comment).
 * Reported live: ordinary coastal/mid-depth water lost its sun-sheen too,
 * which reads as duller, flatter water across the whole map — this is
 * exactly the "shallow/mid-depth sea must look unchanged" contract
 * depthToWaterAlpha's own three-segment amendment already keeps (it does not
 * start moving until PAST WATER_DEPTH_SATURATION_WORLD_UNITS); the specular
 * curve must keep the identical contract for the identical reason, not just
 * "ties its ramp to the same boundary" in the loose sense of ending there.
 * depthToSpecularFactor below now mirrors depthToWaterAlpha's own shape
 * exactly: flat (unchanged, factor 1) through the whole sea column, THEN
 * ramping down only across the Deep Strata tail
 * (WATER_DEPTH_SATURATION_WORLD_UNITS to WATER_DEPTH_FLOOR_WORLD_UNITS) to
 * WATER_SPECULAR_FLOOR — suppression appears exactly where the bug does and
 * nowhere else.
 */

/**
 * Specular multiplier floor: how much of the water's lit sheen survives at
 * and beyond the world's true floor (WATER_DEPTH_FLOOR_WORLD_UNITS —
 * CORRECTED 2026-08-20, was wrongly "the sea-column floor" in the first
 * shipped version; see the "SPECULAR SUPPRESSION" comment above). Not zero —
 * a water surface with literally no specular response reads as a flat unlit
 * paint swatch, which is its own "wrong" (the sea should still look wet over
 * a deep trench, just not cloud-cloaked). 0.15 was the value that cleared
 * the crater screenshot check: the broad sheen pattern stops being legible
 * as texture while a faint wet highlight remains.
 */
export const WATER_SPECULAR_FLOOR = 0.15;

/**
 * The specular curve (CORRECTED 2026-08-20 — see the "SPECULAR SUPPRESSION"
 * comment above for why the first shipped version was wrong): flat at 1
 * (full sheen, byte-identical to every depth before this session's fix) for
 * the ENTIRE ordinary sea column — every depth up to
 * WATER_DEPTH_SATURATION_WORLD_UNITS, the same boundary depthToWaterAlpha's
 * own unchanged region ends at — THEN linear from (saturation, 1) down to
 * (WATER_DEPTH_FLOOR_WORLD_UNITS, WATER_SPECULAR_FLOOR), flat at the floor
 * for anything beyond (there is no such depth in practice, same reasoning as
 * depthToWaterAlpha's own trailing flat segment). Suppression now turns on
 * exactly where depthToWaterAlpha's own ramp turns DOWN — the Deep Strata
 * crust — and nowhere shallower.
 */
export function depthToSpecularFactor(depthWorldUnits: number): number {
  if (depthWorldUnits <= WATER_DEPTH_SATURATION_WORLD_UNITS) return 1;
  if (depthWorldUnits >= WATER_DEPTH_FLOOR_WORLD_UNITS) return WATER_SPECULAR_FLOOR;
  const t =
    (depthWorldUnits - WATER_DEPTH_SATURATION_WORLD_UNITS) /
    (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
  return 1 + (WATER_SPECULAR_FLOOR - 1) * t;
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
 * Alpha at a cell that is DRY LAND: none at all. The sea is not drawn over it.
 *
 * THE BUG THIS FIXES (owner, 2026-08-20: little people "tend to walk through
 * water"). This module's `waterDepthWorldUnits` doc says the depth value "is
 * never sampled [over dry land] in practice, since the water plane fails the
 * depth test over dry terrain". That claim is FALSE for exactly one band, and
 * it is the band every shoreline is made of. Terrain is drawn snapped DOWN to
 * its band floor (shared's quantizeToBand), so every dry height from
 * SEA_LEVEL + 1 up to BAND_HEIGHT − 1 renders at exactly SEA_LEVEL — and
 * render/water.ts puts the sea plane at `SEA_LEVEL + WATER_SURFACE_LIFT`,
 * ABOVE it, precisely so the two do not z-fight. So band-0 land does not fail
 * the depth test: it passes underneath the sea and comes out wearing
 * WATER_MIN_ALPHA's film. 292 of the live world's 4557 dry cells were in that
 * band when this was measured (server/data/world.db snapshot #188), all of it
 * coastal fringe, and anything standing there reads as wading.
 *
 * ZERO, not a smaller film. A dry cell has no water column over it — that is
 * what dry means — and the design record's own words for this ground are
 * "raising land out of water creates buildable-looking flats" (§ acceptance 4).
 * A waterline flat should look like a flat.
 *
 * NOTE THE ASYMMETRY WITH WATER_MIN_ALPHA, which is deliberate: a cell at
 * exactly SEA_LEVEL is WATER (design record Q3, "height ≤ 0 is water") at zero
 * depth and keeps its thin readable film. The two cases were previously
 * indistinguishable here only because `waterDepthWorldUnits` clamps both to
 * depth 0; height, not depth, is what tells them apart.
 */
export const WATER_DRY_LAND_ALPHA = 0;

/**
 * The alpha byte for one cell, from its RAW STORED HEIGHT rather than from a
 * depth — the entry point the texel pass uses, because "is this dry" is a
 * question only the height can answer (see WATER_DRY_LAND_ALPHA).
 */
export function surfaceAlphaByte(height: number): number {
  if (height > SEA_LEVEL) return Math.round(WATER_DRY_LAND_ALPHA * WATER_DEPTH_ALPHA_BYTE_MAX);
  return depthAlphaByte(waterDepthWorldUnits(height));
}

/** depthToSpecularFactor, quantised to the byte the specular texture stores. */
export function depthSpecularFactorByte(depthWorldUnits: number): number {
  return Math.round(depthToSpecularFactor(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

/**
 * The byte a freshly (re)allocated specular-factor texture is filled with
 * before any chunk has written into it — full sheen (byte for factor 1),
 * matching WATER_DEPTH_ALPHA_DEFAULT_BYTE's own reasoning: an unrevealed
 * texel should read as ordinary shallow water, not as an already-suppressed
 * one.
 */
export const WATER_SPECULAR_FACTOR_DEFAULT_BYTE = depthSpecularFactorByte(0);

/**
 * Writes surface-alpha texels for every cell inside `dirtyChunks` into `out` —
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
 *
 * AMENDMENT (2026-08-20, specular suppression): `specularOut`, an optional
 * second row-major byte buffer of the exact same layout, receives
 * depthSpecularFactorByte for the same cell in the same pass — one height
 * sample and one loop serve both curves, rather than a second world/chunk
 * scan. Optional (not every caller needs it — kept so a future consumer of
 * just the alpha buffer, or a test pinning only that half, is not forced to
 * allocate a buffer it never reads) and defaults to leaving specular texels
 * untouched when omitted.
 */
export function writeWaterDepthTexels(
  out: Uint8Array,
  worldSize: number,
  mirror: TerrainMirror,
  dirtyChunks: Iterable<number>,
  specularOut?: Uint8Array,
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
        const height = sampleHeight(mirror, x, y);
        const depth = waterDepthWorldUnits(height);
        // Height, not depth, for the alpha: only the height distinguishes dry
        // band-0 land (no sea drawn over it) from water at zero depth (a thin
        // film). See surfaceAlphaByte / WATER_DRY_LAND_ALPHA.
        out[row + x] = surfaceAlphaByte(height);
        if (specularOut) specularOut[row + x] = depthSpecularFactorByte(depth);
      }
    }
  }
}
