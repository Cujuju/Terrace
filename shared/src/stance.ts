// What a legged mover is DOING HORIZONTALLY — the other half of climb.ts.
//
// THE DEFECT (owner, 2026-09-06: "I would also like it if they only looked like
// they're walking when they're actually walking. If they're not walking, then
// they should look like they are standing in place. And if they haven't moved
// for a while, then they should sit."). The shipped contract said the opposite
// outright — client/src/plugins/kit/moverGait.ts: "a walker's beat is the
// ground it covers, so a stopped walker is a walk cycle that is not advancing".
// That reads as a freeze-frame on a distance-driven walker (wildlife) and as a
// march on the spot on a clock-driven one (the yeti), and neither is standing
// still.
//
// WHY THE SERVER DECIDES AND THE WIRE CARRIES IT. Two of the three answers are
// not visible in a position stream. "Hasn't moved for a WHILE" is a duration,
// and a client that has just connected — or that has just had a creature enter
// its view — has no history to measure it over; the rise out of a sit is a
// memory of what the body was doing a moment ago, which only the side that has
// been ticking all along holds. The same argument put `climbHeight` and
// `falling` on the wire (climb.ts's ClimbWire), and the answer is the same
// shape: ONE derivation here, six serialisers spreading it.
//
// ONE FIELD, NOT A FLAG PER STATE, for the reason moverGait.ts states about
// its own three: a boolean beside a boolean is how the third case gets bolted
// on to the second, and there is no such thing as a mover that is both sitting
// and walking.
//
// MOTION IS SAMPLED, NEVER REPORTED. Every mover family already has a dozen
// paths that end in "hold this tick" — an idle bout, a stranded body, a
// steering ladder that found nothing, a stuck route, a panic pressed against
// terrain — and a contract that asked each of them to say so would be a
// contract each of them could forget. This one asks the only question that
// cannot be forgotten: is the body where it was?

import { cellsAcross } from './constants.ts';
import type { ClimbState } from './climb.ts';

/**
 * The horizontal acts a legged mover has a pose for.
 *
 * Deliberately NOT a superset of MoverGait: this is what the SERVER knows, and
 * the server does not decide poses. The client's kit widens it — a mover on a
 * wall is climbing or falling whatever its feet were doing (moverGaitOf).
 */
export type MoverStance = 'walk' | 'stand' | 'sit';

/**
 * Every stance, in a fixed order — the order IS the wire's index, so appending
 * one is safe and reordering one silently re-poses every mover on an older
 * client. (The client's MOVER_GAITS is keyed the same way, for the same
 * reason; see client/src/plugins/kit/moverGait.ts.)
 */
export const MOVER_STANCES: readonly MoverStance[] = ['walk', 'stand', 'sit'];

/**
 * The least ground a body must cover to count as walking, in world units per
 * second.
 *
 * A SPEED AND NOT A DISTANCE, so the answer does not change with the tick
 * length. An eighth of the slowest thing in the world that walks at all — the
 * yeti's YETI_AMBLE_SPEED_CELLS_PER_SECOND, 0.081 world units/s — so nothing
 * that is actually travelling can fall under it, while the sub-millimetre
 * drift a separation nudge or a float round-trip leaves behind does.
 */
export const STANCE_WALKING_WORLD_UNITS_PER_SECOND = 0.01;

/** The same floor in the cell units movers actually move in. */
export const STANCE_WALKING_CELLS_PER_SECOND = cellsAcross(
  STANCE_WALKING_WORLD_UNITS_PER_SECOND,
);

/**
 * How long a body must be still before it reads as STOPPED rather than hitched.
 *
 * TWO BROADCASTS' WORTH. Movers broadcast every other tick (each plugin's
 * BROADCAST_TICK_INTERVAL), and "held position for one tick" is the ordinary
 * output of a steering ladder that lost a coin flip against a rock — a mover
 * that dropped into a stand for it would flicker between two poses while
 * walking a wall. Below this a body is still walking; it has simply not got
 * anywhere this instant.
 */
export const STILL_SECONDS_BEFORE_STAND = 0.4;

/**
 * How long stillness lasts before the body SITS — the owner's "a while".
 *
 * ONE FIGURE FOR EVERY MOVER, not one per family, and that is the decision
 * rather than a default. "A while" is a statement about the watcher's patience,
 * not about the animal's metabolism; and the species already differ where it
 * matters, because how OFTEN a stall lasts this long is set by their own idle
 * rates. Against those rates 8 s sorts them exactly as it should: a wolf's
 * bout averages 2.5 s (IdleBouts.endPerSecond 0.4) so a wolf pausing to sniff
 * almost never reaches it, an ibex's 4 s reaches it sometimes, and a bison's or
 * an eel's 10 s reaches it often — the settled animals sit and the restless
 * ones do not, with no per-species number to keep in step.
 */
export const STILL_SECONDS_BEFORE_SIT = 8;

/**
 * How long the rise out of a sit is held in the standing pose before the walk
 * resumes.
 *
 * ONE STRIDE of the walk it is about to start (pilgrims' STRIDE_HZ is 1.6, so a
 * stride is 0.625 s) — long enough to read as getting up rather than as a
 * teleport between two poses, and short enough that the body is moving off
 * within a stride of the tick it decided to. It is a WINDOW ON THE CLOCK and
 * not a distance, because a body getting up is not covering ground.
 */
export const STAND_UP_SECONDS = 0.6;

