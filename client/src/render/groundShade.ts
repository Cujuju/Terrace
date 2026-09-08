import { Vector3, type Material } from 'three';
import { DEFAULT_WORLD_SPAN, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import {
  WORLD_POSITION_VERTEX_ANCHOR,
  WORLD_POSITION_VERTEX_GLSL,
  glslFloat,
  spliceShader,
} from './shaderSplice.ts';
import type { GroundShadeDisc } from '../plugins/types.ts';

export type { GroundShadeDisc };

const GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS = DEFAULT_WORLD_SPAN;

const GROUND_SHADE_LOWEST_DECK_WORLD_UNITS = MAX_RELIEF_WORLD_UNITS;

export const GROUND_SHADE_MIN_SUN_Y =
  1 /
  Math.hypot(
    1,
    GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS / GROUND_SHADE_LOWEST_DECK_WORLD_UNITS,
  );

const GROUND_SHADE_MIN_ARRAY_LENGTH = 1;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

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

export interface GroundShadeUniforms {
  readonly uShadeCount: { value: number };
  readonly uShadeSun: { value: Vector3 };
  readonly uShadeA: { value: Vector3[] };
  readonly uShadeB: { value: Vector3[] };
}

let configuredMax = GROUND_SHADE_MIN_ARRAY_LENGTH;
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

const SHADER_COMMON_ANCHOR = '#include <common>';
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
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|groundShade`;
  material.needsUpdate = true;
}
