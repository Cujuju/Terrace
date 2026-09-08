import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  PlaneGeometry,
  type Object3D,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  puffMaskGlsl,
} from './puffDeck.ts';
import { CLOUD_BASE_WORLD_Y, CLOUD_HEADROOM_WORLD_UNITS } from './precipitation.ts';
import { DISC_RENDER_ORDER } from './discRig.ts';
import { glslFloat, spliceShader } from '../../render/shaderSplice.ts';
import type { GroundShadeDisc } from '../types.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

const TWO_PI = Math.PI * 2;

export const DECK_BASE_WORLD_Y = CLOUD_BASE_WORLD_Y;

const DECK_ORDER_HALF_STEP = 0.5;

export const DECK_RENDER_ORDER_CAMERA_ABOVE_BASE = DISC_RENDER_ORDER + DECK_ORDER_HALF_STEP;
export const DECK_RENDER_ORDER_CAMERA_BELOW_BASE = DISC_RENDER_ORDER - DECK_ORDER_HALF_STEP;

export const DECK_THICKNESS_WORLD_UNITS = CLOUD_HEADROOM_WORLD_UNITS / 2;

export const DECK_TIERS: number = 5;

export const DECK_TIER_POPULATION_TAPER = 0.7;

export const DECK_TOP_RADIUS_FRACTION = 0.55;

export const DECK_TIER_JITTER_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS / DECK_TIERS / 2;

export const DECK_RADIAL_EXPONENT = 0.75;

export const DECK_RIM_FADE_START = 0.8;

export const PUFF_SIZE_TOP_GROWTH = 0.6;

export const PUFF_SIZE_SEED_VARIATION = 0.25;

export const PUFF_NORMAL_FLATNESS = 0.45;

export const PUFF_SOFT_EDGE_FRACTION = 0.55;

export const PUFF_LOBE_AMPLITUDE = 0.18;

export const PUFF_ASPECT_SEED_VARIATION = 0.2;

export const PUFF_COVERAGE_OVERLAP = 2;

export function puffsForCoverage(sizeFraction: number): number {
  return Math.ceil(PUFF_COVERAGE_OVERLAP / (sizeFraction * sizeFraction));
}

export function tierPopulations(total: number, tiers: number): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let tier = 0; tier < tiers; tier++) {
    const up = tiers === 1 ? 0 : tier / (tiers - 1);
    const weight = 1 - DECK_TIER_POPULATION_TAPER * up;
    weights.push(weight);
    sum += weight;
  }

  const counts: number[] = [];
  let dealt = 0;
  for (let tier = 0; tier < tiers; tier++) {
    const count = Math.floor((total * weights[tier]!) / sum);
    counts.push(count);
    dealt += count;
  }
  counts[0] = counts[0]! + (total - dealt);
  return counts;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

const SEED_HASH_TIER_JITTER = 7.31;
const SEED_HASH_PUFF_SIZE = 5.7;
const SEED_HASH_PUFF_ASPECT = 3.37;

export function deckShadeDisc(disc: InterpolatedDisc, darkness: number): GroundShadeDisc {
  return {
    x: disc.x * CELL_WORLD_SIZE,
    z: disc.y * CELL_WORLD_SIZE,
    y: DECK_BASE_WORLD_Y,
    radius: disc.radius * CELL_WORLD_SIZE,
    darkness: darkness * disc.intensity,
    inner: 0,
  };
}

export interface CumulusDeckSpec {
  readonly maxMasses: number;
  readonly puffSizeFraction: number;
  readonly color: number;
  readonly name: string;
  readonly applyRevealClip: (material: MeshLambertMaterial, label: string) => void;
}

