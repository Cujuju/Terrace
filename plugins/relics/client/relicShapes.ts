// The SHAPE each relic takes in the world (owner, 2026-09-04: "change the
// relic icons both in the panel and in the game, so they are more
// representative of what they do and what they are"). One geometry per
// SKILL rather than one octahedron for all: a player who can see what a relic
// is from across the valley does not have to walk to it to find out.
//
// Every shape is a handful of three.js primitives MERGED INTO ONE
// BufferGeometry, so a relic is still exactly one mesh and one draw call —
// the plugin's draw budget (index.ts, RELIC_DRAW_OBJECTS) is unchanged. The
// primitives are positioned in a local frame whose origin is the shape's
// centre and whose scale is GEM_RADIUS_CELLS, the octahedron's old radius, so
// the hover height and the pick tolerance in gems.ts still fit.
//
// THE MODEL IS THE ICON (owner, 2026-09-04: "I really wanted match. That means
// color and design"): each part is PAINTED, and the paint's light and dark
// ends are written into the merged geometry as two vertex attributes, so the
// gem shader (gemMaterial.ts) can shade a relic in the world exactly as the
// icon shades its panel tile — same grass, bark, stone and water, same light.
// RELIC_PALETTE below is the one source of those colours — the icon generator
// (.claude/orchestration/refs/hud-icons/relics.py) reads it from this file.
//
// THE MODEL INCLUDES THE ICON'S TILE (owner, 2026-09-05: "I would like that 3D
// model to look exactly like the icon, including sitting on a little plot of
// terrain"): every relic stands on the isometric grass tile the panel draws
// under it — grass top, two shades of soil wall, the category glow and the
// cast shade on the grass — merged into the same one mesh, so the plot hovers,
// bobs and spins with the relic as one object. The builders model with the
// tile top at y = 0, as relics.py models with h = 0, so the two stay one
// layout. The tile's faces are not lit by the gem shader's light levels: they
// carry the icon's own gradients as an explicit per-vertex blend
// (PAINT_BLEND_ATTRIBUTE), because the icon paints them that way.
//
// Built lazily and cached per skill: the geometry is shared by every relic
// carrying that skill (the material is per-relic — index.ts), and released
// when the plugin is disposed.

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

/**
 * The paints, each as the light and dark ends the icon shades between. Amber,
 * crimson and azure are the three skill-category colours (gems.ts) as
 * materials, so the colour code a player learns from the panel still holds in
 * the world.
 */
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

/** A paint's two ends, as hex. */
interface PaintEnds {
  readonly light: string;
  readonly dark: string;
}

/**
 * Where between its paint's ends a vertex sits, 0 light to 1 dark, for a part
 * the icon paints with a fixed gradient rather than by the light. Evaluated on
 * the vertex's final local position.
 */
type Blend = (x: number, y: number, z: number) => number;

/** A primitive, the paint it wears, and — for the tile's faces — its own blend. */
interface Part {
  readonly geometry: BufferGeometry;
  readonly paint: PaintEnds;
  readonly blend?: Blend;
}

/** The colour the icon casts on the grass under its object (relics.py, CAST_SHADE). */
export const CAST_SHADE = '#2e5a2e';

/** The icon's opacities for the category glow and the cast shade on the grass. */
const TILE_GLOW_OPACITY = 0.3;
const CAST_SHADE_OPACITY = 0.5;

/** The icon's tile top is u, v in [-1, 1]; its walls are half a unit tall (4px at 8px per unit). */
const TILE_HALF_WIDTH = 1;
const TILE_WALL_HEIGHT = 0.5;

/**
 * The icon's tile top on the panel, in px: 24 wide, 12 deep. A circle of
 * radius r on the tile projects to an ellipse of rx = r·12/√2, ry = r·6/√2,
 * which is how the icon's glow and cast-shade ellipses are read back as
 * circles on the tile below.
 */
const ICON_TILE_HALF_WIDTH_PX = 12;
const ICON_TILE_HALF_DEPTH_PX = 6;

/** The icon's category-glow ellipse on the grass (rx, ry px), the same on every relic. */
const ICON_GLOW_ELLIPSE_PX: readonly [number, number] = [7, 3.2];

