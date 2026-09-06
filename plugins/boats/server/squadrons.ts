// squadrons.ts — the peacetime half of the fleet.
//
// Until 2026-09-05 a war boat with no kraken in range of its home had exactly
// one goal: the mooring ./fleet.ts's `homeBerthFor` handed it, standoff 0. A
// world that had grown its coast therefore floated three hulls per settlement
// and gave every one of them the same thing to do — sit. This module is the
// second goal source (owner, 2026-09-05: "assemble in fleets of three to seven
// ships and sail around and explore"): every boat past its village's HOME
// GUARD is drawn into a squadron, and a squadron sails legs of open sea.
//
// PURE OF THE WORLD, like everything else in this plugin's server half. It
// owns the roster arithmetic and the state machine; every question that needs
// terrain — where a squadron musters, where a leg may reach — is asked through
// `SquadronNavigator`, which ./fleet.ts implements over the hull law. That is
// what lets the assembly contract be tested against a hand-built roster with
// no world at all.
//
// DETERMINISTIC BY CONSTRUCTION, the same bar the rest of the plugin holds: no
// clock, no RNG, no floating-point comparison that decides a roster. Candidates
// are ordered by a Z-ORDER (Morton) key over their home cell, so the ordering
// is integer-only and spatially coherent — neighbours on one stretch of coast
// come out adjacent — and ties break on boat id, which is unique and fixed.
// Squadron sizes come from `hashCell`, an integer hash of the flagship's home
// cell, so the same world assembles the same squadrons every run.

import { cellsAcross } from '@terrace/shared';
import { BOATS_PER_VILLAGE, VILLAGE_PATROL_RANGE_CELLS } from '../protocol.ts';

/**
 * Boats a village keeps on its own moorings, whatever else it floats.
 *
 * 1, AND IT IS A CHANGE TO A SETTLED RULE (owner, 2026-09-05). Until now every
 * one of a village's BOATS_PER_VILLAGE hulls idled at home, which is exactly
 * the fleet docs/decisions/kraken.md sized KRAKEN_ROUT_WOUNDS to be beaten by
 * — "a full fishing fleet, and not one boat less". A village now moors ONE
 * boat and sends the other two to sea, so a lone settlement can no longer rout
 * a kraken from its own harbour: it must hold until a squadron is recalled.
 * That cost was named to the owner and accepted; see the decision record.
 *
 * 1 rather than 2 because the arithmetic of the thing being built runs the
 * other way: at 2 a village frees a single explorer, so a squadron of
 * SQUADRON_MIN_SHIPS..SQUADRON_MAX_SHIPS would have to be crewed from three to
 * seven separate villages and its members' homes would be strung down miles of
 * coast — further apart than SQUADRON_HOME_SPREAD_CELLS permits, so on a
 * thinly settled coast no squadron would ever form at all. At 1 each village
 * frees two, and a squadron is two to four neighbouring villages.
 */
export const HOME_GUARD_BOATS_PER_VILLAGE = 1;

/**
 * Boats a village frees to the open sea — the whole reason this module has
 * anything to do. Stated as the subtraction it is so that changing either term
 * cannot leave a stale third number behind.
 */
export const EXPLORERS_PER_VILLAGE = BOATS_PER_VILLAGE - HOME_GUARD_BOATS_PER_VILLAGE;

/** Fewest ships that may sail as a squadron — the owner's own lower bound. */
export const SQUADRON_MIN_SHIPS = 3;

/** Most ships one squadron takes — the owner's own upper bound. */
export const SQUADRON_MAX_SHIPS = 7;

/**
 * How far apart two villages may lie and still crew one squadron, in cells.
 *
 * VILLAGE_PATROL_RANGE_CELLS, and it is the recall rule rather than a taste
 * for tight groups. ./fleet.ts's `targetFor` answers a kraken within one
 * patrol range OF A BOAT'S OWN HOME, so a squadron whose members' homes all
 * sit inside one such range is a squadron every member of which is recalled by
 * the SAME kraken. Crew one from homes further apart than that and a single
 * arrival splits it: half the ships peel off to fight, the remainder falls
 * below SQUADRON_MIN_SHIPS and dissolves, and the fleet that was supposed to
 * answer together arrives in two pieces.
 */
