import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';

const SPIRE_HEIGHT = MAX_RELIEF_WORLD_UNITS;

const SPIRE_FOOT_RADIUS_FRACTION = 0.1;

const SPIRE_NECK_OF_FOOT = 0.34;

const SPIRE_POINT_SHARE = 0.16;

const SPIRE_SEGMENTS = 6;

const SHEATH_SCALE = 2.4;

const SPIRE_COLOR = 0xfff0a8;
const SHEATH_COLOR = 0xffbe3d;

const SHEATH_BREATH_HZ = 0.45;
const SHEATH_OPACITY_BASE = 0.34;
const SHEATH_OPACITY_SWING = 0.16;

const BEACON_RENDER_ORDER = 10;

const TWO_PI = Math.PI * 2;

function spireGeometry(footRadius: number): BufferGeometry {
  const neckRadius = footRadius * SPIRE_NECK_OF_FOOT;
  const pointHeight = SPIRE_HEIGHT * SPIRE_POINT_SHARE;
  const shaftHeight = SPIRE_HEIGHT - pointHeight;

  const shaft = new CylinderGeometry(
    neckRadius,
    footRadius,
    shaftHeight,
    SPIRE_SEGMENTS,
    1,
    true,
  );
  shaft.translate(0, shaftHeight / 2, 0);

  const point = new CylinderGeometry(0, neckRadius, pointHeight, SPIRE_SEGMENTS, 1, true);
  point.translate(0, shaftHeight + pointHeight / 2, 0);

  const merged = mergeGeometries([shaft, point], false);
  shaft.dispose();
  point.dispose();
  return merged ?? new CylinderGeometry(0, footRadius, SPIRE_HEIGHT, SPIRE_SEGMENTS, 1, true);
}

export interface PlacementBeacon {
  readonly root: Group;
  setVisible(visible: boolean): void;
  animate(seconds: number): void;
  dispose(): void;
}

export function createPlacementBeacon(span: number, summitY: number): PlacementBeacon {
  const footRadius = span * SPIRE_FOOT_RADIUS_FRACTION;
  const needleGeometry = spireGeometry(footRadius);
  const sheathGeometry = spireGeometry(footRadius * SHEATH_SCALE);

  const needleMaterial = new MeshBasicMaterial({
    color: SPIRE_COLOR,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const sheathMaterial = new MeshBasicMaterial({
    color: SHEATH_COLOR,
    transparent: true,
    opacity: SHEATH_OPACITY_BASE,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });

  const needle = new Mesh(needleGeometry, needleMaterial);
  const sheath = new Mesh(sheathGeometry, sheathMaterial);
  needle.renderOrder = BEACON_RENDER_ORDER;
  sheath.renderOrder = BEACON_RENDER_ORDER;

  const root = new Group();
  root.name = 'temples:beacon';
  root.position.y = summitY;
  root.add(sheath, needle);
  root.visible = false;

  return {
    root,
    setVisible(visible: boolean): void {
      root.visible = visible;
    },
    animate(seconds: number): void {
      const breath = Math.sin(seconds * TWO_PI * SHEATH_BREATH_HZ);
      sheathMaterial.opacity = SHEATH_OPACITY_BASE + breath * SHEATH_OPACITY_SWING;
    },
    dispose(): void {
      root.clear();
      needleGeometry.dispose();
      sheathGeometry.dispose();
      needleMaterial.dispose();
      sheathMaterial.dispose();
    },
  };
}
