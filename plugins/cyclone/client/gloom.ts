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
import { CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';

/**
 * How dark it gets under the centre of a full-strength cyclone: the fraction of
 * the sky's light that is REMOVED.
 *
 * 0.6 — under a hurricane it is famously dark enough to need a lamp at noon,
 * and the whole point of the effect is that a player looks up and knows. It is
 * not 1.0 because a black scene is not a dark day, it is a bug report: the
 * terrain has to stay legible enough to keep playing.
 *
 * MEASURED DOWN FROM 0.72 in the preview harness, where the land under a
 * full-strength cyclone went to near-black and the coastline stopped being
 * findable. 0.6 leaves two fifths of the directional light and rather more of
 * the fill, which reads as a storm without taking the world away.
 */
export const MAX_GLOOM_LIGHT_LOSS = 0.6;

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
 * How much of the gloom reaches the STORM'S OWN CLOUDS, as a fraction of what
 * reaches the ground.
 *
 * A QUARTER, and the asymmetry is the physics rather than a compromise. What
 * darkens the ground is the cloud deck standing between it and the sun; the
 * deck itself is on the SUNNY SIDE of that. A hurricane photographed from above
 * is brilliant white over a black sea, and even from underneath its base is the
 * brightest thing in the sky. Multiplying the clouds by the same factor as the
 * ground — which this plugin did first — makes the storm disappear into the
 * darkness it is causing: the first in-world attempt was a black square with a
 * grey smear in it.
 *
 * Not zero, because a cyclone at dusk should not glow: the deck still tracks
 * the light, just far less than the ground it is shading.
 */
export const CLOUD_GLOOM_RESPONSE = 0.25;

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
 * IT FOLLOWS THE CLOUD DECK, NOT THE WIND, and that is the whole point: what
 * darkens a sky is what is between it and the sun. So this is the same shape
 * ./spiral.ts draws — nothing inside the EYE, full cover just outside it,
 * tapering out at the rim — rather than the server's wind falloff, which peaks
 * at the eyewall for a different reason.
 *
 * THE EYE IS BRIGHT, and that is not an oversight to be smoothed away. The
 * calm bright middle of a hurricane is the one thing everybody knows about
 * one, the renderer already draws the hole, and a gloom that stayed dark
 * through it would be the sky contradicting the clouds directly overhead.
 * A cyclone crosses at half a world unit a second, so a player under the eye
 * gets a minute or two of daylight and then the far eyewall.
 *
 * The taper at the rim is what makes walking out from under a storm a gradual
 * brightening rather than a light switch.
 */
export function overheadFraction(distanceCells: number, radiusCells: number): number {
  if (!(radiusCells > 0)) return 0;
  const r = distanceCells / radiusCells;
  if (r >= 1) return 0;

  // The eye is the protocol's fraction (imported — a restated 0.125 drifted the
  // clear sky away from the drawn eyewall the moment either moved; review
  // 2026-08-28). The SOFT EDGE around it is a second, local shaping constant.
  const eye = CYCLONE_EYE_RADIUS_FRACTION;
  const eyewallSoftness = 0.06;
  if (r <= eye) return 0;

  // In over the eyewall, then out to the rim. Squared on the way out so the
  // interior is uniformly dark and only the last quarter of the radius is
  // where the light comes back — matching the deck, which also thins only at
  // its rim (./spiral.ts's edge fade).
  const overEyewall = Math.min(1, (r - eye) / eyewallSoftness);
  const towardRim = (r - eye) / (1 - eye);
  return overEyewall * (1 - towardRim * towardRim);
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
