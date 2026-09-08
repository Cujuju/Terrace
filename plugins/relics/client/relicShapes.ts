import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SKILL_IDS, type SkillId } from '../protocol.ts';
import { cssColor, GEM_RADIUS_CELLS, relicColor } from './gems.ts';

export const RELIC_PALETTE = {
  amber: { light: '#ffe2b0', dark: '#8a5410' },
  crimson: { light: '#ffc2b8', dark: '#701818' },
  azure: { light: '#d8f4ff', dark: '#155c88' },
  water: { light: '#e2f7ff', dark: '#1a6fa0' },
  foam: { light: '#ffffff', dark: '#8fdcf5' },
  stone: { light: '#e6dcc8', dark: '#6a5a45' },
  grass: { light: '#c8f0a8', dark: '#3f7f3e' },
  bark: { light: '#a06a3a', dark: '#4a2c14' },
  rock: { light: '#7a6a5a', dark: '#2a2018' },
  tileTop: { light: '#a6e08a', dark: '#4f9a4a' },
  tileLeft: { light: '#9a6a45', dark: '#5a3a22' },
  tileRight: { light: '#6e4a2f', dark: '#3a2415' },
} as const;

export type Paint = keyof typeof RELIC_PALETTE;

interface PaintEnds {
  readonly light: string;
  readonly dark: string;
}

type Blend = (x: number, y: number, z: number) => number;

interface Part {
  readonly geometry: BufferGeometry;
  readonly paint: PaintEnds;
  readonly blend?: Blend;
}

export const CAST_SHADE = '#2e5a2e';

const TILE_GLOW_OPACITY = 0.3;
const CAST_SHADE_OPACITY = 0.5;

const TILE_HALF_WIDTH = 1;
const TILE_WALL_HEIGHT = 0.5;

const ICON_TILE_HALF_WIDTH_PX = 12;
const ICON_TILE_HALF_DEPTH_PX = 6;

const ICON_GLOW_ELLIPSE_PX: readonly [number, number] = [7, 3.2];

const ICON_SHADE_ELLIPSE_PX: Readonly<Record<SkillId, readonly [number, number]>> = {
  quake: [9, 3.8],
  genesis: [9, 3.8],
  'bedrock-ward': [8, 3.4],
  bulwark: [9, 3.8],
  landslide: [9, 3.8],
  'azure-heart': [6, 2.6],
  'spring-of-aether': [8.5, 3.6],
};

function tileRadiusFromIconEllipse([rx, ry]: readonly [number, number]): number {
  return (Math.SQRT2 * (rx / ICON_TILE_HALF_WIDTH_PX + ry / ICON_TILE_HALF_DEPTH_PX)) / 2;
}

const DECAL_SEGMENTS = 24;

const DECAL_LIFT = 0.01;

const ROUND_SEGMENTS = 10;
const SPHERE_SEGMENTS = 8;

const QUARTER_TURN = Math.PI / 2;

function place(
  geometry: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
): BufferGeometry {
  geometry.rotateX(rotX);
  geometry.rotateY(rotY);
  geometry.rotateZ(rotZ);
  geometry.translate(x, y, z);
  return geometry;
}

function painted(paint: Paint, ...geometries: BufferGeometry[]): Part[] {
  return geometries.map((geometry) => ({ geometry, paint: RELIC_PALETTE[paint] }));
}

const TILE_TOP_BLEND_AT_CENTRE = 0.5;
const TILE_TOP_BLEND_PER_UNIT = 0.25;
const tileTopBlend: Blend = (x) => TILE_TOP_BLEND_AT_CENTRE + TILE_TOP_BLEND_PER_UNIT * x;

const tileWallBlend: Blend = (_x, y) => -y / TILE_WALL_HEIGHT;

