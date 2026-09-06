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
  type BufferGeometry,
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
 * the hand to be rendered like a strong high-resolution hand like you would
 * expect the hand of God to look like"), replacing the slab-and-boxes mitten:
 * a tapered wrist, a palm with rounded edges, knuckle bulges, four fingers of
 * three phalanges each with a sphere at every joint and a natural curl toward
 * the viewer, and a two-segment thumb splayed out and forward. It is modelled
 * at HAND_SEGMENTS rather than the other relics' ROUND_SEGMENTS: the gem
 * shader takes its normal from screen-space derivatives (gemMaterial.ts), so
 * resolution is the only thing that makes a limb read as round.
 */
const HAND_SEGMENTS = 14;
const HAND_JOINT_LONGITUDES = 10;
const HAND_JOINT_LATITUDES = 6;

const HAND_WRIST_HEIGHT = 0.32;
const HAND_WRIST_RADIUS_TOP = 0.26;
const HAND_WRIST_RADIUS_BOTTOM = 0.2;
const HAND_PALM_HEIGHT = 0.66;
const HAND_PALM_WIDTH = 0.8;
const HAND_PALM_DEPTH = 0.24;
const HAND_PALM_CORNER_RADIUS = 0.14;
const HAND_PALM_BEVEL = 0.045;

/** Fingers, index to little: total length and the sideways splay of the whole digit. */
const HAND_FINGER_LENGTHS = [0.62, 0.7, 0.65, 0.5] as const;
const HAND_FINGER_SPACING = 0.205;
const HAND_FINGER_SPLAY = 0.11;

/** How a finger's length divides between its three phalanges, and how it thins along them. */
const HAND_PHALANX_SHARES = [0.42, 0.33, 0.25] as const;
const HAND_PHALANX_RADII = [0.072, 0.064, 0.055] as const;

/** The curl: each phalanx leans a little further toward the viewer than the last. */
const HAND_PHALANX_TILTS = [0.07, 0.24, 0.44] as const;

/** A joint reads as a knuckle only if it is thicker than the bone either side of it. */
const HAND_JOINT_BULGE = 1.18;

/** The knuckle row on the palm's top edge. */
const HAND_KNUCKLE_RADIUS = 0.085;

