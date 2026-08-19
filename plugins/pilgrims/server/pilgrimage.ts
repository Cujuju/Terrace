// THE PILGRIMAGE SIMULATION — settledness, dispatch, the walk, the blessing.
//
// Pure over a narrow world view (PilgrimWorld) so the whole mechanic runs in
// a node test without a server. Deliberately DETERMINISTIC END TO END: no rng
// anywhere — settledness is a timer, the viewpoint is an arg-max over a fixed
// ring, targets are picked nearest-first, and ties break on scan order. Two
// servers fed the same monster and settlement streams produce byte-identical
// pilgrim traffic.
//
// THE SHAPE OF A PILGRIMAGE. A monster that keeps to one chunk-sized circle
// long enough is SETTLED (the anchor tracker below). Once it is, the standing
// settlements inside its catchment each dispatch one pilgrim; a pilgrim walks
// overland to a viewpoint on a ring safely outside anywhere the settled
// monster (and its sculpt-protection aura) can be, faces the beast for a
// while, and walks home. While any of a settlement's pilgrims are abroad,
// that settlement's cell is BLESSED (structures' route-blessing contract —
// tier prosperity, never CA survival).

import { SEA_LEVEL } from '@terrace/shared';
import { PILGRIMS_CAP, settlementRace, type PilgrimEntityState, type SettlerRace } from '../protocol.ts';

/** The slice of the world the sim reads. Matches WorldApi's members 1:1. */
export interface PilgrimWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Radius, in cells, of the circle a monster must keep to before it counts as
 * settled — and the anchor-reset threshold while it wanders.
 *
 * 16 — one chunk edge, the game's neighbourhood unit. Against the shipped
 * monster speeds this is what makes "settled" mean something: the fastest
 * kind (kraken, 0.6 cells/s) drifts out of a 16-cell circle in under half a
 * minute of ordinary wandering, so only a monster genuinely lingering ever
 * survives the onset timer below.
 */
export const MONSTER_SETTLED_RADIUS_CELLS = 16;

/**
 * Continuous seconds inside the settled circle before pilgrimages begin.
 *
 * 120 — two derivations meet here. Against monster motion: two minutes is
 * 4.5 settled-circle diameters for the fastest shipped kind, so a beast
 * merely crossing the area can never qualify. Against the settlement CA:
 * it is 8 generations (15 s each), so by the time the first pilgrim leaves,
 * the towns that will prosper from the route have had time to exist and
 * settle themselves.
 */
export const PILGRIMAGE_ONSET_SECONDS = 120;

/**
 * How far from the settled anchor a settlement can be and still dispatch,
 * in cells.
 *
 * 64 — four chunks. Bounded by the walk itself: at PILGRIM_WALK_SPEED below,
 * the farthest qualifying pilgrim spends ~2 minutes each way, the same order
 * as the onset the monster already proved it would sit through. Farther
 * towns would routinely arrive after the beast has moved on.
 */
export const PILGRIMAGE_CATCHMENT_CELLS = 64;

/**
 * Radius of the viewpoint ring around the settled anchor, in cells.
 *
 * SETTLED radius + 8: the monster can be anywhere inside its settled circle,
 * and the largest shipped ground-protection aura reaches 4.5 cells beyond a
 * body (measured against monsters @ 2026-08-19: footprint 7 / 2 + standoff
 * 1); 8 covers that with margin. MEASURED, NOT IMPORTED — the bridge rule
 * forbids reading monsters' constants, and the failure mode of drift is only
 * a viewpoint a little too close, never a crash.
 */
export const VIEWPOINT_RING_CELLS = MONSTER_SETTLED_RADIUS_CELLS + 8;

/**
 * Candidate directions sampled on the viewpoint ring.
 *
 * 16 — every 22.5°. The pick is "highest walkable land on the ring"; at ring
 * radius 24 adjacent samples are ~9 cells apart, finer than any terrace
 * feature a player sculpts at brush radius ≤ 4, so more samples would
 * re-find the same ledges.
 */
export const VIEWPOINT_RING_SAMPLES = 16;

/**
 * Walking speed, cells per second.
 *
 * 0.5 — set against the shipped gaits it will be seen next to: a shade
 * faster than the yeti's wary amble (0.45), slower than a cruising kraken
 * (0.6). A purposeful little walk that still reads as a journey across a
 * 64-cell catchment rather than a teleport.
 */
export const PILGRIM_WALK_SPEED_CELLS_PER_SECOND = 0.5;

