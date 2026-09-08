import {
  AdditiveBlending,
  NormalBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type ColorRepresentation,
} from 'three';
import {
  CELL_WORLD_SIZE,
  LASER_BOLT_LENGTH_CELLS,
  LASER_BOLT_LIFETIME_SECONDS,
  LASER_BOLT_SPEED_CELLS_PER_SECOND,
  MAX_LASER_BOLTS,
  MAX_SAUCERS_PER_ENCOUNTER,
} from '../protocol.ts';
import { spliceShader } from '../../../client/src/render/shaderSplice.ts';

function worldUnitsAcross(cells: number): number {
  return cells * CELL_WORLD_SIZE;
}

const scratchDirection = new Vector3();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchMatrix = new Matrix4();
const scratchColor = new Color();

const CYLINDER_AXIS = new Vector3(0, 1, 0);

const UNIT_SCALE = new Vector3(1, 1, 1);

const SHADER_COMMON_ANCHOR = '#include <common>';
const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';
const ALPHATEST_FRAGMENT_ANCHOR = '#include <alphatest_fragment>';

const INSTANCED_ALPHA_VERTEX_DECLARATIONS =  `varying float vInstancedAlpha;
attribute float instancedAlpha;`;
const INSTANCED_ALPHA_FRAGMENT_DECLARATIONS =  `varying float vInstancedAlpha;`;
const INSTANCED_ALPHA_ASSIGN =  `vInstancedAlpha = instancedAlpha;`;
const INSTANCED_ALPHA_APPLY =  `diffuseColor.a *= vInstancedAlpha;`;

