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

import {
  LAND_WALKER_PROFILE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  findRoute,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  steerAvoiding,
  type FreshwaterMap,
  type Occupant,
  type RouteCell,
  type RoutedMover,
  type TraversalProfile,
} from '@terrace/shared';
import { PILGRIMS_CAP, settlementRace, type PilgrimEntityState, type SettlerRace } from '../protocol.ts';

/** The slice of the world the sim reads. Matches WorldApi's members 1:1. */
export interface PilgrimWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  /**
   * Where the rivers and lakes are, per cell — supplied by core's WorldApi and
   * consumed by `shared/`'s traversal predicates, which read it off whatever
   * `TerrainSampler` they are handed.
   *
   * DECLARED HERE EVEN THOUGH `TerrainSampler.freshwater` IS OPTIONAL. Leaving
   * it out would still compile and would still work in the running server —
   * the concrete object passed in is the WorldApi, which has the property
   * regardless of what this interface says — but it would work by accident:
   * the rule would be live in production and silently absent from every test
   * that builds a stand-in world, which is the one place a rivers-vs-lakes
   * regression would otherwise be caught. Naming it makes the dependency
   * checked rather than incidental. Optional so a test may still omit it and
   * mean "this world has no fresh water".
   */
  readonly freshwater?: FreshwaterMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Radius, in cells, of the circle a monster must keep to before it counts as
 * settled — and the anchor-reset threshold while it wanders.
 *
 * 16 WORLD UNITS — one chunk edge, the game's neighbourhood unit. Against the
 * shipped monster speeds this is what makes "settled" mean something: the
 * fastest kind (kraken, 0.6 world units/s) drifts out of the circle in under
 * half a minute of ordinary wandering, so only a monster genuinely lingering
 * ever survives the onset timer below.
 *
 * EVERY DISTANCE AND SPEED IN THIS FILE is stated in world units and converted
 * with WORLD_UNIT_CELLS, because each is a fact about the ground rather than
 * about the grid the ground is sampled on (see @terrace/shared's
 * WORLD_UNIT_CELLS, and the 2026-08-21 re-sample it records).
 */
export const MONSTER_SETTLED_RADIUS_CELLS = cellsAcross(16);

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
export const PILGRIMAGE_CATCHMENT_CELLS = cellsAcross(64);

/**
 * Radius of the viewpoint ring around the settled anchor, in cells.
 *
 * SETTLED radius + 8: the monster can be anywhere inside its settled circle,
 * and the largest shipped ground-protection aura reaches 4.5 world units beyond a
 * body (measured against monsters @ 2026-08-19: footprint 7 / 2 + standoff
 * 1); 8 covers that with margin. MEASURED, NOT IMPORTED — the bridge rule
 * forbids reading monsters' constants, and the failure mode of drift is only
 * a viewpoint a little too close, never a crash.
 */
export const VIEWPOINT_RING_CELLS = MONSTER_SETTLED_RADIUS_CELLS + cellsAcross(8);

/**
 * Candidate directions sampled on the viewpoint ring.
 *
 * 16 — every 22.5°. The pick is "highest walkable land on the ring"; at ring
 * radius 24 adjacent samples are ~9 world units apart, finer than any terrace
 * feature a player sculpts at the widest brush, so more samples would re-find
 * the same ledges.
 */
export const VIEWPOINT_RING_SAMPLES = 16;

/**
 * Walking speed, cells per second.
 *
 * 0.5 — set against the shipped gaits it will be seen next to: a shade
 * faster than the yeti's wary amble (0.45), slower than a cruising kraken
 * (0.6) — all three in world units per second. A purposeful little walk that
 * still reads as a journey across a 64-world-unit catchment rather than a
 * teleport.
 */
export const PILGRIM_WALK_SPEED_CELLS_PER_SECOND = cellsAcross(0.5);

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