/**
 * Seconds spent watching at the viewpoint. 30 — two CA generations: long
 * enough that a route (and its blessing) is a standing fact of the map, short
 * enough that pilgrims visibly cycle home and back over a play session.
 */
export const PILGRIM_LINGER_SECONDS = 30;

/**
 * Seconds without net progress before a pilgrim gives up on its current leg.
 * 20 — at full speed that is 10 cells of thwarted travel, several failed
 * detours around a bay; an outbound pilgrim turns for home, a homebound one
 * despawns (their town's blessing ends with them, honestly).
 */
export const PILGRIM_STUCK_SECONDS = 20;

/**
 * Look-ahead for water avoidance, in seconds of travel — wildlife's
 * LOOKAHEAD_SECONDS value and reasoning (see its comment); at this plugin's
 * walk speed it is 0.3 cells of warning.
 */
export const LOOKAHEAD_SECONDS = 0.6;

/** Wildlife's avoid-turn sweep: 8 × 45° candidates, smallest turn first. */
export const AVOID_TURN_ATTEMPTS = 8;
export const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

/** A pilgrim counts as arrived within this many cells of its goal. */
export const ARRIVAL_RADIUS_CELLS = 0.75;

// ─────────────────────────────────────────────────────────────────────────────
// Settledness — one anchor tracker per living monster id.
// ─────────────────────────────────────────────────────────────────────────────

interface AnchorRecord {
  x: number;
  y: number;
  settledSeconds: number;
}

/** A settled monster: where pilgrims aim, keyed by monster id. */
export interface SettledMonster {
  readonly monsterId: number;
  readonly x: number;
  readonly y: number;
}

export class SettlednessTracker {
  private readonly anchors = new Map<number, AnchorRecord>();

  /**
   * Feeds one tick of monster positions; returns the currently settled set.
   * A monster outside its anchor circle re-anchors AT its new position with
   * the timer zeroed; a monster missing from `monsters` (banished, eaten its
   * cooldown) is forgotten the same tick.
   */
  advance(
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    dt: number,
  ): SettledMonster[] {
    const seen = new Set<number>();
    const settled: SettledMonster[] = [];

    for (const monster of monsters) {
      seen.add(monster.id);
      const anchor = this.anchors.get(monster.id);
      if (anchor === undefined) {
        this.anchors.set(monster.id, { x: monster.x, y: monster.y, settledSeconds: 0 });
        continue;
      }
      const dx = monster.x - anchor.x;
      const dy = monster.y - anchor.y;
      if (dx * dx + dy * dy > MONSTER_SETTLED_RADIUS_CELLS * MONSTER_SETTLED_RADIUS_CELLS) {
        anchor.x = monster.x;
        anchor.y = monster.y;
        anchor.settledSeconds = 0;
        continue;
      }
      anchor.settledSeconds += dt;
      if (anchor.settledSeconds >= PILGRIMAGE_ONSET_SECONDS) {
        settled.push({ monsterId: monster.id, x: anchor.x, y: anchor.y });
      }
    }

    for (const id of this.anchors.keys()) {
      if (!seen.has(id)) this.anchors.delete(id);
    }
    return settled;
  }

