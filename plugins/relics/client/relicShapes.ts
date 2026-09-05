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
// Built lazily and cached per skill: the geometry is shared by every relic
// carrying that skill (the material, which holds the colour, stays per-relic
// — index.ts), and released when the plugin is disposed.

import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SkillId } from '../protocol.ts';
import { GEM_RADIUS_CELLS } from './gems.ts';

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

/**
 * Titan's Hand — a wider brush — is a RAISED HAND, palm toward the viewer
 * and fingers pointing up (owner, 2026-09-04: "point upwards, not flat"): a
 * wrist, a tall palm slab, four fingers of uneven length and a thumb splayed
 * out to the side.
 */
function titansHand(): BufferGeometry[] {
  const palm = new BoxGeometry(0.8, 0.9, 0.22);
  const wrist = place(new BoxGeometry(0.44, 0.3, 0.22), 0, -0.6, 0);
  const fingerWidth = 0.17;
  const fingerGap = 0.21;
  const fingerLengths = [0.42, 0.52, 0.5, 0.4];
  const fingers = fingerLengths.map((length, i) =>
    place(new BoxGeometry(fingerWidth, length, 0.2), (i - 1.5) * fingerGap, 0.45 + length / 2, 0),
  );
  const thumb = place(new BoxGeometry(0.18, 0.46, 0.2), 0.58, 0.12, 0, 0, 0, -0.55);
  return [wrist, palm, ...fingers, thumb];
}

/**
 * Quake — a collapsing crater — is RIPPLES IN THE GROUND (owner, 2026-09-04:
 * "a series of ripples"): a flat disc with three concentric ridges standing
 * on it and a small dome at the epicentre.
 */
function quake(): BufferGeometry[] {
  const slabHeight = 0.1;
  const slab = new CylinderGeometry(1.0, 1.0, slabHeight, ROUND_SEGMENTS);
  const top = slabHeight / 2;
  const ripples = [
    [0.32, 0.065],
    [0.62, 0.055],
    [0.92, 0.045],
  ].map(([radius, tube]) =>
    place(new TorusGeometry(radius, tube, 6, 12), 0, top + tube, 0, QUARTER_TURN),
  );
  const epicentre = place(new SphereGeometry(0.15, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, top + 0.06, 0);
  return [slab, ...ripples, epicentre];
}

/**
 * Genesis — raising a small island — is an ISLAND first (owner, 2026-09-04:
 * "the arrow isn't as prominent"): a wide two-tier mound, beach then grass,
 * with one small round-canopied tree on it.
 */
function genesis(): BufferGeometry[] {
  const beach = new CylinderGeometry(0.8, 1.0, 0.16, ROUND_SEGMENTS);
  const mound = place(new CylinderGeometry(0.55, 0.8, 0.3, ROUND_SEGMENTS), 0, 0.23, 0);
  const trunk = place(new CylinderGeometry(0.06, 0.08, 0.32, 6), 0, 0.54, 0);
  const canopy = place(new SphereGeometry(0.3, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, 0.88, 0);
  return [beach, mound, trunk, canopy];
}

/**
 * Azure Heart — half-price sculpts — is a HEART, extruded so it has a face
 * and a rim to catch the light as it turns.
 */
function azureHeart(): BufferGeometry[] {
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
  // Extrude runs along +z from the shape plane; centre it on the origin.
  heart.translate(0, 0, -0.17);
  return [heart];
}

/**
 * Spring of Aether — mana twice as fast — is a NATURAL SPRING (owner,
 * 2026-09-04: "like a water spring"): a rock outcrop with a rimmed pool sunk
 * into its top, water welling up as a low dome in the middle and one ripple
 * ring around it. No fountain column.
 */
function springOfAether(): BufferGeometry[] {
  const rockHeight = 0.35;
  const rock = new CylinderGeometry(0.75, 0.95, rockHeight, 7);
  const rockTop = rockHeight / 2;
  const rim = place(new TorusGeometry(0.58, 0.1, 6, ROUND_SEGMENTS), 0, rockTop, 0, QUARTER_TURN);
  const poolDepth = 0.06;
  const pool = place(new CylinderGeometry(0.52, 0.52, poolDepth, ROUND_SEGMENTS), 0, rockTop, 0);
  const waterLevel = rockTop + poolDepth / 2;
  const well = place(new SphereGeometry(0.28, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, waterLevel, 0);
  const ripple = place(new TorusGeometry(0.38, 0.035, 5, ROUND_SEGMENTS), 0, waterLevel, 0, QUARTER_TURN);
  return [rock, rim, pool, well, ripple];
}

const BUILDERS: Readonly<Record<SkillId, () => BufferGeometry[]>> = {
  'titans-hand': titansHand,
  quake,
  genesis,
  'azure-heart': azureHeart,
  'spring-of-aether': springOfAether,
};

const cache = new Map<SkillId, BufferGeometry>();

/**
 * The world geometry for a skill's relic, built on first use and shared after.
 * Every part is merged into one geometry and scaled from the unit frame the
 * builders model in to the gem's world radius; the parts are disposed once
 * merged, since only the merge is kept.
 */
export function relicGeometry(skill: SkillId): BufferGeometry {
  const cached = cache.get(skill);
  if (cached !== undefined) return cached;

  const parts = BUILDERS[skill]();
  // Merging needs every part indexed or none: the polyhedra come unindexed,
  // so everything is unrolled — which flat shading wants anyway.
  const unrolled = parts.map((part) => (part.index === null ? part : part.toNonIndexed()));
  const merged = mergeGeometries(unrolled);
  if (merged === null) throw new Error(`relic shape for ${skill} has incompatible parts`);
  for (const part of parts) part.dispose();
  for (const part of unrolled) part.dispose();
  // The bounding box's centre becomes the origin, so every shape bobs and
  // spins about its own middle and hovers at the height gems.ts promises.
  merged.center();
  merged.scale(GEM_RADIUS_CELLS, GEM_RADIUS_CELLS, GEM_RADIUS_CELLS);
  cache.set(skill, merged);
  return merged;
}

/** Releases every cached geometry — the plugin's dispose; a rejoin rebuilds. */
export function disposeRelicGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}
