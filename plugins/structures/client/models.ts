import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type InstancedBufferAttribute,
  type Material,
} from 'three';
import {
  assertAssetFits,
  loadRigAsset,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { flattenAssetParts } from '../../../client/src/render/staticAsset.ts';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURES_CAP,
  STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS,
  STRUCTURE_SURVEYED_GROUND_RADIUS,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_TIER_COUNT,
  type SettlerRace,
  type StructureTier,
} from '../protocol.ts';
import { isDurandsCell } from './durands.ts';
import { FISHING_HUT_BUILDERS, fishingHutVariantIndex } from './fishingHuts.ts';
import {
  fitToRadius,
  mergeParts,
  mergeSharedSurface,
  partsStandingHeight,
  type StructurePart,
} from './parts.ts';
import type { SiteKind } from './site.ts';

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

export const STRUCTURE_FOOTPRINT_RADIUS =
  STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS / 2 / STRUCTURE_SCALE_MAX;

function lambert(color: number, options: { emissive?: number } = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: options.emissive ?? 0x000000 });
}

const IMPORTED_STRUCTURE_TIER = 2;

const TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS = 1.84;

const IMPORTED_STRUCTURE_FOOTPRINT_WORLD_UNITS = {
  x: STRUCTURE_FOOTPRINT_RADIUS * 2,
  z: STRUCTURE_FOOTPRINT_RADIUS * 2,
  y: TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS,
};

let importedBuildingAsset: RigAsset | null = null;

export async function preloadStructureModels(url: string): Promise<void> {
  installStructureAsset(await loadRigAsset(url, null));
}

export function installStructureAsset(asset: RigAsset): void {
  try {
    assertAssetFits(asset, IMPORTED_STRUCTURE_FOOTPRINT_WORLD_UNITS);
  } catch (cause) {
    throw new Error(
      `structure asset: the model breaks the footprint contract — a building must stand ` +
        `strictly over the ground the server surveys for it (see STRUCTURE_FOOTPRINT_RADIUS)`,
      { cause },
    );
  }
  importedBuildingAsset?.dispose();
  importedBuildingAsset = asset;
}

function importedStructureParts(): StructurePart[] | null {
  if (importedBuildingAsset === null) return null;
  const owned = flattenAssetParts(importedBuildingAsset).map((part) => ({
    geometry: part.geometry.clone(),
    material: part.material.clone(),
    localMatrices: part.localMatrices.map((local) => local.clone()),
  }));
  return fitToRadius(owned, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX);
}

const FULL_TURN_RADIANS = Math.PI * 2;

function circleRingMatrices(
  count: number,
  radius: number,
  y: number,
  faceOutward: boolean,
  startAngleRadians = 0,
): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngleRadians + (FULL_TURN_RADIANS * i) / count;
    const position = new Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
    const rotation = faceOutward ? new Quaternion().setFromAxisAngle(Y_AXIS, angle) : new Quaternion();
    matrices.push(new Matrix4().compose(position, rotation, new Vector3(1, 1, 1)));
  }
  return matrices;
}

const WINDOW_GLOW_COLOR = 0xffcf7a;
const WINDOW_FRAME_COLOR = 0x2a1c10;
const WINDOW_EMISSIVE_INTENSITY = 0.5;

function windowMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({
    color: WINDOW_FRAME_COLOR,
    flatShading: true,
    emissive: WINDOW_GLOW_COLOR,
    emissiveIntensity: WINDOW_EMISSIVE_INTENSITY,
  });
}

function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

const TRIANGLE_PRISM_HALF_BASE = Math.sqrt(3) / 2;
const TRIANGLE_PRISM_HEIGHT = 1.5;
const TRIANGLE_PRISM_BASE_FRACTION = 0.5 / TRIANGLE_PRISM_HEIGHT;

const TRIANGLE_PRISM_LIE_FLAT = new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

function trianglePrismMatrix(
  halfBase: number,
  rise: number,
  thickness: number,
  baseY: number,
  z: number,
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(0, baseY + rise * TRIANGLE_PRISM_BASE_FRACTION, z),
    TRIANGLE_PRISM_LIE_FLAT,
    new Vector3(halfBase / TRIANGLE_PRISM_HALF_BASE, thickness, rise / TRIANGLE_PRISM_HEIGHT),
  );
}

interface GableRoof {
  readonly slopeLength: number;
  readonly panelLength: number;
  readonly panelMatrices: Matrix4[];
  readonly endMatrices: Matrix4[];
  readonly ridgeCapMatrices: Matrix4[];
  readonly ridgeY: number;
  readonly courseMatrices: Matrix4[];
  readonly courseSlopeLength: number;
}

const GABLE_END_THICKNESS = 0.04;
const ROOF_COURSES_PER_PANEL = 4;
const ROOF_COURSE_JOINT_FRACTION = 0.14;
const ROOF_COURSE_PROUD = 0.012;
const ROOF_COURSE_THICKNESS = 0.02;
const GABLE_PANEL_THICKNESS = 0.05;
const GABLE_RIDGE_CAP_HALF_WIDTH = 0.035;
const GABLE_RIDGE_CAP_HEIGHT = 0.045;

function gableRoof(
  halfSpan: number,
  ridgeRise: number,
  wallTopY: number,
  halfLength: number,
  wallHalfLength: number,
  ridgeAlongX: boolean,
): GableRoof {
  const slopeLength = Math.hypot(halfSpan, ridgeRise);
  const panelMatrices: Matrix4[] = [];
  const courseMatrices: Matrix4[] = [];
  for (const sign of [1, -1] as const) {
    const angle = Math.atan2(-ridgeRise, sign * halfSpan);
    const rotation = new Quaternion().setFromAxisAngle(Z_AXIS, angle);
    const center = new Vector3((sign * halfSpan) / 2, wallTopY + ridgeRise / 2, 0);
    panelMatrices.push(new Matrix4().compose(center, rotation, new Vector3(1, 1, 1)));

    const slopeDirection = new Vector3(Math.cos(angle), Math.sin(angle), 0);
    const panelNormal = new Vector3(-Math.sin(angle), Math.cos(angle), 0);
    if (panelNormal.y < 0) panelNormal.negate();
    const courseCenterOffset = GABLE_PANEL_THICKNESS / 2 + ROOF_COURSE_PROUD;
    for (let course = 0; course < ROOF_COURSES_PER_PANEL; course++) {
      const alongSlope = -slopeLength / 2 + (slopeLength * (course + 0.5)) / ROOF_COURSES_PER_PANEL;
      const position = center
        .clone()
        .addScaledVector(slopeDirection, alongSlope)
        .addScaledVector(panelNormal, courseCenterOffset);
      courseMatrices.push(new Matrix4().compose(position, rotation.clone(), new Vector3(1, 1, 1)));
    }
  }

  const endMatrices = [wallHalfLength, -wallHalfLength].map((z) =>
    trianglePrismMatrix(halfSpan, ridgeRise, GABLE_END_THICKNESS, wallTopY, z),
  );

  const ridgeCapMatrices = [at(0, wallTopY + ridgeRise - GABLE_RIDGE_CAP_HEIGHT / 2, 0)];

  if (ridgeAlongX) {
    const quarterTurn = new Matrix4().makeRotationY(Math.PI / 2);
    for (const list of [panelMatrices, endMatrices, ridgeCapMatrices, courseMatrices]) {
      for (const matrix of list) matrix.premultiply(quarterTurn);
    }
  }

  return {
    slopeLength,
    panelLength: halfLength * 2,
    panelMatrices,
    endMatrices,
    ridgeCapMatrices,
    ridgeY: wallTopY + ridgeRise,
    courseMatrices,
    courseSlopeLength: (slopeLength / ROOF_COURSES_PER_PANEL) * (1 - ROOF_COURSE_JOINT_FRACTION),
  };
}

function segmentMatrix(from: Vector3, to: Vector3, unitLength: number): Matrix4 {
  const direction = new Vector3().subVectors(to, from);
  const length = direction.length();
  const midpoint = new Vector3().addVectors(from, to).multiplyScalar(0.5);
  const rotation = new Quaternion().setFromUnitVectors(Y_AXIS, direction.normalize());
  return new Matrix4().compose(midpoint, rotation, new Vector3(1, length / unitLength, 1));
}

const STONE_SHADE_COLORS: readonly [number, number, number] = [0x9c968c, 0x8b8b86, 0x76736c];

const STONE_MORTAR_COLOR = 0x55524c;

function stoneMaterial(shadeIndex: number): MeshLambertMaterial {
  return lambert(STONE_SHADE_COLORS[shadeIndex]);
}

interface StoneBlock {
  readonly matrix: Matrix4;
  readonly shadeIndex: number;
}

const STONE_JOINT_FRACTION = 0.06;

function stoneBlocksForFace(
  faceHalfWidth: number,
  wallHeight: number,
  courseCount: number,
  fixedAxis: 'x' | 'z',
  fixedValue: number,
  targetBlockWidth: number,
): StoneBlock[] {
  const faceWidth = faceHalfWidth * 2;
  const columnCount = Math.max(2, Math.round(faceWidth / targetBlockWidth));
  const slotWidth = faceWidth / columnCount;
  const rowHeight = wallHeight / courseCount;
  const blockHeight = rowHeight * (1 - STONE_JOINT_FRACTION);
  const rotation = new Quaternion().setFromAxisAngle(Y_AXIS, fixedAxis === 'x' ? Math.PI / 2 : 0);

  const blocks: StoneBlock[] = [];
  for (let course = 0; course < courseCount; course++) {
    const staggered = course % 2 === 1;
    const y = rowHeight * (course + 0.5);
    const slots: Array<[number, number]> = [];
    if (staggered) {
      slots.push([-faceHalfWidth + slotWidth / 4, slotWidth / 2]);
      for (let column = 0; column < columnCount - 1; column++) {
        slots.push([-faceHalfWidth + slotWidth * (column + 1), slotWidth]);
      }
      slots.push([faceHalfWidth - slotWidth / 4, slotWidth / 2]);
    } else {
      for (let column = 0; column < columnCount; column++) {
        slots.push([-faceHalfWidth + slotWidth * (column + 0.5), slotWidth]);
      }
    }
    slots.forEach(([across, width], column) => {
      const position =
        fixedAxis === 'z' ? new Vector3(across, y, fixedValue) : new Vector3(fixedValue, y, across);
      blocks.push({
        matrix: new Matrix4().compose(
          position,
          rotation,
          new Vector3(width * (1 - STONE_JOINT_FRACTION), blockHeight, 1),
        ),
        shadeIndex: (course + column) % STONE_SHADE_COLORS.length,
      });
    });
  }
  return blocks;
}

