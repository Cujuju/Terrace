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
// Movement is the pilgrims' own advanceWalker/stepWalker — one rule for every
// little person on the road, so a wanderer and a pilgrim meeting the same bay
// detour (or following a planned route around one, since 2026-08-19)
// identically. Monsters are invisible to wanderers ON PURPOSE: protection
// auras veto SCULPTS, not walking, and no shipped monster reacts to walkers,
// so "no monster interaction" is true by construction rather than by a rule
// this file would have to maintain.

import type { RouteCell } from '@terrace/shared';
import { WANDERERS_CAP, hashCell, settlementRace, type PilgrimEntityState } from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  PILGRIM_STUCK_SECONDS,
  WalkerIdAllocator,
  advanceWalker,
  isWalkableCell,
  planRoute,
  type PilgrimWorld,
} from './pilgrimage.ts';
import type { SettlerRace } from '../protocol.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generations a settlement must have SURVIVED before it sends (or receives)
 * wanderers. This is the card's own phrase — "settlements that have stood
 * some while" — measured by the CA's own clock: structures' per-cell `age`
 * counter (generations survived, reset on every birth), carried over the
 * bridge since 2026-08-19.
 *
 * 4 — one dispatch epoch: 4 CA generations × 15 s = 60 s = WANDER_EPOCH_
 * SECONDS, so "old enough to stroll" and "has outlived a full roll cycle"
 * are the same statement, and a B3/S23 blinker edge (which dies in 1–2
 * generations) can never send anyone. An absent age (older structures build)
 * qualifies — the gate degrades to ungated, never to silence.
 *
 * WHY AGE AND NOT TIER, recorded: this gate shipped twice as a tier bar
 * (first tier ≥ 2 on a 1-based guess, then ≥ 1 corrected to the 0-based
 * ladder) and the live wire probe still showed ZERO wanderers in twenty
 * epochs — tier-ups are world-events on a young world (the chronicle
 * celebrates the FIRST hut), so any tier bar gates the feature on prestige
 * the world barely has. Age is what "stood some while" actually says.
 */
export const WANDERER_MIN_AGE_GENERATIONS = 4;

/** True when a settlement row is old enough to take part in wandering. */
function isEstablished(cell: SettlementCell): boolean {
  return (cell.age ?? Infinity) >= WANDERER_MIN_AGE_GENERATIONS;
}

/**
 * Seconds per dispatch epoch. 60 — four CA generations (15 s each): long
 * enough that the settlement set is meaningfully different roll to roll,
 * short enough that a watched world visibly refreshes its road life every
 * minute or two.
 */
export const WANDER_EPOCH_SECONDS = 60;

/**
 * One town in this many rolls a wanderer each epoch. 4 — sized to the
 * MEASURED world, not an imagined one (snapshot #144, generation 3401: the
 * whole world held 14 standing cells, most aged 0–2 — the CA churns hard and
 * established towns are a handful). "Occasionally" per town means a stroll
 * every ~4 epochs ≈ every four minutes from each standing veteran; on the
 * measured 2–4 qualifying senders that is one visible journey every minute
 * or two — alive, not crowded. A future dense world does not swarm: at 100
 * senders the roll rate hits ~25/epoch and WANDERERS_CAP (the guarantee)
 * clamps the population, exactly what the cap is for. (Shipped first at 32,
 * derived from a "lively hundred-town world" that does not exist — the wire
 * probe read zero wanderers in ten epochs, and the snapshot explained why.)
 */
export const WANDER_DISPATCH_MODULUS = 4;

/**
 * Minimum stroll distance, in cells. 8 — half a race district (structures'
 * 16-cell SETTLER_DISTRICT_CELLS, restated by value): a settlement is a BLOB
 * of adjacent live cells, and without this floor "the nearest settlement" is
 * the cell next door — a fourteen-second hop nobody would ever see. A stroll
 * must leave its own block to read as a journey.
 */
export const WANDER_MIN_DISTANCE_CELLS = 8;

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
  /** See pilgrimage.ts's Pilgrim.route — same contract, same fallback. */
  route: RouteCell[] | null;
  routeIndex: number;
}

