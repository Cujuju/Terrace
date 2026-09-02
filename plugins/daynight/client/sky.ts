// day & night — the sky, as numbers.
//
// WHAT THIS FILE IS FOR. Every value that decides how the sky LOOKS at a given
// phase is a pure function of that one number — no three, no DOM, no clock of
// its own — so a node test can read it directly (design doc: no headless GL
// rig). This is the weather plugin's client/sky.ts split, restated for this
// plugin: rig.ts (absent here — see index.ts's header for why) would own
// meshes and resolution; this file owns everything about what the rig would
// draw.
//
// THE MODEL: one sine wave. `sunHeight(phase)` is the sun's height above (>0)
// or below (<0) the horizon, in [-1, 1] — 1 at the peak of noon, 0 exactly at
// the dawn/dusk crossing, −1 at the depth of midnight. Every colour and
// intensity below is a blend between three keyframes taken AT that value:
// NOON (height 1), HORIZON (height 0, both dawn and dusk — the sine passes
// through zero twice a cycle, so both crossings get the same warm treatment
// for free) and NIGHT (height −1). Nothing here needs to know which of dawn or
// dusk it is; the sun's own height already tells the whole story.
//
// THE NOON ANCHOR. The NOON_* constants below are RESTATED from
// client/src/render/scene.ts, not imported — importing that module (or
// client/src/config.ts, which it in turn imports) drags import.meta.env into
// this file, which breaks a plain node test run exactly the way plugins/
// weather/client/sky.ts's WORLD_UNITS_PER_BAND comment documents for the same
// constraint. RESIDUAL, named exactly as that comment names its own: if
// scene.ts's SUN_DIRECTION_NOON, SUN_LIGHT_INTENSITY, HEMISPHERE_LIGHT_
// INTENSITY, AMBIENT_FLOOR_INTENSITY, SKY_COLOR or GROUND_BOUNCE_COLOR ever
// move, these must move with them and nothing will fail loudly if they don't
// — test/client.test.ts pins the current values so a change to either side shows
// up as a failing assertion rather than a silent drift.

// Imported from plugins/types.ts, NOT render/skyRig.ts, even though the
// latter is the type's "natural" neighbour (applySkyRig): skyRig.ts also
// imports Viewport from render/scene.ts, which imports client/src/config.ts's
// import.meta.env — fatal to this file's standalone node test the moment it
// is reachable, type-only import or not. See SkyRigState's own doc comment in
// plugins/types.ts for the full reasoning; this restates only the pointer.
import type { SkyRigState } from '../../../client/src/plugins/types.ts';

const TWO_PI = Math.PI * 2;

// ── The noon anchor (restated — see the header) ──────────────────────────────

/** == client/src/render/scene.ts's SUN_DIRECTION_NOON. */
const NOON_SUN_DIRECTION = { x: 0.7, y: 0.45, z: 0.55 };
/** == SUN_LIGHT_INTENSITY. */
const NOON_SUN_INTENSITY = 1.2;
/** == HEMISPHERE_LIGHT_INTENSITY. */
const NOON_HEMISPHERE_INTENSITY = 1.5;
/** == AMBIENT_FLOOR_INTENSITY. */
const NOON_AMBIENT_INTENSITY = 0.9;
/** == SKY_COLOR. Doubles as the noon background colour — see SkyRigState. */
const NOON_SKY_COLOR = 0x9fc7e8;
/** == GROUND_BOUNCE_COLOR. */
const NOON_GROUND_COLOR = 0x9a948a;
/**
 * scene.ts never names this — it is simply the default colour argument every
 * one of its lights is constructed with (`new DirectionalLight(0xffffff, …)`,
 * `new AmbientLight(0xffffff, …)`) — but the day/night cycle DOES need to name
 * it, because at noon it is one keyframe among three rather than an implicit
 * default.
 */
const NOON_LIGHT_COLOR = 0xffffff;

/**
 * The sun's elevation ANGLE at noon, derived from NOON_SUN_DIRECTION rather
 * than written as a second number: scene.ts's own comment already states this
 * is "~27° elevation" from the 2026-08-14 retune, and deriving it here means
 * this file cannot drift out of step with that retune the way a hand-copied
 * angle could.
 */
const NOON_ELEVATION_ANGLE_RADIANS = Math.asin(
  NOON_SUN_DIRECTION.y / Math.hypot(NOON_SUN_DIRECTION.x, NOON_SUN_DIRECTION.y, NOON_SUN_DIRECTION.z),
);