export const SQUADRON_HOME_SPREAD_CELLS = VILLAGE_PATROL_RANGE_CELLS;

/**
 * How close to the rendezvous every ship must be before the squadron sails, in
 * cells — and, the same scale being the same question, how close the flagship
 * must come to a leg's end for that leg to be over.
 *
 * DERIVED FROM THE WATER A SQUADRON OCCUPIES, not chosen. ./fleet.ts's
 * resolution pass holds hulls two personal spaces apart, so SQUADRON_MAX_SHIPS
 * of them need a disc whose area covers that many discs of radius
 * 2 x BOAT_PERSONAL_SPACE_CELLS: r >= 2 x space x sqrt(n). Anything tighter and
 * the last ship to arrive can never satisfy the test — the resolution pass
 * pushes it back out as fast as it closes — and the squadron musters forever.
 *
 * Restated here against the same 0.5 world units ./fleet.ts's
 * BOAT_PERSONAL_SPACE_CELLS states, rather than imported, only because
 * importing it would make this module depend on the file that consumes it.
 */
const BOAT_PERSONAL_SPACE_WORLD_UNITS = 0.5;
export const SQUADRON_MUSTER_RADIUS_CELLS =
  2 * cellsAcross(BOAT_PERSONAL_SPACE_WORLD_UNITS) * Math.sqrt(SQUADRON_MAX_SHIPS);

/**
 * How long a squadron waits for stragglers before sailing without them.
 *
 * A muster with no deadline is a deadlock: one ship wedged behind a headland,
 * or moored in a bay its sisters cannot enter, holds every other ship of the
 * squadron at the rendezvous for the life of the world. At the timeout the
 * squadron sails with whoever came, provided that is still SQUADRON_MIN_SHIPS;
 * the stragglers are released back to their moorings and are candidates again
 * on the next pass.
 *
 * 60 s, because that is what the distance costs: SQUADRON_HOME_SPREAD_CELLS is
 * 64 world units and a boat makes 0.9 of them a second, so a ship crossing the
 * whole spread needs ~71 s of open water and rather more round a coast. A
 * timeout shorter than the crossing would abandon ships that were sailing
 * perfectly well; this one only ever fires on a ship that is not making way.
 */
export const SQUADRON_MUSTER_TIMEOUT_SECONDS = 60;

/**
 * How far out a leg of open sea reaches from where the squadron starts it, in
 * cells.
 *
 * 2 x VILLAGE_PATROL_RANGE_CELLS. The owner asked for exploration rather than
 * a patrol, and one patrol range is by definition the water a village already
 * defends — a leg that ended inside it would never take a squadron anywhere
 * its own harbour could not see. Two ranges is the shortest leg that certainly
 * ends in water no village of the squadron is answerable for, which is what
 * makes the voyage worth watching, and it is the distance the owner accepted
 * the recall cost for.
 */
export const SQUADRON_LEG_LENGTH_CELLS = 2 * VILLAGE_PATROL_RANGE_CELLS;

/**
 * Shortest a leg may be shortened to before the bearing is abandoned, in cells.
 *
 * A bearing's full SQUADRON_LEG_LENGTH_CELLS often ends on land or in locked
 * ocean, so the navigator walks back along the bearing looking for water a
 * hull may hold. That walk needs a floor, and the floor is the property the
 * leg exists for: VILLAGE_PATROL_RANGE_CELLS, one patrol range, is the water a
 * village already defends — shorten past it and the "leg" ends inside the
 * squadron's own home waters, which is a patrol rather than the exploration
 * the owner asked for. A bearing that cannot reach this far is barred, and the
 * next bearing is tried.
 */
export const SQUADRON_LEG_MIN_LENGTH_CELLS = VILLAGE_PATROL_RANGE_CELLS;

/**
 * Bearings a squadron tries before giving up on a leg for this tick.
 *
 * 8 — the full circle at the same 45 degrees shared/src/steering.ts's
 * AVOID_TURN_ATTEMPTS sweeps, and for the same reason: it is the coarsest
 * sweep that cannot leave a navigable exit unexamined, since no strip of open
 * water wide enough for a hull subtends less than 45 degrees at the leg
 * distances involved. A squadron that fails all eight is landlocked this tick
 * and simply tries again on the next, one hash step further on.
 */
