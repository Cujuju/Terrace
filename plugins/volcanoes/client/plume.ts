import {
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  fract,
  mix,
  pow,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { VENT_SUMMIT_WORLD_UNITS } from '../protocol.ts';
import {
  puffAlphaDiscard,
  puffBillboard,
  puffInstanceBase,
  puffMask,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import { compose, discard } from '../../../client/src/render/materialSlots.ts';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';

export const PARTICLES_PER_PLUME = 48;

export const MAX_PLUMES = 8;

export const PLUME_PARTICLE_LIFE_SECONDS = 6;

export const PLUME_HEIGHT_IN_SUMMITS = 2.4;

export const PLUME_HEIGHT_WORLD_UNITS = VENT_SUMMIT_WORLD_UNITS * PLUME_HEIGHT_IN_SUMMITS;

export const PLUME_LEAN_WORLD_UNITS = PLUME_HEIGHT_WORLD_UNITS * 0.4;

export const PLUME_START_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.28;
export const PLUME_END_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.95;

export const PLUME_RISE_SECONDS = 3;
export const PLUME_DISPERSE_SECONDS = 12;

export const PLUME_RENDER_ORDER = 2;

interface Plume {
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
  readonly seed: number;
  alive: boolean;
  strength: number;
  slotBase: number;
  writtenStrength: number;
}

export interface PlumeSource {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
}

export interface PlumeRenderer {
  readonly root: Group;
  apply(erupting: readonly PlumeSource[]): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export function createPlume(): PlumeRenderer {
  const root = new Group();
  root.name = 'volcanoes:plume';

  const capacity = MAX_PLUMES * PARTICLES_PER_PLUME;

  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;

  const elapsedUniform = uniform(0);
  const aPhase = attribute<'float'>('aPhase', 'float');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');

  // 0 at the mouth, 1 at the top. fract() makes one instance a repeating particle; aPhase spaces them.
  const life = varying(fract(elapsedUniform.div(PLUME_PARTICLE_LIFE_SECONDS).add(aPhase)), 'vLife');

  // Rise eased so particles bunch at the mouth; an exponent below 1 piles them at the ceiling.
  const rise = pow(life, 1.25).mul(PLUME_HEIGHT_WORLD_UNITS);

  // Lean fixed per vent by its seed, quadratic in life so the column rises before it leans.
  const leanAngle = aSeed.mul(6.28318);
  const lean = vec2(cos(leanAngle), sin(leanAngle)).mul(life.mul(life).mul(PLUME_LEAN_WORLD_UNITS));

  // Per-particle scatter widening with life; the floor gives the column a throat, not a beam.
  const scatterAngle = fract(aSeed.mul(31.7).add(aPhase.mul(17.3))).mul(6.28318);
  const scatter = float(0.28)
    .add(life)
    .mul(VENT_SUMMIT_WORLD_UNITS * 0.85)
    .mul(fract(aSeed.mul(7.13).add(0.31)));
  const wobble = vec2(cos(scatterAngle), sin(scatterAngle)).mul(scatter);

  // The instance matrix carries only the vent's position.
  const world = puffInstanceBase().add(vec3(lean.x.add(wobble.x), rise, lean.y.add(wobble.y)));

  const size = mix(float(PLUME_START_SIZE), PLUME_END_SIZE, life);
  compose(material, 'position', () => puffBillboard(world, size));

  const mask = puffMask(0.15);
  discard(material, mask.discarded);

  // Glowing at the mouth, ash above it: two colours and one smoothstep.
  const ember = vec3(1.0, 0.45, 0.12);
  const ash = vec3(0.3, 0.28, 0.28);
  compose(material, 'color', () => mix(ember, ash, smoothstep(0.0, 0.14, life)));

  // In slowly, out slow: a fast ramp clips a white disc onto the summit.
  const fade = smoothstep(0.0, 0.2, life).mul(float(1).sub(smoothstep(0.3, 0.95, life)));

  // Normal blending converges on the ash colour; well under 1 so the sky shows through.
  const alpha = mask.puff.mul(fade).mul(aStrength).mul(0.3);
  discard(material, puffAlphaDiscard(alpha));
  compose(material, 'opacity', () => alpha);

  // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
  compose(material, 'output', (previous) => vec4(radianceForDisplay(previous.rgb), previous.a));

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'volcanoes:plume:particles';
  mesh.count = 0;
  mesh.renderOrder = PLUME_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const phases = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  geometry.setAttribute('aPhase', phases);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  const plumes = new Map<number, Plume>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  let layoutDirty = false;
  let drawn = 0;

  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function writeLayout(): void {
    const phaseArray = phases.array as Float32Array;
    const seedArray = seeds.array as Float32Array;
    const strengthArray = strengths.array as Float32Array;
    drawn = 0;

    for (const plume of plumes.values()) {
      position.set(plume.x * CELL_WORLD_SIZE, plume.groundY, plume.y * CELL_WORLD_SIZE);
      matrix.compose(position, rotation, scale);
      plume.slotBase = drawn;
      plume.writtenStrength = plume.strength;

      for (let i = 0; i < PARTICLES_PER_PLUME; i++) {
        mesh.setMatrixAt(drawn, matrix);
        phaseArray[drawn] = i / PARTICLES_PER_PLUME;
        seedArray[drawn] = (plume.seed + i * 0.6180339887) % 1;
        strengthArray[drawn] = plume.strength;
        drawn++;
      }
    }

    mesh.count = drawn;
    markUploaded(mesh.instanceMatrix, drawn);
    markUploaded(phases, drawn);
    markUploaded(seeds, drawn);
    markUploaded(strengths, drawn);
  }

  function unitFromId(id: number): number {
    let h = id >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  }

  return {
    root,

    apply(erupting): void {
      for (const plume of plumes.values()) plume.alive = false;

      for (const vent of erupting) {
        const existing = plumes.get(vent.id);
        if (existing !== undefined) {
          existing.alive = true;
          continue;
        }
        if (plumes.size >= MAX_PLUMES) continue;
        plumes.set(vent.id, {
          x: vent.x,
          y: vent.y,
          groundY: vent.groundY,
          seed: unitFromId(vent.id),
          alive: true,
          strength: 0,
          slotBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed): void {
      elapsedUniform.value = elapsed;

      if (plumes.size === 0) {
        mesh.count = 0;
        drawn = 0;
        return;
      }

      for (const [id, plume] of plumes) {
        if (plume.alive) {
          plume.strength = Math.min(1, plume.strength + dt / PLUME_RISE_SECONDS);
        } else {
          plume.strength -= dt / PLUME_DISPERSE_SECONDS;
          if (plume.strength <= 0) {
            plumes.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (plumes.size === 0) {
        mesh.count = 0;
        drawn = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      const strengthArray = strengths.array as Float32Array;
      let touched = false;
      for (const plume of plumes.values()) {
        if (plume.strength === plume.writtenStrength) continue;
        strengthArray.fill(plume.strength, plume.slotBase, plume.slotBase + PARTICLES_PER_PLUME);
        plume.writtenStrength = plume.strength;
        touched = true;
      }
      if (touched) markUploaded(strengths, drawn);
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      plumes.clear();
    },
  };
}