function tile(skill: SkillId): Part[] {
  const w = TILE_HALF_WIDTH * 2;
  const h = TILE_WALL_HEIGHT;
  const wallY = -h / 2;
  const top = place(new PlaneGeometry(w, w), 0, 0, 0, -QUARTER_TURN);
  const lit = [
    place(new PlaneGeometry(w, h), -TILE_HALF_WIDTH, wallY, 0, 0, -QUARTER_TURN),
    place(new PlaneGeometry(w, h), 0, wallY, TILE_HALF_WIDTH),
  ];
  const shaded = [
    place(new PlaneGeometry(w, h), TILE_HALF_WIDTH, wallY, 0, 0, QUARTER_TURN),
    place(new PlaneGeometry(w, h), 0, wallY, -TILE_HALF_WIDTH, 0, 2 * QUARTER_TURN),
  ];
  const underside = place(new PlaneGeometry(w, w), 0, -h, 0, QUARTER_TURN);

  const glow = cssColor(relicColor(skill));
  const grass = RELIC_PALETTE.tileTop;
  const glowed = overlay(grass, glow, TILE_GLOW_OPACITY);
  const shadedGrass = overlay(grass, CAST_SHADE, CAST_SHADE_OPACITY);
  const both = overlay(glowed, CAST_SHADE, CAST_SHADE_OPACITY);
  const glowRadius = tileRadiusFromIconEllipse(ICON_GLOW_ELLIPSE_PX);
  const shadeRadius = tileRadiusFromIconEllipse(ICON_SHADE_ELLIPSE_PX[skill]);
  const inner = Math.min(glowRadius, shadeRadius);
  const outer = Math.max(glowRadius, shadeRadius);
  const disc = place(new CircleGeometry(inner, DECAL_SEGMENTS), 0, DECAL_LIFT, 0, -QUARTER_TURN);
  const ring = place(new RingGeometry(inner, outer, DECAL_SEGMENTS), 0, DECAL_LIFT, 0, -QUARTER_TURN);

  return [
    { geometry: top, paint: grass, blend: tileTopBlend },
    ...lit.map((geometry) => ({ geometry, paint: RELIC_PALETTE.tileLeft, blend: tileWallBlend })),
    ...shaded.map((geometry) => ({ geometry, paint: RELIC_PALETTE.tileRight, blend: tileWallBlend })),
    { geometry: underside, paint: RELIC_PALETTE.tileRight, blend: () => 1 },
    { geometry: disc, paint: both, blend: tileTopBlend },
    { geometry: ring, paint: shadeRadius > glowRadius ? shadedGrass : glowed, blend: tileTopBlend },
  ];
}

function overlay(paint: PaintEnds, hex: string, opacity: number): PaintEnds {
  return { light: mixHex(paint.light, hex, opacity), dark: mixHex(paint.dark, hex, opacity) };
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexChannels(a);
  const cb = hexChannels(b);
  const mixed = ca.map((c, i) => Math.round(c + (cb[i]! - c) * t));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const MODEL_AXIS = new Vector3(0, 1, 0);

type Point = readonly [number, number, number];

function orient(geometry: BufferGeometry, dir: Point, x: number, y: number, z: number): BufferGeometry {
  const to = new Vector3(dir[0], dir[1], dir[2]).normalize();
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(MODEL_AXIS, to));
  geometry.translate(x, y, z);
  return geometry;
}

function strut(from: Point, to: Point, radiusTo: number, radiusFrom: number, segments: number): BufferGeometry {
  const dir: Point = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  return orient(
    new CylinderGeometry(radiusTo, radiusFrom, length, segments),
    dir,
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2,
  );
}

function roundedRectShape(width: number, height: number, radius: number): Shape {
  const x = width / 2 - radius;
  const y = height / 2 - radius;
  const outline = new Shape();
  outline.absarc(x, y, radius, 0, QUARTER_TURN, false);
  outline.absarc(-x, y, radius, QUARTER_TURN, 2 * QUARTER_TURN, false);
  outline.absarc(-x, -y, radius, 2 * QUARTER_TURN, 3 * QUARTER_TURN, false);
  outline.absarc(x, -y, radius, 3 * QUARTER_TURN, 4 * QUARTER_TURN, false);
  outline.closePath();
  return outline;
}

const QUAKE_DISC_RADIUS = 1;

const QUAKE_RINGS = 40;
const QUAKE_SPOKES = 48;

const QUAKE_WAVE_CYCLES = 3;
const QUAKE_WAVE_AMPLITUDE = 0.42;

const QUAKE_RIM_AMPLITUDE_SHARE = 0.25;

const QUAKE_SHEET_THICKNESS = 0.07;

const QUAKE_HOVER = 0.3;