/** The icon's cast-shade ellipse on the grass (rx, ry px), sized to each object. */
const ICON_SHADE_ELLIPSE_PX: Readonly<Record<SkillId, readonly [number, number]>> = {
  'titans-hand': [5, 2.4],
  quake: [9, 3.8],
  genesis: [9, 3.8],
  'bedrock-ward': [8, 3.4],
  bulwark: [9, 3.8],
  landslide: [9, 3.8],
  'azure-heart': [6, 2.6],
  'spring-of-aether': [8.5, 3.6],
};

/** A circle on the tile whose projection best matches the icon's ellipse: the mean of the two axes' readings. */
function tileRadiusFromIconEllipse([rx, ry]: readonly [number, number]): number {
  return (Math.SQRT2 * (rx / ICON_TILE_HALF_WIDTH_PX + ry / ICON_TILE_HALF_DEPTH_PX)) / 2;
}

/** Segments for the decals on the grass: round enough to read as the icon's ellipses. */
const DECAL_SEGMENTS = 24;

/** How far a decal floats above the grass so it wins the depth test, in the unit frame. */
const DECAL_LIFT = 0.01;

/** Segment counts: low, because the gems are flat-shaded and small. */
const ROUND_SEGMENTS = 10;
const SPHERE_SEGMENTS = 8;

/** A quarter-turn, for the primitives that need tipping over. */
const QUARTER_TURN = Math.PI / 2;

/**
 * Place a primitive in the local frame. Rotation is applied before
 * translation, as a modelling tool would, so a tipped cone still lands where
 * its centre was asked for.
 */
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

/**
 * The icon's tile-top gradient runs diagonally down the screen, which on the
 * tile is along u alone: a quarter of the way in at the back-left edge, three
 * quarters at the front-right (the SVG's 0→1 diagonal over the diamond's box).
 */
const TILE_TOP_BLEND_AT_CENTRE = 0.5;
const TILE_TOP_BLEND_PER_UNIT = 0.25;
const tileTopBlend: Blend = (x) => TILE_TOP_BLEND_AT_CENTRE + TILE_TOP_BLEND_PER_UNIT * x;

/** The walls' gradients run top edge to foot. */
const tileWallBlend: Blend = (_x, y) => -y / TILE_WALL_HEIGHT;

/**
 * The tile under every relic: a grass top with the icon's diagonal gradient,
 * soil walls in the icon's two shades — the lit pair (facing −u and +v, where
 * the icon's light comes from) lighter than the other — a dark underside, and
 * on the grass the category glow with the object's cast shade over it.
 */
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

  // The decals: alpha over the grass composes linearly, so each region's
  // paint is the grass's two ends each blended with the overlay(s), and the
  // grass's own gradient carries through unchanged.
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

/** A paint with a translucent colour laid over both its ends, as the icon composes it (sRGB). */
function overlay(paint: PaintEnds, hex: string, opacity: number): PaintEnds {
  return { light: mixHex(paint.light, hex, opacity), dark: mixHex(paint.dark, hex, opacity) };
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexChannels(a);
  const cb = hexChannels(b);
  const mixed = ca.map((c, i) => Math.round(c + (cb[i]! - c) * t));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The axis every primitive is modelled along, and the shortest-arc turn that
 * aims one down an arbitrary direction. Limbs — fingers, spray arcs, barbs —
 * are aimed at a point rather than composed out of Euler angles, because the
 * angles that would reach a point are exactly the magic numbers a named
 * constant is meant to replace.
 */
const MODEL_AXIS = new Vector3(0, 1, 0);

type Point = readonly [number, number, number];

function orient(geometry: BufferGeometry, dir: Point, x: number, y: number, z: number): BufferGeometry {
  const to = new Vector3(dir[0], dir[1], dir[2]).normalize();
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(MODEL_AXIS, to));
  geometry.translate(x, y, z);
  return geometry;
}

/** A tapered strut spanning two points: `radiusTo` is the end at `to`. */
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

/** A rounded rectangle in the xy plane, for a palm that has no sharp corners. */
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

