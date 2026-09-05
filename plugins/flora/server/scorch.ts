// SCORCH — the meadow's memory of having burned (issue #290).
//
// The sixth population in this plugin and the second that is not a survey:
// stumps.ts's shape exactly — EVENT-SOURCED, appended by ./index.ts's
// floraBurnedOut and removed by time, so there is no cursor, no chunk budget
// and no staged set here either.
//
// WHY IT HAS TO EXIST AT ALL. Since issue #289 ("the meadow is fuel, not the
// tufts") the fuel answer stopped consulting `grassField` and started asking
// ./grass.ts's `isMeadowCell`, which is a PURE TERRAIN PREDICATE: unlocked,
// unoccupied, green band. Nothing in it remembers a fire. Before #289 the
// removal of the drawn tuft in floraBurnedOut WAS the consumption of the fuel;
// afterwards it removed a blade of scenery and left the fuel bed untouched, so
// burned meadow became fuel again the instant it burned out. Measured live on
// 2026-09-02 over 120 s: of 3054 distinct meadow cells ignited, 1266 ignited
// two to eight times, median gap between re-ignitions 26 s — which is
// FLORA_GRASS_BURN_SECONDS (22) plus about one grass survey. A meadow fire
// therefore never ended, the fire cap stayed pinned, and the client drowned in
// permanent fires.
//
// THIS IS THE FUEL BEING CONSUMED, not a fire rule. It lives in flora because
// flora owns what is standing on the ground; fire asks `fuelAt` and is told
// there is nothing here to burn, exactly as it is told for bare rock.
//
// UNLIKE STUMPS, NOTHING IS BROADCAST. A stump is an object a client draws; a
// scorched cell is the ABSENCE of one, and the client already learns about
// absences twice over — floraBurnedOut sends the tuft removal as a `withered`
// delta, and the mark on the ground is fire's own burn scar
// (plugins/fire/client/scar.ts), which keys on the fire and never asks flora
// whether a blade stood there. When the record expires, the ordinary grass
// survey re-plants the tufts and broadcasts them as `sprouted`. So there is
// nothing about this set the wire needs to carry.
//
// CLOCK: simulated seconds, handed in by the caller — stumps.ts's rule, for
// stumps.ts's reason: a server at any TICK_HZ must behave identically per
// simulated second, so no Date.now.

import { grassKey, grassCellOf, type GrassCell } from '../protocol.ts';

/**
 * How long burned meadow stays bare before it counts as meadow again, in
 * simulated seconds.
 *
 * 180 s — TWICE FLORA_STABILITY_SECONDS (./stability.ts, 90 s), restated
 * rather than imported for the reason grass.ts restates its own survey
 * interval: two mechanisms that relate today must be free to disagree tomorrow
 * without one silently dragging the other. The derivation is what matters:
 *
 *   * IT MUST CLEAR THE LOOP. The bug it exists to kill re-ignited a cell a
 *     median of 26 s after the last burn — FLORA_GRASS_BURN_SECONDS (22,
 *     ./index.ts) plus roughly one GRASS_SURVEY_INTERVAL_SECONDS (5,
 *     ./grass.ts). Any value above ~27 s breaks the cycle, so the floor is not
 *     the binding constraint and picking the smallest number that works would
 *     leave no margin for a longer-burning fuel later.
 *   * IT MUST OUTLAST A FRONT'S LAP OF THE BIGGEST FIRE. At 90 s (the value
 *     until 2026-09-02, issue #297) a cap-sized meadow fire (~2000 cells,
 *     FIRE_CELL_CAP) never ended: measured live over 300 s, 2006 of 2018 cells
 *     re-ignited with a median gap of 96 s after burning out — the window plus
 *     one survey — because the front laps the patch in about that long, so the
 *     first-burned cells were fuel again while the far side still burned. The
 *     window has to exceed that lap time with margin; doubling it is the
 *     owner's first step, and the lap time is the number to re-measure if the
 *     cap or the spread rate moves.
 *   * IT IS DERIVED FROM WHAT A BURN COSTS THE REST OF THE PLUGIN. 90 s is
 *     the window a cell must sit undisturbed before this plugin will grow
 *     anything on it (FLORA_STABILITY_SECONDS). Fire changes no height, so it
 *     resets no stability clock (./index.ts's floraBurnedOut) — this constant
 *     is the GROUND COVER's equivalent of that clock, at twice the value: a
 *     burn costs the meadow twice what a sculpt costs the forest, because the
 *     lap-time point above showed the equal value does not end a fire.
 *   * IT MUST BE SHORTER THAN THE STUMP. FLORA_STUMP_ROT_SECONDS (./stumps.ts)
 *     is 360 s, deliberately TWICE this window, so this lands at exactly half
 *     of it — by construction, not coincidence. The order matters
 *     visually: grass creeps back over a burn scar while the stumps still
 *     stand, and only then do the stumps rot and the tree line return. The
 *     smallest thing heals first, which is what a burn actually looks like.
 *
 * PERSISTED (issue #297, 2026-09-02), unlike the stumps and the stability
 * stamps, as REMAINING seconds per cell (./persistence.ts). It was the one
 * countdown in this plugin worth carrying across a restart: a lost stump is a
 * lost decoration, a lost stability stamp delays a tree, but a lost scorch
 * record is FUEL — a server restarted inside the window came back with the
 * whole burn scar counting as meadow, and a fire still alive at its edge took
 * the scar again from the first tick. The residual that remains is the
 * snapshot cadence (server/src/config.ts's DEFAULT_SNAPSHOT_INTERVAL_S, 60 s):
 * a cell that burned after the last snapshot was written is not in the file,
 * so a crash — not a clean stop, which snapshots on the way out — can hand
 * back at most one snapshot interval's worth of burn as fuel. That is a bounded
 * strip at the front's most recent position, not the whole scar.
 */