function quakeWaveHeight(r: number): number {
  const decay = 1 - (1 - QUAKE_RIM_AMPLITUDE_SHARE) * (r / QUAKE_DISC_RADIUS);
  const crest = (1 - Math.cos((r / QUAKE_DISC_RADIUS) * QUAKE_WAVE_CYCLES * Math.PI * 2)) / 2;
  return QUAKE_HOVER + QUAKE_SHEET_THICKNESS + QUAKE_WAVE_AMPLITUDE * decay * crest;
}

function rippleSurface(
  radius: number,
  rings: number,
  spokes: number,
  height: (r: number) => number,
  faceUp = true,
): BufferGeometry {
  const at = (ring: number, spoke: number): Point => {
    const r = (ring / rings) * radius;
    const a = (spoke / spokes) * Math.PI * 2;
    return [Math.cos(a) * r, height(r), Math.sin(a) * r];
  };
  const tris: number[] = [];
  const push = (...pts: Point[]): void => {
    for (const p of pts) tris.push(p[0], p[1], p[2]);
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let spoke = 0; spoke < spokes; spoke++) {
      const a = at(ring, spoke);
      const b = at(ring, spoke + 1);
      const c = at(ring + 1, spoke + 1);
      const d = at(ring + 1, spoke);
      if (faceUp) {
        if (ring > 0) push(a, b, c);
        push(a, c, d);
      } else {
        if (ring > 0) push(a, c, b);
        push(a, d, c);
      }
    }
  }
  return unrolledGeometry(tris);
}

function unrolledGeometry(tris: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(tris, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array((tris.length / 3) * 2), 2));
  geometry.computeVertexNormals();
  return geometry;
}

function rippleWall(radius: number, spokes: number, rimHeight: number, floor: number): BufferGeometry {
  const tris: number[] = [];
  for (let spoke = 0; spoke < spokes; spoke++) {
    const a0 = (spoke / spokes) * Math.PI * 2;
    const a1 = ((spoke + 1) / spokes) * Math.PI * 2;
    const [x0, z0] = [Math.cos(a0) * radius, Math.sin(a0) * radius];
    const [x1, z1] = [Math.cos(a1) * radius, Math.sin(a1) * radius];
    tris.push(x0, floor, z0, x0, rimHeight, z0, x1, rimHeight, z1);
    tris.push(x0, floor, z0, x1, rimHeight, z1, x1, floor, z1);
  }
  return unrolledGeometry(tris);
}

function quake(): Part[] {
  const face = rippleSurface(QUAKE_DISC_RADIUS, QUAKE_RINGS, QUAKE_SPOKES, quakeWaveHeight);
  const underside = rippleSurface(
    QUAKE_DISC_RADIUS,
    QUAKE_RINGS,
    QUAKE_SPOKES,
    (r) => quakeWaveHeight(r) - QUAKE_SHEET_THICKNESS,
    false,
  );
  const rim = quakeWaveHeight(QUAKE_DISC_RADIUS);
  const wall = rippleWall(QUAKE_DISC_RADIUS, QUAKE_SPOKES, rim, rim - QUAKE_SHEET_THICKNESS);
  return [...painted('rock', underside, wall), ...painted('crimson', face)];
}

const GENESIS_BEACH_HEIGHT = 0.16;
const GENESIS_MOUND_HEIGHT = 0.3;

const GENESIS_PLUG_RADIUS = 0.32;
const GENESIS_PLUG_FLARE = 0.02;

const GENESIS_STRATA: readonly { readonly paint: Paint; readonly height: number }[] = [
  { paint: 'tileTop', height: 0.1 },
  { paint: 'tileLeft', height: 0.22 },
  { paint: 'rock', height: 0.3 },
  { paint: 'tileLeft', height: 0.18 },
];

const GENESIS_LIFT = 0.42;

const GENESIS_FISSURE_RADIUS = 0.42;
const GENESIS_FISSURE_TUBE = 0.035;

const GENESIS_CLODS: readonly { readonly bearing: number; readonly height: number; readonly out: number; readonly size: number }[] = [
  { bearing: 0.4, height: 0.16, out: 0.62, size: 0.09 },
  { bearing: 1.9, height: 0.42, out: 0.58, size: 0.07 },
  { bearing: 3.3, height: 0.1, out: 0.7, size: 0.11 },
  { bearing: 4.6, height: 0.55, out: 0.55, size: 0.06 },
  { bearing: 5.6, height: 0.3, out: 0.66, size: 0.08 },
];
const GENESIS_CLOD_SEGMENTS = 5;

