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
 * 90 s — FLORA_STABILITY_SECONDS (./stability.ts), restated rather than
 * imported for the reason grass.ts restates its own survey interval: two
 * mechanisms that agree today must be free to disagree tomorrow without one
 * silently dragging the other. The derivation is what matters:
 *
 *   * IT MUST CLEAR THE LOOP. The bug it exists to kill re-ignited a cell a
 *     median of 26 s after the last burn — FLORA_GRASS_BURN_SECONDS (22,
 *     ./index.ts) plus roughly one GRASS_SURVEY_INTERVAL_SECONDS (5,
 *     ./grass.ts). Any value above ~27 s breaks the cycle, so the floor is not
 *     the binding constraint and picking the smallest number that works would
 *     leave no margin for a longer-burning fuel later.
 *   * IT MUST MATCH WHAT A BURN COSTS THE REST OF THE PLUGIN. 90 s is the
 *     window a cell must sit undisturbed before this plugin will grow anything
 *     on it (FLORA_STABILITY_SECONDS). Fire changes no height, so it resets no
 *     stability clock (./index.ts's floraBurnedOut) — this constant is the
 *     GROUND COVER's equivalent of that clock, and giving it the same value
 *     says exactly one thing: a burn costs the meadow what a sculpt costs the
 *     forest.
 *   * IT MUST BE SHORTER THAN THE STUMP. FLORA_STUMP_ROT_SECONDS (./stumps.ts)
 *     is 180 s, deliberately TWICE the stability window, so this lands at
 *     exactly half of it — by construction, not coincidence. The order matters
 *     visually: grass creeps back over a burn scar while the stumps still
 *     stand, and only then do the stumps rot and the tree line return. The
 *     smallest thing heals first, which is what a burn actually looks like.
 *
 * RESIDUAL — NOT PERSISTED, and it cannot be without inventing persistence
 * this plugin does not have. Only the forest survives a restart
 * (./persistence.ts: trees and the RNG state, nothing else); the stump list is
 * explicitly not persisted (../protocol.ts's stump section) and neither are
 * the stability stamps. This record follows them. THE CONSEQUENCE, stated
 * plainly: a server restarted while a meadow is burning, or within
 * FLORA_SCORCH_REGROW_SECONDS of one having burned, comes back up with that
 * ground counting as fuel again immediately. That fires only when a restart
 * lands inside a 90-second window after a fire, and the worst it can do is let
 * one already-burned meadow burn a second time — the runaway needs the record
 * to be missing on EVERY cycle, and it is missing only on the boot. Persisting
 * it would mean adding a second field to FloraSlice and a version bump for a
 * 90-second window; the honest trade is to name the hole instead.
 */
export const FLORA_SCORCH_REGROW_SECONDS = 90;

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
export class ScorchField {
  private readonly regrowsAt = new Map<number, number>();

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

  /** Drops the whole record — the world-close and test seam. */
  clear(): void {
    this.regrowsAt.clear();
  }

  /**
   * A fire finished on this cell and the ground under it was meadow: the bed
   * is consumed until FLORA_SCORCH_REGROW_SECONDS from now.
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
    this.regrowsAt.set(key, nowSeconds + FLORA_SCORCH_REGROW_SECONDS);
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