export const FLORA_SCORCH_REGROW_SECONDS = 180;

/**
 * The cells whose ground cover a fire has consumed, keyed by cell, VALUED BY
 * THE SIMULATED SECOND THEY COUNT AS MEADOW AGAIN.
 *
 * An absolute deadline rather than a countdown, for StumpField's reasons: one
 * comparison per entry instead of a subtraction and a write, and no
 * floating-point drift in a value that would otherwise be rewritten ten times
 * a second.
 *
 * NO CAP, unlike every other population in this plugin, and that is the one
 * place this deliberately departs from StumpField. A cap DROPS entries, and a
 * dropped entry here is a cell that is fuel again immediately — i.e. it
 * reintroduces exactly the bug this class exists to close, and reintroduces it
 * preferentially in the biggest fires, which is where it hurts. The set is
 * bounded anyway: it is keyed by cell, so it can never hold more than the
 * world has cells, and entries leave on their own after
 * FLORA_SCORCH_REGROW_SECONDS. Its true size is "cells burned in the last 90
 * s", which the live capture puts at ~3 000 for a world with a meadow fire
 * running flat out.
 *
 * THE MAP IS ALSO THE EXPIRY QUEUE. Every entry gets the same lifetime and the
 * clock only moves forward, so insertion order IS deadline order — which JS
 * Map guarantees — and `advanceRegrowth` can stop at the first entry that is
 * not yet due instead of walking the whole map. That is what makes the tick
 * cost O(cells regrowing this tick) rather than O(cells burned in the last 90
 * s); it is the property StumpField cannot have, because a stump's clock is
 * refreshed in place and its map is capped small enough not to care. The one
 * rule that keeps it true is in `scorch` below: a refresh must DELETE before it
 * SETS, or the re-dated entry would keep its old position and sit in front of
 * entries that are now due before it.
 */
/** One scorched cell and the simulated seconds until it counts as meadow again. */
export interface ScorchRemaining {
  readonly x: number;
  readonly y: number;
  readonly seconds: number;
}

export class ScorchField {
  private readonly regrowsAt = new Map<number, number>();

  /**
   * How long an entry bars its cell, in simulated seconds. Defaults to the
   * burn window; the wind-flatten record (./index.ts's `flattenedField`,
   * issue #304) is a second instance of this same class on its own shorter
   * window (FLORA_WIND_CROP_REGROW_SECONDS, ./cyclone-event.ts) — same
   * deadline-ordered map, same expiry walk, different clock. ONE WINDOW PER
   * INSTANCE is what keeps insertion order equal to deadline order (class
   * note), so the window is fixed at construction rather than passed per call.
   */
  private readonly regrowSeconds: number;

  constructor(regrowSeconds: number = FLORA_SCORCH_REGROW_SECONDS) {
    this.regrowSeconds = regrowSeconds;
  }

  get count(): number {
    return this.regrowsAt.size;
  }

  /** Is this cell still bare from a recent fire? */
  has(x: number, y: number): boolean {
    return this.regrowsAt.has(grassKey(x, y));
  }