/**
 * The stillness a body that has just started moving is wound back to, rather
 * than to zero.
 *
 * THIS IS THE WHOLE OF "no snap" (owner, 2026-09-06), and it is why no client
 * needs a state machine: winding the clock back to exactly one stand-up window
 * above the standing threshold makes the next STAND_UP_SECONDS of stance
 * answers 'stand' and every answer after that 'walk', for free, out of the same
 * one number the sit is read from. A body that was only standing is wound back
 * from wherever it had got to, which is shorter — it had less to get up from.
 */
export const STANDING_UP_STILL_SECONDS = STILL_SECONDS_BEFORE_STAND + STAND_UP_SECONDS;

/**
 * The stillness a mover carries between ticks.
 *
 * THREE FLAT FIELDS RATHER THAN ONE SUB-OBJECT, and the reason is wildlife's:
 * `replacePopulation` shallow-copies every entity (`{ ...entity }`), so a
 * sub-object would be shared BY REFERENCE between a caller's array and the live
 * population (plugins/wildlife/server/population.ts states this at
 * `huntTargetId`). Flat fields copy.
 */
export interface StillMover {
  x: number;
  y: number;
  /** The wall this mover is on, or null. A climb is never stillness. */
  climb: ClimbState | null;
  /**
   * Seconds of stillness the body has accumulated. It RISES while the body is
   * not covering ground and DRAINS while it is — see STANDING_UP_STILL_SECONDS
   * for why draining rather than zeroing is the whole stand-up window.
   */
  stillSeconds: number;
  /** Where the body was at the previous `advanceStillness`, in cells. */
  stillX: number;
  stillY: number;
}

/** The stillness fields of a mover that has just been placed. Spread at spawn. */
export function newStillness(x: number, y: number): {
  stillSeconds: number;
  stillX: number;
  stillY: number;
} {
  return { stillSeconds: 0, stillX: x, stillY: y };
}

/**
 * Advances one mover's stillness by `dt`, from where its body actually is.
 *
 * CALL IT ONCE PER TICK PER MOVER, at the END of the tick — after everything
 * that could have moved the body has run. Called at the top instead it would
 * measure the PREVIOUS tick's motion, which is a whole tick of lag on every
 * stop and start.
 *
 * A CLIMB IS NOT STILLNESS, and the test is `climb`, not distance: a climber's
 * x/y are pinned at the foot of the wall for the whole ascent (climb.ts's
 * ClimbState) — that is what keeps it out of the rock — so a body four seconds
 * up a cliff would otherwise be sitting on it. It is also what makes topping
 * out walk immediately rather than standing up first.
 */
export function advanceStillness(mover: StillMover, dt: number): void {
  const step = Math.max(0, dt);
  if (mover.climb !== null) {
    mover.stillSeconds = 0;
    mover.stillX = mover.x;
    mover.stillY = mover.y;
    return;
  }

  const dx = mover.x - mover.stillX;
  const dy = mover.y - mover.stillY;
  mover.stillX = mover.x;
  mover.stillY = mover.y;

  // Squared on both sides — no Math.sqrt, so the comparison is three multiplies
  // and nothing that the determinism rule (climb.ts's header) has to argue about.
  const floor = STANCE_WALKING_CELLS_PER_SECOND * step;
  if (dx * dx + dy * dy >= floor * floor) {
    mover.stillSeconds = Math.max(
      0,
      Math.min(mover.stillSeconds, STANDING_UP_STILL_SECONDS) - step,
    );
    return;
  }
  mover.stillSeconds += step;
}

/** The stance a mover's accumulated stillness puts it in. */
export function moverStanceOf(mover: StillMover): MoverStance {
  if (mover.stillSeconds >= STILL_SECONDS_BEFORE_SIT) return 'sit';
  if (mover.stillSeconds >= STILL_SECONDS_BEFORE_STAND) return 'stand';
  return 'walk';
}

/**
 * The one thing a client has to be TOLD about a mover that is not walking.
 *
 * ONE SHAPE FOR EVERY WIRE, exactly as ClimbWire is and for the same reason:
 * there are six places a mover is serialised, and a field added at five of them
 * is a bug at the sixth.
 *
 * THE INDEX, NOT THE NAME (MOVER_STANCES), and null for the walking case. The
 * wildlife payload is 58 B a creature (plugins/wildlife/server/index.ts) and it
 * carries up to 850 of them, so the difference between a one-byte integer and a
 * six-byte string is real; null costs nothing at all, because msgpack drops it,
 * and walking is what almost every mover is almost always doing. The same
 * protocol already sends its size class this way (`sizeClassIndex`).
 */
export interface StanceWire {
  /** Index into MOVER_STANCES; null — and absent — means 'walk'. */
  readonly stance: number | null;
}

/** A mover that is walking — one frozen object rather than one per mover per tick. */
const WALKING: StanceWire = Object.freeze({ stance: null });

/** The wire field for a mover's stance, or the walking case. */
export function stanceWireOf(mover: StillMover): StanceWire {
  const stance = moverStanceOf(mover);
  if (stance === 'walk') return WALKING;
  return { stance: MOVER_STANCES.indexOf(stance) };
}

/**
 * The stance a received wire index means.
 *
 * ANYTHING UNRECOGNISED IS 'walk': a row from a pre-stance server carries no
 * index at all, and a version-skewed one could carry an index this build has no
 * stance for. Both mean the same thing to a renderer — draw it walking, which
 * is what every mover did before this existed — and neither may drop the row.
 */
export function moverStanceFromWire(stance: unknown): MoverStance {
  if (typeof stance !== 'number') return 'walk';
  return MOVER_STANCES[stance] ?? 'walk';
}