/**
 * Titan's Hand — a wider brush — is A HAND OF GOD (owner, 2026-09-05: "I want
 * the hand to be rendered like a strong high-resolution hand", then, with a
 * reference render of a smooth mannequin hand on a plinth: "the 3D hand
 * should look more like this 3D model"): a long smooth forearm rising from a
 * two-step pedestal, a rounded palm, four fingers standing straight up with a
 * soft curl at the tips, and a thumb swung out to the side and up. SMOOTH is
 * the brief: the joints are the same radius as the bones either side, so a
 * finger reads as one continuous digit, and everything round is modelled at
 * HAND_SEGMENTS rather than the other relics' ROUND_SEGMENTS, because the gem
 * shader takes its normal from screen-space derivatives (gemMaterial.ts) and
 * resolution is the only thing that makes a limb read as round.
 */
const HAND_SEGMENTS = 18;
const HAND_JOINT_LONGITUDES = 12;
const HAND_JOINT_LATITUDES = 8;

/** The pedestal: two stone discs, the upper narrower, as the reference's plinth. */
const HAND_PLINTH_RADII = [0.62, 0.5] as const;
const HAND_PLINTH_STEP_HEIGHT = 0.07;

/** The forearm: a long taper from the plinth to the wrist. */
const HAND_FOREARM_HEIGHT = 0.62;
const HAND_FOREARM_RADIUS_BOTTOM = 0.24;
const HAND_FOREARM_RADIUS_TOP = 0.19;

/** The palm: a rounded slab a little taller than wide, and a third as deep. */
const HAND_PALM_HEIGHT = 0.7;
const HAND_PALM_WIDTH = 0.66;
const HAND_PALM_DEPTH = 0.22;
const HAND_PALM_CORNER_RADIUS = 0.16;
const HAND_PALM_BEVEL = 0.06;

/** The heel of the thumb: a rounded swell on the palm's thumb side, low down. */
const HAND_THENAR_RADIUS = 0.17;
const HAND_THENAR_HEIGHT_SHARE = 0.3;

/** Fingers, index to little: total length, the middle longest. Straight, parallel, evenly spaced. */
const HAND_FINGER_LENGTHS = [0.6, 0.66, 0.62, 0.5] as const;
const HAND_FINGER_SPACING = 0.165;
const HAND_FINGER_RADIUS = 0.07;

/** How a finger's length divides between its three phalanges. Same radius throughout: a smooth digit. */
const HAND_PHALANX_SHARES = [0.42, 0.32, 0.26] as const;

/** The curl: only the tip leans toward the viewer, and only a little — an open hand. */
const HAND_PHALANX_TILTS = [0, 0.08, 0.22] as const;

/**
 * The thumb: rooted on the palm's +x side just above the thenar, swung out to
 * the side at about 55° then curling up so its tip reaches most of the way to
 * the palm's top, as the reference holds it.
 */
const HAND_THUMB_RADIUS = 0.08;
const HAND_THUMB_ROOT_HEIGHT_SHARE = 0.45;
const HAND_THUMB_SEGMENTS = [
  { length: 0.34, radius: HAND_THUMB_RADIUS, tilt: 0.15, spread: -0.95 },
  { length: 0.3, radius: HAND_THUMB_RADIUS, tilt: 0.25, spread: -0.35 },
] as const;

/** One phalanx: how long, how thick, how far it leans toward the viewer and out to the side. */
interface Phalanx {
  readonly length: number;
  readonly radius: number;
  readonly tilt: number;
  readonly spread: number;
}

/** Where a phalanx points: leaned `tilt` toward the viewer (+z) and swung `spread` about the vertical. */
function limbDirection(tilt: number, spread: number): Point {
  return [-Math.sin(spread) * Math.cos(tilt), Math.cos(spread) * Math.cos(tilt), Math.sin(tilt)];
}

/** A rounded root, then bone, joint, bone, joint … out to a rounded fingertip. */
function digit(root: Point, phalanges: readonly Phalanx[]): BufferGeometry[] {
  const parts = [joint(root, phalanges[0]!.radius)];
  let at = root;
  for (const { length, radius, tilt, spread } of phalanges) {
    const dir = limbDirection(tilt, spread);
    const tip: Point = [at[0] + dir[0] * length, at[1] + dir[1] * length, at[2] + dir[2] * length];
    parts.push(strut(at, tip, radius, radius, HAND_SEGMENTS));
    parts.push(joint(tip, radius));
    at = tip;
  }
  return parts;
}