function angularDistance(a: number, b: number): number {
  const wrapped = ((a - b + Math.PI) % FULL_TURN_RADIANS + FULL_TURN_RADIANS) % FULL_TURN_RADIANS;
  return Math.abs(wrapped - Math.PI);
}

function stonePartsByShade(blocks: readonly StoneBlock[], geometry: BufferGeometry): StructurePart[] {
  return STONE_SHADE_COLORS.map((_, shadeIndex) => ({
    geometry,
    material: stoneMaterial(shadeIndex),
    localMatrices: blocks.filter((block) => block.shadeIndex === shadeIndex).map((block) => block.matrix),
  }));
}

function roofCoursesPart(gable: GableRoof, color: number): StructurePart {
  return {
    geometry: new BoxGeometry(gable.courseSlopeLength, ROOF_COURSE_THICKNESS, gable.panelLength),
    material: lambert(color),
    localMatrices: gable.courseMatrices,
  };
}

const DOOR_FRAME_BAR = 0.028;
const DOOR_FRAME_LINTEL_OVERHANG = 0.012;

function doorFrameMatrices(width: number, height: number, x: number, baseY: number, z: number): Matrix4[] {
  const jambX = width / 2 + DOOR_FRAME_BAR / 2;
  const jambScale = new Vector3(DOOR_FRAME_BAR, height, DOOR_FRAME_BAR);
  const lintelScale = new Vector3(width + 2 * (DOOR_FRAME_BAR + DOOR_FRAME_LINTEL_OVERHANG), DOOR_FRAME_BAR, DOOR_FRAME_BAR);
  const identity = new Quaternion();
  return [
    new Matrix4().compose(new Vector3(x - jambX, baseY + height / 2, z), identity, jambScale),
    new Matrix4().compose(new Vector3(x + jambX, baseY + height / 2, z), identity, jambScale),
    new Matrix4().compose(
      new Vector3(x, baseY + height + DOOR_FRAME_BAR / 2, z),
      identity,
      lintelScale,
    ),
  ];
}

