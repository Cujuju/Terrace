// THE WANDERING SIMULATION — ambient town-to-town strolling (mechanics card
// 26, "Peeps", owner-picked 2026-08-19). Established settlements occasionally
// send a settler for a walk to a neighbouring town: out, a short visit, home.
//
// PURELY COSMETIC, BY CONTRACT: wanderers grant no blessing, cost no mana,
// touch no CA state, and read no monster state. The temptation to hang a
// mechanic here (trade! prosperity! roads!) is real and DELIBERATELY refused —
// card 26's own text is "purely cosmetic at first", and every later mechanic
// that wants walkers can build on this wire without this file promising
// anything it would then have to keep.
//
// DETERMINISTIC END TO END, like the pilgrimage sim beside it: no rng. Time is
// cut into fixed epochs; each epoch, each qualifying settlement rolls the same
// integer hash every server would roll (cell × epoch), and the hash also picks
// the destination. Two servers fed the same settlement stream and the same dt
// stream produce byte-identical road traffic.
//
// Movement is the pilgrims' own stepWalker — one rule for every little person
// on the road, so a wanderer and a pilgrim meeting the same bay detour
// identically. Monsters are invisible to wanderers ON PURPOSE: protection
// auras veto SCULPTS, not walking, and no shipped monster reacts to walkers,
// so "no monster interaction" is true by construction rather than by a rule
// this file would have to maintain.

import { WANDERERS_CAP, hashCell, settlementRace, type PilgrimEntityState } from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  PILGRIM_STUCK_SECONDS,
  WalkerIdAllocator,
  isWalkableCell,
  stepWalker,
  type PilgrimWorld,
} from './pilgrimage.ts';
import type { SettlerRace } from '../protocol.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settlement tier below which a town sends nobody. 1 — the FIRST TIER ABOVE
 * A CAMP: structures' ladder is 0-BASED (its protocol.ts: STRUCTURE_TIERS =
 * ['camp', …], camp = 0), so "outlived camphood" is tier ≥ 1, restated here
 * by value under the own-copy rule. A camp is a CA cell that may die next
 * generation, and a wanderer from a town that vanished mid-stroll walks home
 * to nothing; anything above that has stood some while — which is exactly
 * what the tier ladder already measures, so re-measuring age here would
 * duplicate structures' clock. (Shipped first as 2 on the unverified guess
 * that tiers were 1-based; on the live world that demanded the third rung of
 * BOTH endpoints and produced zero wanderers in twenty epochs — caught by
 * the wire probe, 2026-08-19.)
 */
export const WANDERER_MIN_TIER = 1;

/**
 * Seconds per dispatch epoch. 60 — four CA generations (15 s each): long
 * enough that the settlement set is meaningfully different roll to roll,
 * short enough that a watched world visibly refreshes its road life every
 * minute or two.
 */
export const WANDER_EPOCH_SECONDS = 60;

/**
 * One town in this many rolls a wanderer each epoch. 32 — sized against the
 * journey, not the map: a full stroll below (2 × 48 cells at 0.5 cells/s,
 * plus the visit) is ~3.5 minutes ≈ 3.5 epochs, so a world of N qualifying
 * towns holds ~N × 3.5 / 32 wanderers abroad at once — a lively hundred-town
 * world sits near 11, inside the cap with room, and the cap (not this
 * modulus) is the guarantee.
 */
export const WANDER_DISPATCH_MODULUS = 32;

/**
 * How far away a stroll's destination town may be, in cells. 48 — three
 * chunks, deliberately UNDER the pilgrims' 64-cell catchment: a pilgrimage
 * is a journey to a wonder, a stroll is neighbourly. At walk speed that is
 * a ≤96 s leg, so a wanderer's whole outing fits inside a play session's
 * attention span.
 */
export const WANDER_RANGE_CELLS = 48;

/**
 * Seconds spent visiting the destination town. 10 — long enough to read as
 * "stopped to visit" next to the 30 s a pilgrim spends watching a monster,
 * short enough that a stroll stays a stroll.
 */
export const WANDERER_VISIT_SECONDS = 10;

// ─────────────────────────────────────────────────────────────────────────────

type WandererLeg = 'outbound' | 'visiting' | 'homebound';

interface Wanderer {
  readonly id: number;
  readonly race: SettlerRace;
  readonly homeX: number;
  readonly homeY: number;
  x: number;
  y: number;
  heading: number;
  leg: WandererLeg;
  goalX: number;
  goalY: number;
  visitSeconds: number;
  stuckSeconds: number;
}

interface SettlementCell {
  readonly x: number;
  readonly y: number;
  readonly tier: number;
}

/**
 * The whole ambient population, advanced one tick. Owns the epoch clock,
 * dispatch, movement, the visit, and the give-up rules; the plugin wiring
 * (index.ts) only feeds it and broadcasts what it reports.
 */
export class Wandering {
  private readonly wanderers = new Map<number, Wanderer>();
  private readonly ids: WalkerIdAllocator;
  private readonly dispatchModulus: number;
  private elapsedSeconds = 0;
  /** The last epoch whose rolls were taken, so each epoch rolls exactly once
   *  regardless of tick rate. −1 = the first advance rolls epoch 0. */
  private rolledEpoch = -1;

  /**
   * `dispatchModulus` is a TEST SEAM ONLY (a suite proving the journey or the
   * cap should not have to hunt for cells whose hash happens to roll): every
   * production construction (index.ts) takes the default.
   */
  constructor(ids?: WalkerIdAllocator, dispatchModulus: number = WANDER_DISPATCH_MODULUS) {
    this.ids = ids ?? new WalkerIdAllocator();
    this.dispatchModulus = dispatchModulus;
  }