function addInstancedAlpha(
  geometry: BufferGeometry,
  material: MeshBasicMaterial,
  capacity: number,
  label: string,
): InstancedBufferAttribute {
  const alpha = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  alpha.setUsage(DynamicDrawUsage);
  geometry.setAttribute('instancedAlpha', alpha);

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${INSTANCED_ALPHA_VERTEX_DECLARATIONS}`,
        label,
      ),
      BEGIN_VERTEX_ANCHOR,
      `${BEGIN_VERTEX_ANCHOR}\n    ${INSTANCED_ALPHA_ASSIGN}`,
      label,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${INSTANCED_ALPHA_FRAGMENT_DECLARATIONS}`,
        label,
      ),
      ALPHATEST_FRAGMENT_ANCHOR,
      `${ALPHATEST_FRAGMENT_ANCHOR}\n    ${INSTANCED_ALPHA_APPLY}`,
      label,
    );
  };
  const stockCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${stockCacheKey()}|instancedAlpha:${label}`;

  return alpha;
}

const BOLT_RADIUS_CELLS = 0.2;

const BOLT_FADE_START_FRACTION = 0.7;

const BOLT_INTENSITY = 2;

const BOLT_RADIAL_SEGMENTS = 6;

const BOLT_OVERSHOOT_CELLS = LASER_BOLT_LENGTH_CELLS;

export interface LaserPool {
  readonly root: Group;
  begin(): void;
  draw(from: Vector3, aim: Vector3, age: number, colour: ColorRepresentation): void;
  dispose(): void;
}

export function createLaserPool(): LaserPool {
  const boltRadius = worldUnitsAcross(BOLT_RADIUS_CELLS);
  const boltLength = worldUnitsAcross(LASER_BOLT_LENGTH_CELLS);
  const geometry = new CylinderGeometry(
    boltRadius,
    boltRadius,
    boltLength,
    BOLT_RADIAL_SEGMENTS,
    1,
    true,
  );
  geometry.translate(0, boltLength / 2, 0);

  const root = new Group();
  root.name = 'saucers:bolts';

  const material = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const instancedAlpha = addInstancedAlpha(geometry, material, MAX_LASER_BOLTS, 'saucers:bolts');

  const mesh = new InstancedMesh(geometry, material, MAX_LASER_BOLTS);
  mesh.name = 'saucers:bolts:pool';
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  root.add(mesh);

  let next = 0;

  return {
    root,
    begin(): void {
      mesh.count = 0;
      next = 0;
    },
    draw(from: Vector3, aim: Vector3, age: number, colour: ColorRepresentation): void {
      if (next >= MAX_LASER_BOLTS) return;

      scratchDirection.subVectors(aim, from);
      const distance = scratchDirection.length();
      if (distance <= 0) return;
      scratchDirection.divideScalar(distance);

      const head = worldUnitsAcross(LASER_BOLT_SPEED_CELLS_PER_SECOND) * age;
      if (head > distance + worldUnitsAcross(BOLT_OVERSHOOT_CELLS)) return;
      const tail = Math.max(0, head - worldUnitsAcross(LASER_BOLT_LENGTH_CELLS));

      const index = next;
      next++;

      scratchPosition.copy(from).addScaledVector(scratchDirection, tail);
      scratchQuaternion.setFromUnitVectors(CYLINDER_AXIS, scratchDirection);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, UNIT_SCALE);
      mesh.setMatrixAt(index, scratchMatrix);

      scratchColor.set(colour).multiplyScalar(BOLT_INTENSITY);
      mesh.setColorAt(index, scratchColor);

      const life = Math.min(1, Math.max(0, age / LASER_BOLT_LIFETIME_SECONDS));
      const opacity =
        life < BOLT_FADE_START_FRACTION ? 1 : (1 - life) / (1 - BOLT_FADE_START_FRACTION);
      instancedAlpha.setX(index, opacity);

      mesh.count = next;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      instancedAlpha.needsUpdate = true;
    },
    dispose(): void {
      material.dispose();
      geometry.dispose();
      mesh.dispose();
      root.clear();
    },
  };
}

export const BURST_SECONDS = 2;

const BURST_MAX_RADIUS_CELLS = 8;

const CORE_MAX_RADIUS_CELLS = 4;
const CORE_SECONDS_FRACTION = 0.35;
const CORE_COLOUR = 0xffffff;

const BURST_FADE_EXPONENT = 0.5;

const BURST_RADIAL_SEGMENTS = 16;
const BURST_HEIGHT_SEGMENTS = 12;

const BURST_COLOUR = 0xffa03c;

const BURST_SHARD_COUNT = 24;

const SHARD_REACH_CELLS = 12;
const SHARD_RISE_CELLS = 6;

const SHARD_SIZE_PIXELS = 5;

const SHARD_BEARINGS: readonly { readonly x: number; readonly z: number; readonly lift: number }[] =
  Array.from({ length: BURST_SHARD_COUNT }, (_unused, index) => {
    const angle = (index * 2 * Math.PI) / BURST_SHARD_COUNT;
    return {
      x: Math.cos(angle),
      z: Math.sin(angle),
      lift: index % 3 === 0 ? 1 : index % 3 === 1 ? 0.7 : 0.45,
    };
  });

interface BurstShards {
  readonly points: Points;
  readonly geometry: BufferGeometry;
  readonly material: PointsMaterial;
}

export interface CrashBursts {
  readonly root: Group;
  begin(): void;
  show(x: number, groundY: number, z: number, age: number): void;
  dispose(): void;
}

const BURST_POOL_SIZE = MAX_SAUCERS_PER_ENCOUNTER;

export function createCrashBursts(): CrashBursts {
  const root = new Group();
  root.name = 'saucers:bursts';

  const sphere = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);

  const ballMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const ball = new InstancedMesh(sphere, ballMaterial, BURST_POOL_SIZE);
  ball.name = 'saucers:bursts:ball';
  ball.count = 0;
  ball.instanceMatrix.setUsage(DynamicDrawUsage);
  ball.frustumCulled = false;
  root.add(ball);

  const coreMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const core = new InstancedMesh(sphere, coreMaterial, BURST_POOL_SIZE);
  core.name = 'saucers:bursts:core';
  core.count = 0;
  core.instanceMatrix.setUsage(DynamicDrawUsage);
  core.frustumCulled = false;
  root.add(core);

  const shards: BurstShards[] = [];
  for (let index = 0; index < BURST_POOL_SIZE; index++) {
    const shardGeometry = new BufferGeometry();
    shardGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(BURST_SHARD_COUNT * 3), 3),
    );
    const shardMaterial = new PointsMaterial({
      color: BURST_COLOUR,
      size: SHARD_SIZE_PIXELS,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const points = new Points(shardGeometry, shardMaterial);
    points.name = `saucers:burst:shards:${index}`;
    points.visible = false;
    root.add(points);
    shards.push({ points, geometry: shardGeometry, material: shardMaterial });
  }

  let next = 0;

  return {
    root,
    begin(): void {
      ball.count = 0;
      core.count = 0;
      for (const shard of shards) shard.points.visible = false;
      next = 0;
    },
    show(x: number, groundY: number, z: number, age: number): void {
      const t = age / BURST_SECONDS;
      if (t < 0 || t >= 1) return;
      if (next >= BURST_POOL_SIZE) return;
      const index = next;
      next++;
      const shard = shards[index]!;

      const grow = Math.sqrt(t);
      scratchScale.setScalar(worldUnitsAcross(BURST_MAX_RADIUS_CELLS) * grow);
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, groundY, z);
      ball.setMatrixAt(index, scratchMatrix);
      scratchColor.set(BURST_COLOUR).multiplyScalar(Math.pow(1 - t, BURST_FADE_EXPONENT));
      ball.setColorAt(index, scratchColor);
      ball.count = next;

      const coreT = Math.min(1, t / CORE_SECONDS_FRACTION);
      scratchScale.setScalar(worldUnitsAcross(CORE_MAX_RADIUS_CELLS) * Math.sqrt(coreT));
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, groundY, z);
      core.setMatrixAt(index, scratchMatrix);
      scratchColor.set(CORE_COLOUR).multiplyScalar(1 - coreT);
      core.setColorAt(index, scratchColor);
      core.count = next;

      shard.points.visible = true;
      shard.points.position.set(x, groundY, z);
      const positions = shard.geometry.getAttribute('position') as BufferAttribute;
      for (let i = 0; i < SHARD_BEARINGS.length; i++) {
        const bearing = SHARD_BEARINGS[i]!;
        const reach = worldUnitsAcross(SHARD_REACH_CELLS) * t;
        const rise = worldUnitsAcross(SHARD_RISE_CELLS) * bearing.lift * (t * (2 - 2 * t));
        positions.setXYZ(i, bearing.x * reach, rise, bearing.z * reach);
      }
      positions.needsUpdate = true;
      shard.material.opacity = 1 - t;

      ball.instanceMatrix.needsUpdate = true;
      ball.instanceColor!.needsUpdate = true;
      core.instanceMatrix.needsUpdate = true;
      core.instanceColor!.needsUpdate = true;
    },
    dispose(): void {
      ballMaterial.dispose();
      coreMaterial.dispose();
      ball.dispose();
      core.dispose();
      for (const shard of shards) {
        shard.material.dispose();
        shard.geometry.dispose();
      }
      sphere.dispose();
      root.clear();
    },
  };
}

export const SPLASH_SECONDS = 1.5;

const PLUME_HEIGHT_CELLS = 12;
const PLUME_RADIUS_CELLS = 4;

const RING_MAX_RADIUS_CELLS = BURST_MAX_RADIUS_CELLS;
const RING_TUBE_CELLS = 0.6;
const RING_RADIAL_SEGMENTS = 6;
const RING_TUBULAR_SEGMENTS = 32;

const SPLASH_COLOUR = 0xe8f4ff;

export interface CrashSplashes {
  readonly root: Group;
  begin(): void;
  show(x: number, surfaceY: number, z: number, age: number): void;
  dispose(): void;
}

const SPLASH_POOL_SIZE = MAX_SAUCERS_PER_ENCOUNTER;

export function createCrashSplashes(): CrashSplashes {
  const root = new Group();
  root.name = 'saucers:splashes';

  const sphere = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);
  sphere.translate(0, 1, 0);
  const ringGeometry = new TorusGeometry(1, worldUnitsAcross(RING_TUBE_CELLS), RING_RADIAL_SEGMENTS, RING_TUBULAR_SEGMENTS);
  ringGeometry.rotateX(Math.PI / 2);

  const plumeMaterial = new MeshBasicMaterial({
    color: SPLASH_COLOUR,
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const plumeAlpha = addInstancedAlpha(sphere, plumeMaterial, SPLASH_POOL_SIZE, 'saucers:splashes:plume');
  const plume = new InstancedMesh(sphere, plumeMaterial, SPLASH_POOL_SIZE);
  plume.name = 'saucers:splashes:plume';
  plume.count = 0;
  plume.instanceMatrix.setUsage(DynamicDrawUsage);
  plume.frustumCulled = false;
  root.add(plume);

  const ringMaterial = new MeshBasicMaterial({
    color: SPLASH_COLOUR,
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const ringAlpha = addInstancedAlpha(ringGeometry, ringMaterial, SPLASH_POOL_SIZE, 'saucers:splashes:ring');
  const ring = new InstancedMesh(ringGeometry, ringMaterial, SPLASH_POOL_SIZE);
  ring.name = 'saucers:splashes:ring';
  ring.count = 0;
  ring.instanceMatrix.setUsage(DynamicDrawUsage);
  ring.frustumCulled = false;
  root.add(ring);

  let next = 0;

  return {
    root,
    begin(): void {
      plume.count = 0;
      ring.count = 0;
      next = 0;
    },
    show(x: number, surfaceY: number, z: number, age: number): void {
      const t = age / SPLASH_SECONDS;
      if (t < 0 || t >= 1) return;
      if (next >= SPLASH_POOL_SIZE) return;
      const index = next;
      next++;

      const arc = t * (2 - 2 * t);
      scratchScale.set(
        worldUnitsAcross(PLUME_RADIUS_CELLS) * (0.5 + 0.5 * t),
        worldUnitsAcross(PLUME_HEIGHT_CELLS) * arc,
        worldUnitsAcross(PLUME_RADIUS_CELLS) * (0.5 + 0.5 * t),
      );
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, surfaceY, z);
      plume.setMatrixAt(index, scratchMatrix);
      plumeAlpha.setX(index, 1 - t * t);
      plume.count = next;

      const spread = Math.sqrt(t);
      scratchScale.set(
        worldUnitsAcross(RING_MAX_RADIUS_CELLS) * spread,
        1,
        worldUnitsAcross(RING_MAX_RADIUS_CELLS) * spread,
      );
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, surfaceY, z);
      ring.setMatrixAt(index, scratchMatrix);
      ringAlpha.setX(index, 1 - t);
      ring.count = next;

      plume.instanceMatrix.needsUpdate = true;
      plumeAlpha.needsUpdate = true;
      ring.instanceMatrix.needsUpdate = true;
      ringAlpha.needsUpdate = true;
    },
    dispose(): void {
      plumeMaterial.dispose();
      ringMaterial.dispose();
      plume.dispose();
      ring.dispose();
      sphere.dispose();
      ringGeometry.dispose();
      root.clear();
    },
  };
}

export const LASER_POOL_DRAW_OBJECTS = 1;
const BURST_INSTANCED_DRAW_OBJECTS = 2;
export const BURST_DRAW_OBJECTS = BURST_INSTANCED_DRAW_OBJECTS + BURST_POOL_SIZE;
export const SPLASH_DRAW_OBJECTS = 2;
