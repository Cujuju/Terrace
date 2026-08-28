// WHERE A VENT CAN BE — the three ways one comes into existence, and the one
// predicate all three share.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE BIRTHS (owner, 2026-08-27, settling issue #214's "do we only do
// them when the world is created, or allow them to randomly percolate?").
//
//   1. GENESIS. A world is SITED with a handful of vents the moment it is
//      created, on the highest ground worldgen gave it. This is the one that
//      makes a volcano feel like geology rather than like an event: the
//      mountain was always there, and the player learns which mountain it is
//      before anything comes out of it.
//   2. SPONTANEOUS. Very rarely, and only under `active`, a new vent opens by
//      itself. This is the "percolate" half of the question, kept RARE on
//      purpose — see SPONTANEOUS_BIRTH_MEAN_SECONDS in ./vents.ts for the
//      arithmetic that makes it a thing a long-lived world sees a few times
//      rather than a thing a session sees.
//   3. PLAYER-EXPOSED LAVA. A player who digs a shaft down into the lava band
//      has opened a vent, and one opens. This is issue #214's own placement
//      clause — "or where deep strata are exposed (#31 already defines
//      basalt/obsidian/lava-glow bands below the floor — a vent is where those
//      reach the surface)" — read literally, and it is the route that makes the
//      deep strata a place you can do something with rather than a colour ramp
//      at the bottom of a hole. It is also the ONE route that fires under
//      `dormant`: siting a vent is geology, and only ERUPTING is an event.
//
// WHAT IS DELIBERATELY NOT A ROUTE: a vent inside another vent's cone. Every
// route goes through `isSiteClear` below, which enforces one separation rule
// for all three, so no route can forget it.
//
// ─────────────────────────────────────────────────────────────────────────────
// REJECTION SAMPLING, NOT A SCAN — relics/server/spawn.ts's argument, verbatim
// in its consequences. Building the list of every qualifying cell is
// O(worldSize²), which is 262 144 heightAt calls on a 512² world, and the
// answer goes stale the moment anything sculpts. Sampling a bounded number of
// candidates is O(1) in the world size and needs no invalidation at all.