function unitBoxGeometry(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

function buildTierParts(): StructurePart[][] {
  const tiers: StructurePart[][] = [];

  {
    const TENT_RADIUS = 0.24;
    const tentHeight = 0.5;
    const tentX = -0.13;
    const tent: StructurePart = {
      geometry: new ConeGeometry(TENT_RADIUS, tentHeight, 8),
      material: lambert(0xcbb994),
      localMatrices: [at(tentX, tentHeight / 2, 0)],
    };

    const TEEPEE_DOOR_HALF_BASE = 0.085;
    const TEEPEE_DOOR_RISE = 0.24;
    const TEEPEE_DOOR_DEPTH = 0.02;
    const TEEPEE_DOOR_PROUD_MARGIN = 0.012;
    const teepeeDoorTopRadius = TENT_RADIUS * (1 - TEEPEE_DOOR_RISE / tentHeight);
    const doorZ = teepeeDoorTopRadius + TEEPEE_DOOR_PROUD_MARGIN;
    const teepeeDoor: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x241708),
      localMatrices: [
        trianglePrismMatrix(TEEPEE_DOOR_HALF_BASE, TEEPEE_DOOR_RISE, TEEPEE_DOOR_DEPTH, 0, doorZ).premultiply(
          at(tentX, 0, 0),
        ),
      ],
    };

    const TEEPEE_POLE_RADIUS = 0.011;
    const TEEPEE_POLE_UNIT_LENGTH = 0.1;
    const TEEPEE_POLE_FOOT_RADIUS = TENT_RADIUS + 0.05;
    const TEEPEE_POLE_CROSS_HEIGHT = tentHeight + 0.14;
    const TEEPEE_POLE_CROSS_SPREAD = 0.05;
    const TEEPEE_POLE_COUNT = 3;
    const lodgepoleMatrices: Matrix4[] = [];
    for (let i = 0; i < TEEPEE_POLE_COUNT; i++) {
      const footAngle = (FULL_TURN_RADIANS * i) / TEEPEE_POLE_COUNT + Math.PI / 6;
      const topAngle = footAngle + Math.PI;
      lodgepoleMatrices.push(
        segmentMatrix(
          new Vector3(
            tentX + Math.sin(footAngle) * TEEPEE_POLE_FOOT_RADIUS,
            0,
            Math.cos(footAngle) * TEEPEE_POLE_FOOT_RADIUS,
          ),
          new Vector3(
            tentX + Math.sin(topAngle) * TEEPEE_POLE_CROSS_SPREAD,
            TEEPEE_POLE_CROSS_HEIGHT,
            Math.cos(topAngle) * TEEPEE_POLE_CROSS_SPREAD,
          ),
          TEEPEE_POLE_UNIT_LENGTH,
        ),
      );
    }
    const lodgepoles: StructurePart = {
      geometry: new CylinderGeometry(TEEPEE_POLE_RADIUS, TEEPEE_POLE_RADIUS, TEEPEE_POLE_UNIT_LENGTH, 5),
      material: lambert(0x4a3420),
      localMatrices: lodgepoleMatrices,
    };

    const HEARTH_X = 0.24;
    const HEARTH_Z = 0.06;
    const fireHeight = 0.14;
    const fire: StructurePart = {
      geometry: new ConeGeometry(0.06, fireHeight, 6),
      material: lambert(0x3a2010, { emissive: 0xd9540f }),
      localMatrices: [at(HEARTH_X, fireHeight / 2, HEARTH_Z)],
    };

    const FIREPIT_STONE_COUNT = 5;
    const FIREPIT_STONE_RADIUS = 0.1;
    const stoneHeight = 0.045;
    const firepitStones: StructurePart = {
      geometry: new CylinderGeometry(0.03, 0.035, stoneHeight, 5),
      material: lambert(0x8a8478),
      localMatrices: circleRingMatrices(FIREPIT_STONE_COUNT, FIREPIT_STONE_RADIUS, stoneHeight / 2, false).map(
        (ring) => ring.premultiply(at(HEARTH_X, 0, HEARTH_Z)),
      ),
    };

    const logRadius = 0.024;
    const logLength = 0.15;
    const logRotation = new Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2);
    const woodpile: StructurePart = {
      geometry: new CylinderGeometry(logRadius, logRadius, logLength, 5),
      material: lambert(0x5a3d22),
      localMatrices: [
        new Matrix4().compose(new Vector3(0.36, logRadius, -0.11), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.36, logRadius * 3, -0.11), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.35, logRadius * 5, -0.07), logRotation, new Vector3(1, 1, 1)),
      ],
    };

    const SPIT_STICK_RADIUS = 0.009;
    const SPIT_UNIT_LENGTH = 0.1;
    const SPIT_TOP_HEIGHT = 0.19;
    const SPIT_FOOT_SPREAD = 0.09;
    const SPIT_TOP_SPREAD = 0.055;
    const spitFootA = new Vector3(HEARTH_X - SPIT_FOOT_SPREAD, 0, HEARTH_Z);
    const spitFootB = new Vector3(HEARTH_X + SPIT_FOOT_SPREAD, 0, HEARTH_Z);
    const spitTopA = new Vector3(HEARTH_X - SPIT_TOP_SPREAD, SPIT_TOP_HEIGHT, HEARTH_Z);
    const spitTopB = new Vector3(HEARTH_X + SPIT_TOP_SPREAD, SPIT_TOP_HEIGHT, HEARTH_Z);
    const spit: StructurePart = {
      geometry: new CylinderGeometry(SPIT_STICK_RADIUS, SPIT_STICK_RADIUS, SPIT_UNIT_LENGTH, 5),
      material: lambert(0x4a3420),
      localMatrices: [
        segmentMatrix(spitFootA, spitTopA, SPIT_UNIT_LENGTH),
        segmentMatrix(spitFootB, spitTopB, SPIT_UNIT_LENGTH),
        segmentMatrix(spitTopA, spitTopB, SPIT_UNIT_LENGTH),
      ],
    };

    const HIDE_PIN_STONE_COUNT = 7;
    const HIDE_PIN_STONE_SIZE = 0.032;
    const HIDE_PIN_RING_RADIUS = TENT_RADIUS + 0.02;
    const HIDE_PIN_START_ANGLE = FULL_TURN_RADIANS / HIDE_PIN_STONE_COUNT / 2;
    const hidePinStones: StructurePart = {
      geometry: new BoxGeometry(HIDE_PIN_STONE_SIZE, HIDE_PIN_STONE_SIZE, HIDE_PIN_STONE_SIZE),
      material: lambert(0x8a8478),
      localMatrices: circleRingMatrices(
        HIDE_PIN_STONE_COUNT,
        HIDE_PIN_RING_RADIUS,
        HIDE_PIN_STONE_SIZE / 2,
        false,
        HIDE_PIN_START_ANGLE,
      ).map((ring) => ring.premultiply(at(tentX, 0, 0))),
    };

    tiers.push([tent, fire, firepitStones, woodpile, teepeeDoor, lodgepoles, spit, hidePinStones]);
  }

  {
    const wallRadiusTop = 0.26;
    const wallRadiusBottom = 0.275;
    const wallHeight = 0.42;
    const wall: StructurePart = {
      geometry: new CylinderGeometry(wallRadiusTop, wallRadiusBottom, wallHeight, 8),
      material: lambert(0x9c7a52),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    const THATCH_CAP_COLOR = 0xdcb95a;
    const THATCH_SKIRT_COLOR = 0xc3a047;

    const skirtEaveRadius = 0.38;
    const skirtTopRadius = 0.3;
    const skirtHeight = 0.13;
    const roofSkirt: StructurePart = {
      geometry: new CylinderGeometry(skirtTopRadius, skirtEaveRadius, skirtHeight, 8),
      material: lambert(THATCH_SKIRT_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight / 2, 0)],
    };

    const capHeight = 0.3;
    const roofCap: StructurePart = {
      geometry: new ConeGeometry(skirtTopRadius, capHeight, 8),
      material: lambert(THATCH_CAP_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight / 2, 0)],
    };

    const doorHeight = 0.27;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.13, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, wallRadiusBottom + 0.015)],
    };

    const FRINGE_TARGET_SPACING = 0.085;
    const fringeCount = Math.round((FULL_TURN_RADIANS * skirtEaveRadius) / FRINGE_TARGET_SPACING);
    const fringeTiltRadians = Math.PI / 7;
    const fringe: StructurePart = {
      geometry: new BoxGeometry(0.045, 0.09, 0.02),
      material: lambert(0xb8944a),
      localMatrices: circleRingMatrices(fringeCount, skirtEaveRadius - 0.02, wallHeight + 0.01, true).map((ring) =>
        ring.multiply(new Matrix4().makeRotationX(fringeTiltRadians)),
      ),
    };

    const smokeVentHeight = 0.05;
    const smokeVent: StructurePart = {
      geometry: new CylinderGeometry(0.045, 0.045, smokeVentHeight, 6),
      material: lambert(0x2a1c10),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight - smokeVentHeight / 2, 0)],
    };

    const WATTLE_BAND_RADIAL_PROUD = 0.008;
    const WATTLE_BAND_HEIGHT = 0.022;
    const WATTLE_BAND_YS = [wallHeight * 0.33, wallHeight * 0.66];
    const wattleBands: StructurePart = {
      geometry: new CylinderGeometry(
        wallRadiusTop + WATTLE_BAND_RADIAL_PROUD,
        wallRadiusBottom + WATTLE_BAND_RADIAL_PROUD,
        WATTLE_BAND_HEIGHT,
        8,
        1,
        true,
      ),
      material: lambert(0x7a5c3a),
      localMatrices: WATTLE_BAND_YS.map((y) => at(0, y, 0)),
    };

    const HUT_DOOR_WIDTH = 0.13;
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54381f),
      localMatrices: doorFrameMatrices(HUT_DOOR_WIDTH, doorHeight, 0, 0, wallRadiusBottom + 0.015),
    };

    const CAP_COURSE_HEIGHT = 0.045;
    const CAP_COURSE_RADIAL_PROUD = 0.008;
    const CAP_COURSE_BOTTOM_FRACTIONS = [0.22, 0.52];
    const capRadiusAtFraction = (fraction: number): number => skirtTopRadius * (1 - fraction);
    const capCourses: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 8, 1, true),
      material: lambert(0xcfa94e),
      localMatrices: CAP_COURSE_BOTTOM_FRACTIONS.map((fraction) => {
        const fractionSpan = CAP_COURSE_HEIGHT / capHeight;
        const bottomRadius = capRadiusAtFraction(fraction) + CAP_COURSE_RADIAL_PROUD;
        const topRadius = capRadiusAtFraction(fraction + fractionSpan) + CAP_COURSE_RADIAL_PROUD;
        const y = wallHeight + skirtHeight + capHeight * fraction + CAP_COURSE_HEIGHT / 2;
        const meanRadius = (bottomRadius + topRadius) / 2;
        return new Matrix4().compose(
          new Vector3(0, y, 0),
          new Quaternion(),
          new Vector3(meanRadius, CAP_COURSE_HEIGHT, meanRadius),
        );
      }),
    };

    const FOOTING_HEIGHT = 0.05;
    const FOOTING_RADIAL_PROUD = 0.02;
    const footing: StructurePart = {
      geometry: new CylinderGeometry(
        wallRadiusBottom + FOOTING_RADIAL_PROUD / 2,
        wallRadiusBottom + FOOTING_RADIAL_PROUD,
        FOOTING_HEIGHT,
        8,
        1,
        true,
      ),
      material: lambert(0x87683f),
      localMatrices: [at(0, FOOTING_HEIGHT / 2, 0)],
    };

    tiers.push([wall, roofSkirt, roofCap, door, fringe, smokeVent, wattleBands, doorFrame, capCourses, footing]);
  }

  const buildTimberHouseTier = (): StructurePart[] => {
    const wallHeight = 0.5;
    const wallHalfWidth = 0.28;
    const wallHalfDepth = 0.23;

    const LOG_COURSE_COUNT = 5;
    const logDiameter = wallHeight / LOG_COURSE_COUNT;
    const logRadius = logDiameter / 2;
    const LOG_END_OVERHANG = 0.04;
    const LOG_UNIT_LENGTH = 0.1;

    const logMatrices: Matrix4[] = [];
    for (let course = 0; course < LOG_COURSE_COUNT; course++) {
      const y = logRadius + course * logDiameter;
      for (const z of [wallHalfDepth, -wallHalfDepth]) {
        logMatrices.push(
          segmentMatrix(
            new Vector3(-wallHalfWidth - LOG_END_OVERHANG, y, z),
            new Vector3(wallHalfWidth + LOG_END_OVERHANG, y, z),
            LOG_UNIT_LENGTH,
          ),
        );
      }
      for (const x of [wallHalfWidth, -wallHalfWidth]) {
        logMatrices.push(
          segmentMatrix(
            new Vector3(x, y, -wallHalfDepth - LOG_END_OVERHANG),
            new Vector3(x, y, wallHalfDepth + LOG_END_OVERHANG),
            LOG_UNIT_LENGTH,
          ),
        );
      }
    }
    const logCourses: StructurePart = {
      geometry: new CylinderGeometry(logRadius, logRadius, LOG_UNIT_LENGTH, 8),
      material: lambert(0x7a5232),
      localMatrices: logMatrices,
    };

    const ridgeRise = 0.3;
    const eave = 0.055;
    const gable = gableRoof(wallHalfWidth + eave, ridgeRise, wallHeight, wallHalfDepth + eave, wallHalfDepth, false);
    const ROOF_COLOR = 0x8a3a2e;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(ROOF_COLOR),
      localMatrices: gable.panelMatrices,
    };
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x6b4629),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x5a2820),
      localMatrices: gable.ridgeCapMatrices,
    };

    const openingZ = wallHalfDepth + logRadius + 0.015;
    const doorHeight = 0.3;
    const TIMBER_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(TIMBER_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x2e1c10),
      localMatrices: [at(0, doorHeight / 2, openingZ)],
    };
    const WINDOW_WIDTH = 0.085;
    const WINDOW_HEIGHT = 0.1;
    const WINDOW_X = 0.16;
    const WINDOW_Y = 0.3;
    const windows: StructurePart = {
      geometry: new BoxGeometry(WINDOW_WIDTH, WINDOW_HEIGHT, 0.02),
      material: windowMaterial(),
      localMatrices: [at(WINDOW_X, WINDOW_Y, openingZ), at(-WINDOW_X, WINDOW_Y, openingZ)],
    };

    const roofCourses = roofCoursesPart(gable, 0x7c332a);
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54331c),
      localMatrices: doorFrameMatrices(TIMBER_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    const SHUTTER_WIDTH = 0.032;
    const SHUTTER_GAP = 0.006;
    const shutterX = WINDOW_WIDTH / 2 + SHUTTER_GAP + SHUTTER_WIDTH / 2;
    const shutterMatrices: Matrix4[] = [];
    for (const windowX of [WINDOW_X, -WINDOW_X]) {
      for (const side of [1, -1] as const) {
        shutterMatrices.push(at(windowX + side * shutterX, WINDOW_Y, openingZ));
      }
    }
    const shutters: StructurePart = {
      geometry: new BoxGeometry(SHUTTER_WIDTH, WINDOW_HEIGHT + 0.012, 0.018),
      material: lambert(0x6b4629),
      localMatrices: shutterMatrices,
    };

    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftWindow: StructurePart = {
      geometry: new BoxGeometry(0.06, 0.07, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, wallHalfDepth + GABLE_END_THICKNESS / 2 + 0.012)],
    };

    return [logCourses, roof, gableEnds, ridgeCap, door, windows, roofCourses, doorFrame, shutters, loftWindow];
  };

  tiers.push(importedStructureParts() ?? buildTimberHouseTier());

  {
    const wallHeight = 0.4;
    const wallHalfLength = 0.4;
    const wallHalfDepth = 0.19;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfLength * 2, wallHeight, wallHalfDepth * 2),
      material: lambert(0x5a4028),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    const ridgeRise = 0.24;
    const eave = 0.045;
    const gable = gableRoof(
      wallHalfDepth + eave,
      ridgeRise,
      wallHeight,
      wallHalfLength + eave,
      wallHalfLength,
      true,
    );
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(0x746558),
      localMatrices: gable.panelMatrices,
    };
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x4a3320),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x5c5045),
      localMatrices: gable.ridgeCapMatrices,
    };

    const chimneyHeight = 0.3;
    const chimneyX = wallHalfLength * 0.55;
    const chimneyBaseY = wallHeight;
    const chimneyY = chimneyBaseY + chimneyHeight / 2;
    const chimney: StructurePart = {
      geometry: new BoxGeometry(0.065, chimneyHeight, 0.065),
      material: lambert(STONE_SHADE_COLORS[2]),
      localMatrices: [at(chimneyX, chimneyY, 0)],
    };
    const potHeight = 0.05;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.032, 0.042, potHeight, 6),
      material: lambert(0x3a332c),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight + potHeight / 2, 0)],
    };

    const openingZ = wallHalfDepth + 0.012;
    const doorHeight = 0.28;
    const LONGHOUSE_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(LONGHOUSE_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x2a1a10),
      localMatrices: [at(0, doorHeight / 2, openingZ)],
    };
    const WINDOW_X = 0.22;
    const WINDOW_Y = 0.24;
    const windows: StructurePart = {
      geometry: new BoxGeometry(0.09, 0.1, 0.02),
      material: windowMaterial(),
      localMatrices: [
        at(WINDOW_X, WINDOW_Y, openingZ),
        at(-WINDOW_X, WINDOW_Y, openingZ),
        at(WINDOW_X, WINDOW_Y, -openingZ),
        at(-WINDOW_X, WINDOW_Y, -openingZ),
      ],
    };

    const roofCourses = roofCoursesPart(gable, 0x574a3e);
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x3f2c1a),
      localMatrices: doorFrameMatrices(LONGHOUSE_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    const FRAME_BAR = 0.032;
    const FRAME_PROUD = 0.008;
    const FRAME_COLOR = 0x3f2c1a;
    const framePostScale = new Vector3(FRAME_BAR, wallHeight, FRAME_BAR);
    const frameIdentity = new Quaternion();
    const framingMatrices: Matrix4[] = [];
    for (const x of [wallHalfLength, -wallHalfLength]) {
      for (const z of [wallHalfDepth, -wallHalfDepth]) {
        framingMatrices.push(
          new Matrix4().compose(
            new Vector3(Math.sign(x) * (Math.abs(x) - FRAME_BAR / 2 + FRAME_PROUD), wallHeight / 2, Math.sign(z) * (Math.abs(z) - FRAME_BAR / 2 + FRAME_PROUD)),
            frameIdentity,
            framePostScale,
          ),
        );
      }
    }
    const STUD_X = 0.32;
    for (const z of [wallHalfDepth, -wallHalfDepth]) {
      for (const x of [STUD_X, -STUD_X]) {
        framingMatrices.push(
          new Matrix4().compose(
            new Vector3(x, wallHeight / 2, Math.sign(z) * (Math.abs(z) + FRAME_PROUD - FRAME_BAR / 2)),
            frameIdentity,
            framePostScale,
          ),
        );
      }
    }
    const RAIL_Y = 0.17;
    for (const z of [wallHalfDepth, -wallHalfDepth]) {
      framingMatrices.push(
        new Matrix4().compose(
          new Vector3(0, RAIL_Y, Math.sign(z) * (Math.abs(z) + FRAME_PROUD - FRAME_BAR / 2)),
          frameIdentity,
          new Vector3(wallHalfLength * 2, FRAME_BAR, FRAME_BAR),
        ),
      );
    }
    const framing: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(FRAME_COLOR),
      localMatrices: framingMatrices,
    };

    const EAVE_POST_RADIUS = 0.016;
    const EAVE_POST_XS = [0.3, 0, -0.3];
    const eavePostZ = wallHalfDepth + eave - EAVE_POST_RADIUS;
    const eavePostHeight = wallHeight;
    const eavePosts: StructurePart = {
      geometry: new CylinderGeometry(EAVE_POST_RADIUS, EAVE_POST_RADIUS, eavePostHeight, 5),
      material: lambert(FRAME_COLOR),
      localMatrices: EAVE_POST_XS.map((x) => at(x, eavePostHeight / 2, eavePostZ)),
    };

    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftQuarterTurn = new Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);
    const loftWindowX = wallHalfLength + GABLE_END_THICKNESS / 2 + 0.012;
    const loftWindows: StructurePart = {
      geometry: new BoxGeometry(0.055, 0.065, 0.02),
      material: windowMaterial(),
      localMatrices: [loftWindowX, -loftWindowX].map((x) =>
        new Matrix4().compose(new Vector3(x, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, 0), loftQuarterTurn, new Vector3(1, 1, 1)),
      ),
    };

    tiers.push([
      wall,
      roof,
      gableEnds,
      ridgeCap,
      chimney,
      chimneyPot,
      door,
      windows,
      roofCourses,
      doorFrame,
      framing,
      eavePosts,
      loftWindows,
    ]);
  }

  {
    const wallHeight = 0.55;
    const wallHalfWidth = 0.29;
    const wallHalfDepth = 0.21;
    const STONE_BLOCK_DEPTH = 0.015;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallHalfDepth * 2),
      material: lambert(STONE_MORTAR_COLOR),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    const ridgeRise = 0.3;
    const eave = 0.055;
    const gable = gableRoof(wallHalfWidth + eave, ridgeRise, wallHeight, wallHalfDepth + eave, wallHalfDepth, false);
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(0xb5502e),
      localMatrices: gable.panelMatrices,
    };
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x7d7a74),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x8a3a22),
      localMatrices: gable.ridgeCapMatrices,
    };

    const chimneyHeight = 0.36;
    const chimneyX = wallHalfWidth * 0.5;
    const chimneyBaseY = wallHeight;
    const chimney: StructurePart = {
      geometry: new CylinderGeometry(0.045, 0.056, chimneyHeight, 6),
      material: lambert(STONE_SHADE_COLORS[2]),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight / 2, 0)],
    };
    const potHeight = 0.05;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.03, 0.04, potHeight, 6),
      material: lambert(0x3a332c),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight + potHeight / 2, 0)],
    };

    const cottageOpeningZ = wallHalfDepth + STONE_BLOCK_DEPTH + 0.01;
    const doorHeight = 0.32;
    const COTTAGE_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(COTTAGE_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, cottageOpeningZ)],
    };
    const WINDOW_WIDTH = 0.085;
    const WINDOW_HEIGHT = 0.1;
    const WINDOW_X = 0.17;
    const WINDOW_Y = 0.34;
    const windows: StructurePart = {
      geometry: new BoxGeometry(WINDOW_WIDTH, WINDOW_HEIGHT, 0.02),
      material: windowMaterial(),
      localMatrices: [
        at(WINDOW_X, WINDOW_Y, cottageOpeningZ),
        at(-WINDOW_X, WINDOW_Y, cottageOpeningZ),
        at(WINDOW_X, WINDOW_Y, -cottageOpeningZ),
        at(-WINDOW_X, WINDOW_Y, -cottageOpeningZ),
      ],
    };

    const roofCourses = roofCoursesPart(gable, 0xa2452a);
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: doorFrameMatrices(COTTAGE_DOOR_WIDTH, doorHeight, 0, 0, cottageOpeningZ),
    };

    const SILL_WIDTH = WINDOW_WIDTH + 0.03;
    const SILL_HEIGHT = 0.024;
    const SILL_DEPTH = 0.026;
    const sillIdentity = new Quaternion();
    const sillScale = new Vector3(SILL_WIDTH, SILL_HEIGHT, SILL_DEPTH);
    const sillMatrices: Matrix4[] = [];
    for (const z of [cottageOpeningZ, -cottageOpeningZ]) {
      for (const x of [WINDOW_X, -WINDOW_X]) {
        sillMatrices.push(
          new Matrix4().compose(new Vector3(x, WINDOW_Y - WINDOW_HEIGHT / 2 - SILL_HEIGHT / 2, z), sillIdentity, sillScale),
          new Matrix4().compose(new Vector3(x, WINDOW_Y + WINDOW_HEIGHT / 2 + SILL_HEIGHT / 2, z), sillIdentity, sillScale),
        );
      }
    }
    const sillsAndLintels: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: sillMatrices,
    };

    const COLLAR_RADIUS_TOP = 0.062;
    const COLLAR_RADIUS_BOTTOM = 0.075;
    const COLLAR_EMBED = 0.01;
    const COLLAR_REVEAL = 0.03;
    const roofSurfaceYAt = (x: number): number => wallHeight + ridgeRise * (1 - x / (wallHalfWidth + eave));
    const collarBaseY = roofSurfaceYAt(chimneyX + COLLAR_RADIUS_BOTTOM) - COLLAR_EMBED;
    const collarTopY = roofSurfaceYAt(chimneyX - COLLAR_RADIUS_BOTTOM) + COLLAR_REVEAL;
    const collarHeight = collarTopY - collarBaseY;
    const chimneyCollar: StructurePart = {
      geometry: new CylinderGeometry(COLLAR_RADIUS_TOP, COLLAR_RADIUS_BOTTOM, collarHeight, 6),
      material: lambert(STONE_SHADE_COLORS[1]),
      localMatrices: [at(chimneyX, collarBaseY + collarHeight / 2, 0)],
    };

    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftWindow: StructurePart = {
      geometry: new BoxGeometry(0.06, 0.07, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, wallHalfDepth + GABLE_END_THICKNESS / 2 + 0.012)],
    };

    const quoinWidth = 0.06;
    const quoinProud = 0.006;
    const quoinOffset = (size: number, half: number): number =>
      half + STONE_BLOCK_DEPTH + quoinProud - size / 2;
    const quoinX = quoinOffset(quoinWidth, wallHalfWidth);
    const quoinZ = quoinOffset(quoinWidth, wallHalfDepth);
    const quoinMatrices: Matrix4[] = [];
    for (const x of [quoinX, -quoinX]) {
      for (const z of [quoinZ, -quoinZ]) quoinMatrices.push(at(x, wallHeight / 2, z));
    }
    const quoins: StructurePart = {
      geometry: new BoxGeometry(quoinWidth, wallHeight, quoinWidth),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: quoinMatrices,
    };

    const STONE_BLOCK_TARGET_WIDTH = 0.135;
    const STONE_COURSE_COUNT = 5;
    const stoneBlockGeometry = new BoxGeometry(1, 1, STONE_BLOCK_DEPTH);
    const stoneBlocks: StoneBlock[] = [];
    for (const face of [
      { half: wallHalfWidth, axis: 'z' as const, value: wallHalfDepth + STONE_BLOCK_DEPTH / 2 },
      { half: wallHalfWidth, axis: 'z' as const, value: -(wallHalfDepth + STONE_BLOCK_DEPTH / 2) },
      { half: wallHalfDepth, axis: 'x' as const, value: wallHalfWidth + STONE_BLOCK_DEPTH / 2 },
      { half: wallHalfDepth, axis: 'x' as const, value: -(wallHalfWidth + STONE_BLOCK_DEPTH / 2) },
    ]) {
      stoneBlocks.push(
        ...stoneBlocksForFace(
          face.half,
          wallHeight,
          STONE_COURSE_COUNT,
          face.axis,
          face.value,
          STONE_BLOCK_TARGET_WIDTH,
        ),
      );
    }
    const stoneWalls = stonePartsByShade(stoneBlocks, stoneBlockGeometry);

    tiers.push([
      wall,
      roof,
      gableEnds,
      ridgeCap,
      chimney,
      chimneyPot,
      door,
      windows,
      quoins,
      roofCourses,
      doorFrame,
      sillsAndLintels,
      chimneyCollar,
      loftWindow,
      ...stoneWalls,
    ]);
  }

  {
    const towerHeight = 1.3;
    const towerRadiusTop = 0.22;
    const towerRadiusBottom = 0.24;
    const TOWER_SIDES = 8;
    const STONE_TOWER_BLOCK_DEPTH = 0.018;
    const tower: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusTop, towerRadiusBottom, towerHeight, TOWER_SIDES),
      material: lambert(STONE_MORTAR_COLOR),
      localMatrices: [at(0, towerHeight / 2, 0)],
    };

    const parapetHeight = 0.14;
    const parapetRadius = towerRadiusTop + 0.08;
    const parapet: StructurePart = {
      geometry: new CylinderGeometry(parapetRadius, parapetRadius, parapetHeight, TOWER_SIDES),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, towerHeight + parapetHeight / 2, 0)],
    };
    const roofHeight = 0.4;
    const roof: StructurePart = {
      geometry: new ConeGeometry(towerRadiusTop + 0.04, roofHeight, TOWER_SIDES),
      material: lambert(0x3a4a52),
      localMatrices: [at(0, towerHeight + parapetHeight + roofHeight / 2, 0)],
    };

    const doorHeight = 0.28;
    const towerDoorZ = towerRadiusBottom + STONE_TOWER_BLOCK_DEPTH + 0.01;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.12, doorHeight, 0.04),
      material: lambert(0x2a2018),
      localMatrices: [at(0, doorHeight / 2, towerDoorZ)],
    };

    const ARROW_SLIT_COUNT = 4;
    const ARROW_SLIT_BAND_YS = [towerHeight * 0.45, towerHeight * 0.72];
    const arrowSlitMatrices: Matrix4[] = [];
    for (const y of ARROW_SLIT_BAND_YS) {
      arrowSlitMatrices.push(
        ...circleRingMatrices(ARROW_SLIT_COUNT, towerRadiusTop + STONE_TOWER_BLOCK_DEPTH, y, true),
      );
    }
    const arrowSlits: StructurePart = {
      geometry: new BoxGeometry(0.035, 0.16, 0.02),
      material: windowMaterial(),
      localMatrices: arrowSlitMatrices,
    };

    const merlonHeight = 0.12;
    const merlonDepth = 0.055;
    const parapetInradius = parapetRadius * Math.cos(Math.PI / TOWER_SIDES);
    const merlons: StructurePart = {
      geometry: new BoxGeometry(0.075, merlonHeight, merlonDepth),
      material: lambert(0x6f6a63),
      localMatrices: circleRingMatrices(
        TOWER_SIDES,
        parapetInradius - merlonDepth / 2,
        towerHeight + parapetHeight + merlonHeight / 2 - 0.015,
        true,
        Math.PI / TOWER_SIDES,
      ),
    };

    const plinthHeight = 0.11;
    const plinth: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusBottom + 0.05, towerRadiusBottom + 0.09, plinthHeight, TOWER_SIDES),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, plinthHeight / 2, 0)],
    };

    const STONE_TOWER_COURSE_COUNT = 7;
    const STONE_TOWER_TARGET_SPACING = 0.15;
    const towerStoneBandBottom = plinthHeight;
    const towerStoneBandTop = towerHeight - 0.05;
    const towerStoneBand = towerStoneBandTop - towerStoneBandBottom;
    const towerCourseHeight = towerStoneBand / STONE_TOWER_COURSE_COUNT;
    const towerRadiusAt = (y: number): number =>
      towerRadiusBottom + (towerRadiusTop - towerRadiusBottom) * (y / towerHeight);
    const towerStoneMidRadius = towerRadiusAt((towerStoneBandBottom + towerStoneBandTop) / 2);
    const towerStoneRingCount = Math.round(
      (FULL_TURN_RADIANS * towerStoneMidRadius) / STONE_TOWER_TARGET_SPACING,
    );
    const towerStoneHalfSlotAngle = Math.PI / towerStoneRingCount;
    const ARROW_SLIT_ANGLES = Array.from(
      { length: ARROW_SLIT_COUNT },
      (_, i) => (FULL_TURN_RADIANS * i) / ARROW_SLIT_COUNT,
    );
    const ARROW_SLIT_ANGLE_CLEARANCE = towerStoneHalfSlotAngle;
    const towerStoneBlocks: StoneBlock[] = [];
    for (let course = 0; course < STONE_TOWER_COURSE_COUNT; course++) {
      const y = towerStoneBandBottom + towerCourseHeight * (course + 0.5);
      const courseRadius = towerRadiusAt(y) + STONE_TOWER_BLOCK_DEPTH / 2;
      const startAngle = course % 2 === 1 ? towerStoneHalfSlotAngle : 0;
      const ring = circleRingMatrices(towerStoneRingCount, courseRadius, y, true, startAngle);
      const courseBlockScale = new Matrix4().makeScale(
        ((FULL_TURN_RADIANS * courseRadius) / towerStoneRingCount) * (1 - STONE_JOINT_FRACTION),
        towerCourseHeight * (1 - STONE_JOINT_FRACTION),
        1,
      );
      for (let i = 0; i < ring.length; i++) {
        const angle = startAngle + (FULL_TURN_RADIANS * i) / towerStoneRingCount;
        const nearSlit = ARROW_SLIT_ANGLES.some(
          (slitAngle) => angularDistance(angle, slitAngle) < ARROW_SLIT_ANGLE_CLEARANCE,
        );
        if (nearSlit) continue;
        towerStoneBlocks.push({
          matrix: ring[i].multiply(courseBlockScale),
          shadeIndex: (course + i) % STONE_SHADE_COLORS.length,
        });
      }
    }
    const towerStoneGeometry = new BoxGeometry(1, 1, STONE_TOWER_BLOCK_DEPTH);
    const towerStoneWalls = stonePartsByShade(towerStoneBlocks, towerStoneGeometry);

    const CORBEL_WIDTH = 0.05;
    const CORBEL_HEIGHT = 0.06;
    const CORBEL_DEPTH = 0.06;
    const corbelRingRadius = towerRadiusAt(towerHeight - CORBEL_HEIGHT / 2) + CORBEL_DEPTH / 2;
    const corbels: StructurePart = {
      geometry: new BoxGeometry(CORBEL_WIDTH, CORBEL_HEIGHT, CORBEL_DEPTH),
      material: lambert(0x6f6a63),
      localMatrices: circleRingMatrices(
        TOWER_SIDES,
        corbelRingRadius,
        towerHeight - CORBEL_HEIGHT / 2,
        true,
        Math.PI / TOWER_SIDES,
      ),
    };

    const TOWER_DOOR_WIDTH = 0.12;
    const towerDoorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: doorFrameMatrices(TOWER_DOOR_WIDTH, doorHeight, 0, 0, towerDoorZ),
    };
    const THRESHOLD_WIDTH = 0.2;
    const THRESHOLD_HEIGHT = 0.035;
    const THRESHOLD_DEPTH = 0.08;
    const threshold: StructurePart = {
      geometry: new BoxGeometry(THRESHOLD_WIDTH, THRESHOLD_HEIGHT, THRESHOLD_DEPTH),
      material: lambert(STONE_SHADE_COLORS[1]),
      localMatrices: [at(0, THRESHOLD_HEIGHT / 2, towerDoorZ + THRESHOLD_DEPTH / 2)],
    };

    const EAVE_RING_HEIGHT = 0.035;
    const EAVE_RING_RADIUS = towerRadiusTop + 0.055;
    const eaveRing: StructurePart = {
      geometry: new CylinderGeometry(EAVE_RING_RADIUS, EAVE_RING_RADIUS, EAVE_RING_HEIGHT, TOWER_SIDES),
      material: lambert(0x2e3b42),
      localMatrices: [at(0, towerHeight + parapetHeight + EAVE_RING_HEIGHT / 2, 0)],
    };

    const BANNER_STAFF_RADIUS = 0.008;
    const BANNER_STAFF_HEIGHT = 0.16;
    const bannerStaffBaseY = towerHeight + parapetHeight + roofHeight;
    const BANNER_FLAG_WIDTH = 0.09;
    const BANNER_FLAG_HEIGHT = 0.055;
    const BANNER_FLAG_THICKNESS = 0.012;
    const bannerStaff: StructurePart = {
      geometry: new CylinderGeometry(BANNER_STAFF_RADIUS, BANNER_STAFF_RADIUS, BANNER_STAFF_HEIGHT, 5),
      material: lambert(0x3a2a1a),
      localMatrices: [at(0, bannerStaffBaseY + BANNER_STAFF_HEIGHT / 2, 0)],
    };
    const bannerFlag: StructurePart = {
      geometry: new BoxGeometry(BANNER_FLAG_WIDTH, BANNER_FLAG_HEIGHT, BANNER_FLAG_THICKNESS),
      material: lambert(0x8a2f2f),
      localMatrices: [
        at(
          BANNER_STAFF_RADIUS + BANNER_FLAG_WIDTH / 2,
          bannerStaffBaseY + BANNER_STAFF_HEIGHT - BANNER_FLAG_HEIGHT / 2,
          0,
        ),
      ],
    };

    tiers.push([
      tower,
      parapet,
      roof,
      door,
      arrowSlits,
      merlons,
      plinth,
      corbels,
      towerDoorFrame,
      threshold,
      eaveRing,
      bannerStaff,
      bannerFlag,
      ...towerStoneWalls,
    ]);
  }

  return tiers;
}

