import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS,
  TEMPLE_FRONT_APRON_WORLD_UNITS,
} from '../protocol.ts';
import { createCelestialCrown, type CelestialCrown } from './celestial.ts';
import { createPlacementBeacon, type PlacementBeacon } from './beacon.ts';

const BASE_SPAN = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS;

const COURSE_COUNT = 4;

const COURSE_INSET_FRACTION = 0.09;

const COURSE_HEIGHT_FRACTION = 0.13;

const PLINTH_HEIGHT_FRACTION = 0.045;

const SHRINE_WIDTH_FRACTION = 0.78;
const SHRINE_HEIGHT_FRACTION = 0.3;

const LINTEL_OVERHANG_OF_SHRINE = 0.09;
const LINTEL_TOP_COURSE_REVEAL = 0.08;
const LINTEL_HEIGHT_FRACTION = 0.035;

const STAIR_WIDTH_FRACTION = 0.26;

const OPENING_MIN_HEIGHT_OVER_WIDTH = 1.6;

function opening(
  maxWidth: number,
  height: number,
): { readonly width: number; readonly height: number } {
  return { width: Math.min(maxWidth, height / OPENING_MIN_HEIGHT_OVER_WIDTH), height };
}

const DOORWAY_MAX_WIDTH_FRACTION = 0.3;
const DOORWAY_HEIGHT_FRACTION = 0.2;

const PORTAL_MAX_WIDTH_FRACTION = 0.13;
const PORTAL_HEIGHT_FRACTION = 0.105;
const PORTAL_STAIR_GAP_FRACTION = 0.05;

const PLINTH_HEIGHT = BASE_SPAN * PLINTH_HEIGHT_FRACTION;
const COURSE_HEIGHT = BASE_SPAN * COURSE_HEIGHT_FRACTION;
const COURSE_INSET = BASE_SPAN * COURSE_INSET_FRACTION;
const STAIR_WIDTH = BASE_SPAN * STAIR_WIDTH_FRACTION;

const PORTAL = opening(
  BASE_SPAN * PORTAL_MAX_WIDTH_FRACTION,
  BASE_SPAN * PORTAL_HEIGHT_FRACTION,
);
const PORTAL_Z = STAIR_WIDTH / 2 + BASE_SPAN * PORTAL_STAIR_GAP_FRACTION + PORTAL.width / 2;

const STAIR_APRON_SHARE = 0.5;

const STAIR_TREAD_DEPTH = Math.min(
  COURSE_INSET * 2,
  TEMPLE_FRONT_APRON_WORLD_UNITS * STAIR_APRON_SHARE * 2,
);

export const TEMPLE_HEIGHT =
  PLINTH_HEIGHT +
  COURSE_HEIGHT * COURSE_COUNT +
  BASE_SPAN * SHRINE_HEIGHT_FRACTION +
  BASE_SPAN * LINTEL_HEIGHT_FRACTION;

const PLINTH_COLOR = 0x5f5a4e;
const COURSE_COLORS = [0x9a9280, 0x7e7767, 0x8d8574, 0x726b5c];
const STAIR_COLOR = 0xaea48e;
const SHRINE_COLOR = 0x8a8271;
const LINTEL_COLOR = 0x554f45;
const DOORWAY_COLOR = 0x141731;