/** The thumb: rooted low on the palm's +x side, swung out and toward the viewer. */
const HAND_THUMB_ROOT: Point = [0.38, 0.45, 0.08];
const HAND_THUMB_SEGMENTS = [
  { length: 0.34, radius: 0.082, tilt: 0.5, spread: -1.05 },
  { length: 0.26, radius: 0.07, tilt: 0.7, spread: -0.8 },
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

/** A knuckle at the root and then bone, joint, bone, joint … out to the fingertip. */
function digit(root: Point, phalanges: readonly Phalanx[], rootRadius: number): BufferGeometry[] {
  const parts = [joint(root, rootRadius)];
  let at = root;
  for (const { length, radius, tilt, spread } of phalanges) {
    const dir = limbDirection(tilt, spread);
    const tip: Point = [at[0] + dir[0] * length, at[1] + dir[1] * length, at[2] + dir[2] * length];
    parts.push(strut(at, tip, radius, radius, HAND_SEGMENTS));
    parts.push(joint(tip, radius * HAND_JOINT_BULGE));
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
  const wrist = place(
    new CylinderGeometry(HAND_WRIST_RADIUS_TOP, HAND_WRIST_RADIUS_BOTTOM, HAND_WRIST_HEIGHT, HAND_SEGMENTS),
    0,
    HAND_WRIST_HEIGHT / 2,
    0,
  );
  const palmTop = HAND_WRIST_HEIGHT + HAND_PALM_HEIGHT;
  // Extrude runs along +z from the shape plane, so the palm already faces the
  // viewer; it only has to be lifted onto the wrist and centred in depth.
  const palm = new ExtrudeGeometry(
    roundedRectShape(HAND_PALM_WIDTH, HAND_PALM_HEIGHT, HAND_PALM_CORNER_RADIUS),
    {
      depth: HAND_PALM_DEPTH,
      bevelEnabled: true,
      bevelThickness: HAND_PALM_BEVEL,
      bevelSize: HAND_PALM_BEVEL,
      bevelSegments: 2,
      curveSegments: 6,
    },
  );
  palm.translate(0, HAND_WRIST_HEIGHT + HAND_PALM_HEIGHT / 2, -HAND_PALM_DEPTH / 2);

  const fingers = HAND_FINGER_LENGTHS.flatMap((length, i) => {
    const x = (i - (HAND_FINGER_LENGTHS.length - 1) / 2) * HAND_FINGER_SPACING;
    const spread = (i - (HAND_FINGER_LENGTHS.length - 1) / 2) * HAND_FINGER_SPLAY;
    const phalanges = HAND_PHALANX_SHARES.map((share, k) => ({
      length: length * share,
      radius: HAND_PHALANX_RADII[k]!,
      tilt: HAND_PHALANX_TILTS[k]!,
      spread,
    }));
    return digit([x, palmTop, 0], phalanges, HAND_KNUCKLE_RADIUS);
  });

  const thumb = digit(HAND_THUMB_ROOT, HAND_THUMB_SEGMENTS, HAND_KNUCKLE_RADIUS);

  return painted('amber', wrist, palm, ...fingers, ...thumb);
}

/**
 * Quake — a collapsing crater — is SOUND WAVES (owner, 2026-09-05: "the quake
 * needs to look more like sound waves instead of concentric circles"): the
 * rock slab and the crimson epicentre dome as before, but the three flat
 * closed rings are gone. In their place two mirrored fans of three open arcs
 * stand UPRIGHT in a vertical plane through the epicentre, each arc a segment
 * of a circle centred on the epicentre with its feet on the slab — the
 * ")))•(((" glyph, in three dimensions. Upright and open is the whole point:
 * flat rings read as concentric circles from the isometric camera, which is
 * what the owner was looking at
 * (.claude/orchestration/refs/relics/quake-in-game-2026-09-05.png).
 */
const QUAKE_SLAB_HEIGHT = 0.1;
const QUAKE_SLAB_RADIUS = 1;

/** How much of a turn one wave arc spans — a third, so it opens rather than closes. */
const QUAKE_ARC_TURN = 0.28 * Math.PI * 2;

/** The three waves, outward: how far from the epicentre and how thick. */
const QUAKE_ARC_RADII = [0.36, 0.62, 0.88] as const;
const QUAKE_ARC_TUBES = [0.055, 0.048, 0.041] as const;
const QUAKE_ARC_TUBE_SEGMENTS = 6;
const QUAKE_ARC_RING_SEGMENTS = 12;

const QUAKE_EPICENTRE_RADIUS = 0.16;

function quake(): Part[] {
  const slab = place(
    new CylinderGeometry(QUAKE_SLAB_RADIUS, QUAKE_SLAB_RADIUS, QUAKE_SLAB_HEIGHT, ROUND_SEGMENTS),
    0,
    QUAKE_SLAB_HEIGHT / 2,
    0,
  );
  const top = QUAKE_SLAB_HEIGHT;
  // A torus arc starts at +x and sweeps counter-clockwise, so turning it back
  // by half its span centres it on the direction the wave travels; lifting it
  // by the height of its own ends stands those ends on the slab.
  const halfSpan = QUAKE_ARC_TURN / 2;
  const arcs = QUAKE_ARC_RADII.flatMap((radius, i) => {
    const foot = radius * Math.sin(halfSpan);
    return [0, Math.PI].map((facing) =>
      place(
        new TorusGeometry(
          radius,
          QUAKE_ARC_TUBES[i]!,
          QUAKE_ARC_TUBE_SEGMENTS,
          QUAKE_ARC_RING_SEGMENTS,
          QUAKE_ARC_TURN,
        ),
        0,
        top + foot,
        0,
        0,
        0,
        facing - halfSpan,
      ),
    );
  });
  const epicentre = place(
    new SphereGeometry(QUAKE_EPICENTRE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
    0,
    top,
    0,
  );
  return [...painted('rock', slab), ...painted('crimson', ...arcs, epicentre)];
}

/**
 * Genesis — raising a small island — keeps its two-tier island and plants a
 * BARBED ARROW in the mound (owner, 2026-09-05: "Genesis has a ball on a stick
 * and it should probably look more like a barbed arrow"), replacing the trunk
 * and canopy: a slender crimson shaft, a sharp conical head pointing up, and
 * two barbs swept back and down from under the head, so the silhouette reads
 * "barbed" both from the isometric camera and at 32 px.
 */
const GENESIS_BEACH_HEIGHT = 0.16;
const GENESIS_MOUND_HEIGHT = 0.3;

const GENESIS_SHAFT_RADIUS = 0.06;
const GENESIS_SHAFT_LENGTH = 0.9;
const GENESIS_HEAD_RADIUS = 0.16;
const GENESIS_HEAD_LENGTH = 0.34;

/** The barbs: how long, how thick at the root, and how far they lean off the shaft. */
const GENESIS_BARB_LENGTH = 0.42;
const GENESIS_BARB_RADIUS = 0.115;
const GENESIS_BARB_LEAN = 1.05;

/** Three sides is enough for a barb: it is a wedge, and its job is the silhouette. */
const GENESIS_BARB_SIDES = 3;

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
  const shaftTop = moundTop + GENESIS_SHAFT_LENGTH;
  const shaft = place(
    new CylinderGeometry(GENESIS_SHAFT_RADIUS, GENESIS_SHAFT_RADIUS, GENESIS_SHAFT_LENGTH, ROUND_SEGMENTS),
    0,
    moundTop + GENESIS_SHAFT_LENGTH / 2,
    0,
  );
  const head = place(
    new CylinderGeometry(0, GENESIS_HEAD_RADIUS, GENESIS_HEAD_LENGTH, ROUND_SEGMENTS),
    0,
    shaftTop + GENESIS_HEAD_LENGTH / 2,
    0,
  );
  // The barbs are swept BACK: their roots meet the shaft under the head and
  // their points fall away from it, along the icon's screen-horizontal axis
  // ((1, 0, -1) normalised) so both read at 32 px rather than one hiding
  // behind the other.
  const across = 1 / Math.SQRT2;
  const barbs = [1, -1].map((side) => {
    const out = side * Math.sin(GENESIS_BARB_LEAN);
    const dir: Point = [out * across, -Math.cos(GENESIS_BARB_LEAN), -out * across];
    // A cone is modelled with its base at -length/2 and its point at +length/2
    // along its axis, so seating the base on the shaft puts the centre half a
    // barb along the direction the point falls in.
    const half = GENESIS_BARB_LENGTH / 2;
    return orient(
      new CylinderGeometry(0, GENESIS_BARB_RADIUS, GENESIS_BARB_LENGTH, GENESIS_BARB_SIDES),
      dir,
      dir[0] * half,
      shaftTop + dir[1] * half,
      dir[2] * half,
    );
  });
  return [
    ...painted('stone', beach),
    ...painted('grass', mound),
    ...painted('crimson', shaft, head, ...barbs),
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

const BUILDERS: Readonly<Record<SkillId, () => Part[]>> = {
  'titans-hand': titansHand,
  quake,
  genesis,
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
