// groundShade — clouds darken the ground beneath them, projected along the sun.
//
// THE DEFECT (#284). A plugin that draws something in the sky has two ways to
// affect the light: `setSkyRig`, which it may not have (one claimant), and
// `modulateSkyRig`, which darkens the WHOLE world and therefore cannot show a
// cloud's EDGE on the ground. There was no third, so a cloud sat over bright
// noon terrain and cast nothing.
//
// NO SHADOW MAP, by the owner's decision (plan §6): a depth pass per frame for
// a dozen discs is the wrong tool, and three's shadow maps would cost every
// material a recompile and the terrain a second pass. Instead a shade is a DISC
// IN THE SKY, and the ground shaders project it along the sun onto themselves:
//
//   hit   = p + s * ( ( disc.y - p.y ) / s.y )   // p's sun ray, at deck height
//   d     = distance( hit.xz, disc.xz ) / disc.radius
//   shade = disc.darkness * ( 1.0 - smoothstep( disc.inner, 1.0, d ) )
//   outgoingLight *= 1.0 - max-over-discs( shade )
//
// PER-DISC HEIGHT rather than one global cloud base, because the decks in this
// world already sit at different heights and a shadow must fall from where the
// cloud IS.
//
// THE ARITHMETIC IS WRITTEN TWICE, IN GLSL AND IN TYPESCRIPT, and that is
// deliberate rather than a duplication: this project ships no headless GL rig
// (design doc), so `groundShadeAt` below is the only way the projection can be
// pinned by a test at all. The two are kept in step by being adjacent, by the
// TypeScript being the one the test reads, and by neither having any input the
// other lacks.
//
// WHY THE MAX IS A `#define` AND NOT A UNIFORM. GLSL ES 1.0 needs a compile-time
// array length and a compile-time loop bound. The value is Σ of the plugins'
// declared `groundShadeBudget`s — the `drawBudget` rule applied to a uniform
// array: a cap that is an expression of the plugins' own caps can never drift
// the way a measured or round number does.