export const SQUADRON_WAYPOINT_ATTEMPTS = 8;

/** One point a squadron is steering for — a rendezvous, or a leg's end. */
export interface SquadronWaypoint {
  readonly x: number;
  readonly y: number;
}

/** The slice of a boat this module reasons about. */
export interface SquadronBoat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly homeX: number;
  readonly homeY: number;
}

/**
 * Every question about the world a squadron has to ask, so that this module
 * asks none of them itself. ./fleet.ts implements both over the hull law.
 */
export interface SquadronNavigator {
  /**
   * Open water off this village where a squadron may assemble, or null when
   * the village has none — its first surveyed mooring, which the survey has
   * already proved a manoeuvrable hull pose.
   */
  rendezvousFor(homeX: number, homeY: number): SquadronWaypoint | null;
  /**
   * Is this ship lying in its OWN village's harbour — anywhere the berth
   * survey could have moored it?
   *
   * ITS OWN QUESTION, and not one this module may derive. The obvious
   * shortcut — "within SQUADRON_MUSTER_RADIUS_CELLS of the rendezvous" — is
   * wrong, and measurably so (2026-09-05: a village's six surveyed moorings
   * lay up to 17 cells apart against a 10.58-cell muster radius, so two of
   * every three explorers were judged out of harbour and NO squadron ever
   * formed). A muster radius is the water a gathered squadron occupies; a
   * harbour is the disc the berth survey walks. ./fleet.ts owns that disc.
   */
  isInHarbour(homeX: number, homeY: number, x: number, y: number): boolean;
  /**
   * A leg's end: hull-legal water about SQUADRON_LEG_LENGTH_CELLS from here,
   * on the `attempt`-th bearing of `seed`, that a route actually reaches — or
   * null when that bearing is barred.
   */
  legFrom(
    fromX: number,
    fromY: number,
    seed: number,
    attempt: number,
  ): SquadronWaypoint | null;
}

type SquadronPhase = 'mustering' | 'cruising';

interface Squadron {
  readonly id: number;
  /** Boat ids, flagship first. Flagship is the lowest Z-order member. */
  members: number[];
  /** Where the ships gather before a leg, and where a dissolved one leaves them. */
  readonly rendezvous: SquadronWaypoint;
  phase: SquadronPhase;
  /** Seconds spent mustering — see SQUADRON_MUSTER_TIMEOUT_SECONDS. */
  musteringSeconds: number;
  /** The end of the leg being sailed; meaningless while mustering. */
  leg: SquadronWaypoint | null;
  /** Legs completed — the peacetime trace's measure of a voyage's length. */
  legsSailed: number;
  /**
   * How many legs this squadron has ever ASKED for, successful or not. It, and
   * not `legsSailed`, seeds the bearing: a leg that fails every bearing must
   * come back on the next tick with a different draw, or a squadron boxed in
   * by the coast it happens to sit on would re-try the same eight barred
   * bearings for the life of the world.
   */
  legSeedStep: number;
}

const squadrons = new Map<number, Squadron>();
const squadronOfBoat = new Map<number, number>();
let nextSquadronId = 1;

/** Drops every squadron — a new or restored world assembles from scratch. */
export function resetSquadrons(): void {
  squadrons.clear();
  squadronOfBoat.clear();
  nextSquadronId = 1;
}

/** The squadron this boat sails with, or null — for the peacetime trace. */
export function squadronOf(boatId: number): number | null {
  return squadronOfBoat.get(boatId) ?? null;
}

/** How many squadrons are at sea — for the peacetime trace and the tests. */
export function squadronCount(): number {
  return squadrons.size;
}

/** Ships of this squadron, flagship first — for the peacetime trace and tests. */
export function squadronMembers(squadronId: number): readonly number[] {
  return squadrons.get(squadronId)?.members ?? [];
}

/**
 * An integer hash of a cell — the same shape plugins/structures' own
 * `hashStructureCell` uses, restated rather than imported because plugins may
 * not import each other. Deterministic, integer-only, and mixed well enough
 * that two villages a cell apart do not draw the same squadron size.
 */