  clear(): void {
    this.anchors.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain predicates
// ─────────────────────────────────────────────────────────────────────────────

/** Land a pilgrim will stand on — wildlife's grazer rule: above the sea. */
export function isWalkableCell(world: PilgrimWorld, x: number, y: number): boolean {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return false;
  return world.heightAt(cx, cy) > SEA_LEVEL;
}

/**
 * The viewpoint for a settled monster: the HIGHEST walkable cell among the
 * ring samples (a ridge to watch from), or null when the whole ring is water
 * or off-world — an offshore beast simply gathers no crowd. Ties break on
 * the first (angle-0-first) sample, which is what keeps the pick
 * deterministic.
 */
export function pickViewpoint(
  world: PilgrimWorld,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = -Infinity;
  for (let i = 0; i < VIEWPOINT_RING_SAMPLES; i++) {
    const angle = (i / VIEWPOINT_RING_SAMPLES) * 2 * Math.PI;
    const x = Math.floor(anchorX + Math.cos(angle) * VIEWPOINT_RING_CELLS);
    const y = Math.floor(anchorY + Math.sin(angle) * VIEWPOINT_RING_CELLS);
    if (!isWalkableCell(world, x, y)) continue;
    const height = world.heightAt(x, y);
    if (height > bestHeight) {
      bestHeight = height;
      best = { x: x + 0.5, y: y + 0.5 };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pilgrims
// ─────────────────────────────────────────────────────────────────────────────

export type PilgrimLeg = 'outbound' | 'lingering' | 'homebound';

/**
 * One id sequence for EVERY walker on the wire, whichever sim spawned it —
 * the client keys its views and interpolation by bare id, so the pilgrimage
 * and the wandering populations must never mint the same number. index.ts
 * creates one allocator and hands it to both sims.
 */
export class WalkerIdAllocator {
  private next = 1;

  allocate(): number {
    return this.next++;
  }

  reset(): void {
    this.next = 1;
  }
}

export interface Pilgrim {
  readonly id: number;
  readonly race: SettlerRace;
  /** The settlement that sent them — also the blessed cell while abroad. */
  readonly homeX: number;
  readonly homeY: number;
  readonly monsterId: number;
  x: number;
  y: number;
  heading: number;
  leg: PilgrimLeg;
  goalX: number;
  goalY: number;
  lingerSeconds: number;
  stuckSeconds: number;
}

/** The moving slice of a walker — what stepWalker needs, and nothing more.
 *  Both the pilgrimage and the wandering sims feed their walkers through it. */
export interface MovingWalker {
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
}

/** One walking step with water avoidance — wildlife's veto-the-step shape.
 *  EXPORTED since the wanderers (card 26) landed: one movement rule for every
 *  little person on the road, so a pilgrim and a wanderer meeting the same
 *  bay detour identically. */
export function stepWalker(world: PilgrimWorld, pilgrim: MovingWalker, dt: number): void {
  const toGoalX = pilgrim.goalX - pilgrim.x;
  const toGoalY = pilgrim.goalY - pilgrim.y;
  const desired = Math.atan2(toGoalY, toGoalX);

  const distance = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt;
  const lookahead = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * LOOKAHEAD_SECONDS;

  // Smallest workable turn: desired course first, then alternating left/right
  // sweeps — the same reading wildlife gives its own 8 × 45° search.
  for (let attempt = 0; attempt <= AVOID_TURN_ATTEMPTS; attempt++) {
    const magnitude = Math.ceil(attempt / 2) * AVOID_TURN_STEP_RADIANS;
    const sign = attempt % 2 === 1 ? 1 : -1;
    const heading = desired + sign * magnitude;
    const aheadX = pilgrim.x + Math.cos(heading) * lookahead;
    const aheadY = pilgrim.y + Math.sin(heading) * lookahead;
    if (!isWalkableCell(world, aheadX, aheadY)) continue;

    pilgrim.heading = heading;
    pilgrim.x += Math.cos(heading) * distance;
    pilgrim.y += Math.sin(heading) * distance;
    return;
  }
  // Boxed in: hold position this tick; the stuck timer decides what is next.
}

/** Squared distance to the current goal. */
function goalDistanceSq(pilgrim: Pilgrim): number {
  const dx = pilgrim.goalX - pilgrim.x;
  const dy = pilgrim.goalY - pilgrim.y;
  return dx * dx + dy * dy;
}

/**
 * The whole population, advanced one tick. Owns dispatch, movement, the
 * linger, the give-up rules, and the blessed-set derivation; the plugin
 * wiring (index.ts) only feeds it and broadcasts what it reports.
 */
export class Pilgrimage {
  private readonly tracker = new SettlednessTracker();
  private readonly pilgrims = new Map<number, Pilgrim>();
  private readonly ids: WalkerIdAllocator;
  /** True when this sim minted its own allocator — then clear() may reset it.
   *  A SHARED allocator is never reset here: the other sim's walkers live on. */
  private readonly ownsIds: boolean;

  constructor(ids?: WalkerIdAllocator) {
    this.ids = ids ?? new WalkerIdAllocator();
    this.ownsIds = ids === undefined;
  }

  advance(
    world: PilgrimWorld,
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    settlements: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    dt: number,
  ): void {
    const settled = this.tracker.advance(monsters, dt);
    const settledById = new Map(settled.map((s) => [s.monsterId, s]));

    // ── Recall: a monster that unsettled (or died) sends its crowd home. ──
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.leg === 'homebound') continue;
      if (settledById.has(pilgrim.monsterId)) continue;
      pilgrim.leg = 'homebound';
      pilgrim.goalX = pilgrim.homeX + 0.5;
      pilgrim.goalY = pilgrim.homeY + 0.5;
      pilgrim.stuckSeconds = 0;
    }

    // ── Dispatch: one pilgrim per (settled monster, catchment settlement). ──
    for (const monster of settled) {
      const viewpoint = pickViewpoint(world, monster.x, monster.y);
      if (viewpoint === null) continue;

      // Nearest-first, deterministic: sort by squared distance, then by cell
      // order, so which towns dispatch under the cap never depends on the
      // caller's iteration order.
      const candidates = settlements
        .map((cell) => {
          const dx = cell.x - monster.x;
          const dy = cell.y - monster.y;
          return { cell, distanceSq: dx * dx + dy * dy };
        })
        .filter((c) => c.distanceSq <= PILGRIMAGE_CATCHMENT_CELLS * PILGRIMAGE_CATCHMENT_CELLS)
        .sort(
          (a, b) =>
            a.distanceSq - b.distanceSq ||
            a.cell.y - b.cell.y ||
            a.cell.x - b.cell.x,
        );

      for (const { cell } of candidates) {
        if (this.pilgrims.size >= PILGRIMS_CAP) break;
        if (!isWalkableCell(world, cell.x, cell.y)) continue;
        if (this.hasPilgrimFrom(cell.x, cell.y, monster.monsterId)) continue;

        const id = this.ids.allocate();
        this.pilgrims.set(id, {
          id,
          race: settlementRace(cell.x, cell.y),
          homeX: cell.x,
          homeY: cell.y,
          monsterId: monster.monsterId,
          x: cell.x + 0.5,
          y: cell.y + 0.5,
          heading: Math.atan2(viewpoint.y - cell.y - 0.5, viewpoint.x - cell.x - 0.5),
          leg: 'outbound',
          goalX: viewpoint.x,
          goalY: viewpoint.y,
          lingerSeconds: 0,
          stuckSeconds: 0,
        });
      }
    }

    // ── Walk / linger / arrive. ──
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.leg === 'lingering') {
        pilgrim.lingerSeconds += dt;
        // Face the beast while it is watched — the monster may drift.
        const monster = settledById.get(pilgrim.monsterId);
        if (monster !== undefined) {
          pilgrim.heading = Math.atan2(monster.y - pilgrim.y, monster.x - pilgrim.x);
        }
        if (pilgrim.lingerSeconds >= PILGRIM_LINGER_SECONDS) {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
        }
        continue;
      }

      const before = goalDistanceSq(pilgrim);
      stepWalker(world, pilgrim, dt);
      const after = goalDistanceSq(pilgrim);

      // Net progress resets the stuck clock; anything else runs it.
      if (after < before) pilgrim.stuckSeconds = 0;
      else pilgrim.stuckSeconds += dt;

      if (after <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'lingering';
          pilgrim.lingerSeconds = 0;
        } else {
          this.pilgrims.delete(pilgrim.id); // home again — journey complete
        }
        continue;
      }

      if (pilgrim.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
        } else {
          // Stuck going home: despawn rather than wander forever. The town's
          // blessing ends with its pilgrim — the road failed, honestly.
          this.pilgrims.delete(pilgrim.id);
        }
      }
    }
  }

  private hasPilgrimFrom(homeX: number, homeY: number, monsterId: number): boolean {
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.homeX === homeX && pilgrim.homeY === homeY && pilgrim.monsterId === monsterId) {
        return true;
      }
    }
    return false;
  }

  /** Wire rows for the broadcast, insertion (spawn) order. */
  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const pilgrim of this.pilgrims.values()) {
      rows.push({
        id: pilgrim.id,
        kind: 'pilgrim',
        race: pilgrim.race,
        x: pilgrim.x,
        y: pilgrim.y,
        heading: pilgrim.heading,
      });
    }
    return rows;
  }

  /**
   * Packed structure keys of every settlement with a pilgrim abroad — the
   * total blessed set (structures' replace semantics). The key arithmetic is
   * structures' own: y × 65536 + x, restated by value for the same
   * own-copy reason the race hash is.
   */
  blessedCellKeys(): number[] {
    const keys = new Set<number>();
    for (const pilgrim of this.pilgrims.values()) {
      keys.add(pilgrim.homeY * 65536 + pilgrim.homeX);
    }
    return [...keys];
  }

  populationCount(): number {
    return this.pilgrims.size;
  }

  clear(): void {
    this.tracker.clear();
    this.pilgrims.clear();
    if (this.ownsIds) this.ids.reset();
  }
}