function joint([x, y, z]: Point, radius: number): BufferGeometry {
  return place(
    new SphereGeometry(radius, HAND_JOINT_LONGITUDES, HAND_JOINT_LATITUDES),
    x,
    y,
    z,
  );
}

function titansHand(): Part[] {
  const plinth = HAND_PLINTH_RADII.map((radius, i) =>
    place(
      new CylinderGeometry(radius, radius, HAND_PLINTH_STEP_HEIGHT, HAND_SEGMENTS),
      0,
      HAND_PLINTH_STEP_HEIGHT * (i + 0.5),
      0,
    ),
  );
  const plinthTop = HAND_PLINTH_STEP_HEIGHT * HAND_PLINTH_RADII.length;
  const forearm = place(
    new CylinderGeometry(
      HAND_FOREARM_RADIUS_TOP,
      HAND_FOREARM_RADIUS_BOTTOM,
      HAND_FOREARM_HEIGHT,
      HAND_SEGMENTS,
    ),
    0,
    plinthTop + HAND_FOREARM_HEIGHT / 2,
    0,
  );
  const palmBottom = plinthTop + HAND_FOREARM_HEIGHT;
  const palmTop = palmBottom + HAND_PALM_HEIGHT;
  // Extrude runs along +z from the shape plane, so the palm already faces the
  // viewer; it only has to be lifted onto the forearm and centred in depth.
  const palm = new ExtrudeGeometry(
    roundedRectShape(HAND_PALM_WIDTH, HAND_PALM_HEIGHT, HAND_PALM_CORNER_RADIUS),
    {
      depth: HAND_PALM_DEPTH,
      bevelEnabled: true,
      bevelThickness: HAND_PALM_BEVEL,
      bevelSize: HAND_PALM_BEVEL,
      bevelSegments: 3,
      curveSegments: 8,
    },
  );
  palm.translate(0, palmBottom + HAND_PALM_HEIGHT / 2, -HAND_PALM_DEPTH / 2);
  const thenar = joint(
    [HAND_PALM_WIDTH / 2 - HAND_THENAR_RADIUS / 2, palmBottom + HAND_PALM_HEIGHT * HAND_THENAR_HEIGHT_SHARE, 0],
    HAND_THENAR_RADIUS,
  );

  const fingers = HAND_FINGER_LENGTHS.flatMap((length, i) => {
    const x = (i - (HAND_FINGER_LENGTHS.length - 1) / 2) * HAND_FINGER_SPACING;
    const phalanges = HAND_PHALANX_SHARES.map((share, k) => ({
      length: length * share,
      radius: HAND_FINGER_RADIUS,
      tilt: HAND_PHALANX_TILTS[k]!,
      spread: 0,
    }));
    return digit([x, palmTop, 0], phalanges);
  });

  const thumbRoot: Point = [
    HAND_PALM_WIDTH / 2,
    palmBottom + HAND_PALM_HEIGHT * HAND_THUMB_ROOT_HEIGHT_SHARE,
    0,
  ];
  const thumb = digit(thumbRoot, HAND_THUMB_SEGMENTS);

  return [...painted('stone', ...plinth), ...painted('amber', forearm, palm, thenar, ...fingers, ...thumb)];
}

/**
 * Quake — a collapsing crater — is A REVERBERATING WAVEFORM (owner,
 * 2026-09-05, with a reference plot of a damped radial sine surface: "that
 * should look like a reverberating waveform"): a disc of ground whose surface
 * is a standing ripple, sunk deepest at the epicentre and ringing outward in
 * waves that die away toward the rim — the plot, cast in crimson on a rock
 * base. Not rings and not arcs: ONE continuous surface, which is what a
 * shockwave through the ground is.
 */
const QUAKE_DISC_RADIUS = 1;

/** The surface's resolution: rings out from the centre and spokes around it. */
const QUAKE_RINGS = 40;
const QUAKE_SPOKES = 48;

