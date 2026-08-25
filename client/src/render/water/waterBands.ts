// waterBands — the drifting painted bands that give every water surface in the
// world its texture (owner's pick, 2026-08-24: option B of four).
//
// WHY BANDS. The terrain is drawn as quantised contour bands; before this the
// water beside it was a single flat pane, which is what made it read as a
// material the world had been laid on top of rather than part of the world.
// Posterising the water's own shading into a few drifting steps puts it in the
// terrain's grammar: stacked painted shapes sliding over one another.
//
// WHY ONE MODULE AND NOT ONE MATERIAL. The obvious move — merge the sea's
// material and the river's into one createWaterMaterial — is wrong, and reading
// the two settled it. The sea carries the depth-alpha and specular-suppression
// textures and must not carry a polygon offset; the rivers carry a polygon
// offset (their fall sheets are coincident with the rock by design) and have no
// depth textures. Those differences are load-bearing. What was ACTUALLY
// duplicated between them is the APPEARANCE RULE — they shared only
// WATER_COLOR, so any look added to one would silently miss the other, and the
// ocean would have been left behind. So the rule lives here, once, and both
// materials are passed through it.
//
// WHERE IT SPLICES. `#include <color_fragment>`, i.e. the base colour BEFORE
// lighting, and it MULTIPLIES rather than replaces. Both of those matter: going
// in before lighting means the bands are lit, tone-mapped and fogged exactly
// like the surface always was (render/water.ts's 2026-08-14 sun-glare tuning is
// untouched), and multiplying means each material keeps its own colour, opacity
// and roughness response instead of having a second palette hardcoded over it.

import type { MeshStandardMaterial } from 'three';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { spliceShader } from '../shaderSplice.ts';

/**
 * How many brightness steps the surface is posterised into.
 *
 * The one number that decides whether this reads as painted water or as a
 * mistake: too few and the surface stripes into obvious wide bars, too many and
 * the quantisation stops being visible at all and it is just a soft gradient.
 * Five is the count the four-option preview was tuned at.
 */
const BAND_STEPS = 5;

/** Wave field size, in cells per radian — sets how big one painted shape is. */
const BAND_WAVE_SCALE_CELLS = 0.075;

/**
 * The three travelling waves that make the field, as (direction, wavenumber,
 * angular speed, amplitude). Three is enough that the sum never visibly repeats
 * at the scale a camera sees, and few enough to stay cheap; the directions are
 * deliberately NOT parallel so the pattern does not read as a moving comb.
 */
const BAND_WAVES = [
  { dir: [1.0, 0.16], k: 5.2, speed: 1.55, amplitude: 0.55 },
  { dir: [0.86, -0.22], k: 8.7, speed: 2.05, amplitude: 0.3 },
  { dir: [1.0, 0.42], k: 15.1, speed: 2.7, amplitude: 0.15 },
] as const;

/**
 * Darkest and brightest the bands drive the surface's own colour to.
 *
 * WIDENED 0.78/1.16 → 0.66/1.3 (owner, 2026-08-24: "it's a little hard to see
 * the texture now"). "Now" is the operative word and it is not a coincidence:
 * these are MULTIPLIERS, and the depth shade landing under them means deep
 * water multiplies this range by WATER_SHADE_DEEP before it reaches the screen.
 * At 0.22 a ±19% band range becomes a ±4% one in absolute terms — the steps
 * were still there and no longer legible. Widening here is what keeps the
 * texture readable at the dark end; darkening the deeps and keeping the bands
 * visible are in direct tension, and this is the knob that pays for it. Centred a
 * little under 1 rather than around it: water reading slightly DEEPER than its
 * flat colour, with the crest steps lifting back up, keeps the sea from looking
 * washed out where the depth-alpha is already thinning it.
 */
const BAND_SHADE_MIN = 0.66;
const BAND_SHADE_MAX = 1.3;

/** Extra lift on the top step only, so a crest reads as catching the light. */
const BAND_CREST_GAIN = 1.2;
/** Where the crest lift starts, in normalised band units. */
const BAND_CREST_THRESHOLD = 0.8;

/**
 * The clock every banded material shares, held by reference in each compiled
 * shader's uniform slot so the tick below reaches all of them without any
 * material needing to be revisited after its first compile.
 */