export interface CumulusDeck {
  readonly object: Object3D;
  readonly puffsPerMass: number;
  claimSlot(): number;
  update(slot: number, disc: InterpolatedDisc): void;
  park(slot: number): void;
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

export const CUMULUS_DECK_DRAW_OBJECTS = 1;

export function createCumulusDeck(spec: CumulusDeckSpec): CumulusDeck {
  const puffsPerMass = puffsForCoverage(spec.puffSizeFraction);
  const capacity = spec.maxMasses * puffsPerMass;

  const massXZ = new Float32Array(spec.maxMasses * 2);
  const massSize = new Float32Array(spec.maxMasses * 2);

  const sharedDeclarations =  `
varying vec2 vQuad;
varying float vPuffFade;
varying float vSeed;
#define PUFF_NORMAL_FLATNESS ${glslFloat(PUFF_NORMAL_FLATNESS)}`;

  const vertexDeclarations =  `${sharedDeclarations}
uniform vec2 uMassXZ[${spec.maxMasses}];
uniform vec2 uMassSize[${spec.maxMasses}];
attribute float aSlot;
attribute float aSeed;
attribute float aTier;
attribute vec2 aPolar;`;

  const placement =  `int massSlot = int(aSlot + 0.5);
    vec2 massCentre = uMassXZ[massSlot];
    float massRadius = uMassSize[massSlot].x;
    float massFade = uMassSize[massSlot].y;

    // A dome: each tier is drawn over a smaller disc than the one below it.
    float tierRadius = massRadius * mix(1.0, ${glslFloat(DECK_TOP_RADIUS_FRACTION)}, aTier);
    float outward = aPolar.x * tierRadius;

    // The rim fades, so the deck has no edge; the mass's own intensity fades
    // the whole thing, so a gathering front costs nothing until it is there.
    vPuffFade = massFade *
      (1.0 - smoothstep(${glslFloat(DECK_RIM_FADE_START)}, 1.0, aPolar.x));
    vQuad = position.xy;
    vSeed = aSeed;

    // NOTHING IS DRAWN FOR A PARKED OR DARK SLOT. Every vertex of the quad
    // lands on the same point outside the clip volume, so the primitive is
    // culled before it reaches a fragment — the deck's equivalent of
    // discRig.ts's "a transparent draw call that contributes nothing is still
    // a transparent draw call".
    if (vPuffFade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float tierJitter = (fract(aSeed * ${glslFloat(SEED_HASH_TIER_JITTER)}) * 2.0 - 1.0) *
      ${glslFloat(DECK_TIER_JITTER_WORLD_UNITS)};

    transformed = vec3(
      massCentre.x + cos(aPolar.y) * outward,
      ${glslFloat(DECK_BASE_WORLD_Y)} +
        aTier * ${glslFloat(DECK_THICKNESS_WORLD_UNITS)} + tierJitter,
      massCentre.y + sin(aPolar.y) * outward);

    // Bigger toward the top, and never twice the same size in a row.
    float puffSize = massRadius * ${glslFloat(spec.puffSizeFraction)} *
      (1.0 + ${glslFloat(PUFF_SIZE_TOP_GROWTH)} * aTier) *
      (${glslFloat(1 - PUFF_SIZE_SEED_VARIATION)} +
       ${glslFloat(2 * PUFF_SIZE_SEED_VARIATION)} * fract(aSeed * ${glslFloat(SEED_HASH_PUFF_SIZE)}));

    // Oblong, per seed, and area-neutral: stretched along x by the aspect,
    // squashed along y by the same — see PUFF_ASPECT_SEED_VARIATION.
    float aspect = ${glslFloat(1 - PUFF_ASPECT_SEED_VARIATION)} +
      ${glslFloat(2 * PUFF_ASPECT_SEED_VARIATION)} * fract(aSeed * ${glslFloat(SEED_HASH_PUFF_ASPECT)});
    vec2 puffExtent = puffSize * vec2(aspect, 1.0 / aspect);`;

  const billboard =  `mvPosition.xy += position.xy * puffExtent;
    gl_Position = projectionMatrix * mvPosition;`;

  const mask =  `${puffMaskGlsl(glslFloat(PUFF_SOFT_EDGE_FRACTION), {
    amplitude: PUFF_LOBE_AMPLITUDE,
    seedVarying: 'vSeed',
  })}
    float alpha = puff * vPuffFade;
    ${PUFF_ALPHA_DISCARD_GLSL}
    diffuseColor.a *= alpha;`;

  const sphereNormal =  `vec2 lobedQuad = vQuad / lobeScale;
    vec3 puffSphere =
      vec3(lobedQuad, sqrt(max(0.0, 1.0 - dot(lobedQuad, lobedQuad))));
    vec3 puffUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    normal = normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS));`;

  const material = new MeshLambertMaterial({
    color: spec.color,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const label = `${spec.name} deck`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMassXZ = { value: massXZ };
    shader.uniforms.uMassSize = { value: massSize };

    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${vertexDeclarations}`,
        label,
      ),
      BEGIN_VERTEX_ANCHOR,
      `${BEGIN_VERTEX_ANCHOR}\n    ${placement}`,
      label,
    );
    shader.vertexShader = spliceShader(
      shader.vertexShader,
      PROJECT_VERTEX_ANCHOR,
      `${PROJECT_VERTEX_ANCHOR}\n    ${billboard}`,
      label,
    );

    shader.fragmentShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.fragmentShader,
          SHADER_COMMON_ANCHOR,
          `${SHADER_COMMON_ANCHOR}\n${sharedDeclarations}`,
          label,
        ),
        ALPHATEST_FRAGMENT_ANCHOR,
        `${ALPHATEST_FRAGMENT_ANCHOR}\n    ${mask}`,
        label,
      ),
      NORMAL_FRAGMENT_ANCHOR,
      `${NORMAL_FRAGMENT_ANCHOR}\n    ${sphereNormal}`,
      label,
    );
  };
  const stockCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${stockCacheKey()}|cumulusDeck:${spec.name}`;

  spec.applyRevealClip(material, label);

  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = `${spec.name}:puffs`;
  mesh.renderOrder = DECK_RENDER_ORDER_CAMERA_ABOVE_BASE;
  mesh.visible = false;
  mesh.frustumCulled = false;

  const identity = new Matrix4();
  for (let instance = 0; instance < capacity; instance++) mesh.setMatrixAt(instance, identity);
  mesh.instanceMatrix.needsUpdate = true;

  const slots = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  const tiers = new Float32Array(capacity);
  const polars = new Float32Array(capacity * 2);

  const perTier = tierPopulations(puffsPerMass, DECK_TIERS);
  for (let slot = 0; slot < spec.maxMasses; slot++) {
    let puff = 0;
    for (let tier = 0; tier < DECK_TIERS; tier++) {
      const inTier = perTier[tier]!;
      const tierFraction = DECK_TIERS === 1 ? 0 : tier / (DECK_TIERS - 1);
      for (let index = 0; index < inTier; index++) {
        const instance = slot * puffsPerMass + puff;
        slots[instance] = slot;
        tiers[instance] = tierFraction;
        seeds[instance] = (instance * GOLDEN_RATIO_CONJUGATE) % 1;
        polars[instance * 2] = Math.pow((index + 0.5) / inTier, DECK_RADIAL_EXPONENT);
        polars[instance * 2 + 1] = index * GOLDEN_ANGLE + tier * TWO_PI * GOLDEN_RATIO_CONJUGATE;
        puff++;
      }
    }
  }

  geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aTier', new InstancedBufferAttribute(tiers, 1));
  geometry.setAttribute('aPolar', new InstancedBufferAttribute(polars, 2));

  let claimed = 0;
  let live = 0;

  return {
    object: mesh,
    puffsPerMass,

    claimSlot(): number {
      if (claimed >= spec.maxMasses) return -1;
      return claimed++;
    },

    update(slot: number, disc: InterpolatedDisc): void {
      if (slot < 0) return;
      const intensity = Math.max(0, disc.intensity);
      const wasDark = massSize[slot * 2 + 1] === 0;
      massXZ[slot * 2] = disc.x * CELL_WORLD_SIZE;
      massXZ[slot * 2 + 1] = disc.y * CELL_WORLD_SIZE;
      massSize[slot * 2] = disc.radius * CELL_WORLD_SIZE;
      massSize[slot * 2 + 1] = intensity;
      if (wasDark && intensity > 0) live++;
      if (!wasDark && intensity === 0) live--;
      mesh.visible = live > 0;
    },

    park(slot: number): void {
      if (slot < 0) return;
      if (massSize[slot * 2 + 1] !== 0) live--;
      massSize[slot * 2 + 1] = 0;
      mesh.visible = live > 0;
    },

    orderAgainstCamera(cameraWorldY: number): void {
      mesh.renderOrder =
        cameraWorldY >= DECK_BASE_WORLD_Y
          ? DECK_RENDER_ORDER_CAMERA_ABOVE_BASE
          : DECK_RENDER_ORDER_CAMERA_BELOW_BASE;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      claimed = 0;
      live = 0;
    },
  };
}

const SHADER_COMMON_ANCHOR = '#include <common>';
const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';
const PROJECT_VERTEX_ANCHOR = '#include <project_vertex>';
const ALPHATEST_FRAGMENT_ANCHOR = '#include <alphatest_fragment>';
const NORMAL_FRAGMENT_ANCHOR = '#include <normal_fragment_begin>';
