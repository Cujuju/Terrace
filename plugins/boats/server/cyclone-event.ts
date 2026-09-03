// boats → cyclone, READ-DIRECTION: this plugin's end of the wind-damage world
// event, and the numbers that turn a wind into a hull driven off station.
//
// BY NAME, NEVER BY IMPORT — the string below is the whole of the coupling
// (server/src/plugins/types.ts's emitEvent doc comment, and the by-name
// subscription rule it states). ./events.ts is this plugin's own statement of
// that rule against its two other emitters; this file exists beside it rather
// than inside it because what it holds is not another parser but this plugin's
// TUNING for a storm, and the payload shape it needs is parsed by core's kit
// (server/src/plugins/kit/rotatingStormDamage.ts).
//
// A MISSING EMITTER IS A LEGAL WORLD, as always here: with cyclone uninstalled
// no wind is ever announced and a fleet sails the way it always did.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CYCLONE DOES TO A FLEET: IT MOVES IT, AND NOTHING ELSE.
//
// A boat is pushed along the storm's TANGENTIAL wind — the direction the arms
// the player can see are turning, derived once in the kit's
// `tangentialWindAt` — by a displacement proportional to
// `severity × durationSeconds`. It is not sunk, not damaged, and not steered:
// this plugin has no damage model for a hull (only the kraken's wounds, which
// belong to the kraken), and inventing one for the wind would be a second
// answer to "what is a boat" reachable only from a storm. Being carried a mile
// off station and having to row back IS the consequence.
//
// THE HEADING IS LEFT ALONE, deliberately. A boat's heading is what it is
// STEERING, and a hull shoved sideways by a gale is still pointed where its
// crew is pulling; ./fleet.ts's turning circle then brings it round on its own
// terms over the next few seconds. Rewriting the heading here would make a
// storm the one thing in this plugin that can snap a hull to a new bearing,
// which is exactly the instant pivot the owner objected to in 2026-08-24.

import { BOAT_SPEED_CELLS_PER_SECOND } from '../protocol.ts';

/**
 * The event's full namespaced name, as the cyclone plugin emits it.
 *
 * A STRING, for this file's header's reason. The un-namespaced half is
 * `damage`; the prefix is the emitter's plugin name, which the host prepends.
 */
export const CYCLONE_DAMAGE_EVENT_NAME = 'cyclone:damage';

/**
 * How much of its own top speed a boat is carried at by severity-1 wind, as a
 * fraction.
 *
 * ONE AND A HALF, and stated against the hull's own speed rather than as a
 * number of cells because the RATIO is the whole design. It fixes exactly one
 * thing, and that thing is a statement rather than a number: the severity at
 * which the wind out-pulls the oars is this fraction's reciprocal, TWO THIRDS.
 *
 *   * Above that severity a boat cannot make ground against the circulation at
 *     all. It is carried round the storm however hard its crew pulls, and the
 *     only way out is to work ACROSS the wind until the severity drops below
 *     the line — which is what being caught in a hurricane has always meant.
 *   * Below it the crew can still row upwind, so a fleet is scattered and has
 *     to beat its way back rather than being trapped. At the rim, where
 *     severity is a twentieth, the sag is under a cell a second.
 *
 * BELOW 1 THE MECHANIC DOES NOT EXIST, which is why this is not the half it
 * started as. Every boat here is either station-keeping or making for a goal,
 * so a push the hull can out-row is cancelled within the same second it lands:
 * measured on the whole-world fixture at a half, a fleet 47 cells off the eye
 * finished a thirty-second storm having drifted no further than its own
 * station-keeping takes it, and two of the three hulls ended up UPWIND of
 * where they began. A hurricane a rowing boat can ignore is not a hurricane.
 *
 * NOT MUCH ABOVE IT EITHER. At three the line falls to a third of peak
 * severity and most of the disc becomes water no boat may row in, which makes a
 * cyclone a wall rather than a thing to sail out of. At one and a half the line
 * sits at two thirds, a contour only a storm near its own peak intensity has at
 * all — so an ordinary cyclone scatters a fleet and a severe one traps it.
 *
 * MEASURED, in .verify-299/push.mts: one severity-0.72 event moves a hull 3.58
 * cells along the tangent against a predicted 3.87 (the difference is the same
 * frame's rowing), and over a thirty-second storm a fleet 15 cells off the eye
 * is carried 18 to 27 cells with the spin.
 */
export const BOAT_WIND_PUSH_FRACTION_OF_TOP_SPEED = 1.5;

/**
 * Cells a severity-1 wind carries a boat in one second — 5.4 at the shipped
 * BOAT_SPEED_CELLS_PER_SECOND (cellsAcross(0.9) = 3.6).
 *
 * DERIVED, not tuned: if the hull's speed is ever retuned, the storm's grip on
 * it keeps the same meaning rather than silently becoming stronger or weaker.
 */
export const BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND =
  BOAT_SPEED_CELLS_PER_SECOND * BOAT_WIND_PUSH_FRACTION_OF_TOP_SPEED;

/**
 * The longest single hop the push is committed in, in cells.
 *
 * ONE CELL — the sampling grid's own resolution, and the only value that makes
 * the "a pushed boat never lands on ground" guarantee true rather than
 * probable. `isSailable` answers about a CELL, so a push applied as one long
 * jump tests the destination and nothing in between: a boat two and a half
 * cells from a spit of land, shoved three, would be tested on the open water
 * beyond it and teleported straight through the spit. Walking the push a cell
 * at a time and stopping at the first cell a hull may not occupy is the same
 * belt-and-suspenders step check ./fleet.ts already applies to a boat's own
 * travel, for the same reason.
 *
 * The cost is bounded and small: at the ceiling above, a severity-1 second is
 * 5.4 cells, so even the hardest push this plugin can be given is six
 * `isSailable` calls.
 */
export const BOAT_WIND_PUSH_STEP_CELLS = 1;