export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Interleaves the low bits of a cell into a Z-ORDER key.
 *
 * Sorting candidates by this is what makes a squadron a stretch of coast
 * rather than a set of boats that happen to share an id range: Z-order keeps
 * points that are near in the plane near in the ordering, which plain
 * row-major (y, then x) does not — under row-major two villages one cell apart
 * across a row boundary sort a whole world width apart.
 *
 * 16 bits per axis, which covers any world this game builds; a coordinate
 * past that folds rather than throwing, because a fold costs a slightly worse
 * grouping and a throw costs the fleet.
 */
const ZORDER_BITS_PER_AXIS = 16;

export function zOrderKey(x: number, y: number): number {
  const mask = (1 << ZORDER_BITS_PER_AXIS) - 1;
  const cx = x & mask;
  const cy = y & mask;
  let key = 0;
  for (let bit = 0; bit < ZORDER_BITS_PER_AXIS; bit++) {
    key += ((cx >>> bit) & 1) * Math.pow(2, 2 * bit);
    key += ((cy >>> bit) & 1) * Math.pow(2, 2 * bit + 1);
  }
  return key;
}

/** Squared distance, so the hot comparisons below never take a square root. */
function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * How many ships this flagship's squadron wants — SQUADRON_MIN_SHIPS through
 * SQUADRON_MAX_SHIPS inclusive, drawn from its home cell so it is stable for
 * the life of the village rather than re-rolled every assembly.
 */
function targetSizeFor(homeX: number, homeY: number): number {
  const span = SQUADRON_MAX_SHIPS - SQUADRON_MIN_SHIPS + 1;
  return SQUADRON_MIN_SHIPS + (hashCell(homeX, homeY) % span);
}

/**
 * Drops members that are no longer candidates — sunk, burned, scuttled with
 * their village, or recalled to a kraken — and dissolves any squadron left
 * under strength.
 *
 * DISSOLUTION IS TOTAL, not a top-up. A squadron three ships down is a
 * squadron whose flagship may be gone and whose remaining ships are strung
 * along a leg they can no longer crew; putting a fresh ship into it would
 * hand that ship a goal a hundred cells away with nothing to sail with. The
 * survivors go back to their moorings and are candidates again on the next
 * pass, which is where a new squadron of the right size and shape is formed.
 */
function pruneSquadrons(candidates: ReadonlySet<number>): void {
  for (const [id, squadron] of squadrons) {
    squadron.members = squadron.members.filter((boatId) => candidates.has(boatId));
    if (squadron.members.length >= SQUADRON_MIN_SHIPS) continue;
    for (const boatId of squadron.members) squadronOfBoat.delete(boatId);
    squadrons.delete(id);
  }
  // A boat whose squadron went with it must not keep pointing at the wreck.
  for (const [boatId, squadronId] of squadronOfBoat) {
    if (!squadrons.has(squadronId) || !candidates.has(boatId)) {
      squadronOfBoat.delete(boatId);
    }
  }
}

/**
 * Forms squadrons out of every candidate not already sailing with one.
 *
 * A SQUADRON IS CREWED OUT OF HARBOUR — `SquadronNavigator.isInHarbour`, which
 * is the berth survey's own disc and not this module's arithmetic.
 * An unrecruited explorer is steered home by ./fleet.ts's harbour pass, so a
 * ship merely far from home becomes a candidate the moment it arrives — and a
 * ship that can never get home (wedged, or in a bay its sisters cannot enter)
 * is never recruited at all, rather than being taken on and then waited for.
 *
 * IT IS NOT A CURE FOR THE MUSTER TREADMILL, and does not claim to be: a ship
 * whose own harbour is sound but which cannot reach the FLAGSHIP'S rendezvous
 * is released by SQUADRON_MUSTER_TIMEOUT_SECONDS and is a candidate again the
 * next tick, so it can delay a second squadron the same way. That is bounded
 * and deliberate — every squadron it delays still sails, one timeout late, and
 * the alternative (a release cooldown) would idle ships that were only
 * momentarily late.
 *
 * Candidates are taken in Z-order of their HOME cell (see `zOrderKey`), so the
 * run this walks is a stretch of coast. A squadron accumulates from the first
 * unassigned candidate until it is full, and takes only ships whose homes lie
 * within SQUADRON_HOME_SPREAD_CELLS of the flagship's; the first candidate
 * that does not is where the next squadron starts. A run that runs out under
 * SQUADRON_MIN_SHIPS forms nothing, and its boats stay on their moorings.
 */
