import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  TetrahedronGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { weldFlatShaded } from '../../../client/src/render/weld.ts';
import {
  CROP_PLOT_CLUSTER_CELL_SPAN,
  CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  CROP_STALK_OFFSET_IN_CLUSTER_SPANS,
} from '../protocol.ts';

const cells = (n: number): number => n * CELL_WORLD_SIZE;

const IDENTITY_MATRIX = new Matrix4();

const CLUSTER_SPAN_IN_CELLS = CROP_PLOT_CLUSTER_CELL_SPAN;

const STALK_OFFSET_IN_CLUSTER_SPANS = CROP_STALK_OFFSET_IN_CLUSTER_SPANS;

const STEM_RADIAL_SEGMENTS = 5;
const EAR_RADIAL_SEGMENTS = 6;

const LEAVES_PER_STALK = 3;
const LEAF_DROOP_RADIANS = 0.95;
const LEAF_YAW_STEP_RADIANS = Math.PI * 0.7;
const BLADE_LENGTH_IN_CELLS = 0.085;
const BLADE_WIDTH_IN_CELLS = 0.016;
const BLADE_THICKNESS_IN_CELLS = 0.005;

const LEAF_HORIZONTAL_REACH_IN_CELLS =
  BLADE_LENGTH_IN_CELLS * Math.cos(LEAF_DROOP_RADIANS);

function assertClusterFitsBed(headHorizontalReachInCells: number, label: string): void {
  const plantedCornerInCells =
    (STALK_OFFSET_IN_CLUSTER_SPANS + CROP_STALK_JITTER_IN_CLUSTER_SPANS) *
    CLUSTER_SPAN_IN_CELLS *
    Math.SQRT2;
  const clusterReach = plantedCornerInCells + headHorizontalReachInCells;
  if (clusterReach > CLUSTER_SPAN_IN_CELLS / 2) {
    throw new RangeError(
      `${label} wheat stalks reach ${clusterReach} cells, past the ${CLUSTER_SPAN_IN_CELLS / 2}-cell edge of their own bed`,
    );
  }
}

function baked(source: BufferGeometry, local: Matrix4): BufferGeometry {
  const out = source.index === null ? source.clone() : source.toNonIndexed();
  out.applyMatrix4(local);
  return out;
}

function placePart(parts: BufferGeometry[], part: BufferGeometry, matrix: Matrix4): void {
  parts.push(baked(part, matrix));
}

function buildLeaves(stemHeightInCells: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const blade = new BoxGeometry(
    cells(BLADE_LENGTH_IN_CELLS),
    cells(BLADE_THICKNESS_IN_CELLS),
    cells(BLADE_WIDTH_IN_CELLS),
  );
  blade.translate(cells(BLADE_LENGTH_IN_CELLS) / 2, 0, 0);

  const scratchMatrix = new Matrix4();
  const scratchQuat = new Quaternion();
  for (let i = 0; i < LEAVES_PER_STALK; i++) {
    const attachFraction = 0.35 + (i / (LEAVES_PER_STALK - 1)) * 0.3;
    scratchQuat.setFromEuler(
      new Euler(-LEAF_DROOP_RADIANS, i * LEAF_YAW_STEP_RADIANS, 0, 'YXZ'),
    );
    placePart(
      parts,
      blade,
      scratchMatrix.compose(
        new Vector3(0, cells(stemHeightInCells * attachFraction), 0),
        scratchQuat.clone(),
        new Vector3(1, 1, 1),
      ),
    );
  }
  blade.dispose();
  return parts;
}

function mergeAndDispose(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  merged.deleteAttribute('uv');
  return weldFlatShaded(merged);
}

export interface WheatStalkGeometries {
  readonly stalk: BufferGeometry;
  readonly ear: BufferGeometry;
}

const BOTANICAL_STEM_SEGMENTS = 3;
const BOTANICAL_SEGMENT_LENGTH_IN_CELLS = 0.105;
const BOTANICAL_STEM_BASE_RADIUS_IN_CELLS = 0.017;
const BOTANICAL_STEM_TOP_RADIUS_IN_CELLS = 0.010;
const BOTANICAL_NODE_KINK_RADIANS = 0.06;
const BOTANICAL_NODE_RING_OVERHANG = 1.35;
const BOTANICAL_NODE_RING_HEIGHT_IN_CELLS = 0.012;

