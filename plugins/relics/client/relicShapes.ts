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
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
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
 * Titan's Hand — a wider brush — is a RAISED HAND, palm toward the viewer
 * and fingers pointing up (owner, 2026-09-04: "point upwards, not flat"): a
 * wrist, a tall palm slab, four fingers of uneven length and a thumb splayed
 * out to the side, all in the passive category's amber.
 */
function titansHand(): Part[] {
  const wristHeight = 0.3;
  const palmHeight = 0.9;
  const wrist = place(new BoxGeometry(0.44, wristHeight, 0.22), 0, wristHeight / 2, 0);
  const palmTop = wristHeight + palmHeight;
  const palm = place(new BoxGeometry(0.8, palmHeight, 0.22), 0, wristHeight + palmHeight / 2, 0);
  const fingerWidth = 0.17;
  const fingerGap = 0.21;
  const fingerLengths = [0.42, 0.52, 0.5, 0.4];
  const fingers = fingerLengths.map((length, i) =>
    place(new BoxGeometry(fingerWidth, length, 0.2), (i - 1.5) * fingerGap, palmTop + length / 2, 0),
  );
  const thumb = place(new BoxGeometry(0.18, 0.46, 0.2), 0.58, 0.87, 0, 0, 0, -0.55);
  return painted('amber', wrist, palm, ...fingers, thumb);
}

/**
 * Quake — a collapsing crater — is RIPPLES IN THE GROUND (owner, 2026-09-04:
 * "a series of ripples"): a flat rock disc with three concentric crimson
 * ridges standing on it and a small dome at the epicentre.
 */
function quake(): Part[] {
  const slabHeight = 0.1;
  const slab = place(new CylinderGeometry(1.0, 1.0, slabHeight, ROUND_SEGMENTS), 0, slabHeight / 2, 0);
  const top = slabHeight;
  const ripples = [
    [0.32, 0.065],
    [0.62, 0.055],
    [0.92, 0.045],
  ].map(([radius, tube]) =>
    place(new TorusGeometry(radius, tube, 6, 12), 0, top + tube, 0, QUARTER_TURN),
  );
  const epicentre = place(new SphereGeometry(0.15, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, top + 0.06, 0);
  return [...painted('rock', slab), ...painted('crimson', ...ripples, epicentre)];
}

/**
 * Genesis — raising a small island — is an ISLAND first (owner, 2026-09-04:
 * "the arrow isn't as prominent"): a wide two-tier mound, stone beach then
 * grass, with one small tree on it, bark trunk and a round crimson canopy.
 */
function genesis(): Part[] {
  const beachHeight = 0.16;
  const beach = place(new CylinderGeometry(0.8, 1.0, beachHeight, ROUND_SEGMENTS), 0, beachHeight / 2, 0);
  const mound = place(new CylinderGeometry(0.55, 0.8, 0.3, ROUND_SEGMENTS), 0, 0.31, 0);
  const trunk = place(new CylinderGeometry(0.06, 0.08, 0.32, 6), 0, 0.62, 0);
  const canopy = place(new SphereGeometry(0.3, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, 0.96, 0);
  return [
    ...painted('stone', beach),
    ...painted('grass', mound),
    ...painted('bark', trunk),
    ...painted('crimson', canopy),
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
 * Spring of Aether — mana twice as fast — is a NATURAL SPRING (owner,
 * 2026-09-04: "like a water spring"): a stone outcrop with a rimmed pool sunk
 * into its top, water welling up as a low dome in the middle and one ripple
 * ring around it. No fountain column.
 */
function springOfAether(): Part[] {
  const rockHeight = 0.35;
  const rock = place(new CylinderGeometry(0.75, 0.95, rockHeight, 7), 0, rockHeight / 2, 0);
  const rockTop = rockHeight;
  const rim = place(new TorusGeometry(0.58, 0.1, 6, ROUND_SEGMENTS), 0, rockTop, 0, QUARTER_TURN);
  const poolDepth = 0.06;
  const pool = place(new CylinderGeometry(0.52, 0.52, poolDepth, ROUND_SEGMENTS), 0, rockTop, 0);
  const waterLevel = rockTop + poolDepth / 2;
  const well = place(new SphereGeometry(0.28, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, waterLevel, 0);
  const ripple = place(new TorusGeometry(0.38, 0.035, 5, ROUND_SEGMENTS), 0, waterLevel, 0, QUARTER_TURN);
  return [...painted('stone', rock, rim), ...painted('water', pool, well, ripple)];
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