import { Vector3, type Material } from 'three';
import { DEFAULT_WORLD_SPAN, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import {
  WORLD_POSITION_VERTEX_ANCHOR,
  WORLD_POSITION_VERTEX_GLSL,
  glslFloat,
  spliceShader,
} from './shaderSplice.ts';
/**
 * DEFINED IN THE PLUGIN CONTRACT, NOT HERE, and imported back — the same
 * inversion SkyRigState uses, and for the same reason: a plugin CONSTRUCTS
 * these, so the type has to sit where a plugin's standalone tsc run can reach
 * it without pulling `import.meta.env` in. See its doc comment there.
 */
import type { GroundShadeDisc } from '../plugins/types.ts';

export type { GroundShadeDisc };

/**
 * How far a shadow may travel across the ground before the projection has
 * stopped meaning anything: one world span. A shadow displaced further than
 * the world is wide has left the map, whatever cast it and wherever that was.
 */
const GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS = DEFAULT_WORLD_SPAN;

/**
 * The lowest a shade disc can meaningfully sit: just clear of the tallest
 * ground the world can have. Anything below that is inside the terrain, not
 * over it, so this is the shortest drop the projection ever has to cover — and
 * therefore the case that reaches the travel limit above at the HIGHEST sun.
 */
const GROUND_SHADE_LOWEST_DECK_WORLD_UNITS = MAX_RELIEF_WORLD_UNITS;

/**
 * The sun elevation (as the Y of a UNIT direction vector) below which the shade
 * term is zero.
 *
 * WHY THERE MUST BE ONE. `( disc.y - p.y ) / s.y` runs to infinity as the sun
 * reaches the horizon: at s.y = 0 it is a division by zero, and just above it
 * every disc's shadow is thrown thousands of units sideways, landing on
 * whatever ground happens to be out there. That is not a soft failure to tune
 * around; it is the projection ceasing to describe anything.
 *
 * WHY THIS VALUE. A disc at the lowest height one can sit at
 * (GROUND_SHADE_LOWEST_DECK_WORLD_UNITS, 16) throws its shadow
 * `height / tan(elevation)` units sideways. Setting that equal to
 * GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS (512) gives cot(elevation) = 32, i.e.
 * sin(elevation) = 1 / hypot(1, 32) ≈ 0.0312 — an elevation of ~1.8°. Below it
 * no disc over this world can cast onto this world.
 *
 * WHAT DAY/NIGHT IS DOING AT THAT MOMENT, verified in
 * plugins/daynight/client/sky.ts: the sun's elevation is
 * `sin(sunHeight(phase) * NOON_ELEVATION_ANGLE_RADIANS)` with a noon peak of
 * ~26.8°, so this cut sits at |sunHeight| ≈ 0.067 — the last few percent of the
 * day either side of the horizon crossing, after which that plugin takes the
 * sun's intensity to exactly zero (NIGHT_SUN_INTENSITY, "below the horizon
 * there is no direct sunlight to model"). The shade term therefore switches off
 * inside the band where the light it is modulating is already going out, which
 * is why the cut is not visible as a pop.
 */
export const GROUND_SHADE_MIN_SUN_Y =
  1 /
  Math.hypot(
    1,
    GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS / GROUND_SHADE_LOWEST_DECK_WORLD_UNITS,
  );

/**
 * GLSL forbids a zero-length array, so the `#define` never goes below this.
 * With no publishers the loop bound is `uShadeCount = 0` and the one slot is
 * declared and never read.
 */
const GROUND_SHADE_MIN_ARRAY_LENGTH = 1;

/** The smoothstep three's GLSL runs, restated — see the header on why. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  // GLSL's smoothstep is undefined for edge0 >= edge1; clamping the divisor's
  // input is what keeps `inner` = 1 (a disc with no falloff at all) finite
  // here rather than NaN.
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The shade at world point (px, py, pz) — the exact arithmetic the spliced
 * fragment shader runs, and the reason it can be tested without GL.
 *
 * `sunDir` is the direction the light comes FROM, three's
 * `DirectionalLight.position` convention (render/skyRig.ts writes exactly that
 * vector). It need not be normalised: the projection is scale-invariant in
 * `sunDir` (scaling it by c scales the ray parameter by 1/c), and only the
 * horizon test below cares, so this normalises for that test alone and the
 * shader — which is handed a normalised uniform — computes the same number.
 */
export function groundShadeAt(
  px: number,
  py: number,
  pz: number,
  sunDir: { readonly x: number; readonly y: number; readonly z: number },
  discs: readonly GroundShadeDisc[],
): number {
  const length = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
  if (length === 0) return 0;
  const sy = sunDir.y / length;
  if (sy <= GROUND_SHADE_MIN_SUN_Y) return 0;
  const sx = sunDir.x / length;
  const sz = sunDir.z / length;

  let shade = 0;
  for (const disc of discs) {
    const ray = (disc.y - py) / sy;
    const hitX = px + sx * ray;
    const hitZ = pz + sz * ray;
    const d = Math.hypot(hitX - disc.x, hitZ - disc.z) / disc.radius;
    shade = Math.max(shade, disc.darkness * (1 - smoothstep(disc.inner, 1, d)));
  }
  return shade;
}

/**
 * The uniform array's length: Σ of the mounted plugins' declared budgets, at
 * least GROUND_SHADE_MIN_ARRAY_LENGTH.
 *
 * A non-finite budget contributes NOTHING, for the same reason
 * `frameDrawBudget` leaves one out of its total: a plugin loaded at runtime is
 * not held to the compile-time type, and NaN would destroy the one number the
 * shader is compiled against.
 */
export function groundShadeMaxFor(
  plugins: readonly { readonly groundShadeBudget?: number }[],
): number {
  let total = 0;
  for (const plugin of plugins) {
    const declared = plugin.groundShadeBudget;
    if (declared !== undefined && Number.isFinite(declared) && declared > 0) {
      total += declared;
    }
  }
  return Math.max(GROUND_SHADE_MIN_ARRAY_LENGTH, total);
}

/** The shared uniform object — one write reaches terrain and water alike. */
export interface GroundShadeUniforms {
  readonly uShadeCount: { value: number };
  readonly uShadeSun: { value: Vector3 };
  /** (x, z, y, radius) per disc. */
  readonly uShadeA: { value: Vector3[] };
  /** (darkness, inner) per disc, in a vec4's first two lanes. */
  readonly uShadeB: { value: Vector3[] };
}

// ── The module's one configuration, and why it is module state ───────────────
//
// THE ORDERING PROBLEM, VERIFIED. main.tsx builds the world (line 58) BEFORE
// the plugin host (line 118), and `createWorld` constructs water's material
// immediately; the terrain's is constructed later still, at the first join
// snapshot. So the module that owns the materials never has the plugin list,
// and the module that has the plugin list never sees the materials. What
// actually matters, though, is not construction but COMPILATION: three runs
// `onBeforeCompile` on the first render of a material, which is after boot in
// every case — so the value is known in time provided it is settled at boot and
// never moves afterwards. That is what `configureGroundShade` is: one call, at
// host construction, before the first frame.

let configuredMax = GROUND_SHADE_MIN_ARRAY_LENGTH;
/** Whether any material has already been compiled against `configuredMax`. */
let compiledAgainstMax = false;

const uniforms: GroundShadeUniforms = {
  uShadeCount: { value: 0 },
  uShadeSun: { value: new Vector3(0, 1, 0) },
  uShadeA: { value: [] },
  uShadeB: { value: [] },
};

function resizeUniformArrays(max: number): void {
  const a = uniforms.uShadeA.value;
  const b = uniforms.uShadeB.value;
  a.length = 0;
  b.length = 0;
  for (let i = 0; i < max; i++) {
    a.push(new Vector3());
    b.push(new Vector3());
  }
}
resizeUniformArrays(configuredMax);

/**
 * Fixes the uniform array's length for the session. Called ONCE, by the plugin
 * host, with `groundShadeMaxFor(<the compiled-in registry>)`.
 *
 * THE REGISTRY, NOT THE MOUNTED SET, and this is the one place this module
 * deviates from "Σ of the MOUNTED plugins' budgets". `syncLivePlugins` mounts
 * and unmounts plugins at any time (a world toggling a plugin on), so a sum
 * over the mounted set is not a session constant — and a `#define` that changed
 * would need every terrain and water program recompiled mid-session, which is
 * the one thing a `#define` cannot do cheaply. The registry sum is the upper
 * bound the mounted sum can never exceed, it is fixed before the first frame,
 * and it is still an expression of the plugins' own caps rather than a number
 * anybody chose. The COST of the difference is unused slots in a uniform array
 * whose loop bound is `uShadeCount` — nothing per fragment, and a few dozen
 * bytes of uniform storage.
 *
 * THROWS on a second call that would change the value after something has
 * compiled: the alternative is materials silently disagreeing about the length
 * of an array they share, which no test would catch. Same stance as
 * `spliceShader` — fail on the developer's machine, naming the cause.
 */
export function configureGroundShade(max: number): void {
  if (max === configuredMax) return;
  if (compiledAgainstMax) {
    throw new Error(
      `groundShade: GROUND_SHADE_MAX is already compiled into a material at ` +
        `${String(configuredMax)} and cannot become ${String(max)}. ` +
        `Configure it once, at boot, before the first frame.`,
    );
  }
  configuredMax = max;
  resizeUniformArrays(max);
}

export function groundShadeUniforms(): GroundShadeUniforms {
  return uniforms;
}

/**
 * Writes this frame's sun and discs into the uniforms. Discs past the
 * configured maximum are dropped here as a last line of defence — the host has
 * already applied each plugin's own budget and logged the breach.
 */
/**
 * Says there is nothing in the sky this frame — the loop bound goes to zero and
 * every shader's shade term is the constant 0.
 *
 * SEPARATE FROM `setGroundShade` BECAUSE IT NEEDS NO SUN. With no publisher
 * there is nothing to project and nothing to project it along, so the host must
 * not have to read the lighting rig to say so; and a retired cloud's last
 * shadow must not stay frozen on the ground, which is what leaving the count
 * alone would do.
 */
export function clearGroundShade(): void {
  uniforms.uShadeCount.value = 0;
}

export function setGroundShade(
  sunPosition: { readonly x: number; readonly y: number; readonly z: number },
  discs: readonly GroundShadeDisc[],
): void {
  uniforms.uShadeSun.value.set(sunPosition.x, sunPosition.y, sunPosition.z).normalize();
  const count = Math.min(discs.length, configuredMax);
  for (let i = 0; i < count; i++) {
    const disc = discs[i];
    uniforms.uShadeA.value[i].set(disc.x, disc.z, disc.y);
    uniforms.uShadeB.value[i].set(disc.darkness, disc.inner, disc.radius);
  }
  uniforms.uShadeCount.value = count;
}

// ── The splice ───────────────────────────────────────────────────────────────
//
// PACKED AS TWO vec3 ARRAYS, not the plan's vec4 + vec2. `Vector3` is what
// three uniform-uploads as a `vec3` array without a per-frame allocation, and
// the six numbers a disc carries fit two of them exactly: A = (x, z, y),
// B = (darkness, inner, radius). Same two uploads, same register count, one
// fewer type to keep in step between the TypeScript and the GLSL.

const SHADER_COMMON_ANCHOR = '#include <common>';
/**
 * The fragment anchor: `outgoingLight` is assembled immediately before three
 * emits this include, and everything after it (tone mapping, fog, encoding)
 * must see the shaded value. Verified against this project's installed three
 * 0.185.1 — `meshphysical.glsl.js` line 216, the include that follows
 * `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;`.
 * render/terrainMeshes.ts's self-lit splice uses the same anchor for the same
 * reason.
 */
const GROUND_SHADE_FRAGMENT_ANCHOR = '#include <opaque_fragment>';

function declarationsGlsl(max: number): string {
  return `#define GROUND_SHADE_MAX ${String(max)}
#define GROUND_SHADE_MIN_SUN_Y ${glslFloat(GROUND_SHADE_MIN_SUN_Y)}
uniform int uShadeCount;
uniform vec3 uShadeSun;
uniform vec3 uShadeA[ GROUND_SHADE_MAX ];
uniform vec3 uShadeB[ GROUND_SHADE_MAX ];
varying vec3 vGroundShadeWorld;`;
}

/**
 * The loop, restating `groundShadeAt` — see this module's header on why the
 * arithmetic is written twice.
 *
 * `uShadeCount` bounds it, so the zero-publisher cost is the horizon compare
 * and one loop test: the `for` is entered and breaks on its first iteration.
 */
const GROUND_SHADE_FRAGMENT_GLSL = `float gsShade = 0.0;
    if ( uShadeSun.y > GROUND_SHADE_MIN_SUN_Y ) {
        for ( int i = 0; i < GROUND_SHADE_MAX; i ++ ) {
            if ( i >= uShadeCount ) break;
            vec3 gsA = uShadeA[ i ];
            vec3 gsB = uShadeB[ i ];
            vec3 gsHit = vGroundShadeWorld + uShadeSun * ( ( gsA.z - vGroundShadeWorld.y ) / uShadeSun.y );
            float gsD = distance( gsHit.xz, gsA.xy ) / gsB.z;
            gsShade = max( gsShade, gsB.x * ( 1.0 - smoothstep( gsB.y, 1.0, gsD ) ) );
        }
    }
    outgoingLight *= 1.0 - gsShade;`;

/**
 * Makes a lit stock material take the ground shade. CHAINS onto whatever
 * `onBeforeCompile` the material already has — terrain and water both carry
 * one — rather than replacing it.
 */
export function applyGroundShade(material: Material, label: string): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    compiledAgainstMax = true;
    shader.uniforms.uShadeCount = uniforms.uShadeCount;
    shader.uniforms.uShadeSun = uniforms.uShadeSun;
    shader.uniforms.uShadeA = uniforms.uShadeA;
    shader.uniforms.uShadeB = uniforms.uShadeB;
    const declarations = declarationsGlsl(configuredMax);
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${declarations}`,
        label,
      ),
      WORLD_POSITION_VERTEX_ANCHOR,
      [
        WORLD_POSITION_VERTEX_ANCHOR,
        WORLD_POSITION_VERTEX_GLSL,
        'vGroundShadeWorld = tWorldPosition.xyz;',
      ].join('\n    '),
      label,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${declarations}`,
        label,
      ),
      GROUND_SHADE_FRAGMENT_ANCHOR,
      `${GROUND_SHADE_FRAGMENT_GLSL}\n    ${GROUND_SHADE_FRAGMENT_ANCHOR}`,
      label,
    );
  };
  // See the same line in render/revealMask.ts: three keys a compiled program by
  // material type, parameters and this — never by onBeforeCompile — so without
  // it a shaded material could share a program with an unshaded twin.
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|groundShade`;
  material.needsUpdate = true;
}
