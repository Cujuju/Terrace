import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FLORA_GRASS_CAP,
  GRASS_BLADES_PER_TUFT,
  GRASS_BLADE_HEIGHT_SPREAD,
  GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
  GRASS_BLADE_OFFSETS,
  GRASS_SCALE_MAX,
  GRASS_TUFT_CLUSTER_CELL_SPAN,
  grassBladeVariation,
  grassFlowerOf,
  grassKey,
  type GrassCell,
} from '../protocol.ts';
import {
  COLOR_FLOATS_PER_INSTANCE,
  MATRIX_FLOATS_PER_INSTANCE,
  clearPlacementExtent,
  clusteredReach,
  createPlacementExtent,
  geometryReach,
  includePlacement,
  scaledReach,
  uploadAllInstances,
  uploadInstanceRun,
  writeInstanceSphere,
  type InstanceReach,
} from './instanceBounds.ts';

const cells = (n: number): number => n * CELL_WORLD_SIZE;

const CLUSTER_SPAN_IN_CELLS = GRASS_TUFT_CLUSTER_CELL_SPAN;

const BLADE_COLOR = 0x3f7a26;
const TIP_COLOR = 0xc8e07a;

const BLADE_LENGTH_IN_CELLS = 0.5;

const BLADE_BASE_WIDTH_IN_CELLS = 0.09;

const BLADE_SEGMENTS = 3;

const BLADE_TIP_SEGMENTS = 1;

const BLADE_ARCH_RADIANS = 0.7;

const BLADE_TAPER_EXPONENT = 1.6;

const FLOWER_COLORS: readonly number[] = [
  0xf2e9c4,
  0xe8c25a,
  0xd98ab0,
  0x9d8ad6,
  0xe0704f,
];

const BLOSSOM_RADIUS_IN_CELLS = BLADE_LENGTH_IN_CELLS / 8;

const BLOSSOM_EYE_FRACTION = 0.3;

const BLOSSOM_PETAL_COUNT = 5;

const BLOSSOM_PETAL_FILL = 0.62;

const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

const UP = new Vector3(0, 1, 0);
const BEND_AXIS = new Vector3(0, 0, 1);
const WIDTH_AXIS = new Vector3(0, 0, 1);

export interface GrassPlacement {
  readonly x: number;
  readonly z: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface GrassModels {
  readonly root: Group;
  apply(placements: readonly GrassPlacement[]): void;
  applyDelta(sprouted: readonly GrassPlacement[], withered: readonly GrassCell[]): void;
  dispose(): void;
}

interface BladeGeometries {
  readonly blade: BufferGeometry;
  readonly tip: BufferGeometry;
  readonly horizontalReachInCells: number;
  readonly tipCentre: Vector3;
}

function triangleSoup(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildBlade(): BladeGeometries {
  const segmentLength = cells(BLADE_LENGTH_IN_CELLS) / BLADE_SEGMENTS;
  const bendPerSegment = BLADE_ARCH_RADIANS / BLADE_SEGMENTS;
  const halfBaseWidth = cells(BLADE_BASE_WIDTH_IN_CELLS) / 2;

  const centres: Vector3[] = [new Vector3(0, 0, 0)];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    position.addScaledVector(direction, segmentLength);
    centres.push(position.clone());
    direction.applyAxisAngle(BEND_AXIS, -bendPerSegment).normalize();
  }

  const halfWidths: number[] = [];
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const t = i / BLADE_SEGMENTS;
    halfWidths.push(halfBaseWidth * Math.pow(1 - t, BLADE_TAPER_EXPONENT));
  }

  const left = (i: number): Vector3 =>
    centres[i]!.clone().addScaledVector(WIDTH_AXIS, halfWidths[i]!);
  const right = (i: number): Vector3 =>
    centres[i]!.clone().addScaledVector(WIDTH_AXIS, -halfWidths[i]!);

  const basePositions: number[] = [];
  const tipPositions: number[] = [];
  const push = (into: number[], ...points: Vector3[]): void => {
    for (const point of points) into.push(point.x, point.y, point.z);
  };