/**
 * The sun's compass bearing, held FIXED for the whole cycle — only its
 * elevation moves (see sunDirectionAt). scene.ts's own comment on
 * SUN_DIRECTION_NOON explains why the bearing matters: it is deliberately
 * off-axis on X and Z so the four sides of a terrace step each catch a
 * different amount of light, and an axis-aligned sun makes opposite faces
 * identical. Sweeping the sun through a full compass circle over the day
 * would pass through exactly that axis-aligned case twice — the steps would
 * visibly flatten right when the terrain is otherwise easiest to read (near
 * noon's own high-elevation light). Holding the bearing fixed and animating
 * only elevation keeps every terrace face's relative lighting relationship
 * intact all day, at the cost of the sun always "rising" and "setting" from
 * the same compass point rather than sweeping east to west — a simplification
 * this ambience-only card does not need to spend on, named here as the
 * deliberate choice it is rather than an oversight.
 */
const horizontalMagnitude = Math.hypot(NOON_SUN_DIRECTION.x, NOON_SUN_DIRECTION.z);
const SUN_BEARING = {
  x: NOON_SUN_DIRECTION.x / horizontalMagnitude,
  z: NOON_SUN_DIRECTION.z / horizontalMagnitude,
};

// ── The horizon keyframe (dawn AND dusk — see the header) ───────────────────
//
// Every value here is picked by eye against the existing palette rather than
// derived, because there is nothing to derive a "golden hour" colour FROM —
// unlike the noon and night floors below, no other part of this codebase has
// already made this decision. The guiding rule is the card's own: a readable
// warm→cool transition, and warm enough to read as the same beat as the
// structures plugin's lit windows and Durand's neon sign (WINDOW_GLOW_COLOR,
// 0xffcf7a) without importing that constant — a plugin depending on another
// plugin's palette would be the cross-plugin coupling this codebase's plugin
// contract forbids, so the resemblance is a shared design instinct, not a
// shared value.

const HORIZON_SUN_COLOR = 0xffa864;
/**
 * A third of noon's sun intensity: still clearly the dominant directional
 * light (distinguishing "sun near the horizon" from "no sun"), but dim enough
 * that the warm HUE — not raw brightness — is what reads, which is what a
 * "readable warm→cool transition" needs to mean at this specific fraction
 * of the sky's total light budget.
 */
const HORIZON_SUN_INTENSITY = NOON_SUN_INTENSITY / 3;
const HORIZON_SKY_COLOR = 0xdb8f66;
const HORIZON_GROUND_COLOR = 0x8a6a52;
/** Between night's floor and noon's own value — see the two anchors either side. */
const HORIZON_HEMISPHERE_INTENSITY = 1;
const HORIZON_AMBIENT_COLOR = 0xffd9ad;
const HORIZON_AMBIENT_INTENSITY = 0.6;

// ── The night keyframe ────────────────────────────────────────────────────────

const NIGHT_SUN_COLOR = 0x3a5a8f;
/**
 * Exactly zero: below the horizon there is no direct sunlight to model, and a
 * DirectionalLight shining "up" through the ground it is meant to be behind
 * would be a physically nonsensical picture no non-zero value fixes. Night
 * legibility is the FLOOR lights' job — see NIGHT_DIM_FACTOR and
 * NIGHT_FLOOR_INTENSITY below — which is exactly why they, and not this, are
 * the constants documented against the "must stay legible at night"
 * requirement.
 */
const NIGHT_SUN_INTENSITY = 0;
const NIGHT_SKY_COLOR = 0x141c30;
const NIGHT_GROUND_COLOR = 0x1c2230;
const NIGHT_AMBIENT_COLOR = 0x8fa6c9;

/**
 * How far the two orientation-shaped lights (hemisphere) and the one
 * orientation-independent light (ambient) dim between noon and midnight — ONE
 * ratio applied to both, rather than two independently invented fractions, so
 * "night dims the fill lights" is stated once instead of twice with two
 * numbers that happen to differ for no reason.
 *
 * 1/3 is not invented for this file: AMBIENT_FLOOR_INTENSITY's own doc
 * comment in scene.ts already establishes that 0.9 "guarantees roughly a
 * third of full daylight to the worst-oriented face" at NOON. Applying that
 * same ratio a second time for night keeps this file's one dimming decision
 * consistent with a ratio the codebase had already picked and justified,
 * rather than adding an unrelated second number — and its result (the
 * worst-oriented face falls to roughly a ninth of full daylight) is the
 * concrete meaning of NIGHT_FLOOR_INTENSITY below.
 */
const NIGHT_DIM_FACTOR = 1 / 3;

/**
 * THE MINIMUM NIGHT LIGHT LEVEL (the card's own "night must stay legible"
 * requirement, made concrete). This is AmbientLight's intensity at the depth
 * of night — the one light with no direction and no dependence on which way a
 * face turns, so it is the number that actually bounds how dark the WORST
 * possible face can get, independent of camera angle or sun bearing. 0.3 =
 * AMBIENT_FLOOR_INTENSITY × NIGHT_DIM_FACTOR: dim enough to read unmistakably
 * as night against the noon anchor, never zero, so a player can still judge
 * terrace steps and sculpt in the dark exactly as the card requires — the
 * hemisphere floor (also dimmed by NIGHT_DIM_FACTOR) adds further light to
 * whichever faces are oriented toward the sky on top of this floor, but never
 * below it.
 */
