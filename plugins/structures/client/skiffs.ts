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
// ANCHORED ON A MOORING, NEVER GUESSED: every skiff's anchor comes from
// site.ts's surveySite, which only ever reports a cell as water once this
// client's own terrain data proves it (see that file's banner on its
// under-count-never-over-count contract) AND only reports it as a MOORING once
// every point the hull can reach from it is DRAWN as water
// (SKIFF_MOORING_CLEARANCE_WORLD_UNITS below). A skiff therefore never crosses
// ground at any moment of its orbit — see that constant's comment for the
// derivation, and site.ts's `mooringVerdict` for the enforcement.
//
// AND NEVER SHARED WITH ANOTHER HULL (2026-09-05, GH #327 — owner: the skiffs
// "collide with each other and with the warboats"). Three guarantees now stand
// between a mooring and a collision, and NOT ONE of them is enforced in this
// file — it only ever consumes the moorings it is handed:
//
//   * SPACED. Two moorings in one survey are at least
//     SKIFF_MOORING_SPACING_WORLD_UNITS apart, so the two reach discs are
//     disjoint. Enforced in site.ts's `surveySite`.
//   * CLAIMED ONCE, WORLD-WIDE. The same spacing is required against every
//     mooring any OTHER settlement has already taken this pass, so two villages
//     on one bay can no longer both anchor on the same water — which used to
//     hand hashStructureCell the identical cell and draw two identical orbits
//     through each other. Enforced in placement.ts's second pass.
//   * INSHORE. A mooring's whole reach stays within
//     HARBOUR_INSHORE_BAND_WORLD_UNITS (protocol.ts) of the village's own
//     nearest water, which is the half of the harbour war boats keep out of.
//     Enforced in site.ts's `surveySite`.

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
 * THE CONTAINMENT GUARANTEE, RESTORED (2026-09-04, GH #327). These bounds were
 * both under half a CELL back when a cell was a world unit, which made the
 * orbit provably contained by the one cell site.ts confirmed is water. A cell
 * is a quarter of a world unit now, so a 0.28 orbit spans about two of them and
 * the containment stopped following from the number — nor could it, since the
 * hull itself is longer than a cell. The residual recorded here said restoring
 * it meant "having site.ts confirm a water DISC the orbit fits inside, which is
 * a change to the survey, not to a bound", and that is exactly what was done:
 * an anchor is no longer merely a water cell, it is a MOORING — a water cell
 * whose whole SKIFF_MOORING_CLEARANCE_WORLD_UNITS neighbourhood is DRAWN as
 * water (site.ts's mooringVerdict). The guarantee is structural again, and it is
 * enforced at survey time in site.ts rather than by any bound in this file:
 * nothing here needs to shrink, because the survey no longer offers anchors the
 * orbit could swing off the water from.
 */
export const SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS = 0.12;
export const SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS = 0.28;

/**
 * The hull's silhouette in WORLD UNITS: stem-to-transom length and maximum
 * beam. skiffModels.ts fit-checks assets/skiff.glb against exactly these
 * (SKIFF_FOOTPRINT), and the mooring clearance below is derived from the
 * length, so an authored hull that grew would move both at once.
 *
 * OWNED HERE RATHER THAN IN skiffModels.ts, where they used to sit, because
 * this file is the one both consumers can import: skiffModels.ts imports three
 * and cannot be reached from site.ts, which is pure arithmetic that runs in the
 * node test environment (see this file's banner and placement.ts's).
 *
 * 0.36 x 0.14 are the box the pre-GLB skiff was drawn at and the numbers the
 * fleet's spacing was tuned against — see SKIFF_FOOTPRINT's own comment.
 */
export const SKIFF_HULL_LENGTH_WORLD_UNITS = 0.36;
export const SKIFF_HULL_BEAM_WORLD_UNITS = 0.14;

/**
 * THE FARTHEST ANY POINT OF A MOORED HULL EVER GETS FROM ITS ANCHOR CELL, in
 * world units — the radius site.ts must find drawn water out to before a cell
 * may be used as a mooring.
 *
 * DERIVATION, from skiffModels.ts's writeFrame and nothing else. A skiff's
 * position is `anchor + (sin a, cos a) * orbitRadius` — a circle about the
 * anchor of radius at most SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS — and its own
 * geometry extends from that position by at most half its LENGTH, since yaw is
 * a rotation about the boat's origin and the length is its longest half-axis
 * (the beam, 0.14, is smaller and so is already covered). The two add: the
 * orbit can put the boat's centre at the far side of its circle and the heading
 * can point its bow straight outwards at the same moment. Whatever the roll or
 * heading, no part of the hull is ever further out than this.
 *
 * WHY THE BOB IS NOT IN IT. SKIFF_BOB_AMPLITUDE_WORLD_UNITS moves the boat
 * along Y only (writeFrame adds it to worldY and to nothing else). A mooring
 * test is about which GROUND the hull can be seen over — a horizontal
 * question — and a vertical displacement changes no part of the plan
 * silhouette this radius bounds.
 */
export const SKIFF_MOORING_CLEARANCE_WORLD_UNITS =
  SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS + SKIFF_HULL_LENGTH_WORLD_UNITS / 2;

/**
 * THE LEAST DISTANCE ALLOWED BETWEEN TWO MOORINGS, in world units — the rule
 * that keeps two skiffs from ever occupying the same water.
 *
 * PROOF, one line: every point of a hull moored at A lies within
 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS of A (see above), so if |A − B| is at
 * least TWICE that, the two reach discs are disjoint and no pose of one hull can
 * ever meet any pose of the other.
 *
 * TWICE, NOT MORE. The clearance is already a worst case over every orbit angle
 * and heading at once, so exactly two of them is genuine separation, not a
 * threshold two boats can jitter across (contrast plugins/boats' HOME_BERTH_
 * CLEARANCE_CELLS, which needs slack because its boats are STEERED to their
 * berths by a resolution pass and can be pushed off them; a skiff is drawn at a
 * closed-form offset from a fixed anchor and never moves against anything).
 *
 * ENFORCED IN TWO PLACES, both outside this file: site.ts's `surveySite` applies
 * it within one settlement's survey, placement.ts's second pass applies it
 * across every settlement's claims. See this file's banner.
 */
export const SKIFF_MOORING_SPACING_WORLD_UNITS = 2 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS;

export interface SkiffPlacement {
  /** Anchor mooring cell, in CELLS. skiffModels.ts converts it to world X/Z. */
  readonly x: number;
  readonly z: number;
  readonly orbitRadius: number;
  readonly orbitClockwise: boolean;
  /** Added to elapsed seconds before the orbit-angle formula runs — see skiffModels.ts. */
  readonly phaseSeconds: number;
}

/**
 * Skiffs for one coastal settlement. `moorings` is the subset of this
 * settlement's SiteSurvey.moorings that placement.ts's second pass found still
 * UNCLAIMED by any other settlement — nearest first — so a settlement's boats
 * cluster on the water closest to its own shore rather than scattered across its
 * whole search disc. It may be EMPTY (a coastal site whose water is all too
 * close to the shore to moor in, or whose whole inshore band a neighbouring
 * village claimed first), and this function then returns no skiffs: that is the
 * guarantee working, not a failure.
 *
 * THE COUNT RULE LIVES HERE AND NOWHERE ELSE, which is why the caller hands this
 * the already-filtered pool rather than filtering to a count itself: the pass
 * claims exactly the moorings this function returned placements for, so "how
 * many boats does a tier-N village float" is asked once, in one place, and the
 * claim can never drift from the placement.
 *
 * The orbit-radius roll below is unchanged by the mooring contract and needs no
 * clamp: SKIFF_MOORING_CLEARANCE_WORLD_UNITS is derived from the MAXIMUM roll,
 * so every radius this can produce is already covered.
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
  moorings: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): SkiffPlacement[] {
  if (tier < SKIFF_MIN_TIER) return [];
  const count = Math.min(SKIFF_MAX_PER_SETTLEMENT, tier, moorings.length);

  const placements: SkiffPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const cell = moorings[i];
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