/** The wave: how many full cycles fit between centre and rim, and how tall the first crest is. */
const QUAKE_WAVE_CYCLES = 3;
const QUAKE_WAVE_AMPLITUDE = 0.42;

/** How fast the ringing dies with distance: crest height at the rim as a share of the first crest's. */
const QUAKE_RIM_AMPLITUDE_SHARE = 0.25;

/** How thick the rippled sheet of ground is: its rock underside rides this far below the crimson face. */
const QUAKE_SHEET_THICKNESS = 0.07;

/** How far the sheet hovers above the tile (owner, 2026-09-05: "sits above the ground and not on it"). */
const QUAKE_HOVER = 0.3;

/**
 * The damped ripple's height at radius r: the troughs all lie on the sheet's
 * floor (a thickness above the tile) and the crests rise from it, the first
 * the tallest, dying away toward the rim — the plot's shape, a deep bowl at
 * the centre ringed by ever-lower waves.
 */
function quakeWaveHeight(r: number): number {
  const decay = 1 - (1 - QUAKE_RIM_AMPLITUDE_SHARE) * (r / QUAKE_DISC_RADIUS);
  const crest = (1 - Math.cos((r / QUAKE_DISC_RADIUS) * QUAKE_WAVE_CYCLES * Math.PI * 2)) / 2;
  return QUAKE_HOVER + QUAKE_SHEET_THICKNESS + QUAKE_WAVE_AMPLITUDE * decay * crest;
}

/**
 * A disc surface sampled on rings and spokes, displaced by `height(r)`,
 * unrolled to triangles wound to face up — or down, for an underside. The
 * centre is one fan.
 */
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
      // Spokes run from +x toward +z, so (a, b, c) and (a, c, d) face up.
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

/**
 * A geometry from a flat triangle list. It carries the normal and uv
 * attributes the three primitives carry, because mergeGeometries refuses to
 * merge parts whose attribute sets differ.
 */