  /** Every scorched cell, in deadline order (see the class note). */
  cells(): GrassCell[] {
    return Array.from(this.regrowsAt.keys(), grassCellOf);
  }

  /**
   * Every scorched cell with the simulated seconds it has left before it
   * regrows, in deadline order — the persistence form (./persistence.ts).
   *
   * REMAINING, NOT THE DEADLINE, because the deadline is on this plugin's sim
   * clock and that clock restarts from zero with the server (./index.ts's
   * simSeconds). A deadline written at second 4000 and read at second 0 would
   * keep the cell bare for over an hour; the remainder is the same on both
   * sides of the restart. Downtime does not count against it, on the same rule
   * the stability window keeps: the sim clock does not run while the server
   * is down, so nothing regrows while nobody is simulating it.
   *
   * Never zero or negative: `advanceRegrowth` runs every tick and drops anything
   * due, so what is left always has time to go — but the snapshot is taken
   * between ticks, and a save that lands on a cell's exact deadline must not
   * write a remainder a reader would reject. Clamped at one second.
   */
  remaining(nowSeconds: number): ScorchRemaining[] {
    const out: ScorchRemaining[] = [];
    for (const [key, deadline] of this.regrowsAt) {
      const cell = grassCellOf(key);
      out.push({ x: cell.x, y: cell.y, seconds: Math.max(1, deadline - nowSeconds) });
    }
    return out;
  }

  /**
   * Installs a persisted record on top of whatever is here, dating every entry
   * from `nowSeconds`.
   *
   * SORTED BY REMAINDER BEFORE INSERTING, because the class note's whole
   * economy rests on insertion order being deadline order and a snapshot is
   * the one input that arrives from outside the clock: it was written in
   * deadline order, but a hand-edited file need not be, and `scorch` after a
   * restore must still find the front of the map to be the earliest deadline.
   * A stable sort on an already-ordered list is one pass.
   *
   * A cell already present is refreshed (delete-then-set, as `scorch` does), so
   * restoring onto a live record can only lengthen a cell's bareness, never
   * shorten it.
   */
  restore(entries: readonly ScorchRemaining[], nowSeconds: number): void {
    const ordered = entries.slice().sort((a, b) => a.seconds - b.seconds);
    for (const entry of ordered) {
      const key = grassKey(entry.x, entry.y);
      this.regrowsAt.delete(key);
      this.regrowsAt.set(key, nowSeconds + entry.seconds);
    }
  }

  /** Drops the whole record — the world-close and test seam. */
  clear(): void {
    this.regrowsAt.clear();
  }

  /**
   * A fire finished on this cell and the ground under it was meadow: the bed
   * is consumed until `regrowSeconds` from now (FLORA_SCORCH_REGROW_SECONDS on
   * the scorch record itself; the wind-flatten instance reads "the crop here
   * was laid over" for the same call).
   *
   * DELETE BEFORE SET on a refresh, so the entry moves to the BACK of the map
   * and insertion order stays deadline order — see the class note. A refresh
   * happens when something taller (a tree, a crop) finishes burning on ground
   * that already burned inside the window; the ground burned again, so the
   * clock starts again.
   */
  scorch(x: number, y: number, nowSeconds: number): void {
    const key = grassKey(x, y);
    this.regrowsAt.delete(key);
    this.regrowsAt.set(key, nowSeconds + this.regrowSeconds);
  }

  /**
   * Advances the clock to `nowSeconds`, dropping every cell that has regrown.
   *
   * Returns nothing, because there is nothing to announce: the grass survey
   * re-plants the tufts on its own cadence and broadcasts them itself (see the
   * module header). Empty on the overwhelming majority of ticks — a scorched
   * cell's whole life is two events separated by FLORA_SCORCH_REGROW_SECONDS.
   *
   * Walks from the front and STOPS at the first entry that is not yet due,
   * which is sound only because insertion order is deadline order (class
   * note). Collect-then-delete for StumpField's reason: mutating a Map while
   * iterating it is defined in JS, but this version's correctness does not
   * depend on knowing that.
   */
  advanceRegrowth(nowSeconds: number): void {
    if (this.regrowsAt.size === 0) return;

    const regrown: number[] = [];
    for (const [key, deadline] of this.regrowsAt) {
      if (deadline > nowSeconds) break;
      regrown.push(key);
    }
    for (const key of regrown) this.regrowsAt.delete(key);
  }
}