  const firstTipSegment = BLADE_SEGMENTS - BLADE_TIP_SEGMENTS;
  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    const into = i >= firstTipSegment ? tipPositions : basePositions;
    const l0 = left(i);
    const r0 = right(i);
    const l1 = left(i + 1);
    const r1 = right(i + 1);
    if (halfWidths[i + 1] === 0) {
      push(into, l0, r0, l1);
    } else {
      push(into, l0, r0, l1);
      push(into, r0, r1, l1);
    }
  }

  let horizontalReach = 0;
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const reach = Math.hypot(centres[i]!.x, centres[i]!.z) + halfWidths[i]!;
    horizontalReach = Math.max(horizontalReach, reach);
  }

  return {
    blade: triangleSoup(basePositions),
    tip: triangleSoup(tipPositions),
    horizontalReachInCells: horizontalReach / CELL_WORLD_SIZE,
    tipCentre: centres[BLADE_SEGMENTS]!.clone(),
  };
}

interface BlossomGeometry {
  readonly geometry: BufferGeometry;
  readonly horizontalReachInCells: number;
}

function buildBlossom(tipCentre: Vector3): BlossomGeometry {
  const outer = cells(BLOSSOM_RADIUS_IN_CELLS);
  const inner = outer * BLOSSOM_EYE_FRACTION;
  const half = ((Math.PI * 2) / BLOSSOM_PETAL_COUNT) * BLOSSOM_PETAL_FILL * 0.5;

  const positions: number[] = [];
  const at = (radius: number, angle: number): Vector3 =>
    new Vector3(
      tipCentre.x + radius * Math.cos(angle),
      tipCentre.y,
      tipCentre.z + radius * Math.sin(angle),
    );

  for (let i = 0; i < BLOSSOM_PETAL_COUNT; i++) {
    const centre = ((Math.PI * 2) * i) / BLOSSOM_PETAL_COUNT;
    const i0 = at(inner, centre - half);
    const i1 = at(inner, centre + half);
    const o0 = at(outer, centre - half);
    const o1 = at(outer, centre + half);
    for (const point of [i0, o0, o1, i0, o1, i1]) {
      positions.push(point.x, point.y, point.z);
    }
  }

  return {
    geometry: triangleSoup(positions),
    horizontalReachInCells:
      (Math.hypot(tipCentre.x, tipCentre.z) + outer) / CELL_WORLD_SIZE,
  };
}

function plantingRadiusInSpans(): number {
  let radius = 0;
  for (const [ox, oz] of GRASS_BLADE_OFFSETS) {
    radius = Math.max(radius, Math.hypot(ox, oz));
  }
  return radius;
}

function clusterSpreadInWorld(): number {
  return (
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantingRadiusInSpans() + GRASS_BLADE_JITTER_IN_CLUSTER_SPANS * Math.SQRT2)
  );
}