export const NIGHT_FLOOR_INTENSITY = NOON_AMBIENT_INTENSITY * NIGHT_DIM_FACTOR;
const NIGHT_HEMISPHERE_INTENSITY = NOON_HEMISPHERE_INTENSITY * NIGHT_DIM_FACTOR;

// ── The blend ────────────────────────────────────────────────────────────────

/**
 * The sun's height above (>0) or below (<0) the horizon at `phase`, in
 * [-1, 1]. 0 at phase 0 and 0.5 (both horizon crossings), +1 at phase 0.25
 * (noon), −1 at phase 0.75 (midnight) — a single sine, so the whole day is one
 * smooth, continuous curve with no seams to show a step at.
 */
export function sunHeight(phase: number): number {
  return Math.sin(phase * TWO_PI);
}

/**
 * The sun's direction at `phase` — a unit vector, fixed compass bearing (see
 * SUN_BEARING), elevation swinging between ±NOON_ELEVATION_ANGLE_RADIANS with
 * sunHeight. AT PHASE 0.25 THIS IS EXACTLY scene.ts's OWN NOON DIRECTION (up
 * to the normalisation core's own applySkyRig already performs): sunHeight
 * peaks at 1 there, so the elevation angle is exactly NOON_ELEVATION_ANGLE_
 * RADIANS and this reduces algebraically to NOON_SUN_DIRECTION's own ratio of
 * components — asserted directly in test/client.test.ts rather than left as an
 * argument in a comment.
 */
function sunDirectionAt(phase: number): SkyRigState['sunDirection'] {
  const elevationAngle = sunHeight(phase) * NOON_ELEVATION_ANGLE_RADIANS;
  return {
    x: SUN_BEARING.x * Math.cos(elevationAngle),
    y: Math.sin(elevationAngle),
    z: SUN_BEARING.z * Math.cos(elevationAngle),
  };
}

/** Linear blend of one 0xRRGGBB colour toward another, `t` clamped to [0, 1]. */
function lerpColor(from: number, to: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * clamped);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

/**
 * The full declarative sky state at `phase` — the ONE function the client
 * plugin calls every frame (see index.ts). Blends HORIZON→NOON for a rising
 * sun (height ≥ 0) and HORIZON→NIGHT for a falling one (height < 0); both
 * halves meet at HORIZON exactly at height 0, so the curve has no seam there
 * either.
 */
export function skyStateAtPhase(phase: number): SkyRigState {
  const height = sunHeight(phase);
  const t = Math.abs(height);
  const towardNoon = height >= 0;

  return {
    sunDirection: sunDirectionAt(phase),
    sunColor: lerpColor(HORIZON_SUN_COLOR, towardNoon ? NOON_LIGHT_COLOR : NIGHT_SUN_COLOR, t),
    sunIntensity: lerp(HORIZON_SUN_INTENSITY, towardNoon ? NOON_SUN_INTENSITY : NIGHT_SUN_INTENSITY, t),
    hemisphereSkyColor: lerpColor(HORIZON_SKY_COLOR, towardNoon ? NOON_SKY_COLOR : NIGHT_SKY_COLOR, t),
    hemisphereGroundColor: lerpColor(
      HORIZON_GROUND_COLOR,
      towardNoon ? NOON_GROUND_COLOR : NIGHT_GROUND_COLOR,
      t,
    ),
    hemisphereIntensity: lerp(
      HORIZON_HEMISPHERE_INTENSITY,
      towardNoon ? NOON_HEMISPHERE_INTENSITY : NIGHT_HEMISPHERE_INTENSITY,
      t,
    ),
    ambientColor: lerpColor(HORIZON_AMBIENT_COLOR, towardNoon ? NOON_LIGHT_COLOR : NIGHT_AMBIENT_COLOR, t),
    ambientIntensity: lerp(
      HORIZON_AMBIENT_INTENSITY,
      towardNoon ? NOON_AMBIENT_INTENSITY : NIGHT_FLOOR_INTENSITY,
      t,
    ),
    // Mirrors hemisphereSkyColor at every keyframe — SkyRigState allows the
    // two to diverge, but this plugin has no reason to make the backdrop a
    // different colour than the sky its own hemisphere light is modelling.
    backgroundColor: lerpColor(HORIZON_SKY_COLOR, towardNoon ? NOON_SKY_COLOR : NIGHT_SKY_COLOR, t),
  };
}