interface SiteVariantSet {
  readonly builders: ReadonlyArray<() => StructurePart[]>;
  pick(cellX: number, cellY: number): number;
}

const SITE_TOP_TIER_VARIANTS: Readonly<Partial<Record<SiteKind, SiteVariantSet>>> = {
  coastal: { builders: FISHING_HUT_BUILDERS, pick: fishingHutVariantIndex },
};

const DURANDS_SIGN_CANVAS_WIDTH = 512;
const DURANDS_SIGN_CANVAS_HEIGHT = 128;

const DURANDS_SIGN_TEXT = "Durand's";

const DURANDS_SIGN_FONT = 'bold 84px sans-serif';

const DURANDS_SIGN_BOARD_COLOR = '#3a1610';
const DURANDS_SIGN_TEXT_COLOR = '#f2c85b';

function buildDurandsSignTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = DURANDS_SIGN_CANVAS_WIDTH;
  canvas.height = DURANDS_SIGN_CANVAS_HEIGHT;

  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = DURANDS_SIGN_BOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = DURANDS_SIGN_TEXT_COLOR;
    context.font = DURANDS_SIGN_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(DURANDS_SIGN_TEXT, canvas.width / 2, canvas.height / 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const DURANDS_SIGN_TEXTURE = buildDurandsSignTexture();

export const DURANDS_SIGN_FLASH_PERIOD_SECONDS = 1.6;

const DURANDS_SIGN_EMISSIVE_COLOR = 0xf2c85b;

const DURANDS_SIGN_EMISSIVE_MIN = 0.05;
const DURANDS_SIGN_EMISSIVE_MAX = 1.4;

const DURANDS_TWO_PI = Math.PI * 2;

export const DURANDS_MARQUEE_BULB_PERIOD_SECONDS = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 2;

const DURANDS_MARQUEE_BULB_COLOR = 0xffe9a8;
const DURANDS_MARQUEE_BULB_SOCKET_COLOR = 0x3a3226;
const DURANDS_MARQUEE_BULB_EMISSIVE_MIN = 0.05;
const DURANDS_MARQUEE_BULB_EMISSIVE_MAX = 1.1;
const DURANDS_MARQUEE_BULB_RADIUS = 0.014;
const DURANDS_MARQUEE_BULB_MARGIN = 0.025;
const DURANDS_MARQUEE_BULB_TARGET_SPACING = 0.09;
const DURANDS_MARQUEE_BULB_GAP = 0.015;

function rectangleBorderPoints(count: number, hw: number, hh: number): Array<{ x: number; y: number }> {
  const top = 2 * hw;
  const right = 2 * hh;
  const bottom = 2 * hw;
  const perimeter = top + right + bottom + right;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    let t = (perimeter * i) / count;
    if (t < top) {
      points.push({ x: -hw + t, y: hh });
      continue;
    }
    t -= top;
    if (t < right) {
      points.push({ x: hw, y: hh - t });
      continue;
    }
    t -= right;
    if (t < bottom) {
      points.push({ x: hw - t, y: -hh });
      continue;
    }
    t -= bottom;
    points.push({ x: -hw, y: -hh + t });
  }
  return points;
}

