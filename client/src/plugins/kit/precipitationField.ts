import {
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  Points,
  type Object3D,
} from 'three';
import { LineBasicNodeMaterial, PointsNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  fract,
  int,
  normalize,
  select,
  sin,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { compose, discard } from '../../render/materialSlots.ts';
import { createMassSlots } from './discSlots.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';
import {
  CLOUD_BASE_WORLD_Y,
  PRECIPITATION_COLUMN_WORLD_UNITS,
  seedRadius,
  type PrecipitationProfile,
} from './precipitation.ts';

const TWO_PI = Math.PI * 2;

export const PRECIPITATION_FIELD_DRAW_OBJECTS = 1;

export interface PrecipitationFieldSpec {
  readonly maxMasses: number;
  readonly name: string;
  readonly renderOrder: number;
  readonly canopyFraction: number;
  readonly applyRevealClip: (material: NodeMaterial, label: string) => void;
}

export interface PrecipitationField {
  readonly object: Object3D;
  claimSlot(): number;
  update(slot: number, disc: InterpolatedDisc, elapsed: number): void;
  updateWorld(
    slot: number,
    x: number,
    z: number,
    radius: number,
    intensity: number,
    vx: number,
    vz: number,
    elapsed: number,
  ): void;
  park(slot: number): void;
  dispose(): void;
}

// One draw per kind, animated on the GPU: each particle's fall, sway and
// streak come from its seed attributes, the clock and its slot's uniforms.
export function createPrecipitationField(
  profile: PrecipitationProfile,
  spec: PrecipitationFieldSpec,
): PrecipitationField {
  const verticesPerParticle = profile.form === 'streak' ? 2 : 1;
  const particles = spec.maxMasses * profile.count;
  const vertices = particles * verticesPerParticle;

  const slotOf = new Float32Array(vertices);
  const disc = new Float32Array(vertices * 2);
  const births = new Float32Array(vertices);
  const phases = new Float32Array(vertices);
  const ends = new Float32Array(vertices);
  let write = 0;
  for (let particle = 0; particle < particles; particle++) {
    const slot = Math.floor(particle / profile.count);
    const r = seedRadius(Math.random(), profile.innerRadiusFraction, spec.canopyFraction);
    const angle = Math.random() * TWO_PI;
    const birth = Math.random();
    const phase = Math.random() * TWO_PI;
    for (let end = 0; end < verticesPerParticle; end++) {
      slotOf[write] = slot;
      disc[write * 2] = Math.cos(angle) * r;
      disc[write * 2 + 1] = Math.sin(angle) * r;
      births[write] = birth;
      phases[write] = phase;
      ends[write] = end;
      write++;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute('aSlot', new Float32BufferAttribute(slotOf, 1));
  geometry.setAttribute('aDisc', new Float32BufferAttribute(disc, 2));
  geometry.setAttribute('aBirth', new Float32BufferAttribute(births, 1));
  geometry.setAttribute('aPhase', new Float32BufferAttribute(phases, 1));
  geometry.setAttribute('aEnd', new Float32BufferAttribute(ends, 1));

  const slots = createMassSlots(spec.maxMasses);
  const massXZNode = uniformArray<'vec2'>(slots.massXZ, 'vec2');
  const massSizeNode = uniformArray<'vec2'>(slots.massSize, 'vec2');
  const massVelocityNode = uniformArray<'vec2'>(slots.massVelocity, 'vec2');
  // Fall and sway phases advance in float64 on the CPU; the shader only wraps.
  const fallPhaseNode = uniform(0);
  const swayPhaseNode = uniform(0);

  const slot = int(attribute<'float'>('aSlot', 'float').add(0.5));
  const centre = massXZNode.element(slot);
  const size = massSizeNode.element(slot);
  const velocity = massVelocityNode.element(slot);
  const aDisc = attribute<'vec2'>('aDisc', 'vec2');
  const aBirth = attribute<'float'>('aBirth', 'float');
  const aPhase = attribute<'float'>('aPhase', 'float');
  const aEnd = attribute<'float'>('aEnd', 'float');

  const fraction = fract(aBirth.add(fallPhaseNode));
  const swayAngle = swayPhaseNode.add(aPhase);
  const sway =
    profile.swayWorldUnits === 0
      ? vec2(0, 0)
      : vec2(sin(swayAngle), cos(swayAngle)).mul(profile.swayWorldUnits);
  const streak =
    profile.form === 'streak'
      ? normalize(vec3(velocity.x, float(-profile.fallSpeed), velocity.y))
          .mul(profile.streakLength)
          .mul(aEnd)
      : vec3(0, 0, 0);
  const head = vec3(
    centre.x.add(aDisc.x.mul(size.x)).add(sway.x),
    float(CLOUD_BASE_WORLD_Y).sub(fraction.mul(PRECIPITATION_COLUMN_WORLD_UNITS)),
    centre.y.add(aDisc.y.mul(size.x)).add(sway.y),
  );
  const lit = size.y.greaterThan(0);
  const parked = vec3(centre.x, float(CLOUD_BASE_WORLD_Y), centre.y);
  const fade = varying(size.y.mul(profile.opacity), 'vPrecipitationFade');

  const material =
    profile.form === 'streak'
      ? new LineBasicNodeMaterial({ color: profile.color, transparent: true, depthWrite: false })
      : new PointsNodeMaterial({
          color: profile.color,
          size: profile.spriteSize,
          sizeAttenuation: true,
          transparent: true,
          depthWrite: false,
        });
  compose(material, 'position', () => select(lit, head.add(streak), parked));
  compose(material, 'opacity', (previous) => previous.mul(fade));
  discard(material, fade.lessThanEqual(0));
  const label = `${spec.name} precipitation`;
  material.name = label;
  spec.applyRevealClip(material, label);

  const object =
    profile.form === 'streak' ? new LineSegments(geometry, material) : new Points(geometry, material);
  object.name = `${spec.name}:precipitation`;
  object.renderOrder = spec.renderOrder;
  object.visible = false;
  object.frustumCulled = false;

  function advanceClock(elapsed: number): void {
    fallPhaseNode.value = (elapsed * profile.fallSpeed) / PRECIPITATION_COLUMN_WORLD_UNITS % 1;
    swayPhaseNode.value = (elapsed * profile.swayHz * TWO_PI) % TWO_PI;
  }

  return {
    object,

    claimSlot(): number {
      return slots.claim();
    },

    update(slot: number, disc: InterpolatedDisc, elapsed: number): void {
      advanceClock(elapsed);
      object.visible = slots.update(slot, disc);
    },

    updateWorld(slot, x, z, radius, intensity, vx, vz, elapsed): void {
      advanceClock(elapsed);
      object.visible = slots.updateWorld(slot, x, z, radius, intensity, vx, vz);
    },

    park(slot: number): void {
      object.visible = slots.park(slot);
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      slots.reset();
    },
  };
}