function genesis(): Part[] {
  const beach = place(
    new CylinderGeometry(0.8, 1, GENESIS_BEACH_HEIGHT, ROUND_SEGMENTS),
    0,
    GENESIS_BEACH_HEIGHT / 2,
    0,
  );
  const moundTop = GENESIS_BEACH_HEIGHT + GENESIS_MOUND_HEIGHT;
  const mound = place(
    new CylinderGeometry(0.55, 0.8, GENESIS_MOUND_HEIGHT, ROUND_SEGMENTS),
    0,
    GENESIS_BEACH_HEIGHT + GENESIS_MOUND_HEIGHT / 2,
    0,
  );
  const strata: Part[] = [];
  let y = moundTop + GENESIS_LIFT;
  for (let i = GENESIS_STRATA.length - 1; i >= 0; i--) {
    const { paint, height } = GENESIS_STRATA[i]!;
    const top = GENESIS_PLUG_RADIUS + GENESIS_PLUG_FLARE * i;
    const bottom = top + GENESIS_PLUG_FLARE;
    strata.push(
      ...painted(paint, place(new CylinderGeometry(top, bottom, height, ROUND_SEGMENTS), 0, y + height / 2, 0)),
    );
    y += height;
  }
  const fissure = place(
    new TorusGeometry(GENESIS_FISSURE_RADIUS, GENESIS_FISSURE_TUBE, 5, ROUND_SEGMENTS),
    0,
    moundTop,
    0,
    QUARTER_TURN,
  );
  const clods = GENESIS_CLODS.map(({ bearing, height, out, size }) =>
    place(
      new SphereGeometry(size, GENESIS_CLOD_SEGMENTS, GENESIS_CLOD_SEGMENTS),
      Math.cos(bearing) * out,
      moundTop + height,
      Math.sin(bearing) * out,
    ),
  );
  return [
    ...painted('stone', beach),
    ...painted('grass', mound),
    ...strata,
    ...painted('crimson', fissure),
    ...painted('tileLeft', ...clods),
  ];
}

function azureHeart(): Part[] {
  const outline = new Shape();
  outline.moveTo(0, -0.85);
  outline.bezierCurveTo(-0.95, -0.15, -0.95, 0.75, -0.42, 0.75);
  outline.bezierCurveTo(-0.15, 0.75, 0, 0.55, 0, 0.35);
  outline.bezierCurveTo(0, 0.55, 0.15, 0.75, 0.42, 0.75);
  outline.bezierCurveTo(0.95, 0.75, 0.95, -0.15, 0, -0.85);
  const heart = new ExtrudeGeometry(outline, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 1,
  });
  heart.translate(0, 0.95, -0.17);
  return painted('azure', heart);
}

const SPRING_ROCK_HEIGHT = 0.35;
const SPRING_POOL_DEPTH = 0.06;

const FOUNTAIN_COLUMN_HEIGHT = 0.72;
const FOUNTAIN_COLUMN_RADIUS_FOOT = 0.08;
const FOUNTAIN_COLUMN_RADIUS_HEAD = 0.17;

const FOUNTAIN_PLUME_CORE_RADIUS = 0.17;
const FOUNTAIN_PLUME_BURST_RADIUS = 0.12;
const FOUNTAIN_PLUME_BURST_COUNT = 5;
const FOUNTAIN_PLUME_BURST_REACH = 0.17;
const FOUNTAIN_PLUME_BURST_RISE = 0.09;

const FOUNTAIN_SPRAY_ARCS = 6;
const FOUNTAIN_SPRAY_REACH = 0.46;
const FOUNTAIN_SPRAY_RISE = 0.16;
const FOUNTAIN_SPRAY_STEPS = 3;
const FOUNTAIN_SPRAY_RADIUS = 0.028;

const FOUNTAIN_DROPLET_RADIUS = 0.055;
const FOUNTAIN_DROPLET_COUNT = 4;
const FOUNTAIN_DROPLET_REACH = 0.36;

const TURN = Math.PI * 2;