function formSquadrons(
  candidates: readonly SquadronBoat[],
  nav: SquadronNavigator,
): void {
  const unassigned = candidates.filter((boat) => {
    if (squadronOfBoat.has(boat.id)) return false;
    if (nav.rendezvousFor(boat.homeX, boat.homeY) === null) return false;
    return nav.isInHarbour(boat.homeX, boat.homeY, boat.x, boat.y);
  });
  const ordered = [...unassigned].sort((a, b) => {
    const ka = zOrderKey(a.homeX, a.homeY);
    const kb = zOrderKey(b.homeX, b.homeY);
    return ka === kb ? a.id - b.id : ka - kb;
  });

  let index = 0;
  while (index < ordered.length) {
    const flagship = ordered[index];
    const rendezvous = nav.rendezvousFor(flagship.homeX, flagship.homeY);
    // No water off the flagship's village: it cannot muster anyone. Skip it
    // alone rather than the whole run — the next ship along the coast may
    // have a harbour of its own to gather in.
    if (rendezvous === null) {
      index++;
      continue;
    }
    const wanted = targetSizeFor(flagship.homeX, flagship.homeY);
    const spread = SQUADRON_HOME_SPREAD_CELLS * SQUADRON_HOME_SPREAD_CELLS;
    const crew: number[] = [];
    let scan = index;
    while (scan < ordered.length && crew.length < wanted) {
      const ship = ordered[scan];
      const near =
        distanceSquared(ship.homeX, ship.homeY, flagship.homeX, flagship.homeY) <= spread;
      if (!near) break;
      crew.push(ship.id);
      scan++;
    }
    if (crew.length < SQUADRON_MIN_SHIPS) {
      // Too few along this stretch. Advance one ship, not the whole run: the
      // next flagship's spread reaches a cell further down the coast and may
      // gather ships this one could not.
      index++;
      continue;
    }
    const id = nextSquadronId++;
    squadrons.set(id, {
      id,
      members: crew,
      rendezvous,
      phase: 'mustering',
      musteringSeconds: 0,
      leg: null,
      legsSailed: 0,
      legSeedStep: 0,
    });
    for (const boatId of crew) squadronOfBoat.set(boatId, id);
    index = scan;
  }
}

/**
 * Advances one squadron's state machine and returns the point its ships steer
 * for this tick — the rendezvous while mustering, the leg's end while cruising
 * — or null to say the squadron should be dissolved.
 */