/**
 * A pilgrim counts as arrived within this many cells of its GOAL.
 *
 * 0.75 — comfortably under one cell, so arriving means standing in the goal
 * cell rather than merely nearby.
 *
 * SCOPE NARROWED 2026-08-20, and the narrowing is the bug fix. This radius
 * used to double as the route-following waypoint test, where it was wrong:
 * orthogonal waypoints are one CELL apart — a quarter of this radius since the
 * 2026-08-21 re-sample, and they were the same length as it before — so a
 * walker sitting ON one waypoint was already inside 0.75 of the NEXT and skipped it without ever
 * walking there — the first half of the freeze traced on the live world (see
 * shared/src/steering.ts's `followRoute`). Route progress is now decided by
 * cell containment, in shared, and this constant answers only the question it
 * was derived for.
 */
export const ARRIVAL_RADIUS_CELLS = cellsAcross(0.75);

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

/**
 * Pilgrims and wanderers are land walkers exactly like wildlife's grazer, so
 * they ARE shared's land-walker archetype — not a literal that restates it.
 * This alias exists only so the rest of this file (and its suite) can keep
 * calling the thing by the plugin's own name; every axis of it —  dry ground,
 * terrace risers are walls, the band-0 waterline fringe is not ground, a river
 * or lake is something to walk around — is decided once in
 * shared/src/traversal.ts and never here.
 */
export const PILGRIM_WALKER_PROFILE: TraversalProfile = LAND_WALKER_PROFILE;

/**
 * Land a walker will stand on: a thin adapter over shared's bounds+ground
 * predicate (shared/src/traversal.ts). No gradient term here — a standalone
 * cell query (a settlement, a viewpoint candidate) has no "from" cell to
 * measure a slope against; `stepWalker` and `planRoute` below are the two
 * callers that DO have one.
 */