function springOfAether(): Part[] {
  const rock = place(new CylinderGeometry(0.75, 0.95, SPRING_ROCK_HEIGHT, 7), 0, SPRING_ROCK_HEIGHT / 2, 0);
  const rockTop = SPRING_ROCK_HEIGHT;
  const rim = place(new TorusGeometry(0.58, 0.1, 6, ROUND_SEGMENTS), 0, rockTop, 0, QUARTER_TURN);
  const pool = place(new CylinderGeometry(0.52, 0.52, SPRING_POOL_DEPTH, ROUND_SEGMENTS), 0, rockTop, 0);
  const waterLevel = rockTop + SPRING_POOL_DEPTH / 2;

  const column = place(
    new CylinderGeometry(
      FOUNTAIN_COLUMN_RADIUS_HEAD,
      FOUNTAIN_COLUMN_RADIUS_FOOT,
      FOUNTAIN_COLUMN_HEIGHT,
      ROUND_SEGMENTS,
    ),
    0,
    waterLevel + FOUNTAIN_COLUMN_HEIGHT / 2,
    0,
  );
  const plumeY = waterLevel + FOUNTAIN_COLUMN_HEIGHT;
  const core = place(
    new SphereGeometry(FOUNTAIN_PLUME_CORE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
    0,
    plumeY,
    0,
  );
  const burst = Array.from({ length: FOUNTAIN_PLUME_BURST_COUNT }, (_, i) => {
    const angle = (i / FOUNTAIN_PLUME_BURST_COUNT) * TURN;
    return place(
      new SphereGeometry(FOUNTAIN_PLUME_BURST_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
      Math.cos(angle) * FOUNTAIN_PLUME_BURST_REACH,
      plumeY + FOUNTAIN_PLUME_BURST_RISE,
      Math.sin(angle) * FOUNTAIN_PLUME_BURST_REACH,
    );
  });

  const fall = plumeY - waterLevel;
  const sprayHeight = (t: number): number =>
    plumeY + FOUNTAIN_SPRAY_RISE * t - (FOUNTAIN_SPRAY_RISE + fall) * t * t;
  const spray = Array.from({ length: FOUNTAIN_SPRAY_ARCS }, (_, i) => {
    const angle = (i / FOUNTAIN_SPRAY_ARCS) * TURN;
    const at = (t: number): Point => [
      Math.cos(angle) * (FOUNTAIN_PLUME_BURST_REACH + (FOUNTAIN_SPRAY_REACH - FOUNTAIN_PLUME_BURST_REACH) * t),
      sprayHeight(t),
      Math.sin(angle) * (FOUNTAIN_PLUME_BURST_REACH + (FOUNTAIN_SPRAY_REACH - FOUNTAIN_PLUME_BURST_REACH) * t),
    ];
    return Array.from({ length: FOUNTAIN_SPRAY_STEPS }, (_, k) =>
      strut(at(k / FOUNTAIN_SPRAY_STEPS), at((k + 1) / FOUNTAIN_SPRAY_STEPS), FOUNTAIN_SPRAY_RADIUS, FOUNTAIN_SPRAY_RADIUS, SPHERE_SEGMENTS),
    );
  }).flat();

  const droplets = Array.from({ length: FOUNTAIN_DROPLET_COUNT }, (_, i) => {
    const angle = ((i + 0.5) / FOUNTAIN_DROPLET_COUNT) * TURN;
    return place(
      new SphereGeometry(FOUNTAIN_DROPLET_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
      Math.cos(angle) * FOUNTAIN_DROPLET_REACH,
      waterLevel,
      Math.sin(angle) * FOUNTAIN_DROPLET_REACH,
    );
  });

  return [
    ...painted('stone', rock, rim),
    ...painted('water', pool, column, ...spray, ...droplets),
    ...painted('foam', core, ...burst),
  ];
}

const WARD_ROCK_RADIUS = 0.8;
const WARD_ROCK_HEIGHT = 0.1;
const WARD_SIGIL_RADIUS = 0.66;
const WARD_SIGIL_HEIGHT = 0.06;
const WARD_STONES = 4;
const WARD_STONE_RADIUS = 0.66;
const WARD_STONE_ACROSS = 0.14;
const WARD_STONE_HEIGHT = 0.44;

function bedrockWard(): Part[] {
  const bedrock = place(
    new CylinderGeometry(WARD_ROCK_RADIUS, WARD_ROCK_RADIUS, WARD_ROCK_HEIGHT, ROUND_SEGMENTS),
    0,
    WARD_ROCK_HEIGHT / 2,
    0,
  );
  const sigil = place(
    new CylinderGeometry(WARD_SIGIL_RADIUS, WARD_SIGIL_RADIUS, WARD_SIGIL_HEIGHT, ROUND_SEGMENTS),
    0,
    WARD_ROCK_HEIGHT + WARD_SIGIL_HEIGHT / 2,
    0,
  );
  const stones = Array.from({ length: WARD_STONES }, (_unused, index) => {
    const bearing = (index / WARD_STONES) * TURN;
    return place(
      new BoxGeometry(WARD_STONE_ACROSS, WARD_STONE_HEIGHT, WARD_STONE_ACROSS),
      Math.cos(bearing) * WARD_STONE_RADIUS,
      WARD_ROCK_HEIGHT + WARD_STONE_HEIGHT / 2,
      Math.sin(bearing) * WARD_STONE_RADIUS,
      0,
      -bearing,
      0,
    );
  });
  return [...painted('rock', bedrock), ...painted('amber', sigil), ...painted('stone', ...stones)];
}

const BULWARK_BLOCKS = 12;
const BULWARK_WALL_RADIUS = 0.62;
const BULWARK_BLOCK_ACROSS = 0.3;
const BULWARK_BLOCK_THROUGH = 0.2;
const BULWARK_MERLON_HEIGHT = 0.46;
const BULWARK_CRENEL_HEIGHT = 0.3;
const BULWARK_COURTYARD_RADIUS = 0.5;
const BULWARK_COURTYARD_HEIGHT = 0.1;

function bulwark(): Part[] {
  const courtyard = place(
    new CylinderGeometry(
      BULWARK_COURTYARD_RADIUS,
      BULWARK_COURTYARD_RADIUS,
      BULWARK_COURTYARD_HEIGHT,
      ROUND_SEGMENTS,
    ),
    0,
    BULWARK_COURTYARD_HEIGHT / 2,
    0,
  );
  const blocks = Array.from({ length: BULWARK_BLOCKS }, (_unused, index) => {
    const bearing = (index / BULWARK_BLOCKS) * TURN;
    const height = index % 2 === 0 ? BULWARK_MERLON_HEIGHT : BULWARK_CRENEL_HEIGHT;
    return place(
      new BoxGeometry(BULWARK_BLOCK_THROUGH, height, BULWARK_BLOCK_ACROSS),
      Math.cos(bearing) * BULWARK_WALL_RADIUS,
      height / 2,
      Math.sin(bearing) * BULWARK_WALL_RADIUS,
      0,
      -bearing,
      0,
    );
  });
  return [...painted('grass', courtyard), ...painted('stone', ...blocks)];
}

const LANDSLIDE_CLIFF_THROUGH = 0.62;
const LANDSLIDE_CLIFF_ACROSS = 0.95;
const LANDSLIDE_CLIFF_HEIGHT = 0.72;
const LANDSLIDE_CAP_HEIGHT = 0.1;
const LANDSLIDE_CLIFF_CENTRE = -0.48;

const LANDSLIDE_LIP_U = LANDSLIDE_CLIFF_CENTRE + LANDSLIDE_CLIFF_THROUGH / 2;

const LANDSLIDE_RAMP_FOOT_U = 0.7;
const LANDSLIDE_RAMP_FOOT_H = 0.03;
const LANDSLIDE_RAMP_THICKNESS = 0.13;
const LANDSLIDE_RAMP_ACROSS = 0.66;

const LANDSLIDE_BOULDERS: ReadonlyArray<readonly [number, number, number]> = [
  [0.12, -0.16, 0.15],
  [0.38, 0.15, 0.12],
  [0.62, -0.1, 0.1],
  [0.86, 0.19, 0.08],
  [1.04, -0.05, 0.07],
];

function landslide(): Part[] {
  const cliff = place(
    new BoxGeometry(LANDSLIDE_CLIFF_THROUGH, LANDSLIDE_CLIFF_HEIGHT, LANDSLIDE_CLIFF_ACROSS),
    LANDSLIDE_CLIFF_CENTRE,
    LANDSLIDE_CLIFF_HEIGHT / 2,
    0,
  );
  const cap = place(
    new BoxGeometry(LANDSLIDE_CLIFF_THROUGH, LANDSLIDE_CAP_HEIGHT, LANDSLIDE_CLIFF_ACROSS),
    LANDSLIDE_CLIFF_CENTRE,
    LANDSLIDE_CLIFF_HEIGHT + LANDSLIDE_CAP_HEIGHT / 2,
    0,
  );

  const runU = LANDSLIDE_RAMP_FOOT_U - LANDSLIDE_LIP_U;
  const runH = LANDSLIDE_CLIFF_HEIGHT - LANDSLIDE_RAMP_FOOT_H;
  const rampLength = Math.hypot(runU, runH);
  const rampTilt = -Math.atan2(runH, runU);
  const ramp = place(
    new BoxGeometry(rampLength, LANDSLIDE_RAMP_THICKNESS, LANDSLIDE_RAMP_ACROSS),
    (LANDSLIDE_LIP_U + LANDSLIDE_RAMP_FOOT_U) / 2,
    (LANDSLIDE_CLIFF_HEIGHT + LANDSLIDE_RAMP_FOOT_H) / 2,
    0,
    0,
    0,
    rampTilt,
  );

  const boulders = LANDSLIDE_BOULDERS.map(([along, across, size]) =>
    place(
      new SphereGeometry(size, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
      LANDSLIDE_LIP_U + runU * along,
      LANDSLIDE_CLIFF_HEIGHT - runH * along + size / 2,
      across,
    ),
  );

  return [
    ...painted('rock', cliff),
    ...painted('grass', cap),
    ...painted('tileLeft', ramp),
    ...painted('stone', ...boulders),
  ];
}

const BUILDERS: Readonly<Record<SkillId, () => Part[]>> = {
  quake,
  genesis,
  'bedrock-ward': bedrockWard,
  bulwark,
  landslide,
  'azure-heart': azureHeart,
  'spring-of-aether': springOfAether,
};

function hexChannels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function srgbChannels(hex: string): [number, number, number] {
  const [r, g, b] = hexChannels(hex);
  return [r / HEX_CHANNEL_MAX, g / HEX_CHANNEL_MAX, b / HEX_CHANNEL_MAX];
}

const HEX_CHANNEL_MAX = 255;

export const PAINT_LIGHT_ATTRIBUTE = 'paintLight';
export const PAINT_DARK_ATTRIBUTE = 'paintDark';

export const PAINT_BLEND_ATTRIBUTE = 'paintBlend';
export const PAINT_BLEND_LIT = -1;

function applyPaint(geometry: BufferGeometry, { paint, blend }: Part): void {
  const positions = geometry.getAttribute('position');
  const count = positions.count;
  for (const [name, hex] of [
    [PAINT_LIGHT_ATTRIBUTE, paint.light],
    [PAINT_DARK_ATTRIBUTE, paint.dark],
  ] as const) {
    const channels = srgbChannels(hex);
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) values.set(channels, i * 3);
    geometry.setAttribute(name, new Float32BufferAttribute(values, 3));
  }
  const blends = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    blends[i] =
      blend === undefined
        ? PAINT_BLEND_LIT
        : Math.min(1, Math.max(0, blend(positions.getX(i), positions.getY(i), positions.getZ(i))));
  }
  geometry.setAttribute(PAINT_BLEND_ATTRIBUTE, new Float32BufferAttribute(blends, 1));
}

function buildRelic(skill: SkillId): BufferGeometry {
  const parts = [...BUILDERS[skill](), ...tile(skill)];
  const unrolled = parts.map((part) => {
    const flat = part.geometry.index === null ? part.geometry : part.geometry.toNonIndexed();
    applyPaint(flat, part);
    return flat;
  });
  const merged = mergeGeometries(unrolled);
  if (merged === null) throw new Error(`relic shape for ${skill} has incompatible parts`);
  for (const { geometry } of parts) geometry.dispose();
  for (const part of unrolled) part.dispose();
  merged.center();
  merged.computeBoundingBox();
  return merged;
}

const cache = new Map<SkillId, BufferGeometry>();

export function relicGeometry(skill: SkillId): BufferGeometry {
  const cached = cache.get(skill);
  if (cached !== undefined) return cached;

  const built = new Map(SKILL_IDS.map((id) => [id, buildRelic(id)] as const));
  let tallestHalfHeight = 0;
  for (const geometry of built.values()) {
    const box = geometry.boundingBox!;
    tallestHalfHeight = Math.max(tallestHalfHeight, -box.min.y, box.max.y);
  }
  const scale = GEM_RADIUS_CELLS / tallestHalfHeight;
  for (const [id, geometry] of built) {
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    cache.set(id, geometry);
  }
  return cache.get(skill)!;
}

export function disposeRelicGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}