function block(
  width: number,
  height: number,
  depth: number,
  x: number,
  bottomY: number,
  z: number,
  color: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(x, bottomY + height / 2, z);

  const rgb = new Color(color);
  const count = geometry.attributes['position']!.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = rgb.r;
    colors[i * 3 + 1] = rgb.g;
    colors[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

function buildTempleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(block(BASE_SPAN, PLINTH_HEIGHT, BASE_SPAN, 0, 0, 0, PLINTH_COLOR));

  let courseBottom = PLINTH_HEIGHT;
  const courseSpans: number[] = [];
  for (let i = 0; i < COURSE_COUNT; i++) {
    const span = BASE_SPAN - COURSE_INSET * 2 * i;
    courseSpans.push(span);
    parts.push(
      block(span, COURSE_HEIGHT, span, 0, courseBottom, 0, COURSE_COLORS[i % COURSE_COLORS.length]!),
    );
    courseBottom += COURSE_HEIGHT;
  }

  let stairBottom = PLINTH_HEIGHT;
  for (let i = 0; i < COURSE_COUNT; i++) {
    const span = courseSpans[i]!;
    parts.push(
      block(
        STAIR_TREAD_DEPTH,
        COURSE_HEIGHT,
        STAIR_WIDTH,
        span / 2,
        stairBottom,
        0,
        STAIR_COLOR,
      ),
    );
    stairBottom += COURSE_HEIGHT;
  }

  const summit = PLINTH_HEIGHT + COURSE_HEIGHT * COURSE_COUNT;
  const topSpan = courseSpans[COURSE_COUNT - 1]!;
  const shrineSpan = topSpan * SHRINE_WIDTH_FRACTION;
  const shrineHeight = BASE_SPAN * SHRINE_HEIGHT_FRACTION;
  parts.push(block(shrineSpan, shrineHeight, shrineSpan, 0, summit, 0, SHRINE_COLOR));

  const lintelSpan = Math.min(
    shrineSpan * (1 + LINTEL_OVERHANG_OF_SHRINE * 2),
    topSpan * (1 - LINTEL_TOP_COURSE_REVEAL),
  );
  const lintelHeight = BASE_SPAN * LINTEL_HEIGHT_FRACTION;
  parts.push(
    block(lintelSpan, lintelHeight, lintelSpan, 0, summit + shrineHeight, 0, LINTEL_COLOR),
  );

  const door = opening(
    BASE_SPAN * DOORWAY_MAX_WIDTH_FRACTION,
    BASE_SPAN * DOORWAY_HEIGHT_FRACTION,
  );
  const doorSkin = shrineSpan * 0.04;
  parts.push(
    block(
      doorSkin,
      door.height,
      door.width,
      shrineSpan / 2,
      summit,
      0,
      DOORWAY_COLOR,
    ),
  );

  const portalSkin = BASE_SPAN * 0.01;
  for (const side of [-1, 1]) {
    parts.push(
      block(
        portalSkin,
        PORTAL.height,
        PORTAL.width,
        courseSpans[0]! / 2,
        PLINTH_HEIGHT,
        PORTAL_Z * side,
        DOORWAY_COLOR,
      ),
    );
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged === null) {
    return block(BASE_SPAN, PLINTH_HEIGHT, BASE_SPAN, 0, 0, 0, PLINTH_COLOR);
  }
  merged.computeVertexNormals();
  return merged;
}

export interface TempleModels {
  readonly standing: Group;
  readonly ghost: Group;
  setGhostLegal(legal: boolean): void;
  setBeaconVisible(visible: boolean): void;
  animate(seconds: number): void;
  dispose(): void;
}

const GHOST_LEGAL_COLOR = 0x6fbf73;
const GHOST_ILLEGAL_COLOR = 0xd9634a;

export function createTempleModels(): TempleModels {
  const geometry = buildTempleGeometry();

  const stone = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const ghostMaterial = new MeshLambertMaterial({
    color: GHOST_LEGAL_COLOR,
    flatShading: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });

  const standing = new Group();
  standing.name = 'temples:standing';
  standing.add(new Mesh(geometry, stone));
  const crown: CelestialCrown = createCelestialCrown(BASE_SPAN, TEMPLE_HEIGHT);
  standing.add(crown.root);
  const beacon: PlacementBeacon = createPlacementBeacon(BASE_SPAN, TEMPLE_HEIGHT);
  standing.add(beacon.root);
  standing.visible = false;

  const ghost = new Group();
  ghost.name = 'temples:ghost';
  ghost.add(new Mesh(geometry, ghostMaterial));
  ghost.visible = false;

  return {
    standing,
    ghost,
    setGhostLegal(legal: boolean): void {
      ghostMaterial.color.setHex(legal ? GHOST_LEGAL_COLOR : GHOST_ILLEGAL_COLOR);
    },
    setBeaconVisible(visible: boolean): void {
      beacon.setVisible(visible);
    },
    animate(seconds: number): void {
      crown.animate(seconds);
      beacon.animate(seconds);
    },
    dispose(): void {
      beacon.dispose();
      crown.dispose();
      standing.clear();
      ghost.clear();
      geometry.dispose();
      stone.dispose();
      ghostMaterial.dispose();
    },
  };
}
