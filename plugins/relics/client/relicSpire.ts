// THE SPIRE OF LIGHT over a relic (owner, 2026-09-05: "add spires of light
// coming from the relics so they are easy to spot").
//
// A relic is a marker, and the gem alone is a half-metre object on a valley
// floor: from the default orbit it disappears behind the first hill between it
// and the camera. The spire is the part you can see from across the map — a
// column of the skill's CATEGORY colour (gems.ts, relicColor) standing on the
// relic's ground, so the three-colour code the panel teaches is legible at any
// distance without the gem itself having to be big.
//
// It is ALPHA-BLENDED rather than additive, because additive light over the
// terrain destroys the very thing the spire exists to carry: see
// SPIRE_BASE_ALPHA below.
//
// It is a SECOND mesh, not part of the gem: the gem bobs and spins, and a
// spire that bobbed would read as a searchlight rather than a beacon, while a
// spire that spun would strobe. So it is positioned once per frame at the
// relic's cell with its base on the ground, and it is hidden exactly when the
// gem is (index.ts, animateGems).
//
// One geometry, shared by every spire; one material per relic, because the
// colour is per-category and the pulse is per-relic phase — the same split the
// gems make (relicShapes.ts shares geometry, index.ts makes the material).

import {
  CylinderGeometry,
  DoubleSide,
  ShaderMaterial,
  type BufferGeometry,
  type Color,
} from 'three';

/**
 * How tall a spire stands, in WORLD UNITS. Tall enough to clear a hill between
 * the relic and the camera at the default 55° orbit (client/src/render/
 * scene.ts, INITIAL_POLAR_DEGREES) — the terrain's bands are a quarter of a
 * world unit each, so this is some fifty-odd terraces of headroom — and short
 * enough that a screen full of relics is not a screen full of columns.
 */
export const SPIRE_HEIGHT_WORLD = 14;

/** How wide the column is at its foot, in WORLD UNITS: about a cell across. */
export const SPIRE_RADIUS_WORLD = 0.5;

/** Sides on the column. Ten reads as round through additive blending, which hides the facets. */
const SPIRE_SEGMENTS = 10;

/**
 * The vertical falloff. Alpha is strongest at the base and reaches zero at the
 * top; the exponent decides how quickly — above 1 the column keeps its body
 * near the ground and thins out well before its full height, which is what
 * makes it read as light rather than as a cylinder.
 */
const SPIRE_FALLOFF_EXPONENT = 2.2;

/**
 * A second fade over the first stretch above the ground, in WORLD UNITS. Without
 * it the column's brightest cross-section is exactly where it intersects the
 * terrain, which cuts a hard bright disc into the ground.
 */
const SPIRE_FOOT_FADE_WORLD = 1.2;

/**
 * Peak alpha at the foot, once the fades are applied.
 *
 * ALPHA-BLENDED, NOT ADDITIVE (2026-09-05, from the first render of the row:
 * additive over the terrain's green washed crimson and amber into the same
 * yellow and azure into cyan, so three relics a player is meant to tell apart
 * at a glance all read the same). Straight alpha keeps the column the
 * category's own colour over any ground; this value is what makes it still
 * read as a column at thirty world units without becoming a solid wall.
 */
const SPIRE_BASE_ALPHA = 0.28;

/** The pulse: how long one breath takes, and how much of the alpha it takes away at the trough. */
export const SPIRE_PULSE_PERIOD_S = 4.5;
const SPIRE_PULSE_DEPTH = 0.18;

/**
 * Drawn after the opaque scene. The material is transparent with depthWrite
 * off, which already keeps it from occluding anything; the explicit order is
 * so a spire also lands after the sea surface and the frontier mist, which are
 * transparent too and would otherwise sort against it by distance.
 */
export const SPIRE_RENDER_ORDER = 10;

const VERTEX_SHADER = /* glsl */ `
varying float vHeight;

void main() {
  vHeight = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uHeight;
uniform float uFootFade;
uniform float uFalloff;
uniform float uAlpha;
varying float vHeight;

void main() {
  float up = clamp(vHeight / uHeight, 0.0, 1.0);
  float fade = pow(1.0 - up, uFalloff) * smoothstep(0.0, uFootFade, vHeight);
  gl_FragColor = vec4(uColor, uAlpha * fade);
}
`;

/**
 * The one column geometry, modelled with its base at y = 0 so a spire is
 * positioned by its foot. Open-ended: the caps would be a bright lid seen from
 * above and a bright floor seen from below, and there is nothing inside.
 */
export function spireGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(
    SPIRE_RADIUS_WORLD,
    SPIRE_RADIUS_WORLD,
    SPIRE_HEIGHT_WORLD,
    SPIRE_SEGMENTS,
    1,
    true,
  );
  geometry.translate(0, SPIRE_HEIGHT_WORLD / 2, 0);
  return geometry;
}

/**
 * One spire's material, in the relic's category colour.
 *
 * Unlit and NOT tone mapped, for the reason the gem's material is not
 * (gemMaterial.ts): these are the panel's colours, and the scene's exposure
 * would lift them off the swatch the player is matching them to.
 *
 * NOT FOGGED, and not by omission: the scene sets no `Scene.fog` at all
 * (verified this session — nothing in client/src assigns it; the frontier is
 * its own geometry, client/src/render/frontierFog.ts), so there is no fog for
 * a beacon to respect. If one is ever added, a beacon meant to be seen from
 * across the map should still be exempt from it.
 */
export function createSpireMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: color },
      uHeight: { value: SPIRE_HEIGHT_WORLD },
      uFootFade: { value: SPIRE_FOOT_FADE_WORLD },
      uFalloff: { value: SPIRE_FALLOFF_EXPONENT },
      uAlpha: { value: SPIRE_BASE_ALPHA },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });
}

/** The spire's alpha at a moment in its own pulse — a slow breath, never a flash. */
export function spireAlpha(elapsedS: number, phaseS: number): number {
  const breath = Math.sin(((elapsedS + phaseS) / SPIRE_PULSE_PERIOD_S) * Math.PI * 2);
  return SPIRE_BASE_ALPHA * (1 - SPIRE_PULSE_DEPTH * (1 - breath) * 0.5);
}