const DURANDS_DANCER_NEON_COLOR = 0xff4f96;
const DURANDS_DANCER_TUBE_COLOR = 0x241016;
const DURANDS_DANCER_EMISSIVE_MIN = 0.0;
const DURANDS_DANCER_EMISSIVE_MAX = 1.0;
const DURANDS_DANCER_BODY_EMISSIVE_INTENSITY = 0.85;
const DURANDS_DANCER_TUBE_RADIUS = 0.021;
const DURANDS_DANCER_SEGMENT_UNIT = 0.1;
const DURANDS_DANCER_HEAD_RADIUS = 0.055;
const DURANDS_DANCER_BUST_RADIUS = 0.048;
const DURANDS_DANCER_JOINT_RADIUS = DURANDS_DANCER_TUBE_RADIUS;
const DURANDS_DANCER_POLE_RADIUS = 0.016;
const DURANDS_DANCER_POLE_COLOR = 0xffd9ec;
const DURANDS_DANCER_POLE_EMISSIVE_INTENSITY = 0.9;
const DURANDS_DANCER_FRAME_COLOR = 0xffd98a;
const DURANDS_DANCER_FRAME_EMISSIVE_INTENSITY = 0.55;
const DURANDS_DANCER_FRAME_INSET = 0.035;
const DURANDS_DANCER_FRAME_TUBE_RADIUS = 0.012;

