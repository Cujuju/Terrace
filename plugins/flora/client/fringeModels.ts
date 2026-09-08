import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FLORA_FRINGE_CAP,
  FRINGE_CLUSTER_CELL_SPAN,
  FRINGE_SCALE_MAX,
  FRINGE_STEM_HEIGHT_SPREAD,
  FRINGE_STEM_JITTER_IN_SPANS,
  fringeKey,
  fringeStemOffsets,
  fringeStemVariation,
  type FringeCell,
  type FringeSpecies,
} from '../protocol.ts';
import {
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
  type PlacementExtent,
} from './instanceBounds.ts';

const cells = (n: number): number => n * CELL_WORLD_SIZE;

const CLUSTER_SPAN_IN_CELLS = FRINGE_CLUSTER_CELL_SPAN;

const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

const UP = new Vector3(0, 1, 0);
const BEND_AXIS = new Vector3(0, 0, 1);
const WIDTH_AXIS = new Vector3(0, 0, 1);

interface StemShape {
  readonly lengthInCells: number;
  readonly baseWidthInCells: number;
  readonly segments: number;
  readonly tipSegments: number;
  readonly archRadians: number;
  readonly taperExponent: number;
  readonly baseColor: number;
  readonly tipColor: number;
}

const REED: StemShape = {
  lengthInCells: 0.85,
  baseWidthInCells: 0.07,
  segments: 6,
  tipSegments: 2,
  archRadians: 0.18,
  taperExponent: 2.2,
  baseColor: 0x2f5d46,
  tipColor: 0xbfae74,
};

const HEATHER: StemShape = {
  lengthInCells: 0.3,
  baseWidthInCells: 0.06,
  segments: 5,
  tipSegments: 3,
  archRadians: 1.1,
  taperExponent: 1.2,
  baseColor: 0x4a5637,
  tipColor: 0x9a5fa8,
};

const SHAPES: Readonly<Record<FringeSpecies, StemShape>> = { reed: REED, heather: HEATHER };

export interface FringePlacement {
  readonly x: number;
  readonly z: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly species: FringeSpecies;
  readonly scale: number;
  readonly yaw: number;
}

export interface FringeModels {
  readonly root: Group;
  apply(placements: readonly FringePlacement[]): void;
  applyDelta(sprouted: readonly FringePlacement[], withered: readonly FringeCell[]): void;
  dispose(): void;
}

interface StemGeometries {
  readonly base: BufferGeometry;
  readonly tip: BufferGeometry;
  readonly horizontalReachInCells: number;
}

