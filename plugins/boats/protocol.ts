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
 * Boat speed, cells per second.
 *
 * 1.5, and it is a RATIO rather than a feel number: the kraken lurks at 0.6
 * cells/s (plugins/monsters/server/kinds.ts), so a boat closes at 2.5× its
 * quarry. Anything at or under the kraken's own speed would let it simply
 * out-swim the fleet forever and the mechanic would never resolve; 2.5× closes
 * a full engagement range in under four seconds while still reading as a
 * working boat rather than a torpedo.
 */
export const BOAT_SPEED_CELLS_PER_SECOND = 1.5;

/**
 * How close a boat must get to fight, in cells.
 *
 * 5 — just outside the kraken's own 7-cell footprint (half-width 3.5, see
 * monsters' KRAKEN_FOOTPRINT_CELLS, restated). A boat fights at arm's length
 * from the arm crown: close enough that the two read as engaged, far enough
 * that the hull is never drawn inside the animal.
 */
export const BOAT_ENGAGEMENT_RANGE_CELLS = 5;

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
 * Furthest a village will send boats, in cells.
 *
 * 64 — four chunks, the same order as monsters' own minimum lair (nine chunks
 * across for the kraken), so a village defends the water it can plausibly be
 * said to fish rather than the whole ocean. Without a bound, one tier-1
 * settlement on a 512² world would answer a kraken 500 cells away, which is
 * neither legible nor winnable: the fleet would spend minutes in transit and
 * arrive one boat at a time.
 */
export const VILLAGE_PATROL_RANGE_CELLS = 64;

// ─────────────────────────────────────────────────────────────────────────────
// Wire encoding and validation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decimal places kept on broadcast cell coordinates. Same value and same
 * reasoning as monsters' and wildlife's MONSTER_POSITION_DECIMALS: 1/100 of a
 * cell is far below what any camera distance resolves, and it makes the
 * payload's encoded size bounded.
 */
export const BOAT_POSITION_DECIMALS = 2;

const POSITION_QUANTUM = 10 ** BOAT_POSITION_DECIMALS;

/** Rounds a cell-space coordinate to the broadcast precision. */
export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