type SignPoint = readonly [u: number, v: number];

function dancerSegment(x1: number, y1: number, x2: number, y2: number, z: number): Matrix4 {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tiltZ = Math.atan2(-dx, dy);
  const length = Math.hypot(dx, dy);
  return new Matrix4().compose(
    new Vector3((x1 + x2) / 2, (y1 + y2) / 2, z),
    new Quaternion().setFromAxisAngle(Z_AXIS, tiltZ),
    new Vector3(1, length / DURANDS_DANCER_SEGMENT_UNIT, 1),
  );
}

function dancerCircle(x: number, y: number, z: number, radius: number): Matrix4 {
  const scale = radius / DURANDS_DANCER_HEAD_RADIUS;
  const depthScale = DURANDS_DANCER_TUBE_RADIUS / DURANDS_DANCER_HEAD_RADIUS;
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion(), new Vector3(scale, scale, depthScale));
}

const DANCER_ARC_SAMPLES = 4;

function neonArc(from: SignPoint, control: SignPoint, to: SignPoint): SignPoint[] {
  const points: SignPoint[] = [];
  for (let i = 0; i <= DANCER_ARC_SAMPLES; i++) {
    const t = i / DANCER_ARC_SAMPLES;
    const s = 1 - t;
    points.push([
      s * s * from[0] + 2 * s * t * control[0] + t * t * to[0],
      s * s * from[1] + 2 * s * t * control[1] + t * t * to[1],
    ]);
  }
  return points;
}

function neonStroke(...arcs: SignPoint[][]): SignPoint[] {
  const stroke: SignPoint[] = [...arcs[0]];
  for (let i = 1; i < arcs.length; i++) stroke.push(...arcs[i].slice(1));
  return stroke;
}

const DURANDS_DANCER_POLE_U = 0.2;

const DURANDS_DANCER_BODY_STROKES: ReadonlyArray<readonly SignPoint[]> = [
  neonStroke(
    neonArc([0.05, 0.675], [0.075, 0.63], [0.075, 0.585]),
    neonArc([0.075, 0.585], [0.125, 0.55], [0.055, 0.505]),
    neonArc([0.055, 0.505], [0.03, 0.455], [0.075, 0.385]),
  ),
  neonStroke(
    neonArc([-0.02, 0.66], [-0.06, 0.6], [-0.055, 0.52]),
    neonArc([-0.055, 0.52], [-0.125, 0.45], [-0.06, 0.355]),
  ),
  neonStroke(
    neonArc([0.075, 0.385], [0.01, 0.345], [-0.06, 0.355]),
    neonArc([-0.06, 0.355], [-0.005, 0.24], [0.005, 0.19]),
    neonArc([0.005, 0.19], [0.015, 0.09], [-0.005, 0.025]),
    neonArc([-0.005, 0.025], [0.02, 0.0], [0.065, 0.005]),
  ),
];

const DURANDS_DANCER_BODY_HEAD: SignPoint = [0.015, 0.725];
const DURANDS_DANCER_BODY_BUST: SignPoint = [0.09, 0.552];

const DURANDS_DANCER_LIMBS_A: ReadonlyArray<readonly SignPoint[]> = [
  neonStroke(
    neonArc([0.045, 0.375], [0.15, 0.42], [0.21, 0.47]),
    neonArc([0.21, 0.47], [0.27, 0.52], [0.305, 0.575]),
  ),
  neonArc([0.02, 0.615], [0.1, 0.665], [DURANDS_DANCER_POLE_U, 0.675]),
  neonArc([-0.015, 0.61], [-0.1, 0.635], [-0.19, 0.6]),
  neonArc([-0.045, 0.735], [-0.115, 0.75], [-0.165, 0.715]),
];

const DURANDS_DANCER_LIMBS_B: ReadonlyArray<readonly SignPoint[]> = [
  neonStroke(
    neonArc([0.045, 0.375], [0.13, 0.33], [0.19, 0.3]),
    neonArc([0.19, 0.3], [0.25, 0.27], [0.295, 0.215]),
  ),
  neonArc([0.02, 0.615], [0.09, 0.6], [DURANDS_DANCER_POLE_U, 0.55]),
  neonArc([-0.01, 0.605], [-0.09, 0.66], [-0.14, 0.7]),
  neonArc([-0.045, 0.735], [-0.1, 0.79], [-0.155, 0.78]),
];

function buildDancerStrokes(
  strokes: ReadonlyArray<readonly SignPoint[]>,
  originX: number,
  originY: number,
  z: number,
): { segments: Matrix4[]; circles: Matrix4[] } {
  const segments: Matrix4[] = [];
  const circles: Matrix4[] = [];
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.length; i++) {
      const [u1, v1] = stroke[i];
      const [u2, v2] = stroke[i + 1];
      segments.push(dancerSegment(originX + u1, originY + v1, originX + u2, originY + v2, z));
      if (i > 0) {
        circles.push(dancerCircle(originX + u1, originY + v1, z, DURANDS_DANCER_JOINT_RADIUS));
      }
    }
  }
  return { segments, circles };
}

interface DurandsBuilding {
  readonly parts: StructurePart[];
  readonly signMaterial: MeshLambertMaterial;
  readonly marqueePhaseAMaterial: MeshLambertMaterial;
  readonly marqueePhaseBMaterial: MeshLambertMaterial;
  readonly dancerPoseAMaterial: MeshLambertMaterial;
  readonly dancerPoseBMaterial: MeshLambertMaterial;
}

