// The weather, as numbers and as timing maths.
//
// WHAT THIS FILE IS FOR, and why it is not simply inside rig.ts: the same split
// the monsters plugin uses between dread.ts and atmosphere.ts, and the wildlife
// plugin between placement.ts and models.ts. Everything here is a pure function
// of numbers — where in its fall a drop is at this instant, how long until the
// next flash, how bright a flash is this many milliseconds in — so a node test
// can read it without importing three (this project ships no headless GL rig,
// design §8). rig.ts owns the meshes and the resolution they are built at; this
// file owns every value that decides how the weather BEHAVES.
//
// PRESENTATION ONLY, AND CLIENT-ONLY. Nothing here is on the wire and nothing
// here is authoritative: the whole effect is driven by the system list the
// client already receives plus elapsed time. Two players standing in the same
// rain see the same front in the same place and DIFFERENT individual drops and
// DIFFERENT bolts, deliberately — see createFlashRandom.
//
// UNITS: cells (== world units, CELL_WORLD_SIZE is 1) and seconds.

import { BAND_HEIGHT, MAX_HEIGHT } from '@terrace/shared';
import type { WeatherKind } from '../protocol.ts';

const TWO_PI = Math.PI * 2;

// ── The vertical layout of the sky ───────────────────────────────────────────

/**
 * World units of height the full above-sea range stands — the client's
 * MAX_RELIEF_WORLD_UNITS (client/src/config.ts), restated here for the same
 * import reason as everything else in this block. THE relief fact: it alone
 * decides how mountainous the world looks, and since 2026-08-20 it is what the
 * client's whole vertical scale derives from.
 */
const MAX_RELIEF_WORLD_UNITS = 16;

/**
 * Height units per world unit — the client's WORLD_UNIT_HEIGHT_UNITS
 * (config.ts), restated for the same import reason as the constants around it.
 */
const WORLD_UNIT_HEIGHT_UNITS = MAX_HEIGHT / MAX_RELIEF_WORLD_UNITS;

/**
 * World units one terrace band rises.
 *
 * ONE, restated rather than imported: this plugin cannot import
 * client/src/config.ts's BAND_WORLD_HEIGHT without dragging `import.meta.env`
 * into a node test run (the same trap plugins/mana/client/env.d.ts documents and
 * plugins/wildlife/client/placement.ts works around the same way). RESIDUAL,
 * named: if BAND_WORLD_HEIGHT ever stops equalling CELL_WORLD_SIZE, every height
 * in this file is wrong by that ratio and nothing fails loudly.
 *
 * THAT RESIDUAL CAME TRUE ON 2026-08-20 and this constant moved with it: the
 * client derives BAND_WORLD_HEIGHT from the world's relief now
 * (config.ts's MAX_RELIEF_WORLD_UNITS), so a band draws a QUARTER of a cell at
 * BAND_HEIGHT 16. Restated as the same derivation rather than as 0.25, so the
 * two files agree by construction and not by coincidence.
 */
export const WORLD_UNITS_PER_BAND = MAX_RELIEF_WORLD_UNITS / (MAX_HEIGHT / BAND_HEIGHT);

/**
 * World-space Y of the highest terrain this game can contain.
 *
 * MAX_HEIGHT (@terrace/shared) is the sculpt ceiling in HEIGHT UNITS and
 * BAND_HEIGHT is height units per band, so the quotient is the ceiling in bands
 * — and therefore in BANDS, which is world units only while a band draws one
 * world unit. It does not any more (see WORLD_UNITS_PER_BAND above), so the
 * relief is restated directly instead: it is the one number the client's
 * vertical scale is now built from.
 */