interface SettlementCell {
  readonly x: number;
  readonly y: number;
  /** Generations survived; absent from a pre-age structures build. */
  readonly age?: number;
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
          wanderer.route = planRoute(world, wanderer.x, wanderer.y, wanderer.goalX, wanderer.goalY);
          wanderer.routeIndex = 0;
        }
        continue;
      }

      const beforeDx = wanderer.goalX - wanderer.x;
      const beforeDy = wanderer.goalY - wanderer.y;
      const before = beforeDx * beforeDx + beforeDy * beforeDy;
      advanceWalker(world, wanderer, dt);
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
          wanderer.route = planRoute(world, wanderer.x, wanderer.y, wanderer.goalX, wanderer.goalY);
          wanderer.routeIndex = 0;
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
      if (!isEstablished(cell)) continue;
      if (!isWalkableCell(world, cell.x, cell.y)) continue;
      if (this.hasWandererFrom(cell.x, cell.y)) continue;

      // The roll: cell hash re-hashed with the epoch, so the same town rolls
      // a fresh (but reproducible) number every epoch. Low bits gate the
      // dispatch; high bits pick the destination below.
      const roll = hashCell(hashCell(cell.x, cell.y) ^ epoch, epoch);
      if (roll % this.dispatchModulus !== 0) continue;

      // Destination: ANY standing settlement a real journey away — the card
      // demands standing-some-while of the SENDER only ("settlements that
      // have stood some while … send a wanderer to a nearby settlement"),
      // and on the measured churning world, demanding it of both endpoints
      // leaves no legal pairs at all. Walkable, at least MIN_DISTANCE out
      // (leave your own blob), within range; sorted by (distance, cell
      // order) — the pilgrims' tie-break discipline — then indexed by the
      // roll's high bits, so strolls spread across neighbours instead of
      // always visiting the nearest one.
      const candidates = ordered
        .map((other) => {
          const dx = other.x - cell.x;
          const dy = other.y - cell.y;
          return { other, distanceSq: dx * dx + dy * dy };
        })
        .filter(
          (c) =>
            c.distanceSq >= WANDER_MIN_DISTANCE_CELLS * WANDER_MIN_DISTANCE_CELLS &&
            c.distanceSq <= WANDER_RANGE_CELLS * WANDER_RANGE_CELLS &&
            isWalkableCell(world, c.other.x, c.other.y),
        )
        .sort(
          (a, b) => a.distanceSq - b.distanceSq || a.other.y - b.other.y || a.other.x - b.other.x,
        );
      if (candidates.length === 0) continue;

      const destination = candidates[(roll >>> 8) % candidates.length].other;
      const homeX = cell.x + 0.5;
      const homeY = cell.y + 0.5;
      const goalX = destination.x + 0.5;
      const goalY = destination.y + 0.5;

      // NEVER DISPATCH A WANDERER TO A TRIP IT CANNOT WALK — pilgrims' own
      // rule (pilgrimage.ts's dispatch loop). Unlike pilgrims, there is no
      // next-nearest candidate to fall back to here: the roll already picked
      // ONE destination deterministically, and re-scanning for a reachable
      // one would need its own tie-break to stay deterministic for no real
      // gain — wandering is "occasionally", by contract (WANDER_DISPATCH_
      // MODULUS's own comment), so a town simply not strolling this epoch
      // because its rolled destination has no route is well within that
      // contract, not a bug to work around.
      const route = planRoute(world, homeX, homeY, goalX, goalY);
      if (route === null) continue;

      const id = this.ids.allocate();
      this.wanderers.set(id, {
        id,
        race: settlementRace(cell.x, cell.y),
        homeX: cell.x,
        homeY: cell.y,
        x: homeX,
        y: homeY,
        heading: Math.atan2(goalY - homeY, goalX - homeX),
        leg: 'outbound',
        goalX,
        goalY,
        visitSeconds: 0,
        stuckSeconds: 0,
        route,
        routeIndex: 0,
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

  /** See pilgrimage.ts's Pilgrimage.routes() — same contract, same reason. */
  routes(): ReadonlyArray<{ readonly homeX: number; readonly homeY: number; readonly cells: RouteCell[] }> {
    const rows: Array<{ homeX: number; homeY: number; cells: RouteCell[] }> = [];
    for (const wanderer of this.wanderers.values()) {
      if (wanderer.route !== null) {
        rows.push({ homeX: wanderer.homeX, homeY: wanderer.homeY, cells: wanderer.route });
      }
    }
    return rows;
  }

  clear(): void {
    this.wanderers.clear();
    this.elapsedSeconds = 0;
    this.rolledEpoch = -1;
  }
}