import {
  BAND_HEIGHT,
  DEEP_LAVA_DEPTH,
  MIN_HEIGHT,
  SEA_LEVEL,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type { VolcanoRng } from './rng.ts';

/** The read-only slice of the world this module needs. Keeps stubs one-line. */
export type SitingWorld = Pick<WorldApi, 'worldSize' | 'heightAt'>;

/** A cell, as this module hands one back. */
export interface Site {
  readonly x: number;
  readonly y: number;
}

/**
 * THE TOP OF CORE'S LAVA BAND — the height at or below which the world is
 * showing molten rock, and therefore the height a dug shaft has to reach to
 * count as having opened a vent.
 *
 * DERIVED FROM THE STRATA STACK, NEVER RESTATED. Core's floor is MIN_HEIGHT and
 * the lava band is DEEP_LAVA_DEPTH thick above it (shared/src/constants.ts,
 * Deep Strata 2026-08-19), so its ceiling is the sum and nothing else. Writing
 * the number would bind this plugin to today's −1536 floor and silently
 * mis-site every vent the day the stack is re-tuned — which has already
 * happened once to this codebase (the kraken bar, same design section).
 */
export const LAVA_BAND_CEILING = MIN_HEIGHT + DEEP_LAVA_DEPTH;

/**
 * How high above sea level a GENESIS vent's ground has to be, in terrace bands.
 *
 * Six bands is issue #214's "high ground" made checkable. It is above the
 * shore and above the buildable flats a settlement wants (structures' own
 * siting lives near the waterline), so a genesis cone lands on the part of the
 * island a player was going to look at rather than the part they were going to
 * live on — and the relaxation around a 6-band shoulder is a slope, not a
 * cliff, so the cone reads as the summit of ground that was already rising.
 */
export const VENT_MIN_BANDS_ABOVE_SEA = 6;

/** The same bar in height units, which is what heightAt answers in. */
export const VENT_MIN_HEIGHT = SEA_LEVEL + VENT_MIN_BANDS_ABOVE_SEA * BAND_HEIGHT;

/**
 * How far apart two vents must be, in cells.
 *
 * ONE CONE'S FULL FOOTPRINT, and it is derived from that rather than chosen:
 * ./vents.ts builds a cone as a centre brush plus a ring at CONE_RING_OFFSET,
 * so the edit reaches CONE_RING_OFFSET + MAX_BRUSH_RADIUS from the mouth, and
 * relaxation carries it further still. Two vents closer than that are not two
 * volcanoes — they are one lumpy mountain with two holes in it, and every
 * eruption of either would be re-sculpting the other's cone.
 *
 * Stated in WORLD UNITS and converted, per the 2026-08-21 re-sample rule: this
 * is a distance across the ground, so a change in sampling density must not
 * move it.
 */
export const VENT_SEPARATION_WORLD_UNITS = 24;
export const VENT_SEPARATION_CELLS = cellsAcross(VENT_SEPARATION_WORLD_UNITS);

/**
 * How much world one vent is worth, in SQUARE world units — the density that
 * decides how many vents genesis sites.
 *
 * cellsOverArea, not cellsAcross, and the distinction is the one that constant
 * exists to force: this is an AREA, so it scales as the square of the sampling
 * density. Got wrong as a length it would be four times the volcanoes.
 *
 * 4096 square world units is a 64 × 64-world-unit region per vent, which on the
 * shipped 512² world (16 384 square world units of ground) works out to FOUR
 * vents — enough that a player finds one without looking and few enough that
 * finding one still means something. The clamp below is what keeps a tiny test
 * world from getting zero and a huge world from getting a rash of them.
 */
export const WORLD_AREA_PER_VENT_SQUARE_WORLD_UNITS = 4096;

/** No world has fewer than this, so `dormant` always has something to show. */
export const MIN_VENTS_PER_WORLD = 1;

/**
 * Nor more than this, however big the world is.
 *
 * A CEILING ON THE WHOLE MECHANIC, not just on genesis: ./vents.ts checks it
 * before every birth, so spontaneous vents and dug ones cannot walk a world
 * past it either. Eight is what the eruption rate is tuned against — see
 * ERUPTION_MEAN_DORMANT_SECONDS's arithmetic, which is per-vent, so the world's
 * total eruption rate is this number times it.
 */
export const MAX_VENTS_PER_WORLD = 8;

/** How many vents genesis sites in a world of this size. */
export function genesisVentCount(worldSize: number): number {
  if (!(worldSize > 0)) return 0;
  const cells = worldSize * worldSize;
  const perVent = cellsOverArea(WORLD_AREA_PER_VENT_SQUARE_WORLD_UNITS);
  const count = Math.floor(cells / perVent);
  return Math.min(MAX_VENTS_PER_WORLD, Math.max(MIN_VENTS_PER_WORLD, count));
}

/**
 * Total placement attempts before a genesis siting gives up on one vent.
 *
 * 128, twice relics' budget, because this search is stricter than that one: a
 * relic wants shore-or-land (most of an island) while a vent wants the top six
 * bands (a fraction of it), and a search that gives up leaves the world with
 * one fewer volcano forever rather than retrying in a few seconds.
 */
export const VENT_SITE_ATTEMPTS = 128;

/**
 * Whether nothing already sited is too close — the ONE separation rule, shared
 * by all three birth routes.
 *
 * Chebyshev distance rather than Euclidean: the cone's own footprint is a
 * square of brushes, so a square exclusion is the shape that actually matches
 * what the edit covers, and it needs no square root.
 */
export function isSiteClear(site: Site, existing: readonly Site[]): boolean {
  for (const vent of existing) {
    const dx = Math.abs(vent.x - site.x);
    const dy = Math.abs(vent.y - site.y);
    if (Math.max(dx, dy) < VENT_SEPARATION_CELLS) return false;
  }
  return true;
}

/**
 * Picks a cell for a GENESIS or SPONTANEOUS vent, or null if the search found
 * nothing.
 *
 * THE RELAXATION IS NOT OPTIONAL POLITENESS, and it is here for exactly the
 * reason relics' is: a world whose worldgen produced no ground six bands above
 * the sea — a shallow archipelago, a flat test fixture — would otherwise
 * exhaust its attempts and be given no volcanoes at all, silently. So the
 * search remembers the HIGHEST above-sea candidate it saw and falls back to it.
 * A world with land gets a vent on the best summit it has; a world with no land
 * above water at all gets none, which is the honest answer.
 */
export function chooseVentSite(
  world: SitingWorld,
  rng: VolcanoRng,
  existing: readonly Site[],
): Site | null {
  const size = world.worldSize;
  if (size <= 0) return null;

  let best: Site | null = null;
  let bestHeight = SEA_LEVEL;

  for (let attempt = 0; attempt < VENT_SITE_ATTEMPTS; attempt++) {
    const x = Math.floor(rng.next() * size);
    const y = Math.floor(rng.next() * size);
    // Guards the 1-in-2³² case where next() returns something that floors to
    // `size`; an out-of-bounds cell would throw inside heightAt.
    if (x >= size || y >= size) continue;

    const site = { x, y };
    if (!isSiteClear(site, existing)) continue;

    const height = world.heightAt(x, y);
    if (height >= VENT_MIN_HEIGHT) return site;
    // Not high enough — but remember it if it is the best dry land so far.
    if (height > bestHeight) {
      bestHeight = height;
      best = site;
    }
  }

  return best;
}

/**
 * Whether this cell has been dug down into core's lava band — the predicate
 * behind birth route 3.
 *
 * A HEIGHT TEST AND NOTHING ELSE, which is what keeps this route from needing
 * to know whose sculpt did it or why. A player's shaft, a relic's Quake, a
 * neighbouring eruption's own flow: anything that leaves a cell showing molten
 * rock has exposed the vent, because that is what the cell now IS.
 */
export function isLavaExposed(height: number): boolean {
  return height <= LAVA_BAND_CEILING;
}