function unrolledGeometry(tris: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(tris, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array((tris.length / 3) * 2), 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** The wall around the sheet's rim, between its face and its underside. */
function rippleWall(radius: number, spokes: number, rimHeight: number, floor: number): BufferGeometry {
  const tris: number[] = [];
  for (let spoke = 0; spoke < spokes; spoke++) {
    const a0 = (spoke / spokes) * Math.PI * 2;
    const a1 = ((spoke + 1) / spokes) * Math.PI * 2;
    const [x0, z0] = [Math.cos(a0) * radius, Math.sin(a0) * radius];
    const [x1, z1] = [Math.cos(a1) * radius, Math.sin(a1) * radius];
    // Outward-facing: counter-clockwise seen from outside the wall.
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

/**
 * Genesis — raising a small island — is LAND BEING PULLED UP (owner,
 * 2026-09-05: "what it needs to look more like is land being pulled up"): out
 * of the island's grass mound a plug of ground is rising, a stack of strata —
 * grass cap, soil, rock, soil — torn free along a crimson fissure that rings
 * its foot, with loose clods hanging in the air around it where they broke
 * away. The island itself stays as before, beach then grass.
 */
const GENESIS_BEACH_HEIGHT = 0.16;
const GENESIS_MOUND_HEIGHT = 0.3;

/** The plug's radius at its cap, and how much wider each stratum is below the one above. */
const GENESIS_PLUG_RADIUS = 0.32;
const GENESIS_PLUG_FLARE = 0.02;

/** The strata, top down: paint and thickness. Uneven, as ground is. */
const GENESIS_STRATA: readonly { readonly paint: Paint; readonly height: number }[] = [
  { paint: 'tileTop', height: 0.1 },
  { paint: 'tileLeft', height: 0.22 },
  { paint: 'rock', height: 0.3 },
  { paint: 'tileLeft', height: 0.18 },
];

/** How far the plug has risen: the gap between its lowest stratum and the mound. */
const GENESIS_LIFT = 0.42;

/** The fissure around the plug's foot on the mound: a thin crimson ring. */
const GENESIS_FISSURE_RADIUS = 0.42;
const GENESIS_FISSURE_TUBE = 0.035;

/** The clods: loose lumps hanging around the plug — bearing, height, distance out, size. */
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
  // The strata are stacked from the bottom up so each sits on the one below.
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

/**
 * Azure Heart — half-price sculpts — is a HEART, extruded so it has a face
 * and a rim to catch the light as it turns, hovering just off the tile as it
 * does on the panel.
 */
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
  // Extrude runs along +z from the shape plane; centre it on the origin, then
  // lift it to the icon's hover (relics.py, azure_heart).
  heart.translate(0, 0.95, -0.17);
  return painted('azure', heart);
}

/**
 * Spring of Aether — mana twice as fast — is a FOUNTAIN (owner, 2026-09-05:
 * "it looks like it's actually got water coming up, spraying up from the
 * centre into a plume"), replacing the low well dome: the rock outcrop, rim
 * and pool as before, then a column of water rising out of the pool's centre
 * and opening as it goes, a plume head of foam spheres at its top, six arcs of
 * spray falling from the plume back into the pool, and a few droplets on the
 * water. The foam paint is the water paint's light end pushed further: the
 * plume head is the brightest thing on the relic, and the shader lights every
 * unblended face the same way, so the brightness has to come from the paint.
 */
const SPRING_ROCK_HEIGHT = 0.35;
const SPRING_POOL_DEPTH = 0.06;

const FOUNTAIN_COLUMN_HEIGHT = 0.72;
const FOUNTAIN_COLUMN_RADIUS_FOOT = 0.08;
const FOUNTAIN_COLUMN_RADIUS_HEAD = 0.17;

/** The plume head: one core sphere with a ring of smaller ones bursting off it. */
const FOUNTAIN_PLUME_CORE_RADIUS = 0.17;
const FOUNTAIN_PLUME_BURST_RADIUS = 0.12;
const FOUNTAIN_PLUME_BURST_COUNT = 5;
const FOUNTAIN_PLUME_BURST_REACH = 0.17;
const FOUNTAIN_PLUME_BURST_RISE = 0.09;

/** The falling spray: how many arcs, how far they reach, and how far they rise before they fall. */
const FOUNTAIN_SPRAY_ARCS = 6;
const FOUNTAIN_SPRAY_REACH = 0.46;
const FOUNTAIN_SPRAY_RISE = 0.16;
const FOUNTAIN_SPRAY_STEPS = 3;
const FOUNTAIN_SPRAY_RADIUS = 0.028;

/** Droplets sitting on the pool where the spray lands. */
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

  // Each arc is a parabola from the plume out to the pool: it leaves rising at
  // FOUNTAIN_SPRAY_RISE and lands exactly on the water, so the coefficients are
  // fixed by those two conditions rather than chosen.
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

/**
 * Bedrock Ward — ground that refuses another hand — is MARKED GROUND: a floor
 * of amber sigil laid over the bare rock, with four standing stones set around
 * its edge.
 *
 * A dome was tried first and read as a cauldron at panel size (the plinth rim
 * occludes anything sitting inside it). The flat sigil is the better object:
 * what the skill claims IS ground, so the ground is what the icon colours, and
 * amber is the panel's passive category — the tile is legible before the shape
 * is.
 */
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

/**
 * Bulwark — a ring wall with nothing in the middle — is a RING OF MASONRY on
 * open ground: twelve blocks stood on a bearing each, alternating tall and
 * short so the top reads as battlements rather than as a pipe, around a
 * courtyard of grass that is the point of the skill (the cast leaves the
 * middle untouched, terraform.ts, BULWARK_STEPS).
 *
 * Twelve, not the cast's eight: the icon is read at 30 px, where eight blocks
 * on a circle this size leave gaps wide enough to look like a broken wall. The
 * relic is a portrait of the skill, not a plan of its footprint.
 */
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

/**
 * Landslide — a cliff toppled into a walkable slope — is THE RESULT, not the
 * moment: a scarp with its grass cap still on, its face sheared away, and the
 * fallen ground lying against it as a RAMP that runs from the lip down to open
 * ground, boulders scattered along it.
 *
 * The ramp is what makes the icon read: a cliff with rubble at its foot is
 * just a broken cliff, while a slab leaning from lip to floor is the thing the
 * cast gives you — a way up. It runs toward +u, down-right on the tile and
 * into the icon's light, so the eye reads it as descending.
 */
const LANDSLIDE_CLIFF_THROUGH = 0.62;
const LANDSLIDE_CLIFF_ACROSS = 0.95;
const LANDSLIDE_CLIFF_HEIGHT = 0.72;
const LANDSLIDE_CAP_HEIGHT = 0.1;
const LANDSLIDE_CLIFF_CENTRE = -0.48;

/** The lip: the front edge of the scarp, where the ramp's head meets it. */
const LANDSLIDE_LIP_U = LANDSLIDE_CLIFF_CENTRE + LANDSLIDE_CLIFF_THROUGH / 2;

/** Where the ramp's foot lands on the tile, and how thick and wide the slab is. */
const LANDSLIDE_RAMP_FOOT_U = 0.7;
const LANDSLIDE_RAMP_FOOT_H = 0.03;
const LANDSLIDE_RAMP_THICKNESS = 0.13;
const LANDSLIDE_RAMP_ACROSS = 0.66;

/** Boulders on the ramp: how far down the run each sits (0 lip, 1 foot), its offset across, its size. */
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

  // The slab spans lip to foot, so its length and tilt are read off those two
  // points rather than picked — move either end and it still lands on both.
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
  'titans-hand': titansHand,
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

/** A hex paint end as the 0..1 sRGB channels the gem shader blends. */
function srgbChannels(hex: string): [number, number, number] {
  const [r, g, b] = hexChannels(hex);
  return [r / HEX_CHANNEL_MAX, g / HEX_CHANNEL_MAX, b / HEX_CHANNEL_MAX];
}

const HEX_CHANNEL_MAX = 255;

/** The vertex attributes carrying a paint's two ends — gemMaterial.ts reads them by these names. */
export const PAINT_LIGHT_ATTRIBUTE = 'paintLight';
export const PAINT_DARK_ATTRIBUTE = 'paintDark';

/**
 * The vertex attribute carrying a part's own blend between its ends, or
 * PAINT_BLEND_LIT for a part the shader lights by its face normal instead.
 */
export const PAINT_BLEND_ATTRIBUTE = 'paintBlend';
export const PAINT_BLEND_LIT = -1;

/** Writes one paint's light and dark ends, and its blend, onto every vertex of a geometry. */
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

/** Every part of a skill's relic, unrolled and painted, merged into one geometry in the unit frame, centred. */
function buildRelic(skill: SkillId): BufferGeometry {
  const parts = [...BUILDERS[skill](), ...tile(skill)];
  // Merging needs every part indexed or none: the polyhedra come unindexed,
  // so everything is unrolled — which flat shading wants anyway.
  const unrolled = parts.map((part) => {
    const flat = part.geometry.index === null ? part.geometry : part.geometry.toNonIndexed();
    applyPaint(flat, part);
    return flat;
  });
  const merged = mergeGeometries(unrolled);
  if (merged === null) throw new Error(`relic shape for ${skill} has incompatible parts`);
  for (const { geometry } of parts) geometry.dispose();
  for (const part of unrolled) part.dispose();
  // The bounding box's centre becomes the origin, so every shape bobs and
  // spins about its own middle and hovers at the height gems.ts promises.
  merged.center();
  merged.computeBoundingBox();
  return merged;
}

const cache = new Map<SkillId, BufferGeometry>();

/**
 * The world geometry for a skill's relic, shared by every relic carrying it.
 * All five are built together on first use, because they share ONE scale: the
 * tile is the same size under every relic, as it is under every icon, so the
 * unit frame is scaled to the gem's world radius by the tallest of them.
 * The hover contract (gems.ts, GEM_HOVER_CELLS) clears the ground by that
 * radius, so no shape may stand taller than it — the icons' own proportions
 * decide the size, and the common scale keeps every one inside the clearance.
 */
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
    // The gem shader spans its vertical gradient over this radius.
    geometry.computeBoundingSphere();
    cache.set(id, geometry);
  }
  return cache.get(skill)!;
}

/** Releases every cached geometry — the plugin's dispose; a rejoin rebuilds. */
export function disposeRelicGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}
