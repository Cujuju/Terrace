import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  type BufferGeometry,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { SEA_SURFACE_WORLD_Y } from '../../../client/src/config.ts';
import {
  assertAssetFits,
  loadRigAsset,
  type AssetFootprint,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { STRUCTURES_CAP } from '../protocol.ts';
import {
  SKIFF_HULL_AUTHORED_BEAM_WORLD_UNITS,
  SKIFF_HULL_AUTHORED_LENGTH_WORLD_UNITS,
  SKIFF_MAX_PER_SETTLEMENT,
  SKIFF_MODEL_SCALE,
  SKIFF_ORBIT_PERIOD_SECONDS,
  type SkiffPlacement,
} from './skiffs.ts';

const FULL_TURN_RADIANS = Math.PI * 2;
const MATRIX_ELEMENT_COUNT = 16;

const SKIFF_FLOAT_WORLD_Y = SEA_SURFACE_WORLD_Y;

const SKIFF_BOB_AMPLITUDE_AUTHORED_WORLD_UNITS = 0.006;

const SKIFF_BOB_AMPLITUDE_DRAWN_WORLD_UNITS =
  SKIFF_BOB_AMPLITUDE_AUTHORED_WORLD_UNITS * SKIFF_MODEL_SCALE;
const SKIFF_BOB_PERIOD_SECONDS = 2.6;

const SKIFF_FOOTPRINT: AssetFootprint = {
  x: SKIFF_HULL_AUTHORED_LENGTH_WORLD_UNITS,
  z: SKIFF_HULL_AUTHORED_BEAM_WORLD_UNITS,
};

const SKIFF_FIT_TOLERANCE_WORLD_UNITS = 0.001;

const SKIFF_FORWARD_AXIS_YAW_RADIANS = -Math.PI / 2;

const SKIFF_INSTANCE_CAPACITY = STRUCTURES_CAP * SKIFF_MAX_PER_SETTLEMENT;

interface SkiffKit {
  readonly asset: RigAsset;
  readonly geometry: BufferGeometry;
  readonly waterlineLift: number;
  readonly reachWorldUnits: number;
}

let kit: SkiffKit | null = null;

export async function preloadSkiffModels(url: string): Promise<void> {
  installSkiffKit(await loadRigAsset(url, null));
}

export function installSkiffKit(asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  const waterline = asset.anchor('waterline');
  const dryline = asset.anchor('dryline');
  const soleDryClearance = dryline.y - waterline.y;
  if (soleDryClearance < SKIFF_BOB_AMPLITUDE_AUTHORED_WORLD_UNITS) {
    throw new Error(
      `skiff asset: the sole clears the waterline by ${soleDryClearance.toFixed(4)} world ` +
        `units, less than the authored bob amplitude ${SKIFF_BOB_AMPLITUDE_AUTHORED_WORLD_UNITS} — the sea ` +
        `would render inside the hull at the bottom of every bob cycle. Raise ` +
        `tools/blender/build_skiff.py's FLOOR_HEIGHT_FRACTION (and its ` +
        `SOLE_DRY_CLEARANCE_MIN) or lower SKIFF_BOB_AMPLITUDE_AUTHORED_WORLD_UNITS.`,
    );
  }

  const meshes: Mesh[] = [];
  asset.scene.traverse((child) => {
    if ((child as Partial<Mesh>).isMesh === true) meshes.push(child as Mesh);
  });
  if (meshes.length !== 1) {
    throw new Error(
      `skiff asset: expected exactly one mesh, found ${meshes.length} — ` +
        `the fleet draws through a single InstancedMesh`,
    );
  }
  const geometry = meshes[0].geometry;
  if (geometry.getAttribute('color') === undefined) {
    throw new Error('skiff asset: the hull mesh carries no vertex-colour attribute');
  }

  assertAssetFits(asset, SKIFF_FOOTPRINT, SKIFF_FIT_TOLERANCE_WORLD_UNITS);

  geometry.rotateY(SKIFF_FORWARD_AXIS_YAW_RADIANS);
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;

  disposeSkiffKit();
  kit = {
    asset,
    geometry,
    waterlineLift: -waterline.y * SKIFF_MODEL_SCALE,
    reachWorldUnits: (sphere === null ? 0 : sphere.center.length() + sphere.radius) * SKIFF_MODEL_SCALE,
  };
}

export function disposeSkiffKit(): void {
  kit?.asset.dispose();
  kit = null;
}

export interface SkiffModels {
  readonly root: Group;
  apply(placements: readonly SkiffPlacement[]): void;
  animate(dt: number): void;
  dispose(): void;
}

export function createSkiffModels(): SkiffModels {
  const installed = kit;
  if (installed === null) {
    throw new Error(
      'createSkiffModels: no skiff asset installed — preloadSkiffModels (or installSkiffKit) runs first',
    );
  }
  const { geometry, waterlineLift, reachWorldUnits } = installed;

  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const root = new Group();
  root.name = 'structures:skiffs';
  const mesh = new InstancedMesh(geometry, material, SKIFF_INSTANCE_CAPACITY);
  mesh.count = 0;
  root.add(mesh);

  let current: readonly SkiffPlacement[] = [];
  let elapsedSeconds = 0;

  const instanceMatrix = new Matrix4();
  const elements = instanceMatrix.elements;
  elements[1] = 0;
  elements[3] = 0;
  elements[4] = 0;
  elements[5] = SKIFF_MODEL_SCALE;
  elements[6] = 0;
  elements[7] = 0;
  elements[9] = 0;
  elements[11] = 0;
  elements[15] = 1;

  function writeFrame(): void {
    let count = 0;
    for (const skiff of current) {
      const t = elapsedSeconds + skiff.phaseSeconds;
      const dirSign = skiff.orbitClockwise ? 1 : -1;
      const angle = (t / SKIFF_ORBIT_PERIOD_SECONDS) * FULL_TURN_RADIANS * dirSign;
      const worldX = skiff.x * CELL_WORLD_SIZE + Math.sin(angle) * skiff.orbitRadius;
      const worldZ = skiff.z * CELL_WORLD_SIZE + Math.cos(angle) * skiff.orbitRadius;
      const bob =
        Math.sin((t / SKIFF_BOB_PERIOD_SECONDS) * FULL_TURN_RADIANS) *
        SKIFF_BOB_AMPLITUDE_DRAWN_WORLD_UNITS;
      const worldY = SKIFF_FLOAT_WORLD_Y + waterlineLift + bob;

      const yawSin = dirSign * Math.cos(angle);
      const yawCos = -dirSign * Math.sin(angle);

      elements[0] = yawCos * SKIFF_MODEL_SCALE;
      elements[2] = -yawSin * SKIFF_MODEL_SCALE;
      elements[8] = yawSin * SKIFF_MODEL_SCALE;
      elements[10] = yawCos * SKIFF_MODEL_SCALE;
      elements[12] = worldX;
      elements[13] = worldY;
      elements[14] = worldZ;
      mesh.setMatrixAt(count++, instanceMatrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * MATRIX_ELEMENT_COUNT);
    mesh.instanceMatrix.needsUpdate = true;
  }

  function refreshBoundingSphere(): void {
    const sphere = (mesh.boundingSphere ??= new Sphere());
    if (current.length === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const skiff of current) {
      const anchorX = skiff.x * CELL_WORLD_SIZE;
      const anchorZ = skiff.z * CELL_WORLD_SIZE;
      minX = Math.min(minX, anchorX - skiff.orbitRadius);
      maxX = Math.max(maxX, anchorX + skiff.orbitRadius);
      minZ = Math.min(minZ, anchorZ - skiff.orbitRadius);
      maxZ = Math.max(maxZ, anchorZ + skiff.orbitRadius);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    sphere.center.set(centerX, SKIFF_FLOAT_WORLD_Y + waterlineLift, centerZ);
    sphere.radius =
      Math.hypot(maxX - centerX, maxZ - centerZ) +
      SKIFF_BOB_AMPLITUDE_DRAWN_WORLD_UNITS +
      reachWorldUnits;
  }

  return {
    root,

    apply(placements: readonly SkiffPlacement[]): void {
      current = placements;
      writeFrame();
      refreshBoundingSphere();
    },

    animate(dt: number): void {
      elapsedSeconds += dt;
      if (current.length > 0) writeFrame();
    },

    dispose(): void {
      mesh.dispose();
      material.dispose();
      root.clear();
    },
  };
}