  advance(world: PilgrimWorld, settlements: ReadonlyArray<SettlementCell>, dt: number): void {
    this.elapsedSeconds += dt;

    const epoch = Math.floor(this.elapsedSeconds / WANDER_EPOCH_SECONDS);
    if (epoch > this.rolledEpoch) {
      this.rolledEpoch = epoch;
      this.dispatch(world, settlements, epoch);
    }

    for (const wanderer of this.wanderers.values()) {
      if (wanderer.leg === 'visiting') {
        wanderer.visitSeconds += dt;
        if (wanderer.visitSeconds >= WANDERER_VISIT_SECONDS) {
          wanderer.leg = 'homebound';
          wanderer.goalX = wanderer.homeX + 0.5;
          wanderer.goalY = wanderer.homeY + 0.5;
          wanderer.stuckSeconds = 0;
        }
        continue;
      }

      const beforeDx = wanderer.goalX - wanderer.x;
      const beforeDy = wanderer.goalY - wanderer.y;
      const before = beforeDx * beforeDx + beforeDy * beforeDy;
      stepWalker(world, wanderer, dt);
      const afterDx = wanderer.goalX - wanderer.x;
      const afterDy = wanderer.goalY - wanderer.y;
      const after = afterDx * afterDx + afterDy * afterDy;

      if (after < before) wanderer.stuckSeconds = 0;
      else wanderer.stuckSeconds += dt;

      if (after <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        if (wanderer.leg === 'outbound') {
          wanderer.leg = 'visiting';
          wanderer.visitSeconds = 0;
        } else {
          this.wanderers.delete(wanderer.id); // home again — outing complete
        }
        continue;
      }

      if (wanderer.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        if (wanderer.leg === 'outbound') {
          wanderer.leg = 'homebound';
          wanderer.goalX = wanderer.homeX + 0.5;
          wanderer.goalY = wanderer.homeY + 0.5;
          wanderer.stuckSeconds = 0;
        } else {
          // Stuck going home: despawn rather than wander forever — the
          // pilgrims' own honesty rule, and nothing here to un-bless.
          this.wanderers.delete(wanderer.id);
        }
      }
    }
  }

  /**
   * One epoch's dispatch. Every step is deterministic: settlements are taken
   * in cell order (y then x, never the caller's iteration order); the roll is
   * an integer hash of (cell, epoch); the roll's high bits pick the
   * destination from the deterministically-ordered candidate list.
   */
  private dispatch(
    world: PilgrimWorld,
    settlements: ReadonlyArray<SettlementCell>,
    epoch: number,
  ): void {
    const ordered = [...settlements].sort((a, b) => a.y - b.y || a.x - b.x);

    for (const cell of ordered) {
      if (this.wanderers.size >= WANDERERS_CAP) break;
      if (cell.tier < WANDERER_MIN_TIER) continue;
      if (!isWalkableCell(world, cell.x, cell.y)) continue;
      if (this.hasWandererFrom(cell.x, cell.y)) continue;

      // The roll: cell hash re-hashed with the epoch, so the same town rolls
      // a fresh (but reproducible) number every epoch. Low bits gate the
      // dispatch; high bits pick the destination below.
      const roll = hashCell(hashCell(cell.x, cell.y) ^ epoch, epoch);
      if (roll % this.dispatchModulus !== 0) continue;

      // Destination: another qualifying town within range, walkable, sorted
      // by (distance, cell order) — the same tie-break discipline as the
      // pilgrims' catchment sort — then indexed by the roll's high bits, so
      // strolls spread across neighbours instead of always visiting the
      // nearest one.
      const candidates = ordered
        .map((other) => {
          const dx = other.x - cell.x;
          const dy = other.y - cell.y;
          return { other, distanceSq: dx * dx + dy * dy };
        })
        .filter(
          (c) =>
            c.distanceSq > 0 &&
            c.distanceSq <= WANDER_RANGE_CELLS * WANDER_RANGE_CELLS &&
            c.other.tier >= WANDERER_MIN_TIER &&
            isWalkableCell(world, c.other.x, c.other.y),
        )
        .sort(
          (a, b) => a.distanceSq - b.distanceSq || a.other.y - b.other.y || a.other.x - b.other.x,
        );
      if (candidates.length === 0) continue;

      const destination = candidates[(roll >>> 8) % candidates.length].other;
      const id = this.ids.allocate();
      this.wanderers.set(id, {
        id,
        race: settlementRace(cell.x, cell.y),
        homeX: cell.x,
        homeY: cell.y,
        x: cell.x + 0.5,
        y: cell.y + 0.5,
        heading: Math.atan2(destination.y - cell.y, destination.x - cell.x),
        leg: 'outbound',
        goalX: destination.x + 0.5,
        goalY: destination.y + 0.5,
        visitSeconds: 0,
        stuckSeconds: 0,
      });
    }
  }

  private hasWandererFrom(homeX: number, homeY: number): boolean {
    for (const wanderer of this.wanderers.values()) {
      if (wanderer.homeX === homeX && wanderer.homeY === homeY) return true;
    }
    return false;
  }

  /** Wire rows for the broadcast, insertion (spawn) order. */
  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const wanderer of this.wanderers.values()) {
      rows.push({
        id: wanderer.id,
        kind: 'wanderer',
        race: wanderer.race,
        x: wanderer.x,
        y: wanderer.y,
        heading: wanderer.heading,
      });
    }
    return rows;
  }

  populationCount(): number {
    return this.wanderers.size;
  }

  clear(): void {
    this.wanderers.clear();
    this.elapsedSeconds = 0;
    this.rolledEpoch = -1;
  }
}