function advanceSquadron(
  squadron: Squadron,
  positions: ReadonlyMap<number, SquadronBoat>,
  flagshipHome: SquadronBoat,
  nav: SquadronNavigator,
  dt: number,
): SquadronWaypoint | null {
  const musterRadius = SQUADRON_MUSTER_RADIUS_CELLS * SQUADRON_MUSTER_RADIUS_CELLS;

  if (squadron.phase === 'mustering') {
    squadron.musteringSeconds += dt;
    const gathered = squadron.members.filter((boatId) => {
      const ship = positions.get(boatId);
      return (
        ship !== undefined &&
        distanceSquared(ship.x, ship.y, squadron.rendezvous.x, squadron.rendezvous.y) <=
          musterRadius
      );
    });
    const timedOut = squadron.musteringSeconds >= SQUADRON_MUSTER_TIMEOUT_SECONDS;
    const complete = gathered.length === squadron.members.length;
    // TIMED OUT WITH TOO FEW TO SAIL: DISSOLVE, do not keep waiting. Waiting
    // is what the timeout exists to forbid, and the old shape only forbade it
    // for a squadron that could still sail — a squadron whose absentees left
    // it under SQUADRON_MIN_SHIPS fell through the release and held its
    // gathered ships at the rendezvous for the life of the world (caught by
    // the muster contract test, 2026-09-05). Dissolving hands every ship back
    // to ./fleet.ts's harbour pass, which is the only thing that can actually
    // move a straggler toward a rendezvous, and the next pass re-forms.
    if (timedOut && !complete && gathered.length < SQUADRON_MIN_SHIPS) return null;
    if (!complete && !timedOut) {
      return squadron.rendezvous;
    }
    if (timedOut && !complete) {
      // Sail with those who came; the stragglers are released here and are
      // candidates for a fresh squadron on the next pass.
      for (const boatId of squadron.members) {
        if (!gathered.includes(boatId)) squadronOfBoat.delete(boatId);
      }
      squadron.members = gathered;
    }
    const leg = planLeg(squadron, squadron.rendezvous, flagshipHome, nav);
    if (leg === null) return squadron.rendezvous;
    squadron.leg = leg;
    squadron.phase = 'cruising';
    return leg;
  }

  // Cruising. The leg is over when the FLAGSHIP is on it — not the whole
  // squadron: the ships astern are still closing on the same point, and
  // holding the next leg until the last of them arrived would stop the
  // column dead at every waypoint.
  const flagship = positions.get(squadron.members[0]);
  const leg = squadron.leg;
  if (leg === null) {
    // Cruising with no leg cannot happen by any path above; the fallback is a
    // return to the rendezvous rather than a crash on a null waypoint.
    squadron.phase = 'mustering';
    squadron.musteringSeconds = 0;
    return squadron.rendezvous;
  }
  const arrived =
    flagship !== undefined &&
    distanceSquared(flagship.x, flagship.y, leg.x, leg.y) <= musterRadius;
  if (!arrived) return leg;
  squadron.legsSailed++;
  const next = planLeg(squadron, { x: flagship.x, y: flagship.y }, flagshipHome, nav);
  // Nowhere to go from here this tick: hold the leg just finished and try
  // again next tick, one hash step further on.
  if (next === null) return leg;
  squadron.leg = next;
  return next;
}

/**
 * Draws the next leg, trying SQUADRON_WAYPOINT_ATTEMPTS bearings from a seed
 * that advances with every leg the squadron has sailed — so a squadron that
 * fails a bearing does not sit trying the same barred one forever, and two
 * squadrons out of neighbouring villages do not sail the same course.
 */
function planLeg(
  squadron: Squadron,
  from: SquadronWaypoint,
  flagshipHome: SquadronBoat,
  nav: SquadronNavigator,
): SquadronWaypoint | null {
  const seed = hashCell(
    flagshipHome.homeX + squadron.legSeedStep,
    flagshipHome.homeY - squadron.legSeedStep,
  );
  squadron.legSeedStep++;
  for (let attempt = 0; attempt < SQUADRON_WAYPOINT_ATTEMPTS; attempt++) {
    const leg = nav.legFrom(from.x, from.y, seed, attempt);
    if (leg !== null) return leg;
  }
  return null;
}

/**
 * The whole peacetime pass: prune, form, advance, and hand back the point each
 * squadron ship steers for this tick, keyed by boat id.
 *
 * `candidates` is every boat that is free to sail — past its village's home
 * guard and with no kraken in range of its home. A boat absent from it is a
 * boat ./fleet.ts is steering for itself, and this module must not also have
 * an opinion about it.
 */
export function advanceSquadrons(
  candidates: readonly SquadronBoat[],
  nav: SquadronNavigator,
  dt: number,
): Map<number, SquadronWaypoint> {
  const byId = new Map<number, SquadronBoat>();
  for (const boat of candidates) byId.set(boat.id, boat);

  pruneSquadrons(new Set(byId.keys()));
  formSquadrons(candidates, nav);

  const goals = new Map<number, SquadronWaypoint>();
  // Squadron ids ascend, and a Map iterates in insertion order, so this pass
  // is in creation order — fixed for the life of a squadron.
  for (const squadron of squadrons.values()) {
    const flagship = byId.get(squadron.members[0]);
    if (flagship === undefined) continue;
    const waypoint = advanceSquadron(squadron, byId, flagship, nav, dt);
    if (waypoint === null) {
      for (const boatId of squadron.members) squadronOfBoat.delete(boatId);
      squadrons.delete(squadron.id);
      continue;
    }
    for (const boatId of squadron.members) goals.set(boatId, waypoint);
  }
  return goals;
}
