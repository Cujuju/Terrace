import { DoubleSide, InstancedBufferAttribute, InstancedMesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { MeshBasicNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  int,
  positionGeometry,
  select,
  sin,
  uniform,
  uniformArray,
  varying,
  vec3,
} from 'three/tsl';
import { compose, discard } from '../../render/materialSlots.ts';
import { createMassSlots } from './discSlots.ts';
import { DISC_RENDER_ORDER } from './discRig.ts';
import { HAZE_COLOR, HAZE_LAYERS, buildHazeGeometry } from './hazeBank.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

const TWO_PI = Math.PI * 2;

export const HAZE_DECK_DRAW_OBJECTS = 1;

export interface HazeDeckSpec {
  readonly maxMasses: number;
  readonly strength: number;
  readonly name: string;
  readonly applyRevealClip: (material: NodeMaterial, label: string) => void;
}

export interface HazeDeck {
  readonly object: Object3D;
  claimSlot(): number;
  update(slot: number, disc: InterpolatedDisc, elapsed: number): void;
  park(slot: number): void;
  dispose(): void;
}

// One instanced draw per kind: every system's haze sheets are instances whose
// spin, bob, scale and fade come from per-slot uniforms, not per-object matrices.
export function createHazeDeck(spec: HazeDeckSpec): HazeDeck {
  const layers = HAZE_LAYERS.length;
  const capacity = spec.maxMasses * layers;

  const slots = createMassSlots(spec.maxMasses);
  const massXZNode = uniformArray<'vec2'>(slots.massXZ, 'vec2');
  const massSizeNode = uniformArray<'vec2'>(slots.massSize, 'vec2');
  const layerShapeNode = uniformArray<'vec3'>(
    HAZE_LAYERS.map((layer) => new Vector3(layer.height, layer.radiusScale, layer.opacity)),
    'vec3',
  );
  const layerMotionNode = uniformArray<'vec3'>(
    HAZE_LAYERS.map((layer) => new Vector3(layer.spinHz, layer.bobUnits, layer.bobHz)),
    'vec3',
  );
  const elapsedNode = uniform(0);

  const aSlot = attribute<'float'>('aSlot', 'float');
  const aLayer = attribute<'float'>('aLayer', 'float');
  const slot = int(aSlot.add(0.5));
  const layer = int(aLayer.add(0.5));

  const centre = massXZNode.element(slot);
  const size = massSizeNode.element(slot);
  const shape = layerShapeNode.element(layer);
  const motion = layerMotionNode.element(layer);

  const angle = elapsedNode.mul(motion.x.mul(TWO_PI));
  const scale = size.x.mul(shape.y);
  const spunX = positionGeometry.x.mul(cos(angle)).add(positionGeometry.z.mul(sin(angle)));
  const spunZ = positionGeometry.z.mul(cos(angle)).sub(positionGeometry.x.mul(sin(angle)));
  const height = shape.x.add(sin(elapsedNode.mul(motion.z.mul(TWO_PI))).mul(motion.y));
  const lit = size.y.greaterThan(0);
  const sheetPosition = vec3(
    centre.x.add(spunX.mul(scale)),
    height,
    centre.y.add(spunZ.mul(scale)),
  );
  const parkedPosition = vec3(centre.x, height, centre.y);

  const fade = varying(shape.z.mul(spec.strength).mul(size.y), 'vHazeFade');

  const material = new MeshBasicNodeMaterial({
    color: HAZE_COLOR,
    transparent: true,
    vertexColors: true,
    side: DoubleSide,
    depthWrite: false,
  });
  compose(material, 'position', () => select(lit, sheetPosition, parkedPosition));
  compose(material, 'opacity', (previous) => previous.mul(fade));
  discard(material, fade.lessThanEqual(0));
  const label = `${spec.name} haze`;
  material.name = label;
  spec.applyRevealClip(material, label);

  const geometry: BufferGeometry = buildHazeGeometry();
  const slotOf = new Float32Array(capacity);
  const layerIndex = new Float32Array(capacity);
  for (let instance = 0; instance < capacity; instance++) {
    slotOf[instance] = Math.floor(instance / layers);
    layerIndex[instance] = instance % layers;
  }
  geometry.setAttribute('aSlot', new InstancedBufferAttribute(slotOf, 1));
  geometry.setAttribute('aLayer', new InstancedBufferAttribute(layerIndex, 1));

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = `${spec.name}:haze`;
  mesh.renderOrder = DISC_RENDER_ORDER;
  mesh.visible = false;
  mesh.frustumCulled = false;

  return {
    object: mesh,

    claimSlot(): number {
      return slots.claim();
    },

    update(slot: number, disc: InterpolatedDisc, elapsed: number): void {
      elapsedNode.value = elapsed;
      mesh.visible = slots.update(slot, disc);
    },

    park(slot: number): void {
      mesh.visible = slots.park(slot);
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      slots.reset();
    },
  };
}
