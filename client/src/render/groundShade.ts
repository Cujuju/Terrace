import { Vector3 } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  float,
  max,
  positionWorld,
  smoothstep as smoothstepNode,
  uniform,
  uniformArray,
  vec4,
} from 'three/tsl';
import { DEFAULT_WORLD_SPAN, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import { compose } from './materialSlots.ts';
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

function setShadeCount(count: number): void {
  uniforms.uShadeCount.value = count;
  shadeCountNode.value = count;
}

export function clearGroundShade(): void {
  setShadeCount(0);
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
  setShadeCount(count);
}

const shadeCountNode = uniform(0, 'int');
const shadeSunNode = uniform(uniforms.uShadeSun.value);
const shadeANode = uniformArray<'vec3'>(uniforms.uShadeA.value, 'vec3');
const shadeBNode = uniformArray<'vec3'>(uniforms.uShadeB.value, 'vec3');

// uShadeA is (x, z, deckY); uShadeB is (darkness, inner, radius).
const shadeAt = Fn(() => {
  compiledAgainstMax = true;
  const shade = float(0).toVar();
  If(shadeSunNode.y.greaterThan(GROUND_SHADE_MIN_SUN_Y), () => {
    Loop(configuredMax, ({ i }) => {
      If(i.greaterThanEqual(shadeCountNode), () => {
        Break();
      });
      const disc = shadeANode.element(i);
      const shape = shadeBNode.element(i);
      const travel = disc.z.sub(positionWorld.y).div(shadeSunNode.y);
      const hit = positionWorld.add(shadeSunNode.mul(travel));
      const reach = hit.xz.distance(disc.xy).div(shape.z);
      shade.assign(max(shade, shape.x.mul(smoothstepNode(shape.y, 1, reach).oneMinus())));
    });
  });
  return shade;
});

export function applyGroundShade(material: NodeMaterial, label: string): void {
  material.name = label;
  compose(material, 'output', (previous) =>
    vec4(previous.rgb.mul(shadeAt().oneMinus()), previous.a),
  );
  material.needsUpdate = true;
}