const bandTimeUniform = { value: 0 };

/** Set once the clock has a frame source; keeps a second caller from double-ticking. */
let clockInstalled = false;

/**
 * Starts (or joins) the shared band clock.
 *
 * Idempotent BY DESIGN. Both the sea and the river rig call this with their own
 * frame registrar, and whichever is constructed first wins — so a preview
 * harness that builds only one of the two still animates, while the real client,
 * which builds both, advances the clock exactly once per frame. A second tick
 * would not merely be wasted work: it would run the water at double speed
 * wherever both exist and single speed in the previews, which is precisely the
 * kind of "works in one place" difference this file exists to stop.
 */
export function installWaterBandClock(
  onFrame: (handler: (dt: number) => void) => () => void,
): void {
  if (clockInstalled) return;
  clockInstalled = true;
  onFrame((dt: number) => {
    bandTimeUniform.value += dt;
  });
}

/**
 * Formats a JS number as a GLSL float literal — GLSL ES forbids mixing int and
 * float, so an integral constant spliced in as `5` fails to compile where `5.0`
 * is fine. Mirrors render/water.ts's glslFloat for the same reason.
 */
function glslFloat(value: number): string {
  return value.toFixed(6);
}

/** The wave sum, unrolled from BAND_WAVES so the constants stay in TypeScript. */
function wavesGlsl(): string {
  const terms = BAND_WAVES.map(
    (w) =>
      `  s += sin( dot( q, vec2( ${glslFloat(w.dir[0])}, ${glslFloat(w.dir[1])} ) ) * ` +
      `${glslFloat(w.k)} - t * ${glslFloat(w.speed)} ) * ${glslFloat(w.amplitude)};`,
  );
  return ['float waterBandField( vec2 q, float t ) {', '  float s = 0.0;', ...terms, '  return s;', '}'].join(
    '\n',
  );
}

/**
 * Gives one water material the drifting painted bands.
 *
 * Chains onto any onBeforeCompile the material already has rather than
 * replacing it — the sea's depth-alpha splice is installed the same way, and
 * clobbering it here would silently delete the shallows.
 */
export function makeBanded(material: MeshStandardMaterial): void {
  const existing = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    existing(shader, renderer);
    shader.uniforms.uWaterBandTime = bandTimeUniform;

    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        '#include <common>\nvarying vec2 vWaterBandXZ;',
        'waterBands',
      ),
      '#include <begin_vertex>',
      // World space, in cells — the same frame and the same CELL_WORLD_SIZE
      // divisor the depth-alpha splice uses, so the bands are anchored to the
      // world rather than to each mesh's own local origin. A river tile and the
      // sea meeting at a shoreline therefore carry ONE continuous pattern
      // across the join instead of two that happen to be adjacent.
      `#include <begin_vertex>\nvWaterBandXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz / ${glslFloat(
        CELL_WORLD_SIZE,
      )};`,
      'waterBands',
    );

    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        `#include <common>\nvarying vec2 vWaterBandXZ;\nuniform float uWaterBandTime;\n${wavesGlsl()}`,
        'waterBands',
      ),
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        `float wbHeight = waterBandField( vWaterBandXZ * ${glslFloat(
          BAND_WAVE_SCALE_CELLS,
        )}, uWaterBandTime ) * 0.5 + 0.5;`,
        // floor(h * STEPS) / (STEPS - 1) spreads the steps across the full
        // shade range: the top step lands exactly on 1.0 rather than one step
        // short of it, which is what keeps the brightest band actually bright.
        `float wbBand = floor( wbHeight * ${glslFloat(BAND_STEPS)} ) / ${glslFloat(
          BAND_STEPS - 1,
        )};`,
        `diffuseColor.rgb *= mix( ${glslFloat(BAND_SHADE_MIN)}, ${glslFloat(
          BAND_SHADE_MAX,
        )}, clamp( wbBand, 0.0, 1.0 ) );`,
        `diffuseColor.rgb *= mix( 1.0, ${glslFloat(
          BAND_CREST_GAIN,
        )}, step( ${glslFloat(BAND_CREST_THRESHOLD)}, wbBand ) );`,
      ].join('\n'),
      'waterBands',
    );
  };
}