export function isWalkableCell(world: PilgrimWorld, x: number, y: number): boolean {
  return sharedIsWalkableCell(world, PILGRIM_WALKER_PROFILE, x, y);
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

/**
 * Plans a walking route from (fromX, fromY) to (toX, toY) over shared's A*
 * (shared/src/pathing.ts) using PILGRIM_WALKER_PROFILE — go AROUND ground too
 * steep to climb, preferring gentle slopes even where a steeper way would
 * still be legal (owner, 2026-08-19: "attempts to go around obstacles
 * instead of over or through them"). Returns null when no route exists
 * within shared's search bounds/budget (ROUTE_SEARCH_MARGIN_CELLS /
 * ROUTE_NODE_BUDGET) — see `advanceWalker` for what a walker does about that.
 */
export function planRoute(
  world: PilgrimWorld,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): RouteCell[] | null {
  const plan = findRoute(world, PILGRIM_WALKER_PROFILE, { x: fromX, y: fromY }, { x: toX, y: toY });
  return plan === null ? null : [...plan.cells];
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
  /** The planned route to `goalX`/`goalY` (see `advanceWalker`), or null when
   *  none exists / none has been planned — the walker then falls back to
   *  stepWalker's direct local avoidance for this leg. Never on the wire. */
  route: RouteCell[] | null;
  /** Index of the next unreached waypoint in `route`. */
  routeIndex: number;
}

/** The moving slice of a walker — what `stepWalker` needs, and nothing more.
 *  Both the pilgrimage and the wandering sims feed their walkers through it. */
export interface MovingWalker {
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
}

/** A MovingWalker that also carries a planned route — what `advanceWalker`
 *  needs. Both `Pilgrim` and wandering.ts's `Wanderer` satisfy this, and it is
 *  shared's `RoutedMover` (steering.ts) plus this plugin's own goal fields. */
export interface RoutedWalker extends MovingWalker, RoutedMover {}

/**
 * Personal space around one walker, in cells — how close another body may
 * come before a candidate heading is refused (shared's `steerAvoiding`).
 *
 * 0.2 — MEASURED off the shipped model, not guessed, and measured HERE rather
 * than imported for the reason VIEWPOINT_RING_CELLS states above: a server sim
 * must not reach into a client model file, and the failure mode of drift is
 * walkers passing a little closer than intended, never a crash. The widest
 * part of a settler is the head sphere, radius 0.155 cells
 * (pilgrims/client/models.ts), and its limbs and tail swing a little wider
 * again; 0.2 is that rounded up. Two walkers therefore hold 0.4 cells centre
 * to centre — bodies clear, with the gap reading as a gap rather than a graze.
 *
 * WHY THIS DID NOT EXIST BEFORE (owner, 2026-08-20: "they tend to run into
 * each other"): nothing in this plugin, or in any other mover plugin, read a
 * second mover's position at all. That is fixed at the contract layer — see
 * shared/src/steering.ts's header — and this constant is only this plugin's
 * body size, the one part of it that is genuinely local.
 */
export const WALKER_PERSONAL_SPACE_CELLS = cellsAcross(0.2);

/**
 * The moving population a walker must keep clear of, as shared's `Occupant`
 * rows. Assembled by the plugin wiring (index.ts) across BOTH sims and passed
 * down, because a pilgrim and a wanderer are equally solid to each other and
 * neither sim can see the other's list.
 */
export function walkerOccupants(walkers: Iterable<MovingWalker>): Occupant[] {
  const rows: Occupant[] = [];
  for (const walker of walkers) {
    rows.push({ x: walker.x, y: walker.y, radiusCells: WALKER_PERSONAL_SPACE_CELLS });
  }
  return rows;
}

/**
 * The crowd ONE walker must steer around: everybody else in its own sim, plus
 * whatever the caller passed in from the other one, and never itself.
 *
 * `population` and `crowd` are parallel — `crowd[i]` is `population[i]`'s
 * start-of-tick snapshot — so self-exclusion is an index lookup rather than a
 * position comparison. Position comparison would be wrong: two walkers may
 * legitimately share a cell for a tick, and dropping both of them would
 * disable separation exactly when it is needed.
 */
function crowdAround(
  self: MovingWalker,
  population: readonly MovingWalker[],
  crowd: readonly Occupant[],
  foreign: readonly Occupant[],
): Occupant[] {
  const rows: Occupant[] = [];
  for (let i = 0; i < population.length; i++) {
    if (population[i] !== self) rows.push(crowd[i]);
  }
  for (const row of foreign) rows.push(row);
  return rows;
}

/** How far ahead a walker probes when steering. See LOOKAHEAD_SECONDS. */
function lookaheadCells(): number {
  return PILGRIM_WALK_SPEED_CELLS_PER_SECOND * LOOKAHEAD_SECONDS;
}

/**
 * One walking step with water/slope/crowd avoidance toward (targetX, targetY)
 * — now a thin adapter over shared's `steerAvoiding` (shared/src/steering.ts),
 * which owns the sweep itself. `targetX`/`targetY` default to
 * `pilgrim.goalX`/`goalY`, the walker's ultimate destination.
 *
 * STILL EXPORTED, and still the one movement rule for every little person on
 * the road: what changed 2026-08-20 is only that the rule moved to the
 * contract layer, where boats and monsters use it too. See steering.ts's
 * header for why four copies of this sweep was the bug rather than four
 * plugins' business.
 */
export function stepWalker(
  world: PilgrimWorld,
  pilgrim: MovingWalker,
  dt: number,
  targetX: number = pilgrim.goalX,
  targetY: number = pilgrim.goalY,
  occupants: readonly Occupant[] = [],
): void {
  const desired = Math.atan2(targetY - pilgrim.y, targetX - pilgrim.x);
  // One tick's travel: the distance the walker moves, and the distance the
  // separation test is taken at (shared's `SteerOptions.stepCells`). One
  // expression, so the sweep cannot reason about a step the walker does not
  // then take.
  const stepCells = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt;
  const heading = steerAvoiding(world, PILGRIM_WALKER_PROFILE, pilgrim, desired, lookaheadCells(), {
    stepCells,
    occupants,
    selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS,
  });
  // Boxed in: hold position this tick; the stuck timer decides what is next.
  if (heading === null) return;

  pilgrim.heading = heading;
  pilgrim.x += Math.cos(heading) * stepCells;
  pilgrim.y += Math.sin(heading) * stepCells;
}

/**
 * Advances one walker toward its ultimate goal for one tick — a thin adapter
 * over shared's `followRoute` (shared/src/steering.ts), which owns the
 * route-following contract and the fix to the freeze it used to cause.
 *
 * Returns TRUE when the walker got somewhere this tick — it entered a new
 * route cell, or (routeless) closed on its goal. The caller's stuck timer
 * runs off THIS, not off distance to the goal; see `followRoute`'s
 * `progressed` for why the distance measure could neither survive a real
 * detour nor detect a walker oscillating on the spot.
 */
export function advanceWalker(
  world: PilgrimWorld,
  walker: RoutedWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): boolean {
  const result = followRoute(world, PILGRIM_WALKER_PROFILE, walker, {
    stepCells: PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt,
    lookaheadCells: lookaheadCells(),
    goalX: walker.goalX,
    goalY: walker.goalY,
    occupants,
    selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS,
  });
  return result.progressed;
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
    occupants: readonly Occupant[] = [],
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
      pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
      pilgrim.routeIndex = 0;
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

        // NEVER DISPATCH A PILGRIM TO A TRIP IT CANNOT WALK: plan the route
        // before minting a walker, not after. A settlement with no legal
        // route to the viewpoint (walled in, an island, budget-exhausted —
        // see shared/src/pathing.ts) sends no pilgrim this tick rather than
        // one doomed to the stuck-timeout give-up. Try the next-nearest
        // candidate instead of the whole monster's dispatch failing.
        const homeX = cell.x + 0.5;
        const homeY = cell.y + 0.5;
        const route = planRoute(world, homeX, homeY, viewpoint.x, viewpoint.y);
        if (route === null) continue;

        const id = this.ids.allocate();
        this.pilgrims.set(id, {
          id,
          race: settlementRace(cell.x, cell.y),
          homeX: cell.x,
          homeY: cell.y,
          monsterId: monster.monsterId,
          x: homeX,
          y: homeY,
          heading: Math.atan2(viewpoint.y - homeY, viewpoint.x - homeX),
          leg: 'outbound',
          goalX: viewpoint.x,
          goalY: viewpoint.y,
          lingerSeconds: 0,
          stuckSeconds: 0,
          route,
          routeIndex: 0,
        });
      }
    }

    // ── Walk / linger / arrive. ──
    //
    // The crowd every walker steers around is a START-OF-TICK SNAPSHOT of all
    // of them, taken before any of them moves. Deliberately not "wherever each
    // one happens to be by the time we reach it": that would make a walker's
    // path depend on its position in the iteration order, which is exactly the
    // kind of order-dependence the rest of this file goes to some trouble to
    // keep out (see the header's determinism note). Everyone reacts to the same
    // world; nobody gets the advantage of moving last.
    const own = [...this.pilgrims.values()];
    const ownCrowd = walkerOccupants(own);

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
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
        }
        continue;
      }

      // Route progress — NOT distance to the goal — resets the stuck clock.
      // The distance measure cannot tell a legitimate detour (which increases
      // it, for as long as the detour lasts) from being stuck, nor a walker
      // oscillating on the spot (which decreases it every other tick) from
      // one making headway; see shared/src/steering.ts's `progressed`.
      const progressed = advanceWalker(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants));
      if (progressed) pilgrim.stuckSeconds = 0;
      else pilgrim.stuckSeconds += dt;

      const after = goalDistanceSq(pilgrim);

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
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
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

  /** The live walkers, in spawn order — what the plugin wiring turns into the
   *  `Occupant` rows the OTHER sim steers around (see index.ts). Exposed as
   *  the moving slice alone: nothing outside this file has business with a
   *  pilgrim's leg, route or blessing. */
  walkers(): readonly MovingWalker[] {
    return [...this.pilgrims.values()];
  }

  /**
   * Every pilgrim currently following a planned route, as an ordered cell
   * list — EXPOSED so a future roads feature (mechanics card 29: "long-lived
   * neighbouring settlements wear footpaths between themselves along walkable
   * routes") can read what ground a route actually crosses without this file
   * knowing roads exist. A pilgrim currently degraded to direct local
   * avoidance (no route — see `advanceWalker`) contributes nothing; that is
   * not a route to wear a footpath along.
   */
  routes(): ReadonlyArray<{ readonly homeX: number; readonly homeY: number; readonly cells: RouteCell[] }> {
    const rows: Array<{ homeX: number; homeY: number; cells: RouteCell[] }> = [];
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.route !== null) {
        rows.push({ homeX: pilgrim.homeX, homeY: pilgrim.homeY, cells: pilgrim.route });
      }
    }
    return rows;
  }

  clear(): void {
    this.tracker.clear();
    this.pilgrims.clear();
    if (this.ownsIds) this.ids.reset();
  }
}
