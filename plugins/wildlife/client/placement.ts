// Vertical placement: turning "the rendered terrain surface is at world Y = s"
// into "this creature's origin belongs at world Y = y".
//
// Pure arithmetic, no three, no DOM — which is what lets it be tested in the
// same node environment as the rest of the suite (the project ships no headless
// GL rig; see client/vite.config.ts).
//
// HORIZONTAL placement needs no code: CELL_WORLD_SIZE is 1 (client/src/config.ts
// — "world-space X/Z coordinates ARE cell coordinates"), so a creature's cell
// position is its world X/Z and its body length in cells is its length in world
// units. RESIDUAL, stated rather than papered over: if CELL_WORLD_SIZE ever
// stops being 1, every size and position in this plugin's client half needs a
// multiply, and nothing here will fail loudly to tell you so.

import { SEA_LEVEL } from '@terrace/shared';
import type { WildlifeSpecies } from '../protocol.ts';

/**
 * World-space Y of the sea surface.
 *
 * The renderer draws the sea at `SEA_LEVEL * HEIGHT_WORLD_SCALE +
 * WATER_SURFACE_LIFT` (client/src/render/water.ts). SEA_LEVEL is 0 by definition
 * in @terrace/shared — "water is every height at or below zero" — so the first
 * term is exactly 0 whatever the height scale is, and the second is a
 * thirty-second of a cell, two hundred times smaller than the tightest clearance
 * below. Swimmers are therefore placed against Y = 0.
 *
 * The `: 0` annotation is the guard: this stops compiling the day SEA_LEVEL
 * becomes anything else, which is exactly when this reasoning stops holding.
 */
export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

/** Where in the water column a species swims, and how much room it insists on. */
export interface SwimProfile {
  /** 0 = at the surface, 1 = on the seabed. */
  readonly depthFraction: number;
  /** Never closer than this to the seabed, in world units. */
  readonly minClearance: number;
  /** Never closer than this to the surface, in world units. */
  readonly minSubmergence: number;
}

/**
 * Fish sit just under the surface where the light is, whales cruise mid-water,
 * and the deep-sea creature hugs the bottom — that vertical separation is what
 * makes three species sharing one body of water read as three species rather
 * than as a soup. The clearances are sized off each model's own half-height so a
 * creature never intersects the seabed or breaches the surface.
 */
export const SWIM_PROFILES: Readonly<Record<WildlifeSpecies, SwimProfile | null>> = {
  fish: { depthFraction: 0.2, minClearance: 0.25, minSubmergence: 0.3 },
  whale: { depthFraction: 0.5, minClearance: 0.7, minSubmergence: 0.7 },
  deepsea: { depthFraction: 0.88, minClearance: 0.35, minSubmergence: 0.5 },
  // Land species stand on the ground; they have no water column to sit in.
  grazer: null,
};

/**
 * Terrain Y a creature is placed against when the client has never been sent the
 * chunk it is standing in. Band 0 is what the terrain mesh draws for unknown
 * cells (see ClientPluginCtx.terrainHeightAt), and band 0 is world Y 0 — the
 * same plane as the sea surface — so this matches what the player sees.
 *
 * In practice creatures only ever exist in UNLOCKED territory (the server refuses
 * to spawn or steer them anywhere else), so this is a belt-and-suspenders default
 * for the one frame between a creature's first broadcast and its chunk arriving.
 */
export const UNKNOWN_TERRAIN_WORLD_Y = 0;

/**
 * Where a swimmer's origin sits between the seabed and the surface.
 *
 * The fraction is applied first, then both clearances clamp it. In water too
 * shallow to honour both (a fish that has drifted over a sandbar), the clamps
 * would cross; splitting the remaining column is the only answer that keeps the
 * creature inside the water at all, and it degrades smoothly as the water
 * shallows rather than snapping when the two limits meet.
 */
export function swimmerWorldY(seabedY: number, profile: SwimProfile): number {
  const column = SEA_SURFACE_WORLD_Y - seabedY;
  const preferred = SEA_SURFACE_WORLD_Y - profile.depthFraction * column;

  const lowest = seabedY + profile.minClearance;
  const highest = SEA_SURFACE_WORLD_Y - profile.minSubmergence;
  if (highest < lowest) return seabedY + column / 2;

  return Math.min(Math.max(preferred, lowest), highest);
}

/**
 * World Y for one creature. `terrainY` is ClientPluginCtx.terrainHeightAt at the
 * creature's cell — the seabed for a swimmer, the ground for a walker — or null
 * before the first snapshot arrives.
 */
export function creatureWorldY(species: WildlifeSpecies, terrainY: number | null): number {
  const surfaceY = terrainY ?? UNKNOWN_TERRAIN_WORLD_Y;
  const profile = SWIM_PROFILES[species];
  // Land species' models are built with the origin at their feet, so the ground
  // height is the answer with no offset.
  return profile === null ? surfaceY : swimmerWorldY(surfaceY, profile);
}
