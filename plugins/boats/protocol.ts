// boats — the wire contract between the plugin's two halves, and the numbers
// the fight is made of.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as structures/protocol.ts is for that plugin.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (owner, 2026-08-20, settling the arc docs/DESIGN.md parked on
// 2026-08-19: "boats fight the kraken, terrain does not").
//
// A coastal settlement that has survived to its first tier-up is a FISHING
// VILLAGE, and a fishing village keeps boats. When a kraken is in water those
// boats can reach, they sail out and fight it. The kraken sinks them one at a
// time; they wear it down; whoever runs out first loses. A routed kraken
// leaves through the departure the monsters plugin already owns — the design
// record's "the cooldown machinery is kept whole for the boats arc" — so this
// plugin never invents a second way for a monster to leave.
//
// WHAT IS DELIBERATELY NOT HERE: a player verb. Boats are dispatched by
// villages, not commanded, so a player fights krakens by growing coastline.
// Owner-deferred to its own card (2026-08-20): "list the player can reinforce
// as a future issue".
// ─────────────────────────────────────────────────────────────────────────────

// The one import this file allows itself, and the reason is the same one that
// keeps it dependency-free otherwise: every distance below is a fact about the
// WORLD, and @terrace/shared owns how many cells the world is sampled at.
import {
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const BOATS_PLUGIN_NAME = 'boats';

/**
 * Server → client, the whole afloat-boat list (`boats:state`).
 *
 * FULL STATE, NOT DELTAS, and that is the opposite of the choice structures
 * made one directory over — for the opposite reason. A building never moves,
 * so its life is a handful of events; a boat's position changes every tick, so
 * there is no quiet steady state for deltas to exploit and a replace message is
 * both smaller and impossible to desync. It is the shape monsters' own
 * broadcast uses, for the same reason.
 */
export const BOATS_STATE_MESSAGE = 'state';

/** One afloat boat, as broadcast. */
export interface BoatState {
  /** Stable for the boat's whole life; never reused after it sinks. */
  readonly id: number;
  /** Cell-space position, fractional. */
  readonly x: number;
  readonly y: number;
  /** Radians; travel direction is (cos, sin) in cell space. */
  readonly heading: number;
  /** True while it is within engagement range of a kraken. */
  readonly fighting: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The fight, in numbers.
//
// EVERY CONSTANT BELOW IS DERIVED FROM ONE DESIGN SENTENCE: it takes a full
// fishing fleet to drive off a kraken. The arithmetic that makes that true is
// written out at KRAKEN_ROUT_WOUNDS, and the four numbers it relates are
// pinned against each other by test rather than left as four independent dials
// that happen to work today.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tier at which a coastal settlement is judged to keep boats.
 *
 * 1 — the first tier past the founding camp, and a DELIBERATE RESTATEMENT of
 * plugins/structures/client/skiffs.ts's SKIFF_MIN_TIER, not an import: plugins
 * are independently installable and must build with every other one deleted.
 * The semantics are meant to match — the settlements that visibly float skiffs
 * are the settlements that send boats — and the shared reasoning is worth
 * repeating: a settlement that has not survived a single tier-up has not grown
 * anything yet, boats included.
 *
 * It is also what makes this plugin's roster buildable from the `upgraded`
 * list of structures' own world event and nothing else: reaching tier 1
 * REQUIRES an upgrade, so every qualifying settlement announces itself exactly
 * once, without structures needing to emit anything new. See server/events.ts.
 */
export const VILLAGE_MIN_TIER = 1;

/**
 * Most boats one village keeps afloat.
 *
 * 3 — restated from skiffs.ts's SKIFF_MAX_PER_SETTLEMENT for the same reason
 * as the tier above, and load-bearing here in a way it is not there: three is
 * exactly the fleet KRAKEN_ROUT_WOUNDS is sized to be beaten by, so "a mature
 * village's whole fleet, and not one boat less" is the unit of a winning
 * attack.
 */
export const BOATS_PER_VILLAGE = 3;

/**
 * Seconds a village takes to replace one lost boat.
 *
 * 20 — long enough that a village which has just lost a fleet cannot meet a
 * second kraken with a fresh one (a full rebuild is 60 s, more than twice the
 * 24 s a won fight takes), short enough that a quiet coastline is back to
 * strength within a minute. This is the whole cost of losing: no boat is
 * destroyed permanently, but a coastline that has just fought is briefly
 * defenceless, which is what makes a second arrival mean something.
 */
export const BOAT_REBUILD_SECONDS = 20;

/**
 * Boat speed, cells per second — 0.9 WORLD UNITS per second, converted.
 *
 * A speed is a distance across the ground per second, so it is stated in world
 * units and multiplied by WORLD_UNIT_CELLS like every other distance in this
 * file. Left as a literal 0.9 through the 2026-08-21 re-sample every boat in
 * the game would have slowed to a quarter of the speed it was tuned at, and
 * the ratio the next paragraph rests on would still have held — which is
 * exactly why nothing would have failed.
 *
 * 0.9, AND IT IS STILL A RATIO RATHER THAN A FEEL NUMBER. The kraken lurks at
 * 0.6 world units/s (plugins/monsters/server/kinds.ts), so a boat closes at
 * 1.5× its quarry: anything at or under the kraken's own speed would let it
 * out-swim the fleet forever and the mechanic would never resolve, and 1.5× is
 * the slowest ratio that still shortens the range in a stern chase — the worst
 * case, a kraken running dead away, closes at 0.3 units/s and covers a full
 * BOAT_ENGAGEMENT_RANGE_CELLS in ~17 s. A kraken does not flee (it wanders at
 * KRAKEN_TURN_NOISE_RADIANS_PER_SECOND), so the ordinary case is far shorter.
 *
 * WAS 1.5 UNTIL 2026-08-24 (owner: boats "travel too fast"). 1.5 also made a
 * rowed boat the fastest thing in the water, ahead of the wildlife whale's 0.8
 * — which that animal's own comment claims nothing exceeds. At 0.9 the whale is
 * a shade slower than a boat under oars, which is the reading the bestiary was
 * written for, and the hull is no longer a torpedo.
 */
export const BOAT_SPEED_CELLS_PER_SECOND = cellsAcross(0.9);

/**
 * How close a boat must get to fight, in cells — five WORLD UNITS, converted.
 *
 * 5 — just outside the kraken's own 7-world-unit footprint (half-width 3.5, see
 * monsters' KRAKEN_FOOTPRINT_CELLS, restated). A boat fights at arm's length
 * from the arm crown: close enough that the two read as engaged, far enough
 * that the hull is never drawn inside the animal.
 */
export const BOAT_ENGAGEMENT_RANGE_CELLS = cellsAcross(5);

/**
 * Wounds one engaged boat inflicts per second. ONE, by definition — it is the
 * unit the other numbers are counted in, not an independent dial.
 */
export const BOAT_WOUNDS_PER_SECOND = 1;

/**
 * Seconds between the kraken sinking one engaged boat.
 *
 * 12 — chosen with KRAKEN_ROUT_WOUNDS below as a pair; see the arithmetic
 * there. Long enough that a player watching sees three distinct losses rather
 * than a fleet evaporating, short enough that a fight is over inside half a
 * minute.
 */
export const KRAKEN_SINKS_BOAT_EVERY_SECONDS = 12;

/**
 * Wounds that rout a kraken.
 *
 * 54, AND IT IS ARITHMETIC, NOT TASTE. A full fleet of BOATS_PER_VILLAGE boats
 * engages; the kraken sinks one every KRAKEN_SINKS_BOAT_EVERY_SECONDS; each
 * surviving boat deals BOAT_WOUNDS_PER_SECOND. So the wounds a fleet of N
 * delivers before it is wiped out are
 *
 *     Σ over k = N…1 of (k × KRAKEN_SINKS_BOAT_EVERY_SECONDS)
 *
 * which for N = 3 and a 12 s interval is 12 × (3 + 2 + 1) = 72, and the fleet
 * is wiped at t = 36 s. A fleet of 2 delivers 12 × (2 + 1) = 36. Any bar
 * strictly between 36 and 72 therefore encodes the design sentence — a full
 * fleet wins, one boat fewer does not:
 *
 *     3 boats → 36 wounds by t = 12 s, 54 by t = 21 s  → WIN, two boats left
 *     2 boats → 36 wounds by its wipe (t = 24 s)       → LOSS
 *     1 boat  → 12 wounds by its wipe (t = 12 s)       → LOSS
 *
 * Two villages fielding two boats each beat it as surely as one village
 * fielding three, so a longer coastline really is a stronger one.
 *
 * WHY 54 AND NOT THE MIDPOINT-LOOKING 60, which was the first value here and
 * was WRONG in a way only a test caught: 60 is reached at exactly t = 24 s,
 * which is exactly when the kraken sinks its second boat. Two accumulators
 * crossing their thresholds on the same tick makes the outcome — does the
 * fleet come home two-strong or one-strong — a tie-break between them, decided
 * by floating-point drift rather than by design. 54 lands at t = 21 s, three
 * seconds clear of the nearest sinking, so the result is the same on every
 * machine and every tick rate. A win condition must never coincide with a loss
 * event.
 *
 * The relationship between these four numbers is pinned in test/boats.test.ts —
 * retuning any one of them without the others fails there rather than silently
 * making krakens invincible or free.
 */
export const KRAKEN_ROUT_WOUNDS = 54;

/**
 * Wounds a kraken sheds per second while nothing is engaging it.
 *
 * 2 — faster than one boat can inflict (BOAT_WOUNDS_PER_SECOND), and that
 * inequality is the point rather than the value: without it, a single boat
 * parked at range would eventually rout a kraken given long enough, which
 * would make every number above decorative. Healing strictly faster than the
 * smallest possible attack means a fight must be WON, not merely sustained.
 * It also means a routed-but-not-quite kraken is fully recovered ~30 s after
 * the last boat sinks, which is inside the village's own rebuild cycle.
 */
export const KRAKEN_WOUND_HEAL_PER_SECOND = 2;

/**
 * How far from a settlement water is looked for before it counts as COASTAL,
 * and how much of it there must be.
 *
 * A DELIBERATE RESTATEMENT of plugins/structures/client/site.ts's
 * COASTAL_SEARCH_RADIUS_CELLS and COASTAL_MIN_WATER_CELLS — the same tight
 * disc (`dx² + dy² < r·(r−1)`, 36 cells at radius 4) and the same two-cell
 * minimum that plugin uses to decide a settlement is a fishing village, give
 * it a harbour and anchor its skiffs. Restated and not imported for the usual
 * reason (plugins are independently installable), but the semantics MUST
 * match: the settlements that visibly float skiffs are the settlements that
 * send boats, and a player looking at a harbour has every right to expect a
 * fleet to come out of it.
 *
 * THIS REPLACES A WET 4-NEIGHBOUR TEST, which is why the numbers are stated
 * here rather than left implicit in the launch code. That test — "a settlement
 * with no adjacent water cell is inland" — sounded like a definition of
 * coastal and was really a definition of *waterfront*. Measured against the
 * owner's live world it called all seven tier-1 settlements inland, including
 * one the structures plugin had already given a harbour and skiffs to, whose
 * water was three world units away. No boat was ever built. Settlements sit on
 * BUILDABLE ground (suitability.ts), which the shoreline itself rarely is, so
 * "coastal" essentially never means "adjacent".
 */
export const COASTAL_SEARCH_RADIUS_CELLS = cellsAcross(4);
/**
 * How much water inside that disc makes a settlement coastal — an AREA, not a
 * distance, so it scales as the SQUARE of the sampling density: two world
 * units' worth of sea is 32 cells of it since the 2026-08-21 re-sample. Scaled
 * with the wrong power this would be the one constant in the file that still
 * looked right and behaved differently — a two-CELL threshold inside a disc
 * sixteen times denser calls a settlement with a puddle coastal.
 */
export const COASTAL_MIN_WATER_CELLS = cellsOverArea(2);

/**
 * The INSHORE STRIP a village's skiffs own, in world units, measured out from
 * that village's nearest water.
 *
 * A DELIBERATE RESTATEMENT of plugins/structures/protocol.ts's constant of the
 * same name, on exactly the footing COASTAL_SEARCH_RADIUS_CELLS above is
 * restated on: the two plugins are independently installable, so this is not
 * imported, but the semantics MUST match or the partition it defines has a gap.
 *
 * WHY 1.5 (six cells). Structures moors a skiff about three cells past the
 * shore, and a moored skiff reaches 1.84 cells further still — up to 0.28 world
 * units of orbit round its mooring plus half of a 0.36-long hull, converted.
 * 3 + 1.84 rounds up to six cells, so 1.5 world units is the smallest band that
 * contains a skiff's whole reach.
 *
 * WHAT IT PARTITIONS (owner defect, 2026-09-05: skiffs "collide with each other
 * and with the warboats"). Both plugins berth off the SAME village at the SAME
 * distance from it — measured on the owner's world, nearest war-boat berth and
 * nearest skiff mooring agreed to within a cell at all fifteen coastal villages
 * — so war boats at rest sat inside the skiffs' orbits. Neither side can see
 * the other's moorings (structures' depend on the client's drawn ground, which
 * the server does not have), so the harbour is zoned by a rule both derive from
 * the one input they share: the village cell and its nearest water. Skiffs stay
 * inside this band; war boats berth beyond it (`BERTH_STANDOFF_CELLS`).
 */
export const HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5;

/**
 * Furthest a village will send boats, in cells.
 *
 * 64 WORLD UNITS — four chunks, the same order as monsters' own minimum lair
 * (nine chunks across for the kraken), so a village defends the water it can
 * plausibly be said to fish rather than the whole ocean. Without a bound, one
 * tier-1 settlement on a default world would answer a kraken 500 world units
 * away, which is
 * neither legible nor winnable: the fleet would spend minutes in transit and
 * arrive one boat at a time.
 */
export const VILLAGE_PATROL_RANGE_CELLS = cellsAcross(64);

// ─────────────────────────────────────────────────────────────────────────────
// Wire encoding and validation.
// ─────────────────────────────────────────────────────────────────────────────

// Broadcast coordinate precision lives in @terrace/shared (shared/src/wire.ts).
// Five plugins each carried a byte-identical copy of this rounding, and the
// copies are how issue #180 shipped: the bounded form did not exist, so nothing
// stopped a rounded coordinate from leaving the map, and fixing it in one
// plugin left the other four exposed. Re-exported here so this file stays the
// one wire contract this plugin's server and client halves both import.
export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';

/**
 * Defensive bound on the broadcast list.
 *
 * A world's boats are bounded by its coastal villages, which the structures
 * plugin caps at STRUCTURES_CAP (512) live cells — so 512 × BOATS_PER_VILLAGE
 * is the true ceiling. Restated as a literal rather than imported (plugin
 * independence, as everywhere else here) and rounded up: past this a payload
 * is malformed, not a bigger world.
 */
export const BOATS_PAYLOAD_CAP = 2048;

export interface BoatsStatePayload {
  readonly boats: readonly BoatState[];
}

/**
 * Validates a `boats:state` payload, returning null for anything malformed.
 *
 * WHOLE-PAYLOAD REJECTION, like every other plugin's: a half-read list would
 * render a fleet that is missing boats the server believes are there. An EMPTY
 * list is not malformed — it is how a client learns the boats it could see have
 * left its view, or sunk.
 */
export function parseBoatsPayload(payload: unknown): BoatState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { boats } = payload as { boats?: unknown };
  if (!Array.isArray(boats) || boats.length > BOATS_PAYLOAD_CAP) return null;

  const parsed: BoatState[] = [];
  for (const item of boats) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, x, y, heading, fighting } = item as Record<string, unknown>;
    if (!Number.isInteger(id) || (id as number) < 0) return null;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(heading)) return null;
    if (typeof fighting !== 'boolean') return null;
    parsed.push({ id: id as number, x, y, heading, fighting });
  }
  return parsed;
}
