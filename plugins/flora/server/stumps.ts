// STUMPS — what a fire leaves where a tree used to be (GH #195).
//
// The fifth population in this plugin and the only one that is not a survey.
// The other four ask the heightmap a question on a rolling cadence and move
// their list toward the answer; this one has no question to ask, because
// nothing about the terrain says whether a tree burned here. Stumps are
// EVENT-SOURCED — appended by ./index.ts's floraBurnedOut, removed by time —
// which is why there is no cursor, no chunk budget and no staged set below.
//
// ../protocol.ts's stump section holds the design record: why fire is the only
// cause that leaves one, why nothing is persisted, and where the cap comes
// from. What this module owns is the clock.
//
// THE CLOCK IS A SCAN, NOT A QUEUE, and that is a deliberate re-run of the
// argument forest.ts makes for polling over per-cell timers. A priority queue
// keyed by expiry would visit strictly fewer entries per tick — and would need
// to stay consistent with three removal paths that can take a stump out from
// under it (a sculpt, a building, a world close). The scan cannot desynchronise
// from the map because it IS the map: at most FLORA_STUMP_CAP (4096) entries,
// visited once per tick, and only while any stump stands at all.
//
// MEASURED, 2026-08-26, at the worst case this plugin can produce — a full
// 4096-stump list, i.e. the entire forest burned down inside one rot window:
// 0.037 ms per tick, 0.37 ms per second at the shipped TICK_HZ of 10. That is
// a sixteenth of what the tree survey already spends on the same world
// (forest.ts: 0.59 ms mean per tick), for the population that costs the most.
// An empty list — the steady state of a world that is not on fire — measures
// 17 nanoseconds, which is the size check advanceDecay opens with and nothing
// else.
//
// CLOCK: simulated seconds, handed in by the caller. No Date.now, for
// forest.ts's reason — a server at any TICK_HZ must behave identically per
// simulated second.

import { FLORA_STUMP_CAP, stumpCellOf, stumpKey, type StumpCell } from '../protocol.ts';

/**
 * How long a stump stands before it rots away, in simulated seconds.
 *
 * 360 s — TWICE FLORA_SCORCH_REGROW_SECONDS (./scorch.ts, 180 s), which is
 * itself twice FLORA_STABILITY_SECONDS (stability.ts, 90 s), the window a cell
 * must sit undisturbed before this plugin will grow anything on it. Deriving
 * it from those numbers rather than picking a round one is the whole point: a
 * stump holds its cell against replanting while it stands (./index.ts's
 * occupiedCells), so if it matched the stability window the scar would rot at
 * roughly the moment the ground became eligible again and the burn would leave
 * no visible aftermath at all; and it must outlast the scorch window so grass
 * creeps back over the scar while the stumps still stand (scorch.ts's heal
 * order). The sequence a player sees is "it burned, it stayed burned for a
 * while, then it grew back" — three states instead of two. Doubled from 180 s
 * on 2026-09-02 alongside the scorch window (issue #297) to keep that ratio.
 *
 * The ceiling on it is that a stump is scenery a player cannot clear except by
 * sculpting the cell: long enough to be a scar, short enough that a world heals
 * inside one play session.
 */
export const FLORA_STUMP_ROT_SECONDS = 360;

/**
 * The standing stumps, keyed by cell, VALUED BY THE SIMULATED SECOND THEY ROT.
 *
 * An absolute deadline rather than a remaining-seconds countdown, so a tick's
 * work is one comparison per entry instead of one subtraction and one write —
 * and so that no accumulated floating-point drift can build up in a value that
 * is rewritten ten times a second for three minutes.
 */
export class StumpField {
  private readonly rotsAt = new Map<number, number>();

  get count(): number {
    return this.rotsAt.size;
  }

  has(x: number, y: number): boolean {
    return this.rotsAt.has(stumpKey(x, y));
  }

  /** Every standing stump, in no particular order (Map iteration order). */
  cells(): StumpCell[] {
    return Array.from(this.rotsAt.keys(), stumpCellOf);
  }

  /** Drops every stump — the world-close and test seam. */
  clear(): void {
    this.rotsAt.clear();
  }

  /**
   * A fire finished on this cell and there was a tree on it: leave a stump.
   *
   * Returns the new stump, or null when there is nothing to announce — either
   * the cap is full or a stump already stands here. In the second case the
   * clock is REFRESHED rather than left alone: the cell burned again, so the
   * scar is new again, and every client already knows the cell is occupied so
   * there is no delta to send about it.
   *
   * The cap DROPS the stump rather than evicting the oldest one. Evicting would
   * make a distant, still-burning fire silently erase the scar a player is
   * standing in front of — and at FLORA_STUMP_CAP the only way to reach it is
   * for the entire forest to burn inside one rot window, which is a world where
   * one missing stump is not the thing anyone notices.
   */
  leave(x: number, y: number, nowSeconds: number): StumpCell | null {
    const key = stumpKey(x, y);
    if (this.rotsAt.has(key)) {
      this.rotsAt.set(key, nowSeconds + FLORA_STUMP_ROT_SECONDS);
      return null;
    }
    if (this.rotsAt.size >= FLORA_STUMP_CAP) return null;
    this.rotsAt.set(key, nowSeconds + FLORA_STUMP_ROT_SECONDS);
    return { x, y };
  }

  /**
   * Removes the stump at (x, y) because its cell was edited or built on — the
   * reactive path (./index.ts), mirroring GrassField.reactToEdit exactly.
   * Returns the removed cell, or null if there was none.
   *
   * NO NEIGHBOUR RESIDUAL, for GrassField.reactToEdit's reason and more simply:
   * a stump depends on nothing outside its own cell, not even that cell's
   * height. Digging the ground out from under one takes it; nothing else can.
   */
  reactToEdit(x: number, y: number): StumpCell | null {
    if (!this.rotsAt.delete(stumpKey(x, y))) return null;
    return { x, y };
  }

  /**
   * Advances the clock to `nowSeconds` and returns every stump that has rotted
   * away since the last call. Empty on the overwhelming majority of ticks — a
   * stump's whole life is two events separated by FLORA_STUMP_ROT_SECONDS.
   *
   * Deletion happens after the scan rather than during it: mutating a Map while
   * iterating it is defined in JS, but "collect then delete" is the version
   * whose correctness does not depend on knowing that.
   */
  advanceDecay(nowSeconds: number): StumpCell[] {
    if (this.rotsAt.size === 0) return [];

    const rotted: StumpCell[] = [];
    for (const [key, deadline] of this.rotsAt) {
      if (deadline <= nowSeconds) rotted.push(stumpCellOf(key));
    }
    for (const cell of rotted) this.rotsAt.delete(stumpKey(cell.x, cell.y));
    return rotted;
  }
}