function buildDurandsParts(): DurandsBuilding {
  const bodyHalfWidth = 0.40;
  const jettyHalfWidth = 0.44;
  const backZ = -STRUCTURE_FOOTPRINT_RADIUS;
  const bodyDepth = 0.5;
  const bodyFrontZ = backZ + bodyDepth;
  const bodyCenterZ = (backZ + bodyFrontZ) / 2;
  const porchFrontZ = STRUCTURE_FOOTPRINT_RADIUS;
  const porchDepth = porchFrontZ - bodyFrontZ;
  const porchCenterZ = (bodyFrontZ + porchFrontZ) / 2;
  const porchHalfWidth = bodyHalfWidth + 0.02;

  const groundFloorHeight = 0.55;
  const secondFloorHeight = 0.45;
  const secondFloorTopY = groundFloorHeight + secondFloorHeight;

  const boardwalkHeight = 0.04;
  const boardwalk: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, boardwalkHeight, porchDepth),
    material: lambert(0x6b4a2e),
    localMatrices: [at(0, boardwalkHeight / 2, porchCenterZ)],
  };

  const groundFloor: StructurePart = {
    geometry: new BoxGeometry(bodyHalfWidth * 2, groundFloorHeight, bodyDepth),
    material: lambert(0x7a2a20),
    localMatrices: [at(0, groundFloorHeight / 2, bodyCenterZ)],
  };

  const secondDepth = bodyDepth + 0.04;
  const secondCenterZ = bodyCenterZ + 0.02;
  const secondFrontZ = secondCenterZ + secondDepth / 2;
  const secondFloor: StructurePart = {
    geometry: new BoxGeometry(jettyHalfWidth * 2, secondFloorHeight, secondDepth),
    material: lambert(0x8f3325),
    localMatrices: [at(0, groundFloorHeight + secondFloorHeight / 2, secondCenterZ)],
  };

  const falseFrontHeight = 0.3;
  const falseFrontDepth = 0.06;
  const falseFrontTopY = secondFloorTopY + falseFrontHeight;
  const falseFrontY = secondFloorTopY + falseFrontHeight / 2;
  const falseFrontZ = secondFrontZ + falseFrontDepth / 2;
  const falseFront: StructurePart = {
    geometry: new BoxGeometry(jettyHalfWidth * 2, falseFrontHeight, falseFrontDepth),
    material: lambert(0x9c2b1e),
    localMatrices: [at(0, falseFrontY, falseFrontZ)],
  };

  const porchThickness = 0.05;
  const porchRoof: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, porchThickness, porchDepth + 0.04),
    material: lambert(0x4a2015),
    localMatrices: [at(0, groundFloorHeight - porchThickness / 2, porchCenterZ)],
  };
  const postInset = 0.05;
  const postX = porchHalfWidth - postInset;
  const postZ = porchFrontZ - postInset;
  const postHeight = groundFloorHeight - porchThickness;
  const porchPosts: StructurePart = {
    geometry: new CylinderGeometry(0.028, 0.028, postHeight, 6),
    material: lambert(0xac8a55),
    localMatrices: [at(postX, postHeight / 2, postZ), at(-postX, postHeight / 2, postZ)],
  };

  const roofCapThickness = 0.025;
  const roofCapInset = 0.03;
  const roofCap: StructurePart = {
    geometry: new BoxGeometry(
      jettyHalfWidth * 2 - roofCapInset,
      roofCapThickness,
      secondDepth - roofCapInset,
    ),
    material: lambert(0x3f2418),
    localMatrices: [at(0, secondFloorTopY + roofCapThickness / 2, secondCenterZ - roofCapInset / 2)],
  };

  const windowZ = secondFrontZ + 0.01;
  const groundWindowZ = bodyFrontZ + 0.01;
  const upstairsWindowY = groundFloorHeight + secondFloorHeight * 0.55;
  const rearWindowZ = backZ - 0.01;
  const sideWindowQuarterTurn = new Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);
  const sideWindowAt = (x: number, y: number, z: number): Matrix4 =>
    new Matrix4().compose(new Vector3(x, y, z), sideWindowQuarterTurn, new Vector3(1, 1, 1));
  const windows: StructurePart = {
    geometry: new BoxGeometry(0.11, 0.13, 0.02),
    material: windowMaterial(),
    localMatrices: [
      at(0.24, upstairsWindowY, windowZ),
      at(-0.24, upstairsWindowY, windowZ),
      at(0.28, groundFloorHeight * 0.6, groundWindowZ),
      at(-0.28, groundFloorHeight * 0.6, groundWindowZ),
      at(0.22, upstairsWindowY, rearWindowZ),
      at(-0.22, upstairsWindowY, rearWindowZ),
      sideWindowAt(jettyHalfWidth + 0.01, upstairsWindowY, secondCenterZ),
      sideWindowAt(-(jettyHalfWidth + 0.01), upstairsWindowY, secondCenterZ),
    ],
  };

  const backDoorHeight = 0.3;
  const backDoor: StructurePart = {
    geometry: new BoxGeometry(0.13, backDoorHeight, 0.02),
    material: lambert(0x3a1410),
    localMatrices: [at(0.15, backDoorHeight / 2, rearWindowZ)],
  };

  const saloonDoorHeight = 0.26;
  const saloonDoorHalfWidth = 0.09;
  const saloonDoorGap = 0.01;
  const saloonDoorClearance = 0.06;
  const saloonDoorY = boardwalkHeight + saloonDoorClearance + saloonDoorHeight / 2;
  const saloonDoors: StructurePart = {
    geometry: new BoxGeometry(saloonDoorHalfWidth * 2 - saloonDoorGap, saloonDoorHeight, 0.02),
    material: lambert(0x5a2015),
    localMatrices: [
      at(saloonDoorHalfWidth + saloonDoorGap / 2, saloonDoorY, bodyFrontZ + 0.01),
      at(-(saloonDoorHalfWidth + saloonDoorGap / 2), saloonDoorY, bodyFrontZ + 0.01),
    ],
  };

  const signHalfWidth = 0.3;
  const signHalfHeight = 0.08;
  const signThickness = 0.02;
  const signGap = 0.01;
  const signX = 0;
  const signY = secondFloorTopY + falseFrontHeight * 0.5;
  const signZ = falseFrontZ + falseFrontDepth / 2 + signThickness / 2 + signGap;
  const signMaterial = new MeshLambertMaterial({
    map: DURANDS_SIGN_TEXTURE,
    flatShading: true,
    emissive: DURANDS_SIGN_EMISSIVE_COLOR,
    emissiveIntensity: DURANDS_SIGN_EMISSIVE_MIN,
  });
  const sign: StructurePart = {
    geometry: new BoxGeometry(signHalfWidth * 2, signHalfHeight * 2, signThickness),
    material: signMaterial,
    localMatrices: [at(signX, signY, signZ)],
  };

  const marqueeHalfWidth = signHalfWidth + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueeHalfHeight = signHalfHeight + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueePerimeter = 2 * (marqueeHalfWidth + marqueeHalfHeight) * 2;
  const marqueeBulbCount = Math.round(marqueePerimeter / DURANDS_MARQUEE_BULB_TARGET_SPACING);
  const marqueeBulbZ = signZ + signThickness / 2 + DURANDS_MARQUEE_BULB_GAP;
  const marqueeBorder = rectangleBorderPoints(marqueeBulbCount, marqueeHalfWidth, marqueeHalfHeight);

  const marqueeBulbGeometry = new SphereGeometry(DURANDS_MARQUEE_BULB_RADIUS, 6, 4);
  const marqueePhaseAMatrices: Matrix4[] = [];
  const marqueePhaseBMatrices: Matrix4[] = [];
  marqueeBorder.forEach((point, index) => {
    const matrix = at(signX + point.x, signY + point.y, marqueeBulbZ);
    (index % 2 === 0 ? marqueePhaseAMatrices : marqueePhaseBMatrices).push(matrix);
  });

  const marqueePhaseAMaterial = new MeshLambertMaterial({
    color: DURANDS_MARQUEE_BULB_SOCKET_COLOR,
    flatShading: true,
    emissive: DURANDS_MARQUEE_BULB_COLOR,
    emissiveIntensity: DURANDS_MARQUEE_BULB_EMISSIVE_MAX,
  });
  const marqueePhaseBMaterial = new MeshLambertMaterial({
    color: DURANDS_MARQUEE_BULB_SOCKET_COLOR,
    flatShading: true,
    emissive: DURANDS_MARQUEE_BULB_COLOR,
    emissiveIntensity: DURANDS_MARQUEE_BULB_EMISSIVE_MIN,
  });
  const marqueeBulbsPhaseA: StructurePart = {
    geometry: marqueeBulbGeometry,
    material: marqueePhaseAMaterial,
    localMatrices: marqueePhaseAMatrices,
  };
  const marqueeBulbsPhaseB: StructurePart = {
    geometry: marqueeBulbGeometry,
    material: marqueePhaseBMaterial,
    localMatrices: marqueePhaseBMatrices,
  };

  const dancerBoardHalfWidth = 0.34;
  const dancerBoardHalfHeight = 0.45;
  const dancerBoardThickness = 0.03;
  const dancerLegHeight = 0.1;
  const dancerBoardBottomY = falseFrontTopY + dancerLegHeight;
  const dancerBoardY = dancerBoardBottomY + dancerBoardHalfHeight;
  const dancerBoardZ = falseFrontZ;
  const dancerLegs: StructurePart = {
    geometry: new CylinderGeometry(0.018, 0.018, dancerLegHeight, 5),
    material: lambert(0x3a3226),
    localMatrices: [
      at(dancerBoardHalfWidth * 0.7, falseFrontTopY + dancerLegHeight / 2, dancerBoardZ),
      at(-dancerBoardHalfWidth * 0.7, falseFrontTopY + dancerLegHeight / 2, dancerBoardZ),
    ],
  };
  const dancerBoard: StructurePart = {
    geometry: new BoxGeometry(dancerBoardHalfWidth * 2, dancerBoardHalfHeight * 2, dancerBoardThickness),
    material: lambert(0x2a1218),
    localMatrices: [at(0, dancerBoardY, dancerBoardZ)],
  };

  const dancerFigureBaseY = dancerBoardBottomY + 0.05;
  const dancerZ = dancerBoardZ + dancerBoardThickness / 2 + DURANDS_DANCER_TUBE_RADIUS;

  const dancerFrameMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_FRAME_COLOR,
    emissiveIntensity: DURANDS_DANCER_FRAME_EMISSIVE_INTENSITY,
  });
  const frameU = dancerBoardHalfWidth - DURANDS_DANCER_FRAME_INSET;
  const frameTop = dancerBoardY + dancerBoardHalfHeight - DURANDS_DANCER_FRAME_INSET;
  const frameBottom = dancerBoardY - dancerBoardHalfHeight + DURANDS_DANCER_FRAME_INSET;
  const dancerFrameTubes: StructurePart = {
    geometry: new CylinderGeometry(
      DURANDS_DANCER_FRAME_TUBE_RADIUS,
      DURANDS_DANCER_FRAME_TUBE_RADIUS,
      DURANDS_DANCER_SEGMENT_UNIT,
      5,
    ),
    material: dancerFrameMaterial,
    localMatrices: [
      dancerSegment(-frameU, frameTop, frameU, frameTop, dancerZ),
      dancerSegment(-frameU, frameBottom, frameU, frameBottom, dancerZ),
      dancerSegment(-frameU, frameBottom, -frameU, frameTop, dancerZ),
      dancerSegment(frameU, frameBottom, frameU, frameTop, dancerZ),
    ],
  };

  const dancerPole: StructurePart = {
    geometry: new CylinderGeometry(
      DURANDS_DANCER_POLE_RADIUS,
      DURANDS_DANCER_POLE_RADIUS,
      dancerBoardHalfHeight * 2 - 0.04,
      6,
    ),
    material: new MeshLambertMaterial({
      color: DURANDS_DANCER_TUBE_COLOR,
      flatShading: true,
      emissive: DURANDS_DANCER_POLE_COLOR,
      emissiveIntensity: DURANDS_DANCER_POLE_EMISSIVE_INTENSITY,
    }),
    localMatrices: [at(DURANDS_DANCER_POLE_U, dancerBoardY, dancerZ)],
  };

  const dancerBodyMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_BODY_EMISSIVE_INTENSITY,
  });
  const dancerPoseAMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MAX,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const dancerPoseBMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MIN,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const dancerSegmentGeometry = new CylinderGeometry(
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_SEGMENT_UNIT,
    5,
  );
  const dancerCircleGeometry = new SphereGeometry(DURANDS_DANCER_HEAD_RADIUS, 8, 6);

  const body = buildDancerStrokes(DURANDS_DANCER_BODY_STROKES, 0, dancerFigureBaseY, dancerZ);
  body.circles.push(
    dancerCircle(
      DURANDS_DANCER_BODY_HEAD[0],
      dancerFigureBaseY + DURANDS_DANCER_BODY_HEAD[1],
      dancerZ,
      DURANDS_DANCER_HEAD_RADIUS,
    ),
    dancerCircle(
      DURANDS_DANCER_BODY_BUST[0],
      dancerFigureBaseY + DURANDS_DANCER_BODY_BUST[1],
      dancerZ,
      DURANDS_DANCER_BUST_RADIUS,
    ),
  );
  const limbsA = buildDancerStrokes(DURANDS_DANCER_LIMBS_A, 0, dancerFigureBaseY, dancerZ);
  const limbsB = buildDancerStrokes(DURANDS_DANCER_LIMBS_B, 0, dancerFigureBaseY, dancerZ);

  const dancerBodyTubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerBodyMaterial,
    localMatrices: body.segments,
  };
  const dancerBodyCircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerBodyMaterial,
    localMatrices: body.circles,
  };
  const dancerPoseATubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseAMaterial,
    localMatrices: limbsA.segments,
  };
  const dancerPoseACircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerPoseAMaterial,
    localMatrices: limbsA.circles,
  };
  const dancerPoseBTubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseBMaterial,
    localMatrices: limbsB.segments,
  };
  const dancerPoseBCircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerPoseBMaterial,
    localMatrices: limbsB.circles,
  };

  return {
    parts: [
      boardwalk,
      groundFloor,
      secondFloor,
      falseFront,
      roofCap,
      porchRoof,
      porchPosts,
      windows,
      backDoor,
      saloonDoors,
      sign,
      marqueeBulbsPhaseA,
      marqueeBulbsPhaseB,
      dancerLegs,
      dancerBoard,
      dancerFrameTubes,
      dancerPole,
      dancerBodyTubes,
      dancerBodyCircles,
      dancerPoseATubes,
      dancerPoseACircles,
      dancerPoseBTubes,
      dancerPoseBCircles,
    ],
    signMaterial,
    marqueePhaseAMaterial,
    marqueePhaseBMaterial,
    dancerPoseAMaterial,
    dancerPoseBMaterial,
  };
}