export const MAX_TERRAIN_WORLD_Y = (MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND;

/**
 * Clearance between the highest possible mountain and the cloud base, in world
 * units.
 *
 * Eight — half of MAX_TERRAIN_WORLD_Y — for the same reason the wildlife
 * plugin's birds keep the same gap: the requirement is that weather reads as
 * being OVER the world, and that has to hold at the worst case (a player who has
 * built a maximum-height peak and then watches a front cross it) rather than at
 * the typical one. It puts the cloud base at exactly the altitude birds fly at,
 * which is the correct picture and not a collision: a flock crossing under the
 * rim of a rain column is what a sky looks like.
 */
export const CLOUD_HEADROOM_WORLD_UNITS = MAX_TERRAIN_WORLD_Y / 2;

/** World-space Y a drop or a flake is born at. 24 today. */
export const CLOUD_BASE_WORLD_Y = MAX_TERRAIN_WORLD_Y + CLOUD_HEADROOM_WORLD_UNITS;

/**
 * How far below sea level precipitation keeps falling before it is recycled, in
 * bands.
 *
 * A QUARTER OF A CELL below a fresh world's open-sea floor. Precipitation is
 * depth-TESTED, so the terrain and the sea surface hide everything under them;
 * the column has to reach past the deepest ordinary ground so that rain visibly
 * meets the floor everywhere instead of stopping in mid-air over a trench. It
 * does not reach MIN_HEIGHT: a player-dug abyss that deep would show rain
 * ending above its floor, which is a cheaper failure than making every column
 * that tall.
 *
 * STATED IN HEIGHT UNITS SINCE 2026-08-20, band count derived. It was "4
 * bands", one band under the open-sea floor's "3 bands" — a relation between
 * two band counts that only held while a band was 64 units. Both sides are
 * depths now (the sea floor is 192 units, core's
 * FRESH_SEABED_DEPTH_BELOW_SEA), so the clearance is stated as a depth too and
 * the column keeps reaching past the seabed at any terracing. Restated rather
 * than imported for this file's usual reason — a client plugin cannot pull in
 * the server's world module.
 */
const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
/** Clearance under that floor: a quarter cell, enough to read as "past it". */
const PRECIPITATION_FLOOR_CLEARANCE = WORLD_UNIT_HEIGHT_UNITS / 4;
export const PRECIPITATION_FLOOR_BANDS_BELOW_SEA =
  (FRESH_SEABED_DEPTH_BELOW_SEA + PRECIPITATION_FLOOR_CLEARANCE) / BAND_HEIGHT;

/** World-space Y at which a drop is recycled to the cloud base. −4 today. */
export const PRECIPITATION_FLOOR_WORLD_Y =
  -PRECIPITATION_FLOOR_BANDS_BELOW_SEA * WORLD_UNITS_PER_BAND;

/** Height of the falling column, in world units. 28 today. */
export const PRECIPITATION_COLUMN_WORLD_UNITS =
  CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y;

// ── Precipitation ────────────────────────────────────────────────────────────

/** Everything that decides how one kind of precipitation falls and looks. */
export interface PrecipitationProfile {
  /** Line segments (rain) or round sprites (snow). Chooses the mesh in rig.ts. */
  readonly form: 'streak' | 'flake';
  /** Particles in one rig. See the count constants for the budget. */
  readonly count: number;
  /** World units per second, downward. */
  readonly fallSpeed: number;
  /** Length of a streak, in world units. Ignored by 'flake'. */
  readonly streakLength: number;
  /** Sprite diameter in world units. Ignored by 'streak'. */
  readonly spriteSize: number;
  /** Peak alpha, reached at intensity 1. */
  readonly opacity: number;
  readonly color: number;
  /** Horizontal sway amplitude in cells, and its rate. Rain does not sway. */
  readonly swayCells: number;
  readonly swayHz: number;
}

/**
 * Particles in one rain rig.
 *
 * 900 over a system's disc, which is 1 800 cells² at the minimum radius and
 * 9 800 at the maximum — so between one drop per two cells and one per eleven,
 * spread through a 28-unit column. That is not a physical density (real rain
 * would be millions); it is the density at which the eye reads "it is raining"
 * from the camera's 80-cell orbit, where a single drop is a sub-pixel streak and
 * what registers is the texture of the whole column.
 *
 * The cost is one draw call and, per frame, 900 iterations writing 5 400 floats
 * into a buffer that is allocated once. Three concurrent systems is 2 700
 * iterations a frame — well under a tenth of a millisecond, and nothing is
 * allocated.
 */
export const RAIN_DROP_COUNT = 900;

/**
 * Particles in one snow rig — fewer than rain, and that is what makes it read as
 * snow. Snow falls an order of magnitude slower, so a flake is on screen for
 * eight seconds where a drop is on for one; matching rain's count would fill the
 * air with standing flakes.
 */
export const SNOW_FLAKE_COUNT = 700;

/**
 * How a kind of system precipitates. `fog` does not (it is sheets, below), and
 * that null is what the rig factory switches on.
 *
 * `storm` is rain, harder: the same form and speed, more drops and more opacity,
 * so that the moment before a bolt already looks like the kind of sky a bolt
 * comes out of. The drop count is the one number a storm does not share, which
 * is why this is a table of profiles rather than a `heavier: boolean` on one.
 */
export const PRECIPITATION_PROFILES: Readonly<
  Record<WeatherKind, PrecipitationProfile | null>
> = {
  // Pale grey-blue, and translucent: a drop is a highlight on falling water, not
  // a solid object. The fall speed puts a drop through the whole column in 1.1 s,
  // which at 60 fps is a 0.43-unit step per frame — half a streak length, so
  // consecutive frames overlap and the column reads as continuous rather than as
  // a dotted line.
  rain: {
    form: 'streak',
    count: RAIN_DROP_COUNT,
    fallSpeed: 26,
    streakLength: 0.9,
    spriteSize: 0,
    opacity: 0.42,
    color: 0xa8c4d8,
    swayCells: 0,
    swayHz: 0,
  },
  storm: {
    form: 'streak',
    // Half again as many drops as ordinary rain, and darker — the rain of a
    // storm, before any lightning has told you it is one.
    count: Math.round(RAIN_DROP_COUNT * 1.5),
    fallSpeed: 30,
    streakLength: 1.1,
    spriteSize: 0,
    opacity: 0.55,
    color: 0x8fa8bd,
    swayCells: 0,
    swayHz: 0,
  },
  // Snow falls at a twelfth of rain's speed and sways: those two facts are the
  // whole difference between the two effects, and both are why snow needs the
  // sprite form (a streak at 3 units/s would be a stationary dash).
  snow: {
    form: 'flake',
    count: SNOW_FLAKE_COUNT,
    fallSpeed: 3.2,
    streakLength: 0,
    spriteSize: 0.22,
    opacity: 0.85,
    color: 0xf2f6ff,
    // Half a cell of sway at a quarter of a hertz: a four-second sideways
    // wander of about a flake's own drift, slow enough to read as air moving
    // rather than as a flake vibrating. Nothing here oscillates faster than
    // this — see the photosensitivity note on MIN_FLASH_INTERVAL_SECONDS.
    swayCells: 0.5,
    swayHz: 0.25,
  },
  fog: null,
};

/**
 * Where in its fall a particle is, as a fraction in [0, 1): 0 at the cloud base,
 * approaching 1 at the floor.
 *
 * `birth` is the particle's own position in the cycle, drawn once when the rig
 * is built, so a rig's particles are spread through the column instead of
 * falling as one sheet. The wrap is per-particle: a drop that reaches the floor
 * reappears at the cloud base, 28 units above and far from anything a player is
 * looking at.
 *
 * Total for any finite input, including a negative elapsed time — the JS `%`
 * keeps the sign of its left operand, so the `+ 1` is what stops a negative
 * fraction placing a drop above the cloud.
 */
export function fallFraction(
  elapsedSeconds: number,
  birth: number,
  fallSpeed: number,
): number {
  const cycles = birth + (elapsedSeconds * fallSpeed) / PRECIPITATION_COLUMN_WORLD_UNITS;
  return ((cycles % 1) + 1) % 1;
}

/**
 * Seconds a particle at fall fraction `f` has been in the air. Multiplied by the
 * system's wind velocity, this is how far downwind it has been carried — which
 * is what shears the column and makes snow visibly blow sideways while rain
 * barely leans.
 *
 * At the wind's 2 cells/s ceiling: rain drifts 2 × 28/26 = 2.2 cells across the
 * whole column, snow 2 × 28/3.2 = 17.5. Both are the honest answer to "how long
 * was it falling", and the difference between them is the effect.
 */
export function driftSeconds(fraction: number, fallSpeed: number): number {
  return (fraction * PRECIPITATION_COLUMN_WORLD_UNITS) / fallSpeed;
}

// ── Fog ──────────────────────────────────────────────────────────────────────

/** One horizontal sheet of fog. Several of them stack into a bank. */
export interface FogLayerSpec {
  /** Height above sea level, in world units, before the bob. */
  readonly height: number;
  /** Radius as a fraction of the system's radius. */
  readonly radiusScale: number;
  /** Peak alpha, reached at intensity 1. */
  readonly opacity: number;
  /** Turns per second about the vertical, signed. */
  readonly spinHz: number;
  /** Vertical bob amplitude in world units, and its rate in cycles per second. */
  readonly bobUnits: number;
  readonly bobHz: number;
}

/**
 * Cold and desaturated, a touch lighter than the sea it lies on (the water is
 * 0x2f6f9e, client/src/render/water.ts). Close to but not the same as the
 * monsters plugin's MIST_COLOR (0x9fb2ad): that mist is something the water is
 * giving off around one creature, this is weather, so it is a shade cooler and
 * greyer. INDEPENDENT OF IT, though visually of a piece — the two effects can be
 * on screen at once and neither knows the other exists.
 */
export const FOG_COLOR = 0xa9b8c2;

/**
 * THE BANK: four sheets from just above the waterline up to two bands, widest at
 * the bottom and thinning upward.
 *
 * Layered horizontal sheets rather than a volumetric shader, for the reason the
 * monsters plugin's MIST_LAYERS states: a few transparent discs cost nothing to
 * draw and nothing to author, and the parallax between sheets at different
 * heights and different spin rates is what actually sells volume to a moving
 * camera.
 *
 * WHY THE HEIGHTS STOP AT 2.4 WORLD UNITS. That is a bit over two terrace bands,
 * so fog fills the shoreline flats and the valleys and leaves anything a player
 * has raised three bands or more standing clear above it. Fog that swallowed the
 * mountains would be scene fog, which this deliberately is not — the design
 * record's rule and the monsters plugin's: NOT scene.fog, never the global
 * lighting rig, only local geometry that moves with the mass that owns it.
 *
 * The four spin rates are mutually non-multiple and alternate in sign, so the
 * sheets never realign into one apparent slab; the same is true of the bob
 * rates. Every period is tens of seconds — slow enough to be invisible frame to
 * frame, which is both the aesthetic rule this codebase uses for idle motion and
 * the reason none of it is a photosensitivity concern.
 */
export const FOG_LAYERS: readonly FogLayerSpec[] = [
  { height: 0.25, radiusScale: 1, opacity: 0.3, spinHz: 0.013, bobUnits: 0.1, bobHz: 0.043 },
  { height: 0.85, radiusScale: 0.9, opacity: 0.24, spinHz: -0.019, bobUnits: 0.16, bobHz: 0.031 },
  { height: 1.55, radiusScale: 0.76, opacity: 0.17, spinHz: 0.027, bobUnits: 0.22, bobHz: 0.023 },
  { height: 2.4, radiusScale: 0.58, opacity: 0.1, spinHz: -0.037, bobUnits: 0.28, bobHz: 0.017 },
];

/**
 * How irregular a sheet's outline is, as a fraction of its radius, and the two
 * lobe counts that make it so.
 *
 * A perfect circle of haze reads as a targeting decal. Two sine lobes at coprime
 * counts never repeat inside one turn, which is what makes the outline look torn
 * rather than stamped. 3 and 5 is the monsters plugin's pair; 4 and 7 here, with
 * a deeper wobble, because a weather system is five times the size of that mist
 * bank and a big disc needs a coarser tear to read as one. Deterministic — this
 * is the SHAPE of the fog, not the weather, and every client tears it
 * identically.
 */
export const FOG_EDGE_WOBBLE = 0.22;
export const FOG_EDGE_LOBES_A = 4;
export const FOG_EDGE_LOBES_B = 7;
/** Phases, so the two lobe sets do not both peak on the +X axis. */
export const FOG_EDGE_PHASE_A = 1.1;
export const FOG_EDGE_PHASE_B = 2.7;

/**
 * Falloff exponent of a sheet's alpha from its centre to its rim.
 * alpha(u) = (1 − u²)^k. 1.8 gives a broad soft core and a rim that reaches zero
 * smoothly, so no sheet ever shows an edge.
 */
export const FOG_EDGE_SOFTNESS = 1.8;

/** Radius multiplier of a fog sheet's wobbled outline at bearing `angle`. */
export function fogEdgeWobble(angle: number): number {
  return (
    1 +
    FOG_EDGE_WOBBLE *
      (Math.sin(FOG_EDGE_LOBES_A * angle + FOG_EDGE_PHASE_A) * 0.6 +
        Math.sin(FOG_EDGE_LOBES_B * angle + FOG_EDGE_PHASE_B) * 0.4)
  );
}

/**
 * How much of a fog sheet's own opacity a RAIN or SNOW system also gets.
 *
 * Precipitation without any haze under it reads as lines in a vacuum; real rain
 * greys the air it falls through. A third of the fog bank's strength is enough
 * to soften the ground under a front without turning every shower into fog, and
 * it reuses the fog rig rather than adding a fifth effect.
 */
export const PRECIPITATION_HAZE_SCALE = 1 / 3;

// ── Lightning ────────────────────────────────────────────────────────────────

/**
 * Mean interval between flashes within ONE storm, in seconds.
 *
 * A storm is the only kind that flashes at all, and a flash has to stay an event
 * rather than a rhythm: at 9 s a player standing under a storm for half a minute
 * sees three, and one who glances at a storm on the far side of the map usually
 * sees none. Shorter than the monsters plugin's 11 s because a storm is
 * something a player walks into and out of, where the monster's dread is
 * permanent for as long as it is there.
 */
export const MEAN_FLASH_INTERVAL_SECONDS = 9;

/**
 * PHOTOSENSITIVITY FLOOR: the shortest gap allowed between the START of one
 * flash and the start of the next, ANYWHERE ON THIS CLIENT, in seconds. This is
 * a safety limit, not a tuning value.
 *
 * The reasoning is the monsters plugin's MIN_FLASH_INTERVAL_SECONDS verbatim,
 * because it is the same stimulus and the same guidance. WCAG 2.3.1 allows up to
 * three flashes per second; one flash per three seconds is a tenth of that, and
 * since a flash's envelope has exactly two brightness transitions (one rise,
 * one fall — see flashBrightness), the worst case is 0.67 transitions per
 * second. The codebase's other precedent, the mana gauge's MIN_PULSE_PERIOD_S
 * (0.25 s), is deliberately an order of magnitude below this: that cue is a few
 * pixels of falling sand inside a HUD widget, this one is a full-screen change
 * in scene brightness, which is exactly the stimulus the guidance is written
 * about.
 *
 * WHAT IS NEW HERE, AND WHY IT NEEDED TO BE. The monsters plugin has at most one
 * monster, so a per-effect interval floor IS a global one. This plugin can have
 * up to MAX_ACTIVE_SYSTEMS storms at once, and two independent Poisson clocks
 * that each honour a 3-second floor can still fire 50 ms apart. A per-rig clamp
 * would therefore have been a floor that quietly stops holding exactly when the
 * sky is busiest. So the floor is enforced by one LightningGovernor for the
 * whole client, and the per-storm schedules only ever PROPOSE — see that class.
 */
export const MIN_FLASH_INTERVAL_SECONDS = 3;

/**
 * Ceiling on the sampled interval, in seconds.
 *
 * The exponential distribution has an unbounded tail: without this, one sample
 * in a hundred leaves a player standing in a thunderstorm watching nothing for
 * a minute and more. e^(−45/9) ≈ 0.7% of intervals hit the clamp and land
 * exactly here, which is a distortion of the tail and is the point of it.
 */
export const MAX_FLASH_INTERVAL_SECONDS = 45;

/**
 * The flash envelope: how long the brightness takes to reach its peak, and how
 * long the whole flash lasts, in seconds.
 *
 * ~50 ms of attack is fast enough to read as a discharge rather than as a lamp
 * being turned up, and is still several frames at 60 Hz so it is a ramp and not
 * a single-frame jump (a one-frame full-brightness step is precisely the
 * strobing this effect must not do).
 *
 * DELIBERATELY NOT MODELLED: the double- and triple-strike flicker real
 * lightning has. It is the most recognisable thing about lightning and it is a
 * 10 Hz brightness oscillation, i.e. the exact waveform that triggers seizures.
 * One flash, one rise, one fall.
 */
export const FLASH_ATTACK_SECONDS = 0.05;
export const FLASH_DURATION_SECONDS = 0.32;

/**
 * Shape of the decay after the peak. 2.2 — steeper than linear, so the flash
 * dies away like a discharge instead of dimming like a fader, without the long
 * near-invisible tail a higher exponent leaves.
 */
export const FLASH_DECAY_EXPONENT = 2.2;

/** Pale blue-white. The one cold light in a scene lit by a warm sun. */
export const FLASH_COLOR = 0xcfe3ff;

/**
 * Peak intensity of the momentary point light, in candela (three's lights have
 * been physical since r155), and the radius at which it is cut off.
 *
 * INVERSE SQUARE, stated because the number is meaningless without it: with the
 * default decay of 2, illuminance is intensity / distance². 520 cd puts ~2.1 at
 * a point 16 cells below the bolt — about the sun's own 2.2 (render/scene.ts) —
 * and ~0.6 at 30 cells. A flash SHOULD overexpose what it lights; the renderer's
 * ACES tone mapping rolls that off instead of clipping it to paper white.
 *
 * The cutoff bounds the light's influence so one storm cannot brighten terrain
 * across the world. 90 cells is a little over the largest system's diameter, and
 * the falloff has already taken the light to 0.06 there — below the hemisphere
 * ambient, so the cutoff is not a visible edge.
 */
export const FLASH_LIGHT_PEAK_INTENSITY = 520;
export const FLASH_LIGHT_RANGE_CELLS = 90;

/**
 * The bolt's vertical extent, in world units.
 *
 * It falls from the cloud base — the same altitude the storm's own rain is born
 * at, so the bolt comes out of the cloud the rain comes out of — and stops two
 * bands above sea level, in the haze under the system, rather than at the
 * ground. Terminating at the terrain would need a height lookup at the strike
 * point every flash and would then be WRONG over a locked chunk, where the
 * client's height mirror reads band 0. Ending in the haze is right everywhere
 * and reads as a bolt going into weather.
 */
export const BOLT_TOP_WORLD_Y = CLOUD_BASE_WORLD_Y;
export const BOLT_BOTTOM_WORLD_Y = 2 * WORLD_UNITS_PER_BAND;

/**
 * Where in the system a bolt may fall, as a fraction of the system's radius.
 *
 * Out to 0.85 rather than 1: a bolt on the exact rim would stand outside the
 * visible column of rain, which reads as a bolt from a clear sky. The inner
 * bound is 0 — the centre of a storm is a perfectly good place for lightning,
 * and unlike the monsters plugin there is no model in the middle for a bolt to
 * be drawn through.
 */
export const BOLT_MAX_REACH_FRACTION = 0.85;

/**
 * The bolt ribbon: how wide it is at the top, how much of that width is left at
 * the tip, and how far each kink throws it sideways — all in world units.
 *
 * A third of a cell is about the thinnest a strip can be and still be more than
 * a line at the camera's 80-cell orbit; it is wider than the monsters plugin's
 * 0.25 because this bolt is seen from further away and from anywhere on the map.
 * The taper is what gives it a direction; the jag is what makes it lightning
 * instead of a laser.
 */
export const BOLT_WIDTH_WORLD_UNITS = 0.33;
export const BOLT_TIP_WIDTH_FRACTION = 0.35;
export const BOLT_JAG_WORLD_UNITS = 0.9;

/**
 * How brightly the haze under a storm lights up during a flash — peak alpha of
 * one extra additive sheet through the middle of the bank.
 *
 * The sheets are unlit (MeshBasicMaterial), so the point light cannot touch
 * them; without this the flash would light the terrain and leave the weather
 * conspicuously dead. 0.45 is under half, so the bank brightens rather than
 * turning into a white disc.
 */
export const FLASH_GLOW_OPACITY = 0.45;

// ── Timing maths ─────────────────────────────────────────────────────────────

/**
 * Turns a uniform sample in [0, 1) into a Poisson-process interval, clamped into
 * [MIN_FLASH_INTERVAL_SECONDS, MAX_FLASH_INTERVAL_SECONDS].
 *
 * −ln(1 − u) · mean is the standard inverse-CDF draw for an exponential, which
 * is what makes flashes MEMORYLESS: the gap since the last one tells you nothing
 * about the next, so the lightning never falls into a rhythm the player can feel
 * coming. The clamps are the photosensitivity floor and the patience ceiling
 * documented on those constants.
 *
 * The floor is applied as a CLAMP on the sampled interval rather than as a "skip
 * this one" rule, because a skip would silently turn a long Poisson tail into a
 * burst the moment the tail ended. (The governor below DOES drop a proposal, and
 * that is a different case with a different argument — see it.)
 */
export function nextFlashIntervalSeconds(uniform: number): number {
  // A generator that returned exactly 1 (none of ours does) would give Infinity;
  // clamping the input keeps this total for any finite caller.
  const u = Math.min(Math.max(uniform, 0), 1 - Number.EPSILON);
  const interval = -Math.log(1 - u) * MEAN_FLASH_INTERVAL_SECONDS;
  if (interval < MIN_FLASH_INTERVAL_SECONDS) return MIN_FLASH_INTERVAL_SECONDS;
  if (interval > MAX_FLASH_INTERVAL_SECONDS) return MAX_FLASH_INTERVAL_SECONDS;
  return interval;
}

/**
 * Brightness of a flash `since` seconds after it began, in [0, 1]; 0 outside the
 * flash.
 *
 * EXACTLY TWO BRIGHTNESS TRANSITIONS — one rise, one fall — and that is a safety
 * property, not a style: see MIN_FLASH_INTERVAL_SECONDS. Anything that added a
 * flicker here would defeat the interval floor that keeps this within
 * photosensitivity guidance.
 */
export function flashBrightness(since: number): number {
  if (!(since >= 0) || since >= FLASH_DURATION_SECONDS) return 0;
  if (since < FLASH_ATTACK_SECONDS) return since / FLASH_ATTACK_SECONDS;
  const decaying =
    (since - FLASH_ATTACK_SECONDS) / (FLASH_DURATION_SECONDS - FLASH_ATTACK_SECONDS);
  return Math.pow(1 - decaying, FLASH_DECAY_EXPONENT);
}

/** Where one flash lands inside its system, and how its ribbons are turned. */
export interface Flash {
  /** Bearing from the system's centre, radians. */
  readonly bearing: number;
  /** Distance from the centre as a fraction of the radius, [0, 1). */
  readonly reach: number;
  /** Yaw of the bolt's own crossed ribbons, radians. */
  readonly yaw: number;
}

/**
 * A small deterministic PRNG (mulberry32), seeded by the caller.
 *
 * SEEDED CLIENT-SIDE, ON PURPOSE, AND THE BOLTS THEREFORE DIFFER BETWEEN
 * PLAYERS. This is visual weather, not world state: nothing in the simulation,
 * the protocol or any other plugin can observe where a bolt fell, so agreeing on
 * it would mean putting a schedule on the wire to buy nothing. The systems
 * themselves, which players DO need to agree on, are server state and are
 * untouched by any of this.
 *
 * A named generator rather than Math.random so a test can drive a schedule with
 * a known stream — the interval floor that keeps this effect inside
 * photosensitivity guidance is a property worth asserting, and asserting it
 * needs a reproducible sequence.
 */
export function createFlashRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * THE ONE THING ON THIS CLIENT THAT MAY START A FLASH.
 *
 * Every storm rig owns a LightningSchedule, but no schedule starts anything by
 * itself: it proposes, and this governor decides. The governor holds the time
 * since the last flash ANYWHERE and refuses any proposal inside
 * MIN_FLASH_INTERVAL_SECONDS of it. That is what makes the photosensitivity
 * floor a property of the client rather than of one effect — with up to
 * MAX_ACTIVE_SYSTEMS storms in the sky, per-rig floors would each hold while the
 * thing they exist to prevent happened between them.
 *
 * A REFUSED PROPOSAL IS DROPPED, not deferred, and that is the opposite of the
 * clamp in nextFlashIntervalSeconds — on purpose. A deferral queue would repay
 * the suppressed flashes the instant the floor cleared, which is a burst: the
 * exact failure the floor exists to prevent. Dropping can only ever REMOVE a
 * flash, never add or bunch one, so the floor holds unconditionally and the only
 * cost is that a second storm flashes slightly less often than its own mean —
 * which is invisible, and is the correct trade against a stimulus this file is
 * not permitted to get wrong.
 *
 * It starts ready: the first flash of a session is not held back, because there
 * is nothing before it to be too close to.
 */
export class LightningGovernor {
  /** Seconds since the last flash started anywhere. Large means "ready". */
  private sinceLastFlash = Number.POSITIVE_INFINITY;

  /** Advances the shared clock. Call exactly once per frame, before any rig. */
  advance(dt: number): void {
    // Guarded rather than trusted: `dt` is host-capped, but an accumulator that
    // takes one NaN never recovers, and this one gates a safety property.
    if (dt > 0 && Number.isFinite(dt)) this.sinceLastFlash += dt;
  }

  /** True if a flash may start now. Records it when it says yes. */
  requestFlash(): boolean {
    if (this.sinceLastFlash < MIN_FLASH_INTERVAL_SECONDS) return false;
    this.sinceLastFlash = 0;
    return true;
  }

  /** Seconds since the last flash. Exposed for tests, not for rigs. */
  secondsSinceLastFlash(): number {
    return this.sinceLastFlash;
  }

  /** Forgets the last flash (used on dispose, and by tests). */
  reset(): void {
    this.sinceLastFlash = Number.POSITIVE_INFINITY;
  }
}

/**
 * One storm's lightning clock: decides WHEN it would like to flash and how
 * bright the flash in progress is now.
 *
 * It knows nothing about three, about the system it belongs to, or about the
 * user's motion preference — a caller that must not flash simply passes
 * `armed: false`, which is what makes "no flashes at all under
 * prefers-reduced-motion" a property of one `if` rather than of every value this
 * class produces.
 *
 * The first flash is scheduled from the same distribution as every other, so a
 * storm does not announce itself with a bolt the instant it gathers.
 */
export class LightningSchedule {
  private readonly random: () => number;
  /** Seconds remaining until this storm would like to flash. */
  private untilNext: number;
  /** Seconds since the current flash began; large means "none in progress". */
  private sinceFlash = Number.POSITIVE_INFINITY;

  constructor(random: () => number = createFlashRandom(Date.now())) {
    this.random = random;
    this.untilNext = nextFlashIntervalSeconds(random());
  }

  /**
   * Advances the clock by `dt` seconds. Returns the flash that STARTED this
   * frame, or null — which is every frame but roughly one in five hundred, so
   * the one small object allocated here is not a per-frame allocation.
   *
   * `armed` false holds the countdown where it is and starts nothing, while
   * still letting a flash already in progress decay away on its own curve —
   * which is what a storm drifting off the map wants: it stops proposing
   * lightning, but it does not freeze a lit bolt in mid-air. (The OTHER caller
   * of `armed: false` is reduced motion, and there the renderer additionally
   * forces the brightness to zero on the spot: someone who has just asked for
   * less motion should get none, not the tail of a flash.)
   *
   * `governor` has the last word, and a refusal RESCHEDULES rather than
   * retrying next frame — otherwise a storm refused once would ask again 16 ms
   * later and fire the instant the floor cleared, turning the governor into a
   * synchroniser that makes two storms flash together.
   *
   * At most one flash can start per call whatever `dt` is: a long frame (a
   * background tab coming back) shortens the wait to zero and fires once,
   * instead of paying out the whole backlog as a burst.
   */
  advance(dt: number, armed: boolean, governor: LightningGovernor): Flash | null {
    const step = Math.max(0, dt);
    this.sinceFlash += step;
    if (!armed) return null;
    this.untilNext -= step;
    if (this.untilNext > 0) return null;

    this.untilNext = nextFlashIntervalSeconds(this.random());
    if (!governor.requestFlash()) return null;

    this.sinceFlash = 0;
    return {
      bearing: this.random() * TWO_PI,
      reach: this.random() * BOLT_MAX_REACH_FRACTION,
      yaw: this.random() * TWO_PI,
    };
  }

  /** Brightness of the flash in progress, in [0, 1]; 0 between flashes. */
  brightness(): number {
    return flashBrightness(this.sinceFlash);
  }

  /**
   * Forgets any flash in progress and redraws the wait for the next one, exactly
   * as the constructor does. Required before a pooled rig is reused: without it,
   * a schedule returned to the pool mid-flash (or within FLASH_DURATION_SECONDS
   * of one) would replay that stale brightness the instant a NEW storm acquires
   * the rig — a flash the governor never approved, lit at the old storm's bolt
   * position. Call this on release, before the rig re-enters the free list.
   */
  reset(): void {
    this.sinceFlash = Number.POSITIVE_INFINITY;
    this.untilNext = nextFlashIntervalSeconds(this.random());
  }
}
