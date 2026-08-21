// skiffs.ts — CARD 33 "Fishing Villages": the small fleet a mature coastal
// settlement floats on its own confirmed water (site.ts). Pure placement/
// animation-parameter arithmetic, no three import — mirrors placement.ts's
// own "pure logic here, three.js in the sibling *Models.ts file" split, so
// this runs in the same node test environment as the rest of the suite.
//
// PURELY CLIENT-SIDE PRESENTATION, deliberately not a server-tracked entity
// (contrast plugins/wildlife's creatures, which the server steers and
// broadcasts at 5 Hz). A skiff has no simulated behaviour to protect — it
// never catches anything, blocks anything, or is worth a player's sculpt
// decision — so there is nothing here an authoritative server needs to
// referee, and nothing here for anti-cheat to reason about. Its whole state
// is "float near this settlement, in a small idle loop", the same shape
// plugins/weather/client/rig.ts's rain uses for the same reason: every
// raindrop invented locally from a handful of broadcast numbers. That
// argument transfers directly here — the "settlement broadcast numbers" are
// just a structure's own tier and cell, already on the wire. Consequence:
// zero marginal wire bytes, and no new population cap to police the way
// WILDLIFE_POPULATION_CAP polices wildlife's broadcast (see census.ts) —
// skiffModels.ts's SKIFF_INSTANCE_CAPACITY is a client-side INSTANCE BUFFER
// bound only, not a bandwidth budget, because nothing here is ever sent.
//
// ANCHORED ON CONFIRMED WATER, NEVER GUESSED: every skiff's anchor comes
// from site.ts's surveySite, which only ever reports a cell as water once
// this client's own terrain data proves it (see that file's banner on its
// under-count-never-over-count contract). A skiff is never placed anywhere
// this client has not itself confirmed is water, and its idle orbit
// (SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS) is bounded well inside that one
// cell — see that constant's own comment for why "must respect the water"
// is a placement-time AND an animation-time guarantee.

import { hashStructureCell, type StructureTier } from '../protocol.ts';

/**
 * Tier at which a shore settlement is judged to have "grown a boat" (card
 * 33's own phrase). Below this, a settlement is a bare camp — plausible on
 * any coast, not yet a fishing village — so it floats nothing.
 *
 * 1 — the first tier past the founding camp (STRUCTURE_TIERS[0],
 * protocol.ts). Not 0: a settlement that has not survived a single tier-up
 * has not "grown" anything yet, boats included.
 */
export const SKIFF_MIN_TIER: StructureTier = 1;

/**
 * Most skiffs one settlement ever floats, however high its tier climbs.
 *
 * 3 — enough that a mature fishing village visibly reads as "has a fleet"
 * rather than "has a boat", while keeping the worst-case instance count
 * (skiffModels.ts's SKIFF_INSTANCE_CAPACITY) a small, fixed multiple of
 * STRUCTURES_CAP rather than letting one maxed-out settlement's count grow
 * with MAX_STRUCTURE_TIER indefinitely.
 */
export const SKIFF_MAX_PER_SETTLEMENT = 3;

/**
 * Seconds for one full lap of a skiff's idle orbit around its anchor.
 * Shared with skiffModels.ts so a placement's `phaseSeconds` (an offset
 * added to elapsed time) and the render-time orbit-angle formula agree on
 * what "one lap" means.
 */
export const SKIFF_ORBIT_PERIOD_SECONDS = 14;

/**
 * Bounds on a skiff's idle-orbit radius around its anchor cell, in WORLD UNITS.
 *
 * The values are unchanged by the 2026-08-21 re-sample and deliberately so: a
 * skiff's orbit is as wide a patch of sea as it ever was, and 0.12 as the floor
 * still keeps even the smallest roll visibly moving rather than sitting still.
 *
 * WHAT THE RE-SAMPLE DID TAKE, STATED RATHER THAN QUIETLY LOST: these bounds
 * were both under half a CELL back when a cell was a world unit, which made the
 * orbit provably contained by the one cell site.ts confirmed is water. A cell
 * is a quarter of a world unit now, so a 0.28 orbit spans about two of them and
 * the containment no longer follows from the number — nor could it, since the
 * hull itself (0.9 world units, skiffModels.ts) is wider than a cell. In
 * practice the survey's water cell sits in open sea and its neighbours are
 * water too; the guarantee is now empirical rather than structural. RESIDUAL,
 * named and not fixed here: restoring it means having site.ts confirm a water
 * DISC the orbit fits inside, which is a change to the survey, not to a bound.
 */
export const SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS = 0.12;
export const SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS = 0.28;

export interface SkiffPlacement {
  /** Anchor water cell, in CELLS. skiffModels.ts converts it to world X/Z. */
  readonly x: number;
  readonly z: number;
  readonly orbitRadius: number;
  readonly orbitClockwise: boolean;
  /** Added to elapsed seconds before the orbit-angle formula runs — see skiffModels.ts. */
  readonly phaseSeconds: number;
}

/**
 * Skiffs for one coastal settlement. `waterCells` is site.ts's
 * SiteSurvey.waterCells for this settlement's own cell — nearest confirmed
 * water first — so a settlement's boats cluster on the water closest to its
 * own shore rather than scattered across its whole search disc.
 *
 * Deterministic: every skiff's animation parameters come from
 * hashStructureCell on its OWN anchor cell — a different input domain from
 * every other hash consumer in this plugin (structureVariation and
 * isDurandsCell both hash the STRUCTURE's own cell; this hashes a WATER
 * cell), so there is no risk of two unrelated rolls correlating through a
 * shared coordinate.
 */
export function skiffsForSettlement(
  tier: StructureTier,
  waterCells: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): SkiffPlacement[] {
  if (tier < SKIFF_MIN_TIER) return [];
  const count = Math.min(SKIFF_MAX_PER_SETTLEMENT, tier, waterCells.length);

  const placements: SkiffPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const cell = waterCells[i];
    const hash = hashStructureCell(cell.x, cell.y);
    const phaseRoll = hash & 0xffff;
    const radiusRoll = (hash >>> 16) & 0xff;
    const directionRoll = (hash >>> 24) & 1;
    placements.push({
      x: cell.x,
      z: cell.y,
      orbitRadius:
        SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS +
        (radiusRoll / 0xff) * (SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS - SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS),
      orbitClockwise: directionRoll === 0,
      phaseSeconds: (phaseRoll / 0x10000) * SKIFF_ORBIT_PERIOD_SECONDS,
    });
  }
  return placements;
}
