// The placement beacon: a bright spire on the temple's summit, drawn only
// while the Temple tool is held, so a hidden temple is still findable.

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

/** How tall the spire stands above the summit. The world's whole relief, so
 *  no column of terrain can reach past the tip. */
const SPIRE_HEIGHT = MAX_RELIEF_WORLD_UNITS;

/** Radius at the foot, as a fraction of the temple's footprint span. */
const SPIRE_FOOT_RADIUS_FRACTION = 0.1;

/** Where the shaft ends and the point begins, as a fraction of the foot. A
 *  spire tapering to nothing would be a hairline for most of its height. */
const SPIRE_NECK_OF_FOOT = 0.34;

/** Share of the height given to the point rather than the tapering shaft. */
const SPIRE_POINT_SHARE = 0.16;

/** Facets. Six reads as a needle from any angle and costs nothing extra. */
const SPIRE_SEGMENTS = 6;

/** The additive sheath around the needle, as a multiple of its radii. */
const SHEATH_SCALE = 2.4;

/** Gold: the hue the terrain ramp and the sky colour both leave free. Unlit
 *  materials carry it, so the sun can never dim the beacon. */
const SPIRE_COLOR = 0xfff0a8;
const SHEATH_COLOR = 0xffbe3d;

/** The sheath's breath — slow enough to read as a beacon, not a blinker. */
const SHEATH_BREATH_HZ = 0.45;
const SHEATH_OPACITY_BASE = 0.34;
const SHEATH_OPACITY_SWING = 0.16;

/** Drawn last. With the depth test off, render order alone decides what
 *  covers what, so the beacon claims a value above every scene default. */
const BEACON_RENDER_ORDER = 10;

const TWO_PI = Math.PI * 2;

/**
 * One spire, merged into a single geometry: a tapering shaft with a point on
 * top, its foot at y = 0 and its tip at y = SPIRE_HEIGHT.
 */
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
  // Null only on mismatched attributes, which two cylinders cannot have — but
  // the render loop must never meet one.
  return merged ?? new CylinderGeometry(0, footRadius, SPIRE_HEIGHT, SPIRE_SEGMENTS, 1, true);
}

/** What the caller gets: a group to parent, and a clock to drive it. */
export interface PlacementBeacon {
  /** Parent this into the standing temple, at the temple's own origin. */
  readonly root: Group;
  /** Whether the spire is drawn at all — true only in placement mode. */
  setVisible(visible: boolean): void;
  /** Poses the sheath for the given elapsed seconds. Pure in `seconds`, so a
   *  dropped frame cannot leave the breath out of step. */
  animate(seconds: number): void;
  dispose(): void;
}

/**
 * Builds the beacon for a temple of `span` world units whose summit stands
 * `summitY` above its base.
 */
export function createPlacementBeacon(span: number, summitY: number): PlacementBeacon {
  const footRadius = span * SPIRE_FOOT_RADIUS_FRACTION;
  const needleGeometry = spireGeometry(footRadius);
  const sheathGeometry = spireGeometry(footRadius * SHEATH_SCALE);

  const needleMaterial = new MeshBasicMaterial({
    color: SPIRE_COLOR,
    // Both off together: the world never hides the beacon, and the beacon
    // never hides the world.
    depthTest: false,
    depthWrite: false,
    // The cylinders are open-ended, so their back faces are the spire's far
    // wall — drawing them is what keeps it solid from every angle.
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
