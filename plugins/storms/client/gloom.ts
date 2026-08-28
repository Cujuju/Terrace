// THE GLOOM — what a cyclone overhead does to the light, expressed as a pure
// function of the sky somebody else already decided.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT MODULATES, IT DOES NOT CLAIM.
//
// The sky rig has ONE claimant per client (ClientPluginCtx.setSkyRig), and on a
// stock install that claimant is the day/night plugin, because day/night is the
// thing that knows what time it is. A hurricane has no opinion about the time
// and every opinion about how much of the sun gets through, which is exactly
// the split ClientPluginCtx.modulateSkyRig exists for: day/night writes the
// sky, this darkens whatever it wrote. Two plugins fighting for the claim would
// have meant one of them silently losing, and a dark canopy drawn into this
// plugin's own layer would have been a second, inconsistent sky.
//
// Read modulateSkyRig's doc comment for the residual: with no claimant, nothing
// calls a modifier and the sky stays core's static boot look.
//
// ─────────────────────────────────────────────────────────────────────────────
// PURE ARITHMETIC, NO STATE, NO THREE.
//
// Everything here is numbers in and numbers out, which is why this file imports
// nothing but a type. The one piece of state the effect needs — how deep the
// gloom is RIGHT NOW, easing toward its target — lives in ./index.ts with the
// rest of the frame loop, because that is where dt is.

import type { SkyRigState } from '../../../client/src/plugins/types.ts';

/**
 * How dark it gets under the centre of a full-strength cyclone: the fraction of
 * the sky's light that is REMOVED.
 *
 * 0.72 — under a hurricane it is famously dark enough to need a lamp at noon,
 * and the whole point of the effect is that a player looks up and knows. It is
 * not 1.0 because a black scene is not a dark day, it is a bug report: the
 * terrain has to stay legible enough to keep playing, and this leaves rather
 * more than a quarter of the light.
 */
export const MAX_GLOOM_LIGHT_LOSS = 0.72;

/**
 * The colour everything is dragged toward as the gloom deepens — a cold slate.
 *
 * A HURRICANE SKY IS NOT JUST A DIM ONE. Dimming alone reads as dusk, because
 * dusk is the only thing this codebase's sky does that removes light. Pulling
 * the hue toward a desaturated blue-grey at the same time is what makes it read
 * as weather rather than as time.
 */
export const GLOOM_COLOR = 0x3a4048;

/**
 * How fast the gloom follows the storm, in units of depth per second.
 *
 * 0.35 → about three seconds from clear to fully overcast. The eye of a cyclone
 * crosses a player's view in minutes, so this is far faster than the storm; it
 * exists to smooth the STEP that a 5 Hz server push and a screen-centre
 * re-aim would otherwise put in the light, not to model a front arriving.
 *
 * REDUCED MOTION does not need a special case here: this is a slow ramp of
 * brightness with no oscillation, and the plugin freezes its whole animation
 * clock under that preference anyway (./index.ts), which pins the gloom at
 * whatever depth it had reached.
 */
export const GLOOM_RESPONSE_PER_SECOND = 0.35;

/**
 * How much of a cyclone's radius counts as "overhead", as a fraction.
 *
 * A player under the outer arms of a hurricane is under a hurricane — the
 * cloud deck covers them and the light really has gone — so this is 1.0 at the
 * eye and tapers to nothing at the rim rather than switching at some inner
 * ring. The taper is what makes walking out from under one a gradual
 * brightening instead of a light switch.
 */
export function overheadFraction(distanceCells: number, radiusCells: number): number {
  if (!(radiusCells > 0)) return 0;
  const r = distanceCells / radiusCells;
  if (r >= 1) return 0;
  // Squared, so the deep interior is uniformly dark and the last quarter of the
  // radius is where the light comes back — matching the deck, which also thins
  // only at its rim (./spiral.ts's edge fade).
  return 1 - r * r;
}

/** Mixes two 0xRRGGBB colours, `t` of the way from `from` to `to`. */
function mixHex(from: number, to: number, t: number): number {
  const mixChannel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * t) & 0xff;
  };
  return (mixChannel(16) << 16) | (mixChannel(8) << 8) | mixChannel(0);
}

/**
 * Applies `depth` (0 = clear, 1 = under the eye of a full-strength cyclone) to
 * a sky the claimant produced.
 *
 * THE SUN LOSES THE MOST, THE AMBIENT FLOOR THE LEAST, and the ratios are the
 * physics of an overcast rather than three tuned numbers: cloud does not remove
 * light so much as SCATTER it, so the directional component goes first (a
 * hurricane casts no shadows at all), the hemisphere fill follows it down, and
 * the ambient floor — which is the scattered light — barely moves. Dimming all
 * three equally would produce a night, not a storm.
 */
export function applyGloom(state: SkyRigState, depth: number): SkyRigState {
  const clamped = Math.min(1, Math.max(0, depth));
  if (clamped <= 0) return state;

  const loss = clamped * MAX_GLOOM_LIGHT_LOSS;
  return {
    // The sun keeps its DIRECTION: the claimant owns what time it is, and an
    // overcast does not move the sun, it hides it.
    sunDirection: state.sunDirection,
    sunColor: mixHex(state.sunColor, GLOOM_COLOR, clamped),
    // The directional light goes almost entirely: nothing under a hurricane
    // casts a shadow.
    sunIntensity: state.sunIntensity * (1 - loss),
    hemisphereSkyColor: mixHex(state.hemisphereSkyColor, GLOOM_COLOR, clamped),
    hemisphereGroundColor: mixHex(state.hemisphereGroundColor, GLOOM_COLOR, clamped),
    // Two thirds of the sun's loss — the sky is still lit, it is just lit by
    // cloud.
    hemisphereIntensity: state.hemisphereIntensity * (1 - loss * (2 / 3)),
    ambientColor: mixHex(state.ambientColor, GLOOM_COLOR, clamped),
    // A third of the sun's loss: this is the scattered light, and scattered
    // light is what an overcast is made of.
    ambientIntensity: state.ambientIntensity * (1 - loss / 3),
    backgroundColor: mixHex(state.backgroundColor, GLOOM_COLOR, clamped),
  };
}
