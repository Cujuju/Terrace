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
  quantizeToBand,
  seabedHeight,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../config.ts';
import { type TerrainMirror } from './mirror.ts';

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
 * World-unit water-column depth at the bottom of the ORDINARY sea column
 * (shared's SEA_COLUMN_BANDS, 64 bands) rather than the world's true floor
 * (MIN_HEIGHT, 32 bands further down through the Deep Strata crust).
 *
 * NO LONGER WHERE ALPHA SATURATES (corrected 2026-08-25 — see
 * WATER_ALPHA_SATURATION_WORLD_UNITS just below, which took that job over
 * after the band counts in this comment turned out to be wrong by 4x and the
 * ocean was rendering at a fifth of its intended strength). What it still
 * marks, unchanged, is the boundary of the WATER_MAX_ALPHA plateau and the
 * start of both the deep-strata down-ramp and specular suppression. Two
 * consequences, both intended:
 *
 *   - every depth an unmodified genesis ocean or an everyday dig reaches sits
 *     at or before this boundary, so "a shelf reads as a shelf and a trench
 *     reads as a trench" is settled by the alpha ramp above it and never by
 *     the deep-strata ramp below;
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
 * CORRECTION (2026-08-25). The depth at which ALPHA reaches WATER_MAX_ALPHA.
 * Split out of WATER_DEPTH_SATURATION_WORLD_UNITS above, which alpha used to
 * share with the specular curve, because the two constants answer different
 * questions and only one of them is about the sea column's floor.
 *
 * THE BUG. The comment above claims the shared constant means "every depth an
 * unmodified genesis ocean or an everyday dig reaches gets the full richening
 * curve", and it named SEA_COLUMN_BANDS as "16 bands". SEA_COLUMN_BANDS is
 * 64. So the ramp that was supposed to be spent across the ocean was spent
 * across a depth five times deeper than any ocean, and measurement (below) put
 * essentially the whole sea on its first fifth: ordinary open water rendered
 * at alpha 0.18 out of a designed 0.1-0.55 range. The sea's own colour, and
 * every painted band on it (render/water/waterBands.ts), therefore arrived at
 * roughly a fifth of the strength they were tuned to, and an A/B that hid the
 * water plane entirely was nearly indistinguishable from one that drew it —
 * the seabed's palette was doing essentially all the work.
 *
 * MEASURED, not reasoned — the discipline the shade ramp above had to learn
 * three times. Live world frostwick-hollows, 2026-08-25, 4.67M water cells
 * (94% of the map), depth in bands:
 *
 *     p25 11    p50 12    p75 12    p95 14    p99 21    max 96
 *
 * 59% of all water sits in band 12 alone. Pinned to the measured p95, so the
 * ramp is spent across the depths water actually occupies and the ordinary
 * ocean lands in the rich part of the range rather than its first fifth. Past
 * p95 is trench, and a trench riding the WATER_MAX_ALPHA plateau is the
 * behaviour the plateau was always for.
 *
 * SUPERSEDED THE NEXT DAY (2026-08-26) as a literal: the same mistake turned
 * up in the seabed palette, so the measured boundary now lives once, in
 * config.ts's ORDINARY_SEA_DEPTH_BANDS, and this ramp derives from it like
 * every other depth curve. The number moved 14 → 15 with the re-measurement.
 *
 * WHY THE SPECULAR BOUNDARY DID NOT MOVE WITH IT. depthToSpecularFactor keeps
 * WATER_DEPTH_SATURATION_WORLD_UNITS: its flatness across the ENTIRE ordinary
 * sea column is a shipped correction (the 2026-08-20 milky-water fix), and the
 * contract it keeps is that ordinary sea must not lose its sheen. Starting
 * suppression at p95 instead would strip the sheen from open water — the exact
 * regression that fix exists to prevent. Two questions, two constants.
 */
/**
 * WHERE THE WATER READS AS FULLY DEEP — the band the shade ramp reaches
 * WATER_SHADE_DEEP at and the alpha ramp saturates at. WAS the measured
 * ordinary floor (ORDINARY_SEA_DEPTH_BANDS, 15) so that every band the
 * ordinary ocean has got its own step; owner, 2026-08-28, on the staircase:
 * "it still goes from looking shallow to deep too quickly" — so the descent
 * is spread over five more bands, past the ordinary floor and into what the
 * histogram calls trench. The per-band step in the populated 10-15 window
 * gets smaller by the same ratio; that is the trade the owner chose.
 */
const WATER_DEEP_FLOOR_BANDS = 20;
const WATER_ALPHA_SATURATION_BANDS = WATER_DEEP_FLOOR_BANDS;
export const WATER_ALPHA_SATURATION_WORLD_UNITS =
  WATER_ALPHA_SATURATION_BANDS * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

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
 * THE BAND IS THE UNIT (2026-08-27, owner: "There has to be a very clear visual
 * distinction between the bands"). The depth every curve in this file is
 * evaluated at, quantised to the terrace band the terrain under it is DRAWN at.
 *
 * THE BUG THIS FIXES, and it is one bug behind three failed attempts. Terrain
 * renders snapped DOWN to its band floor (shared's quantizeToBand) — that is
 * what makes the world a staircase. The water's three depth curves were fed the
 * RAW stored height instead, so within one drawn band the alpha, the shade and
 * the specular factor all swept smoothly across the band's full 16 units, and
 * at the boundary between two bands they were CONTINUOUS: the terrain stepped,
 * the water did not. Since the water owns roughly half of every underwater
 * pixel, the sea contributed a smooth ramp over a stepped world and erased the
 * steps it was drawn over. Measured through the shipped shader math
 * (2026-08-27, client/.seabands-model.mjs): the on-screen luma step at a band
 * boundary in the ordinary ocean was 0.9 to 2.2 parts in 255 — which is exactly
 * the owner's "before and after is identical" for two rounds of palette and
 * slope tuning, neither of which could have worked, because neither addressed
 * the fact that nothing STEPPED.
 *
 * Every consumer of this file goes through here, so the fix is one function
 * rather than one correction per curve. The three curves keep their own shapes;
 * they are simply asked about the band, which is the only depth the player can
 * actually see.
 *
 * NOT a determinism concern despite quantizeToBand's integer contract: this is
 * a render-side lookup over a mirror the server already agrees on, the same way
 * the palette's own bandPaletteIndex is.
 */
export function bandFloorWaterDepthWorldUnits(height: number): number {
  return waterDepthWorldUnits(quantizeToBand(height));
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
  // The up-ramp is spent across the depths water actually occupies, not across
  // the sea column's full 64 bands — see WATER_ALPHA_SATURATION_WORLD_UNITS.
  if (depthWorldUnits <= WATER_ALPHA_SATURATION_WORLD_UNITS) {
    const t = depthWorldUnits / WATER_ALPHA_SATURATION_WORLD_UNITS;
    return WATER_MIN_ALPHA + (WATER_MAX_ALPHA - WATER_MIN_ALPHA) * t;
  }
  // The plateau, unchanged in meaning: from wherever alpha saturates down to
  // the sea column's floor, every depth rides the WATER_MAX_ALPHA ceiling.
  if (depthWorldUnits <= WATER_DEPTH_SATURATION_WORLD_UNITS) return WATER_MAX_ALPHA;
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
  // The RAW height answers "is this dry"; the BAND answers "how deep" — see
  // bandFloorWaterDepthWorldUnits. The two questions want different values from
  // the same number and always have.
  return depthAlphaByte(bandFloorWaterDepthWorldUnits(height));
}

/**
 * DEPTH SHADING (2026-08-24, owner: "We can't see any of the texture below the
 * sea. Shallows should draw light, and the Deeper the water, the darker it
 * should render").
 *
 * The third depth-derived curve, and the one that gives the sea its own value
 * structure. Until now depth drove only how much TERRAIN showed through (alpha)
 * and how much SHEEN survived (specular); the water's own colour was one flat
 * value everywhere, so an ocean read as a single pane of blue and the painted
 * bands laid over it had nothing to read against.
 *
 * WHY A THIRD CURVE RATHER THAN REUSING EITHER EXISTING ONE. The same reason
 * the specular factor could not reuse alpha, stated in the SPECULAR
 * SUPPRESSION comment above: `depthToWaterAlpha` is deliberately NON-MONOTONIC
 * past the sea-column floor, so one alpha byte cannot tell "shallow" apart from
 * "past the cap", and a shade built by inverting it would make the very deepest
 * water start getting LIGHTER again — precisely backwards from what was asked
 * for. `depthToSpecularFactor` is monotone but is deliberately FLAT across the
 * entire ordinary sea column (that flatness is a shipped correction, and the
 * contract it keeps is that ordinary sea must not lose its sheen), which is
 * exactly the range this curve has to vary across. Neither can do this job
 * without breaking the job it already does.
 *
 * SHAPE. Monotone decreasing over the WHOLE range, with no plateau and no sign
 * change anywhere: brightest at the waterline, darkest at the world's floor.
 * That is the entire requested behaviour, and being monotone end to end is what
 * keeps this curve from ever developing alpha's ambiguity.
 *
 * The stored byte is the MIX PARAMETER, not the multiplier — 1 at the surface
 * falling to 0 at the floor — so the two ends of the range live in the shader
 * as named constants and the texture stays a plain [0,1] scalar like its two
 * siblings. Encoding a multiplier that can exceed 1 would have needed an
 * encode scale that every reader then has to know about.
 */
/**
 * THE SHADE MODEL. Owned here, both ends of it, so the curve and the range it
 * maps into cannot be tuned against each other from two files.
 *
 * CENTRED ON THE MEDIAN, not anchored at the surface — the third and, measured,
 * correct framing. The first two both ramped DOWN FROM DEPTH ZERO, differing
 * only in where they bottomed out (the crust's 96 bands, then the trench's 32).
 * Both were wrong the same way, and the second failed for a reason the first
 * hid: essentially NO water is near depth zero, so the bright end of such a ramp
 * is never reached and the entire ocean lives on its dark half. At a 16-band
 * anchored ramp the median seabed rendered at 0.51 of its own colour and the
 * whole sea simply went dark.
 *
 * Measured depth histogram, live world (frostwick-hollows, 512², 90% water):
 *
 *     p5   5 bands    p50 11 bands    p90 14 bands
 *     p25 10 bands    p75 12 bands    p95 16 bands    p99 37 bands
 *
 * So: the MEDIAN depth renders at neutral — ordinary sea looks like ordinary
 * sea, and adding depth shading does not silently restyle 62% of the map — and
 * depth spends the range in BOTH directions around it. Shallower than typical
 * brightens, deeper darkens, and the ramp is steep enough that the 10-12 window
 * holding most of the water spans a visible 18% rather than the 7% a
 * distribution-blind ramp gave it.
 *
 * This is histogram equalisation by another name: output range is spent where
 * the input density is. The flats at either end are the point, not a defect —
 * past p95 is trench, and a trench reading uniformly dark is correct.
 */

/** The depth that renders neutral: the measured median of a real world. */
const WATER_SHADE_CENTRE_BANDS = 11;

/**
 * The ends of the range, and WATER_SHADE_SHALLOW is a CEILING rather than a
 * taste setting. It, the band range and the crest gain (render/water/waterBands.ts)
 * are three multipliers that stack onto WATER_COLOR, whose blue channel is
 * already 0.620 — so their product must stay under 1/0.620 = 1.614 or blue
 * clips at 1.0 before anything else does. A 1.35 x 1.30 x 1.20 = 2.106 stack
 * drove peak blue to 1.305: every bright crest in shallow water clipped to the
 * same flat cyan, erasing the very variation this ramp creates. Owner caught it
 * on screen ("you just made the blue from the texture too opaque") before the
 * arithmetic was checked. 1.15 x 1.25 x 1.10 = 1.581, peak blue 0.980.
 */
export const WATER_SHADE_SHALLOW = 1.15;
export const WATER_SHADE_DEEP = 0.3;

/**
 * THE TRENCH SEGMENT (2026-08-28). Owner, on the staircase fixture: "I want
 * more variability in the staircase when getting to deeper water." The ramp
 * above reaches WATER_SHADE_DEEP at the ordinary floor (band 15) and was flat
 * beyond it, so every band from 15 to the fixture's 26 rendered identically —
 * the "trench reads uniformly dark" flat that the histogram note calls a
 * feature. It is not one the owner wants: past the ordinary floor the shade
 * keeps falling, on a SECOND, gentler slope, from WATER_SHADE_DEEP at the
 * ordinary floor to WATER_SHADE_TRENCH at WATER_SHADE_TRENCH_BANDS, and is
 * flat only below that. The steep segment over the populated 11-15 window is
 * untouched, so the differentiation asked for on 2026-08-26 is kept.
 *
 * WATER_SHADE_TRENCH_BANDS: the live world's p99 is 21 bands; 26 is that with
 * the same headroom previewWater's staircase uses, so the whole fixture shows
 * a change per tread. WATER_SHADE_TRENCH: the headroom the self-light and the
 * 2026-08-28 tint lift created is spent here — 0.12 is the deep end the 0.3
 * scalar used to have relative to noon, now reached only in a trench.
 */
export const WATER_SHADE_TRENCH = 0.12;
const WATER_SHADE_TRENCH_BANDS = 28;

/**
 * THE SHADE RANGE IS A COLOUR RANGE, NOT A SCALAR (2026-08-27). The two
 * constants above still define the CURVE — its clamps, and the [0,1] the texel
 * normalises into — but what the shader mixes between is now these two
 * per-channel triples, applied to WATER_COLOR the same way the scalar was.
 *
 * WHY. A scalar can only move a colour along one line through black, so every
 * undersea band is the same hue at a different brightness, and brightness is
 * the axis with the least room left: ACES tone mapping (render/scene.ts) spends
 * its shoulder compressing exactly the range the sea occupies, so the whole
 * ordinary ocean floor arrives inside a ~30-part-in-255 luma window whatever
 * this curve does. Measured through the shipped shader math (2026-08-27), the
 * best a scalar range can do for the worst adjacent band pair over the ordinary
 * floor is dLuma 8.8 / dE 5.3; pulling the two ends apart in HUE as well gets
 * the same pair to dLuma 10.8 / dE 7.7 — a 45% gain in perceptual distance for
 * the same one multiply, because chroma is the axis that still has room.
 *
 * WHAT THE ENDS SAY. Shallow water is silt over a lit floor, so its tint lifts
 * red and green and holds blue back — the shallows go silt-teal at about the
 * luminance the 1.15 scalar gave them. Deep water is the opposite statement,
 * and deliberately darker than the 0.3 scalar it replaces as well as bluer: the
 * deep end is the half of the range the owner's report was about, so it spends
 * both axes at once and lands as near-black indigo.
 *
 * BOUNDED ABOVE by the same ceiling the scalar was — see WATER_SHADE_SHALLOW's
 * comment. The binding channel is blue, and blue is the one channel this tint
 * pulls DOWN, so the stack's peak falls rather than rises.
 */
// Lifted 2026-08-28 (owner: "the depths a little brighter, the shallows a
// little brighter"). Shallow blue stays at 1.0 — it is the channel bound by
// the WATER_SHADE_SHALLOW ceiling — so the lift goes into red and green.
export const WATER_SHALLOW_TINT: readonly [number, number, number] = [1.8, 1.45, 1.0];
export const WATER_DEEP_TINT: readonly [number, number, number] = [0.16, 0.28, 0.52];

/**
 * The colour the trench segment (WATER_SHADE_TRENCH) descends to. A THIRD
 * tint rather than a wider deep→shallow span, measured (2026-08-28): the
 * first cut of the trench segment stretched the two-tint mix to cover it and
 * the deep treads did not move — the WATER_COLOR red channel is already at
 * the floor by the ordinary sea floor, and WATER_DEEP_TINT holds blue at
 * 0.52, so the extra 11 bands had nothing left to spend. The shader mixes
 * trench→deep over the trench segment and deep→shallow over the ordinary one
 * (WATER_SHADE_FLOOR_MIX is the join), so the owner-tuned ordinary range is
 * untouched and the trench gets a range of its own: from the deep indigo down
 * to a near-black one, with blue — the channel that still has room — doing the
 * work.
 */
export const WATER_TRENCH_TINT: readonly [number, number, number] = [0.01, 0.03, 0.1];

/**
 * THE SEA'S OWN LIGHT (2026-08-28). The band contour that used to live here
 * (fd11cef..a4b50fc) was rejected on sight by the owner: a stepped ring drawn
 * on the water surface reads as a ghost outline, not as a seabed. What the
 * owner actually wanted was for the water not to go near-black at night.
 *
 * The daynight plugin drops the sun to zero and the ambient/hemisphere floor
 * to a third of noon, and the water's albedo is lit by that floor like any
 * other surface — so at midnight the whole sea sits at a third of its noon
 * brightness, on top of a tint range whose deep end is already near-black.
 * Radiance added to `totalEmissiveRadiance` (render/water.ts) is summed into
 * `outgoingLight` after the lighting sum and does not scale with the rig; the
 * water emits WATER_SELF_LIGHT_RADIANCE x its own tinted colour, so the depth
 * structure (shallow silt-teal, deep indigo) is preserved, only lifted.
 *
 * THE VALUE: noon irradiance is ambient 0.9 + hemisphere 1.5 = 2.4 (render/
 * scene.ts, before the sun); midnight's floor is a third of that, 0.8. Adding
 * 0.4 of self-light takes the midnight sea from 0.8 to 1.2 of its colour —
 * half of noon's un-sunned level instead of a third — while adding only a
 * sixth to the noon sea, which the owner also asked to be brighter.
 * APPROXIMATE by construction (ignores the sun's NdotL term and tone
 * mapping); a starting point for eyes-on tuning, not a photometric match.
 */
export const WATER_SELF_LIGHT_RADIANCE = 0.4;

/** The neutral multiplier the centre depth maps to — ordinary sea, unchanged. */
const WATER_SHADE_NEUTRAL = 1;

/**
 * How much of the multiplier one band of depth is worth.
 *
 * WAS 0.09 (2026-08-24), chosen so "a one-band sculpt does not step visibly".
 * That is the opposite of what the owner asked for once the seabed palette was
 * fixed (2026-08-26: "I would still like more differentiation between the
 * shallows and the depths", and earlier the same day, "I can't even tell what
 * the outlines for the various bands are below the water"). At 0.09 the
 * ordinary ocean floor, bands 10-15, used 1.09 → 0.64 of a 1.15 → 0.3 range —
 * the bottom third of the range was reserved for a trench holding 5% of the
 * water.
 *
 * DERIVED, not chosen: the slope that reaches WATER_SHADE_DEEP exactly at the
 * ordinary sea floor (config.ts's ORDINARY_SEA_DEPTH_BANDS, measured) from the
 * neutral median. The whole dark half of the range is spent between the median
 * depth and the deepest ordinary depth, and the ceiling lands about one band
 * above the median — so every band the ocean actually has gets its own visible
 * step, and a re-measurement moves this with the palette and the alpha ramp.
 */
const WATER_SHADE_CONTRAST_PER_BAND =
  (WATER_SHADE_NEUTRAL - WATER_SHADE_DEEP) /
  (WATER_DEEP_FLOOR_BANDS - WATER_SHADE_CENTRE_BANDS);

/**
 * Where, in the stored [0,1] mix, the ordinary floor sits — the join between
 * the shader's trench→deep and deep→shallow mixes. Derived, so the texture
 * and the shader agree on it by construction.
 */
export const WATER_SHADE_FLOOR_MIX =
  (WATER_SHADE_DEEP - WATER_SHADE_TRENCH) / (WATER_SHADE_SHALLOW - WATER_SHADE_TRENCH);

/** Derived the same way as the segment above it: deep at the ordinary floor, trench at its bands. */
const WATER_SHADE_TRENCH_CONTRAST_PER_BAND =
  (WATER_SHADE_DEEP - WATER_SHADE_TRENCH) / (WATER_SHADE_TRENCH_BANDS - WATER_DEEP_FLOOR_BANDS);

/**
 * The multiplier this depth should scale the water's colour by, before it is
 * normalised into the [0,1] the texture carries.
 */
function depthToShadeMultiplier(depthWorldUnits: number): number {
  const bands = depthWorldUnits / (BAND_HEIGHT * HEIGHT_WORLD_SCALE);
  if (bands <= WATER_DEEP_FLOOR_BANDS) {
    const raw =
      WATER_SHADE_NEUTRAL - WATER_SHADE_CONTRAST_PER_BAND * (bands - WATER_SHADE_CENTRE_BANDS);
    return Math.min(WATER_SHADE_SHALLOW, raw);
  }
  // The trench segment — see WATER_SHADE_TRENCH.
  const raw =
    WATER_SHADE_DEEP - WATER_SHADE_TRENCH_CONTRAST_PER_BAND * (bands - WATER_DEEP_FLOOR_BANDS);
  return Math.max(WATER_SHADE_TRENCH, raw);
}

/**
 * The stored value: the multiplier above, normalised to the [0,1] a RedFormat
 * byte carries, which the shader turns back into a multiplier by mixing between
 * the same two constants. Keeping the texture a plain [0,1] scalar matches its
 * two siblings and needs no encode scale anyone has to remember.
 */
export function depthToShadeMix(depthWorldUnits: number): number {
  // Normalised over the FULL range, trench to shallow, since the trench
  // segment was added (2026-08-28); the shader mixes over the same two ends.
  return (
    (depthToShadeMultiplier(depthWorldUnits) - WATER_SHADE_TRENCH) /
    (WATER_SHADE_SHALLOW - WATER_SHADE_TRENCH)
  );
}

/** depthToShadeMix, quantised to the byte the shade texture stores. */
export function depthShadeMixByte(depthWorldUnits: number): number {
  return Math.round(depthToShadeMix(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

/**
 * The byte a freshly (re)allocated shade texture is filled with before any
 * chunk has written into it — the shallow end, for the same reason
 * WATER_SPECULAR_FACTOR_DEFAULT_BYTE picks full sheen: an unrevealed texel
 * should read as ordinary shallow water rather than as an abyss.
 */
export const WATER_SHADE_MIX_DEFAULT_BYTE = depthShadeMixByte(0);

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
 * Reads through `seabedHeight` (not sampleRenderHeight): the depth texture is
 * a fact about the water column, which exists whether or not a chunk has
 * been revealed to THIS client, so it takes the raw mirror value the same
 * way picking and prediction do.
 *
 * AMENDMENT (2026-08-25, layered columns): the raw value it wants is the
 * SEABED, not the surface. `heightAt` reports the topmost ceiling, so a column
 * with a roof arching over a flooded gap would report the roof — dry land — and
 * the sea would vanish from under its own arch. `seabedHeight` (shared/src/
 * columns.ts) answers the question this loop is actually asking: what does the
 * water column bottom out on here. For every one-span column it returns exactly
 * what `sampleHeight` returned, so nothing changes on unlayered terrain.
 *
 * Chunk indices come from `chunksPerEdge`, which rejects a world size that is
 * not a whole number of chunks, so every (x, y) below is in bounds and needs
 * none of `sampleHeight`'s border clamping.
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
  shadeOut?: Uint8Array,
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
        const height = seabedHeight(mirror.map, x, y);
        // The band's depth, not the raw cell's — see
        // bandFloorWaterDepthWorldUnits for why every curve wants the band.
        const depth = bandFloorWaterDepthWorldUnits(height);
        // Height, not depth, for the alpha: only the height distinguishes dry
        // band-0 land (no sea drawn over it) from water at zero depth (a thin
        // film). See surfaceAlphaByte / WATER_DRY_LAND_ALPHA.
        out[row + x] = surfaceAlphaByte(height);
        if (specularOut) specularOut[row + x] = depthSpecularFactorByte(depth);
        // Third curve, same single height sample and same single loop — see
        // depthToShadeMix. Optional for the same reason specularOut is.
        if (shadeOut) shadeOut[row + x] = depthShadeMixByte(depth);
      }
    }
  }
}