function assertBladeFitsTuft(horizontalReachInCells: number): void {
  const worstInSpans =
    plantingRadiusInSpans() +
    GRASS_BLADE_JITTER_IN_CLUSTER_SPANS * Math.SQRT2 +
    horizontalReachInCells / CLUSTER_SPAN_IN_CELLS;

  if (worstInSpans > SQUARE_CIRCUMRADIUS_PER_EDGE) {
    throw new RangeError(
      `a grass blade reaches ${worstInSpans.toFixed(3)} cluster spans from its tuft centre, past the ${SQUARE_CIRCUMRADIUS_PER_EDGE.toFixed(3)} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, side: DoubleSide });
}

export function createGrassModels(): GrassModels {
  const built = buildBlade();
  const blossom = buildBlossom(built.tipCentre);
  assertBladeFitsTuft(Math.max(built.horizontalReachInCells, blossom.horizontalReachInCells));

  const geometries: BufferGeometry[] = [built.blade, built.tip, blossom.geometry];
  const materials: Material[] = [lambert(BLADE_COLOR), lambert(TIP_COLOR), lambert(0xffffff)];

  const bladeCapacity = FLORA_GRASS_CAP * GRASS_BLADES_PER_TUFT;
  const blades = new InstancedMesh(built.blade, materials[0], bladeCapacity);
  const tips = new InstancedMesh(built.tip, materials[1], bladeCapacity);

  const blossoms = new InstancedMesh(blossom.geometry, materials[2], FLORA_GRASS_CAP);
  const blossomColors = new InstancedBufferAttribute(
    new Float32Array(FLORA_GRASS_CAP * COLOR_FLOATS_PER_INSTANCE),
    COLOR_FLOATS_PER_INSTANCE,
  );
  blossoms.instanceColor = blossomColors;

  const meshes = [blades, tips, blossoms];
  blades.name = 'flora:grass-blades';
  tips.name = 'flora:grass-tips';
  blossoms.name = 'flora:grass-blossoms';

  const flowerColors = FLOWER_COLORS.map((hex) => new Color(hex));

  const root = new Group();
  root.name = 'flora:grass';
  for (const mesh of meshes) {
    mesh.count = 0;
    root.add(mesh);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const tuftRotation = new Quaternion();
  const bladeRotation = new Quaternion();
  const bladeScale = new Vector3();
  const bladePosition = new Vector3();
  const bladeOffset = new Vector3();

  const NO_BLOSSOM = -1;

  const slotOfCell = new Map<number, number>();
  const cellOfSlot: number[] = [];
  const blossomOfSlot: number[] = [];
  const tuftOfBlossom: number[] = [];

  let tuftCount = 0;
  let blossomCount = 0;

  const extent = createPlacementExtent();

  const spread = clusterSpreadInWorld();
  const reachOf = (geometry: BufferGeometry): InstanceReach =>
    scaledReach(
      clusteredReach(geometryReach(geometry), spread, 1 + GRASS_BLADE_HEIGHT_SPREAD),
      GRASS_SCALE_MAX,
    );
  const reaches: InstanceReach[] = geometries.map(reachOf);

  const writeTuft = (
    slot: number,
    placement: GrassPlacement,
    blossomSlot: number,
  ): boolean => {
    const flower = grassFlowerOf(placement.cellX, placement.cellY);
    let flowered = false;

    position.set(placement.x, placement.groundY, placement.z);
    tuftRotation.setFromAxisAngle(UP, placement.yaw);

    const clusterWidth = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

    let blade = slot * GRASS_BLADES_PER_TUFT;
    for (let index = 0; index < GRASS_BLADES_PER_TUFT; index++) {
      const [ox, oz] = GRASS_BLADE_OFFSETS[index]!;
      const variation = grassBladeVariation(placement.cellX, placement.cellY, index);

      bladeOffset
        .set((ox + variation.jitterX) * clusterWidth, 0, (oz + variation.jitterZ) * clusterWidth)
        .applyQuaternion(tuftRotation);
      bladePosition.copy(position).add(bladeOffset);

      bladeRotation.setFromAxisAngle(UP, variation.yaw);

      bladeScale.set(placement.scale, placement.scale * variation.height, placement.scale);

      matrix.compose(bladePosition, bladeRotation, bladeScale);
      blades.setMatrixAt(blade, matrix);
      tips.setMatrixAt(blade++, matrix);

      if (flower !== null && flower.bladeIndex === index) {
        blossoms.setMatrixAt(blossomSlot, matrix);
        const color = flowerColors[Math.floor((flower.tintRoll / 256) * flowerColors.length)]!;
        blossoms.setColorAt(blossomSlot, color);
        flowered = true;
      }
    }

    includePlacement(extent, placement.x, placement.groundY, placement.z);
    return flowered;
  };

  const moveInstances = (
    attribute: BufferAttribute,
    from: number,
    to: number,
    count: number,
    floatsPerInstance: number,
  ): void => {
    attribute.array.copyWithin(
      to * floatsPerInstance,
      from * floatsPerInstance,
      (from + count) * floatsPerInstance,
    );
  };

  const removeBlossom = (slot: number): void => {
    const last = blossomCount - 1;
    if (slot !== last) {
      moveInstances(blossoms.instanceMatrix, last, slot, 1, MATRIX_FLOATS_PER_INSTANCE);
      moveInstances(blossomColors, last, slot, 1, COLOR_FLOATS_PER_INSTANCE);
      const owner = tuftOfBlossom[last]!;
      tuftOfBlossom[slot] = owner;
      blossomOfSlot[owner] = slot;
      uploadInstanceRun(blossoms.instanceMatrix, slot, 1, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(blossomColors, slot, 1, COLOR_FLOATS_PER_INSTANCE);
    }
    blossomCount = last;
    tuftOfBlossom.length = last;
  };

  const removeCell = (key: number): void => {
    const slot = slotOfCell.get(key);
    if (slot === undefined) return;
    slotOfCell.delete(key);

    const blossom = blossomOfSlot[slot]!;
    if (blossom !== NO_BLOSSOM) removeBlossom(blossom);

    const last = tuftCount - 1;
    if (slot !== last) {
      const run = GRASS_BLADES_PER_TUFT;
      moveInstances(blades.instanceMatrix, last * run, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      moveInstances(tips.instanceMatrix, last * run, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);

      const movedKey = cellOfSlot[last]!;
      cellOfSlot[slot] = movedKey;
      slotOfCell.set(movedKey, slot);
      const movedBlossom = blossomOfSlot[last]!;
      blossomOfSlot[slot] = movedBlossom;
      if (movedBlossom !== NO_BLOSSOM) tuftOfBlossom[movedBlossom] = slot;

      uploadInstanceRun(blades.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(tips.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    }

    tuftCount = last;
    cellOfSlot.length = last;
    blossomOfSlot.length = last;
  };

  const addCell = (key: number, placement: GrassPlacement): void => {
    if (tuftCount >= FLORA_GRASS_CAP) return;
    const slot = tuftCount++;
    const flowered = writeTuft(slot, placement, blossomCount);

    slotOfCell.set(key, slot);
    cellOfSlot[slot] = key;
    blossomOfSlot[slot] = flowered ? blossomCount : NO_BLOSSOM;
    if (flowered) {
      tuftOfBlossom[blossomCount] = slot;
      uploadInstanceRun(blossoms.instanceMatrix, blossomCount, 1, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(blossomColors, blossomCount, 1, COLOR_FLOATS_PER_INSTANCE);
      blossomCount++;
    }

    const run = GRASS_BLADES_PER_TUFT;
    uploadInstanceRun(blades.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    uploadInstanceRun(tips.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
  };

  const publish = (): void => {
    blades.count = tuftCount * GRASS_BLADES_PER_TUFT;
    tips.count = blades.count;
    blossoms.count = blossomCount;
    for (let i = 0; i < meshes.length; i++) {
      writeInstanceSphere(meshes[i]!, extent, reaches[i]!);
    }
  };

  return {
    root,

    apply(placements: readonly GrassPlacement[]): void {
      slotOfCell.clear();
      cellOfSlot.length = 0;
      blossomOfSlot.length = 0;
      tuftOfBlossom.length = 0;
      tuftCount = 0;
      blossomCount = 0;
      clearPlacementExtent(extent);

      for (const placement of placements) {
        if (tuftCount >= FLORA_GRASS_CAP) break;
        const key = grassKey(placement.cellX, placement.cellY);
        const slot = tuftCount++;
        const flowered = writeTuft(slot, placement, blossomCount);
        slotOfCell.set(key, slot);
        cellOfSlot[slot] = key;
        blossomOfSlot[slot] = flowered ? blossomCount : NO_BLOSSOM;
        if (flowered) tuftOfBlossom[blossomCount++] = slot;
      }

      publish();
      uploadAllInstances(blades.instanceMatrix, blades.count, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(tips.instanceMatrix, tips.count, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(blossoms.instanceMatrix, blossomCount, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(blossomColors, blossomCount, COLOR_FLOATS_PER_INSTANCE);
    },

    applyDelta(
      sprouted: readonly GrassPlacement[],
      withered: readonly GrassCell[],
    ): void {
      for (const cell of withered) removeCell(grassKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = grassKey(placement.cellX, placement.cellY);
        removeCell(key);
        addCell(key, placement);
      }
      publish();
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