export interface StructurePlacement {
  readonly x: number;
  readonly z: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly tier: StructureTier;
  readonly scale: number;
  readonly yaw: number;
  readonly race: SettlerRace;
  readonly site: SiteKind;
}

export const RACE_TINTS: Readonly<Record<SettlerRace, number>> = {
  rudy: 0xffe9cf,
  uno: 0xd9e4f5,
};

export interface StructureModels {
  readonly root: Group;
  apply(placements: readonly StructurePlacement[]): void;
  animate(dt: number): void;
  dispose(): void;
}

const MATRIX_ELEMENT_COUNT = 16;

const COLOR_ELEMENT_COUNT = 3;

function uploadInstancePrefix(
  attribute: InstancedBufferAttribute,
  instanceCount: number,
  elementsPerInstance: number,
): void {
  if (instanceCount === 0) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, instanceCount * elementsPerInstance);
  attribute.needsUpdate = true;
}

function assertHeightBudgetStillHolds(tierParts: readonly StructurePart[][]): void {
  let tallestProcedural = 0;
  for (let tier = 0; tier < tierParts.length; tier++) {
    if (tier === IMPORTED_STRUCTURE_TIER) continue;
    tallestProcedural = Math.max(tallestProcedural, partsStandingHeight(tierParts[tier]));
  }
  if (TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS > tallestProcedural) {
    throw new Error(
      `structures: TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS is ` +
        `${TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS}, but the tallest procedural tier now ` +
        `stands ${tallestProcedural.toFixed(3)} — lower the constant to match, or an imported ` +
        `asset may tower over every building in the game`,
    );
  }
}

export function createStructureModels(): StructureModels {
  const tierParts = buildTierParts().map((parts) => mergeParts(parts));
  if (tierParts.length !== STRUCTURE_TIER_COUNT) {
    throw new Error(`structures: built ${tierParts.length} tier models, expected ${STRUCTURE_TIER_COUNT}`);
  }
  assertHeightBudgetStillHolds(tierParts);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const root = new Group();
  root.name = 'structures:buildings';

  const meshesByTier: InstancedMesh[][] = tierParts.map((parts, tier) =>
    parts.map((part, partIndex) => {
      geometries.push(part.geometry);
      materials.push(part.material);
      const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
      mesh.name = `structures:tier${String(tier)}:part${String(partIndex)}`;
      mesh.count = 0;
      root.add(mesh);
      return mesh;
    }),
  );

  const durands = buildDurandsParts();
  const durandsParts = mergeSharedSurface(
    fitToRadius(durands.parts, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX),
  );
  const durandsMeshes: InstancedMesh[] = durandsParts.map((part, partIndex) => {
    geometries.push(part.geometry);
    materials.push(part.material);
    const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
    mesh.name = `structures:durands:part${String(partIndex)}`;
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  const siteVariantParts: Partial<Record<SiteKind, StructurePart[][]>> = {};
  const siteVariantMeshes: Partial<Record<SiteKind, InstancedMesh[][]>> = {};
  for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
    const built = SITE_TOP_TIER_VARIANTS[siteKind]!.builders.map((build) => build());
    siteVariantParts[siteKind] = built;
    siteVariantMeshes[siteKind] = built.map((parts, variant) =>
      parts.map((part, partIndex) => {
        geometries.push(part.geometry);
        materials.push(part.material);
        const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
        mesh.name = `structures:${siteKind}${String(variant)}:part${String(partIndex)}`;
        mesh.count = 0;
        root.add(mesh);
        return mesh;
      }),
    );
  }

  const buildingPosition = new Vector3();
  const buildingRotation = new Quaternion();
  const buildingScale = new Vector3();
  const buildingMatrix = new Matrix4();
  const instanceMatrix = new Matrix4();
  const raceTints: Readonly<Record<SettlerRace, Color>> = {
    rudy: new Color(RACE_TINTS.rudy),
    uno: new Color(RACE_TINTS.uno),
  };

  let durandsFlashElapsedSeconds = 0;

  function writeInstances(
    parts: StructurePart[],
    meshes: InstancedMesh[],
    counts: number[],
    tint: Color | null,
  ): void {
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const mesh = meshes[partIndex];
      let count = counts[partIndex];
      for (const local of part.localMatrices) {
        instanceMatrix.multiplyMatrices(buildingMatrix, local);
        if (tint !== null) mesh.setColorAt(count, tint);
        mesh.setMatrixAt(count++, instanceMatrix);
      }
      counts[partIndex] = count;
    }
  }

  function finalizeMeshes(meshes: InstancedMesh[], counts: number[]): void {
    for (let partIndex = 0; partIndex < meshes.length; partIndex++) {
      const mesh = meshes[partIndex];
      mesh.count = counts[partIndex];
      uploadInstancePrefix(mesh.instanceMatrix, mesh.count, MATRIX_ELEMENT_COUNT);
      if (mesh.instanceColor !== null) {
        uploadInstancePrefix(mesh.instanceColor, mesh.count, COLOR_ELEMENT_COUNT);
      }
      mesh.computeBoundingSphere();
    }
  }

  return {
    root,

    apply(placements: readonly StructurePlacement[]): void {
      const counts = meshesByTier.map((parts) => parts.map(() => 0));
      const durandsCounts = durandsMeshes.map(() => 0);
      const siteVariantCounts: Partial<Record<SiteKind, number[][]>> = {};
      for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
        siteVariantCounts[siteKind] = siteVariantParts[siteKind]!.map((parts) => parts.map(() => 0));
      }

      for (const placement of placements) {
        buildingPosition.set(placement.x, placement.groundY, placement.z);
        buildingRotation.setFromAxisAngle(Y_AXIS, placement.yaw);
        buildingScale.setScalar(placement.scale);
        buildingMatrix.compose(buildingPosition, buildingRotation, buildingScale);

        const variantSet = SITE_TOP_TIER_VARIANTS[placement.site];
        if (placement.tier === MAX_STRUCTURE_TIER && variantSet !== undefined) {
          const built = siteVariantParts[placement.site]!;
          const variant = Math.min(Math.max(variantSet.pick(placement.cellX, placement.cellY), 0), built.length - 1);
          writeInstances(
            built[variant],
            siteVariantMeshes[placement.site]![variant],
            siteVariantCounts[placement.site]![variant],
            raceTints[placement.race],
          );
          continue;
        }

        if (isDurandsCell(placement.tier, placement.cellX, placement.cellY)) {
          writeInstances(durandsParts, durandsMeshes, durandsCounts, null);
          continue;
        }

        const parts = tierParts[placement.tier];
        const meshes = meshesByTier[placement.tier];
        if (parts === undefined || meshes === undefined) continue;
        writeInstances(parts, meshes, counts[placement.tier], raceTints[placement.race]);
      }

      for (let tier = 0; tier < meshesByTier.length; tier++) finalizeMeshes(meshesByTier[tier], counts[tier]);
      finalizeMeshes(durandsMeshes, durandsCounts);
      for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
        const meshes = siteVariantMeshes[siteKind]!;
        const counts = siteVariantCounts[siteKind]!;
        for (let variant = 0; variant < meshes.length; variant++) finalizeMeshes(meshes[variant], counts[variant]);
      }
    },

    animate(dt: number): void {
      durandsFlashElapsedSeconds += dt;
      const angle = durandsFlashElapsedSeconds * (DURANDS_TWO_PI / DURANDS_SIGN_FLASH_PERIOD_SECONDS);
      const t = (Math.sin(angle) + 1) / 2;
      durands.signMaterial.emissiveIntensity =
        DURANDS_SIGN_EMISSIVE_MIN + t * (DURANDS_SIGN_EMISSIVE_MAX - DURANDS_SIGN_EMISSIVE_MIN);

      const marqueeAngle = durandsFlashElapsedSeconds * (DURANDS_TWO_PI / DURANDS_MARQUEE_BULB_PERIOD_SECONDS);
      const phaseAT = (Math.sin(marqueeAngle) + 1) / 2;
      const phaseBT = (Math.sin(marqueeAngle + Math.PI) + 1) / 2;
      durands.marqueePhaseAMaterial.emissiveIntensity =
        DURANDS_MARQUEE_BULB_EMISSIVE_MIN + phaseAT * (DURANDS_MARQUEE_BULB_EMISSIVE_MAX - DURANDS_MARQUEE_BULB_EMISSIVE_MIN);
      durands.marqueePhaseBMaterial.emissiveIntensity =
        DURANDS_MARQUEE_BULB_EMISSIVE_MIN + phaseBT * (DURANDS_MARQUEE_BULB_EMISSIVE_MAX - DURANDS_MARQUEE_BULB_EMISSIVE_MIN);

      durands.dancerPoseAMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseAT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
      durands.dancerPoseAMaterial.opacity = phaseAT;
      durands.dancerPoseBMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseBT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
      durands.dancerPoseBMaterial.opacity = phaseBT;
    },

    dispose(): void {
      for (const parts of meshesByTier) for (const mesh of parts) mesh.dispose();
      for (const mesh of durandsMeshes) mesh.dispose();
      for (const variants of Object.values(siteVariantMeshes)) {
        for (const meshes of variants!) for (const mesh of meshes) mesh.dispose();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
