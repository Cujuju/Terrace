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
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  SphereGeometry,
  TetrahedronGeometry,
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
 * Titan's Hand — a wider brush — is an OPEN HAND, palm down, as if pressing
 * the ground flat: a broad palm slab with four fingers ahead of it and a thumb
 * out to the side.
 */
function titansHand(): BufferGeometry[] {
  const palm = new BoxGeometry(0.9, 0.22, 0.8);
  const fingerWidth = 0.18;
  const fingerLength = 0.55;
  const fingerGap = 0.23;
  const fingers = [-1.5, -0.5, 0.5, 1.5].map((slot) =>
    place(
      new BoxGeometry(fingerWidth, 0.2, fingerLength),
      slot * fingerGap,
      0,
      0.4 + fingerLength / 2,
    ),
  );
  const thumb = place(new BoxGeometry(0.42, 0.2, 0.18), 0.62, 0, 0.1, 0, -0.5);
  return [palm, ...fingers, thumb];
}

/**
 * Quake — a collapsing crater — is SHATTERED ROCK: a low broken slab with
 * jagged shards standing out of it at odd angles.
 */
function quake(): BufferGeometry[] {
  const slab = new CylinderGeometry(0.75, 0.9, 0.22, 6);
  const shards = [
    place(new TetrahedronGeometry(0.42), 0.25, 0.32, 0.1, 0.4, 0.3, 0.2),
    place(new TetrahedronGeometry(0.34), -0.35, 0.28, -0.2, -0.3, 1.1, 0.5),
    place(new TetrahedronGeometry(0.28), -0.1, 0.25, 0.4, 0.6, 2.2, -0.4),
    place(new TetrahedronGeometry(0.24), 0.45, 0.22, -0.4, -0.5, 0.7, 0.9),
  ];
  return [slab, ...shards];
}

/**
 * Genesis — raising a small island — is an ISLAND: a mound with a single tree
 * on it, trunk and canopy.
 */
function genesis(): BufferGeometry[] {
  const mound = new CylinderGeometry(0.5, 0.9, 0.32, ROUND_SEGMENTS);
  const trunk = place(new CylinderGeometry(0.07, 0.09, 0.4, 6), 0, 0.36, 0);
  const canopy = place(new ConeGeometry(0.34, 0.6, 7), 0, 0.82, 0);
  return [mound, trunk, canopy];
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
 * Spring of Aether — mana twice as fast — is a SPRING: a basin ring with a
 * column of water rising from it and a drop cresting at the top.
 */
function springOfAether(): BufferGeometry[] {
  const basin = place(new TorusGeometry(0.62, 0.16, 6, ROUND_SEGMENTS), 0, -0.4, 0, QUARTER_TURN);
  const column = place(new CylinderGeometry(0.16, 0.26, 0.9, 8), 0, 0.05, 0);
  const crest = place(new SphereGeometry(0.3, SPHERE_SEGMENTS, SPHERE_SEGMENTS), 0, 0.6, 0);
  const drop = place(new ConeGeometry(0.14, 0.32, 6), 0, 0.98, 0);
  return [basin, column, crest, drop];
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