function triangleSoup(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildStem(shape: StemShape): StemGeometries {
  const segmentLength = cells(shape.lengthInCells) / shape.segments;
  const bendPerSegment = shape.archRadians / shape.segments;
  const halfBaseWidth = cells(shape.baseWidthInCells) / 2;

  const centres: Vector3[] = [new Vector3(0, 0, 0)];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  for (let i = 0; i < shape.segments; i++) {
    position.addScaledVector(direction, segmentLength);
    centres.push(position.clone());
    direction.applyAxisAngle(BEND_AXIS, -bendPerSegment).normalize();
  }

  const halfWidths: number[] = [];
  for (let i = 0; i <= shape.segments; i++) {
    const t = i / shape.segments;
    halfWidths.push(halfBaseWidth * Math.pow(1 - t, shape.taperExponent));
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

  const firstTipSegment = shape.segments - shape.tipSegments;
  for (let i = 0; i < shape.segments; i++) {
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
  for (let i = 0; i <= shape.segments; i++) {
    const reach = Math.hypot(centres[i]!.x, centres[i]!.z) + halfWidths[i]!;
    horizontalReach = Math.max(horizontalReach, reach);
  }

  return {
    base: triangleSoup(basePositions),
    tip: triangleSoup(tipPositions),
    horizontalReachInCells: horizontalReach / CELL_WORLD_SIZE,
  };
}

function plantingRadiusInSpans(species: FringeSpecies): number {
  let radius = 0;
  for (const [ox, oz] of fringeStemOffsets(species)) {
    radius = Math.max(radius, Math.hypot(ox, oz));
  }
  return radius;
}

function clusterSpreadInWorld(species: FringeSpecies): number {
  return (
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantingRadiusInSpans(species) + FRINGE_STEM_JITTER_IN_SPANS * Math.SQRT2)
  );
}

function assertStemFitsPlant(species: FringeSpecies, horizontalReachInCells: number): void {
  const worstInSpans =
    plantingRadiusInSpans(species) +
    FRINGE_STEM_JITTER_IN_SPANS * Math.SQRT2 +
    horizontalReachInCells / CLUSTER_SPAN_IN_CELLS;

  if (worstInSpans > SQUARE_CIRCUMRADIUS_PER_EDGE) {
    throw new RangeError(
      `a ${species} stem reaches ${worstInSpans.toFixed(3)} cluster spans from its plant centre, past the ${SQUARE_CIRCUMRADIUS_PER_EDGE.toFixed(3)} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, side: DoubleSide });
}

interface SpeciesMeshes {
  readonly base: InstancedMesh;
  readonly tip: InstancedMesh;
  readonly offsets: ReadonlyArray<readonly [number, number]>;
  readonly slotOfCell: Map<number, number>;
  readonly cellOfSlot: number[];
  readonly extent: PlacementExtent;
  readonly reaches: readonly [InstanceReach, InstanceReach];
  written: number;
}

const SPECIES: readonly FringeSpecies[] = ['reed', 'heather'];

export function createFringeModels(): FringeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const meshes: InstancedMesh[] = [];
  const bySpecies = {} as Record<FringeSpecies, SpeciesMeshes>;

  const root = new Group();
  root.name = 'flora:fringe';

  for (const species of SPECIES) {
    const shape = SHAPES[species];
    const built = buildStem(shape);
    assertStemFitsPlant(species, built.horizontalReachInCells);

    const offsets = fringeStemOffsets(species);
    const capacity = FLORA_FRINGE_CAP * offsets.length;

    const baseMaterial = lambert(shape.baseColor);
    const tipMaterial = lambert(shape.tipColor);
    const base = new InstancedMesh(built.base, baseMaterial, capacity);
    const tip = new InstancedMesh(built.tip, tipMaterial, capacity);
    base.name = `flora:fringe-${species}-base`;
    tip.name = `flora:fringe-${species}-tip`;

    geometries.push(built.base, built.tip);
    materials.push(baseMaterial, tipMaterial);
    meshes.push(base, tip);

    const spread = clusterSpreadInWorld(species);
    const reachOf = (geometry: BufferGeometry): InstanceReach =>
      scaledReach(
        clusteredReach(geometryReach(geometry), spread, 1 + FRINGE_STEM_HEIGHT_SPREAD),
        FRINGE_SCALE_MAX,
      );
    bySpecies[species] = {
      base,
      tip,
      offsets,
      slotOfCell: new Map(),
      cellOfSlot: [],
      extent: createPlacementExtent(),
      reaches: [reachOf(built.base), reachOf(built.tip)],
      written: 0,
    };

    base.count = 0;
    tip.count = 0;
    root.add(base);
    root.add(tip);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const plantRotation = new Quaternion();
  const stemRotation = new Quaternion();
  const stemScale = new Vector3();
  const stemPosition = new Vector3();
  const stemOffset = new Vector3();

  const plantCount = (): number => bySpecies.reed.written + bySpecies.heather.written;

  const writePlant = (target: SpeciesMeshes, slot: number, placement: FringePlacement): void => {
    position.set(placement.x, placement.groundY, placement.z);
    plantRotation.setFromAxisAngle(UP, placement.yaw);

    const clusterWidth = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

    let stemSlot = slot * target.offsets.length;
    for (let index = 0; index < target.offsets.length; index++) {
      const [ox, oz] = target.offsets[index]!;
      const stem = fringeStemVariation(placement.cellX, placement.cellY, index);

      stemOffset
        .set((ox + stem.jitterX) * clusterWidth, 0, (oz + stem.jitterZ) * clusterWidth)
        .applyQuaternion(plantRotation);
      stemPosition.copy(position).add(stemOffset);

      stemRotation.setFromAxisAngle(UP, stem.yaw);

      stemScale.set(placement.scale, placement.scale * stem.height, placement.scale);

      matrix.compose(stemPosition, stemRotation, stemScale);
      target.base.setMatrixAt(stemSlot, matrix);
      target.tip.setMatrixAt(stemSlot++, matrix);
    }

    includePlacement(target.extent, placement.x, placement.groundY, placement.z);
  };

  const moveInstances = (
    attribute: BufferAttribute,
    from: number,
    to: number,
    count: number,
  ): void => {
    attribute.array.copyWithin(
      to * MATRIX_FLOATS_PER_INSTANCE,
      from * MATRIX_FLOATS_PER_INSTANCE,
      (from + count) * MATRIX_FLOATS_PER_INSTANCE,
    );
  };

  const removeCell = (key: number): void => {
    for (const species of SPECIES) {
      const target = bySpecies[species];
      const slot = target.slotOfCell.get(key);
      if (slot === undefined) continue;
      target.slotOfCell.delete(key);

      const last = target.written - 1;
      const run = target.offsets.length;
      if (slot !== last) {
        moveInstances(target.base.instanceMatrix, last * run, slot * run, run);
        moveInstances(target.tip.instanceMatrix, last * run, slot * run, run);

        const movedKey = target.cellOfSlot[last]!;
        target.cellOfSlot[slot] = movedKey;
        target.slotOfCell.set(movedKey, slot);

        uploadInstanceRun(
          target.base.instanceMatrix,
          slot * run,
          run,
          MATRIX_FLOATS_PER_INSTANCE,
        );
        uploadInstanceRun(target.tip.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      }

      target.written = last;
      target.cellOfSlot.length = last;
      return;
    }
  };

  const addCell = (key: number, placement: FringePlacement): void => {
    const target = bySpecies[placement.species];
    const slot = target.written++;
    writePlant(target, slot, placement);
    target.slotOfCell.set(key, slot);
    target.cellOfSlot[slot] = key;

    const run = target.offsets.length;
    uploadInstanceRun(target.base.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    uploadInstanceRun(target.tip.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
  };

  const publish = (): void => {
    for (const species of SPECIES) {
      const target = bySpecies[species];
      const drawn = target.written * target.offsets.length;
      target.base.count = drawn;
      target.tip.count = drawn;
      writeInstanceSphere(target.base, target.extent, target.reaches[0]);
      writeInstanceSphere(target.tip, target.extent, target.reaches[1]);
    }
  };

  return {
    root,

    apply(placements: readonly FringePlacement[]): void {
      for (const species of SPECIES) {
        const target = bySpecies[species];
        target.slotOfCell.clear();
        target.cellOfSlot.length = 0;
        target.written = 0;
        clearPlacementExtent(target.extent);
      }

      for (const placement of placements) {
        if (plantCount() >= FLORA_FRINGE_CAP) break;
        addCell(fringeKey(placement.cellX, placement.cellY), placement);
      }

      publish();
      for (const mesh of meshes) {
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
      }
    },

    applyDelta(
      sprouted: readonly FringePlacement[],
      withered: readonly FringeCell[],
    ): void {
      for (const cell of withered) removeCell(fringeKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = fringeKey(placement.cellX, placement.cellY);
        removeCell(key);
        if (plantCount() >= FLORA_FRINGE_CAP) continue;
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