const BOTANICAL_EAR_LENGTH_IN_CELLS = 0.12;
const BOTANICAL_EAR_RADIUS_IN_CELLS = 0.02;
const BOTANICAL_EAR_TIP_TAPER = 0.25;
const BOTANICAL_GRAIN_RANKS = 2;
const BOTANICAL_GRAIN_PAIRS = 8;
const BOTANICAL_GRAIN_SIZE_IN_CELLS = 0.013;
const BOTANICAL_GRAIN_ELONGATION = 2.0;
const BOTANICAL_GRAIN_FLATTENING = 0.55;
const BOTANICAL_GRAIN_TILT_RADIANS = 0.5;
const BOTANICAL_AWN_COUNT = 6;
const BOTANICAL_AWN_LENGTH_IN_CELLS = 0.09;
const BOTANICAL_AWN_THICKNESS_IN_CELLS = 0.004;
const BOTANICAL_AWN_FAN_RADIANS = 0.5;
const BOTANICAL_HEAD_NOD_RADIANS = 0.35;
const BOTANICAL_HEAD_YAW_RADIANS = Math.PI * 0.35;

function buildBotanicalWheat(): WheatStalkGeometries {
  const stemHeight =
    BOTANICAL_STEM_SEGMENTS * BOTANICAL_SEGMENT_LENGTH_IN_CELLS;
  const earLength = BOTANICAL_EAR_LENGTH_IN_CELLS;

  const m = new Matrix4();
  const q = new Quaternion();

  const stalkParts: BufferGeometry[] = [...buildLeaves(stemHeight)];
  let cursorY = 0;
  let cursorTilt = 0;
  for (let seg = 0; seg < BOTANICAL_STEM_SEGMENTS; seg++) {
    const tBase = seg / BOTANICAL_STEM_SEGMENTS;
    const tTop = (seg + 1) / BOTANICAL_STEM_SEGMENTS;
    const rBase =
      BOTANICAL_STEM_BASE_RADIUS_IN_CELLS +
      (BOTANICAL_STEM_TOP_RADIUS_IN_CELLS - BOTANICAL_STEM_BASE_RADIUS_IN_CELLS) * tBase;
    const rTop =
      BOTANICAL_STEM_BASE_RADIUS_IN_CELLS +
      (BOTANICAL_STEM_TOP_RADIUS_IN_CELLS - BOTANICAL_STEM_BASE_RADIUS_IN_CELLS) * tTop;
    const segment = new CylinderGeometry(
      cells(rTop), cells(rBase),
      cells(BOTANICAL_SEGMENT_LENGTH_IN_CELLS),
      STEM_RADIAL_SEGMENTS, 1, true,
    );
    q.setFromEuler(new Euler(cursorTilt, 0, 0));
    placePart(
      stalkParts,
      segment,
      m.compose(new Vector3(0, cells(cursorY + BOTANICAL_SEGMENT_LENGTH_IN_CELLS / 2), 0), q, new Vector3(1, 1, 1)),
    );
    segment.dispose();

    if (seg < BOTANICAL_STEM_SEGMENTS - 1) {
      const ring = new CylinderGeometry(
        cells(rTop * BOTANICAL_NODE_RING_OVERHANG), cells(rTop * BOTANICAL_NODE_RING_OVERHANG),
        cells(BOTANICAL_NODE_RING_HEIGHT_IN_CELLS),
        STEM_RADIAL_SEGMENTS, 1, true,
      );
      placePart(
        stalkParts,
        ring,
        m.compose(
          new Vector3(0, cells(cursorY + BOTANICAL_SEGMENT_LENGTH_IN_CELLS), 0),
          new Quaternion(),
          new Vector3(1, 1, 1),
        ),
      );
      ring.dispose();
    }

    cursorY += BOTANICAL_SEGMENT_LENGTH_IN_CELLS;
    cursorTilt += BOTANICAL_NODE_KINK_RADIANS;
  }

  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(BOTANICAL_EAR_RADIUS_IN_CELLS * BOTANICAL_EAR_TIP_TAPER),
    cells(BOTANICAL_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  const grain = new OctahedronGeometry(cells(BOTANICAL_GRAIN_SIZE_IN_CELLS));
  const grainScale = new Vector3(1, BOTANICAL_GRAIN_ELONGATION, BOTANICAL_GRAIN_FLATTENING);
  for (let pair = 0; pair < BOTANICAL_GRAIN_PAIRS; pair++) {
    const alongEar =
      cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) +
      (pair / BOTANICAL_GRAIN_PAIRS) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - BOTANICAL_EAR_TIP_TAPER);
    const rankRadius = cells(BOTANICAL_EAR_RADIUS_IN_CELLS) * taper;
    for (let rank = 0; rank < BOTANICAL_GRAIN_RANKS; rank++) {
      const angle = Math.PI * rank + Math.PI / BOTANICAL_GRAIN_RANKS;
      q.setFromEuler(new Euler(-BOTANICAL_GRAIN_TILT_RADIANS, angle, 0, 'YXZ'));
      placePart(
        earParts,
        grain,
        m.compose(
          new Vector3(
            Math.cos(angle) * (rankRadius + cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) * 0.5),
            alongEar,
            Math.sin(angle) * (rankRadius + cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) * 0.5),
          ),
          q,
          grainScale,
        ),
      );
    }
  }
  grain.dispose();

  const awn = new BoxGeometry(
    cells(BOTANICAL_AWN_THICKNESS_IN_CELLS),
    cells(BOTANICAL_AWN_LENGTH_IN_CELLS),
    cells(BOTANICAL_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(BOTANICAL_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < BOTANICAL_AWN_COUNT; a++) {
    const fanT = a / (BOTANICAL_AWN_COUNT - 1);
    q.setFromEuler(new Euler(
      BOTANICAL_AWN_FAN_RADIANS * 0.5 + BOTANICAL_AWN_FAN_RADIANS * fanT * 0.3,
      fanT * BOTANICAL_AWN_FAN_RADIANS * 2,
      0, 'YXZ',
    ));
    placePart(
      earParts,
      awn,
      m.compose(
        new Vector3(0, cells(earLength * 0.9), 0),
        q,
        new Vector3(1, 1, 1),
      ),
    );
  }
  awn.dispose();

  const headPivot = new Matrix4()
    .makeTranslation(0, cells(cursorY), 0)
    .multiply(
      new Matrix4().makeRotationFromEuler(
        new Euler(BOTANICAL_HEAD_NOD_RADIANS, BOTANICAL_HEAD_YAW_RADIANS, 0, 'YXZ'),
      ),
    );
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    Math.max(
      LEAF_HORIZONTAL_REACH_IN_CELLS,
      earLength * Math.sin(BOTANICAL_HEAD_NOD_RADIANS),
    ),
    'botanical',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

const BEARDED_STEM_HEIGHT_IN_CELLS = 0.26;
const BEARDED_STEM_BASE_RADIUS_IN_CELLS = 0.018;
const BEARDED_STEM_TOP_RADIUS_IN_CELLS = 0.011;

const BEARDED_EAR_LENGTH_IN_CELLS = 0.095;
const BEARDED_EAR_RADIUS_IN_CELLS = 0.026;
const BEARDED_EAR_TIP_TAPER = 0.45;
const BEARDED_KERNEL_WHORLS = 4;
const BEARDED_KERNELS_PER_WHORL = 6;
const BEARDED_KERNEL_SIZE_IN_CELLS = 0.012;

const BEARDED_AWN_COUNT = 12;
const BEARDED_AWN_LENGTH_IN_CELLS = 0.14;
const BEARDED_AWN_THICKNESS_IN_CELLS = 0.0035;
const BEARDED_AWN_FAN_ARC_RADIANS = Math.PI * 1.6;
const BEARDED_AWN_LEAN_RADIANS = 0.55;

function buildBeardedBarley(): WheatStalkGeometries {
  const earLength = BEARDED_EAR_LENGTH_IN_CELLS;
  const m = new Matrix4();
  const q = new Quaternion();

  const stalkParts: BufferGeometry[] = [...buildLeaves(BEARDED_STEM_HEIGHT_IN_CELLS)];
  const stem = new CylinderGeometry(
    cells(BEARDED_STEM_TOP_RADIUS_IN_CELLS), cells(BEARDED_STEM_BASE_RADIUS_IN_CELLS),
    cells(BEARDED_STEM_HEIGHT_IN_CELLS), STEM_RADIAL_SEGMENTS, 1, true,
  );
  stem.translate(0, cells(BEARDED_STEM_HEIGHT_IN_CELLS) / 2, 0);
  placePart(stalkParts, stem, IDENTITY_MATRIX);
  stem.dispose();

  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(BEARDED_EAR_RADIUS_IN_CELLS * BEARDED_EAR_TIP_TAPER),
    cells(BEARDED_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  const kernel = new TetrahedronGeometry(cells(BEARDED_KERNEL_SIZE_IN_CELLS));
  for (let w = 0; w < BEARDED_KERNEL_WHORLS; w++) {
    const alongEar =
      cells(BEARDED_KERNEL_SIZE_IN_CELLS) +
      (w / (BEARDED_KERNEL_WHORLS - 1)) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - BEARDED_EAR_TIP_TAPER);
    const whorlRadius = cells(BEARDED_EAR_RADIUS_IN_CELLS) * taper;
    for (let k = 0; k < BEARDED_KERNELS_PER_WHORL; k++) {
      const angle =
        (Math.PI * 2 * k) / BEARDED_KERNELS_PER_WHORL +
        (w % 2) * (Math.PI / BEARDED_KERNELS_PER_WHORL);
      q.setFromEuler(new Euler((w % 2 ? 1 : -1) * 0.6, angle, 0, 'YXZ'));
      placePart(
        earParts,
        kernel,
        m.compose(
          new Vector3(
            Math.cos(angle) * (whorlRadius + cells(BEARDED_KERNEL_SIZE_IN_CELLS) * 0.35),
            alongEar,
            Math.sin(angle) * (whorlRadius + cells(BEARDED_KERNEL_SIZE_IN_CELLS) * 0.35),
          ),
          q,
          new Vector3(1, 1.4, 1),
        ),
      );
    }
  }
  kernel.dispose();

  const awn = new BoxGeometry(
    cells(BEARDED_AWN_THICKNESS_IN_CELLS),
    cells(BEARDED_AWN_LENGTH_IN_CELLS),
    cells(BEARDED_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(BEARDED_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < BEARDED_AWN_COUNT; a++) {
    const around = (Math.PI * 2 * a) / BEARDED_AWN_COUNT;
    const fan = Math.sin(a * 2.4);
    q.setFromEuler(new Euler(
      BEARDED_AWN_LEAN_RADIANS * (0.4 + 0.6 * Math.abs(fan)),
      around,
      0, 'YXZ',
    ));
    placePart(
      earParts,
      awn,
      m.compose(
        new Vector3(0, cells(earLength * 0.75), 0),
        q,
        new Vector3(1, 1, 1),
      ),
    );
  }
  awn.dispose();

  const beardedNodRadians = 0.25;
  const headPivot = new Matrix4()
    .makeTranslation(0, cells(BEARDED_STEM_HEIGHT_IN_CELLS), 0)
    .multiply(new Matrix4().makeRotationFromEuler(new Euler(beardedNodRadians, Math.PI * 0.2, 0, 'YXZ')));
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    Math.max(
      LEAF_HORIZONTAL_REACH_IN_CELLS,
      BEARDED_AWN_LENGTH_IN_CELLS *
        Math.sin(beardedNodRadians + BEARDED_AWN_LEAN_RADIANS),
    ),
    'bearded',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

const HEAVY_STEM_SEGMENTS = 4;
const HEAVY_SEGMENT_LENGTH_IN_CELLS = 0.075;
const HEAVY_STEM_BASE_RADIUS_IN_CELLS = 0.019;
const HEAVY_STEM_TOP_RADIUS_IN_CELLS = 0.011;
const HEAVY_BEND_PER_SEGMENT_RADIANS = 0.075;

const HEAVY_EAR_LENGTH_IN_CELLS = 0.105;
const HEAVY_EAR_RADIUS_IN_CELLS = 0.024;
const HEAVY_EAR_TIP_TAPER = 0.3;
const HEAVY_KERNEL_WHORLS = 4;
const HEAVY_KERNELS_PER_WHORL = 6;
const HEAVY_KERNEL_SIZE_IN_CELLS = 0.015;
const HEAVY_KERNEL_ELONGATION = 1.7;
const HEAVY_HEAD_NOD_RADIANS = 0.22;
const HEAVY_HEAD_YAW_RADIANS = Math.PI * 0.3;
const HEAVY_AWN_COUNT = 5;
const HEAVY_AWN_LENGTH_IN_CELLS = 0.05;
const HEAVY_AWN_THICKNESS_IN_CELLS = 0.004;

function buildHarvestWheat(): WheatStalkGeometries {
  const earLength = HEAVY_EAR_LENGTH_IN_CELLS;
  const stemHeight = HEAVY_STEM_SEGMENTS * HEAVY_SEGMENT_LENGTH_IN_CELLS;
  const m = new Matrix4();
  const q = new Quaternion();

  const stalkParts: BufferGeometry[] = [];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  let cumulativeBend = 0;
  for (let seg = 0; seg < HEAVY_STEM_SEGMENTS; seg++) {
    const tBase = seg / HEAVY_STEM_SEGMENTS;
    const rBase =
      HEAVY_STEM_BASE_RADIUS_IN_CELLS +
      (HEAVY_STEM_TOP_RADIUS_IN_CELLS - HEAVY_STEM_BASE_RADIUS_IN_CELLS) * tBase;
    const rTop =
      HEAVY_STEM_BASE_RADIUS_IN_CELLS +
      (HEAVY_STEM_TOP_RADIUS_IN_CELLS - HEAVY_STEM_BASE_RADIUS_IN_CELLS) * ((seg + 1) / HEAVY_STEM_SEGMENTS);
    const segment = new CylinderGeometry(
      cells(rTop), cells(rBase),
      cells(HEAVY_SEGMENT_LENGTH_IN_CELLS),
      STEM_RADIAL_SEGMENTS, 1, true,
    );
    q.setFromUnitVectors(new Vector3(0, 1, 0), direction);
    const mid = position.clone().addScaledVector(direction, cells(HEAVY_SEGMENT_LENGTH_IN_CELLS) / 2);
    placePart(stalkParts, segment, m.compose(mid, q, new Vector3(1, 1, 1)));
    segment.dispose();

    position.addScaledVector(direction, cells(HEAVY_SEGMENT_LENGTH_IN_CELLS));
    cumulativeBend += HEAVY_BEND_PER_SEGMENT_RADIANS;
    direction.applyAxisAngle(new Vector3(0, 0, 1), -HEAVY_BEND_PER_SEGMENT_RADIANS).normalize();
  }

  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(HEAVY_EAR_RADIUS_IN_CELLS * HEAVY_EAR_TIP_TAPER),
    cells(HEAVY_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  const kernel = new OctahedronGeometry(cells(HEAVY_KERNEL_SIZE_IN_CELLS));
  const kernelScale = new Vector3(1, HEAVY_KERNEL_ELONGATION, 1.1);
  for (let w = 0; w < HEAVY_KERNEL_WHORLS; w++) {
    const alongEar =
      cells(HEAVY_KERNEL_SIZE_IN_CELLS) +
      (w / (HEAVY_KERNEL_WHORLS - 1)) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - HEAVY_EAR_TIP_TAPER);
    const whorlRadius = cells(HEAVY_EAR_RADIUS_IN_CELLS) * taper;
    for (let k = 0; k < HEAVY_KERNELS_PER_WHORL; k++) {
      const angle =
        (Math.PI * 2 * k) / HEAVY_KERNELS_PER_WHORL +
        (w % 2) * (Math.PI / HEAVY_KERNELS_PER_WHORL);
      placePart(
        earParts,
        kernel,
        m.compose(
          new Vector3(
            Math.cos(angle) * (whorlRadius + cells(HEAVY_KERNEL_SIZE_IN_CELLS) * 0.4),
            alongEar,
            Math.sin(angle) * (whorlRadius + cells(HEAVY_KERNEL_SIZE_IN_CELLS) * 0.4),
          ),
          q.identity(),
          kernelScale,
        ),
      );
    }
  }
  kernel.dispose();

  const awn = new BoxGeometry(
    cells(HEAVY_AWN_THICKNESS_IN_CELLS),
    cells(HEAVY_AWN_LENGTH_IN_CELLS),
    cells(HEAVY_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(HEAVY_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < HEAVY_AWN_COUNT; a++) {
    const around = (Math.PI * 2 * a) / HEAVY_AWN_COUNT;
    q.setFromEuler(new Euler(0.3, around, 0, 'YXZ'));
    placePart(
      earParts,
      awn,
      m.compose(new Vector3(0, cells(earLength * 0.95), 0), q, new Vector3(1, 1, 1)),
    );
  }
  awn.dispose();

  const headPivot = new Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(
      new Matrix4().makeRotationFromEuler(
        new Euler(cumulativeBend + HEAVY_HEAD_NOD_RADIANS, HEAVY_HEAD_YAW_RADIANS, 0, 'YXZ'),
      ),
    );
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    Math.abs(position.x) / CELL_WORLD_SIZE +
      earLength * Math.sin(cumulativeBend + HEAVY_HEAD_NOD_RADIANS),
    'harvest',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

export const WHEAT_VARIANT_BUILDERS: ReadonlyArray<() => WheatStalkGeometries> = [
  buildBotanicalWheat,
  buildBeardedBarley,
  buildHarvestWheat,
];

export const WHEAT_VARIANT_NAMES: ReadonlyArray<string> = [
  'Botanical',
  'Bearded barley',
  'Harvest-heavy',
];

export const SHIPPED_WHEAT_VARIANT = 2;
