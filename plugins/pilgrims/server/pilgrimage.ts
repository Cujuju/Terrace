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
  ROUTE_NODE_BUDGET,
  WORLD_UNIT_CELLS,
  cellsAcross,
  createRouteBudget,
  findRoute,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  steerWithShorteningProbe,
  type FreshwaterMap,
  type Occupant,
  type RouteBudget,
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

/**
 * A* node expansions ONE tick's DISPATCH may spend, shared across every settled
 * monster and every catchment settlement it considers (shared's RouteBudget).
 *
 * ROUTE_NODE_BUDGET — exactly one whole search's worth per tick, and the size
 * is forced rather than chosen. A route failure is only ever PROVEN by a search
 * that exhausts a full ROUTE_NODE_BUDGET (shared/src/pathing.ts: A* can say
 * "no" no other way), and the memo below may only record a failure that was
 * proven. A pool smaller than one full budget could therefore never prove a
 * single failure: every unreachable pair would come back "inconclusive — the
 * pool ran out" and be retried on the next tick forever, which is the very
 * bleed this constant exists to stop. Larger buys nothing either: the second
 * exhausted search in one tick is the one that turns a 50 ms tick into a
 * blown one (2026-08-29 perf review, D3: 44.9–58.1 ms per exhausted search
 * against a 100 ms tick at TICK_HZ = 10).
 *
 * WHAT IT BOUNDS, THEN, is the tick: dispatch can cost at most one exhausted
 * search however many settled monsters and cut-off towns the world holds,
 * where before it cost one PER cut-off town PER tick, indefinitely. Successful
 * routes are ~0.3 ms each (same measurement), so an ordinary tick spends a
 * fraction of the pool and the cap is never felt.
 */
export const PILGRIM_DISPATCH_EXPANSION_POOL = ROUTE_NODE_BUDGET;

/**
 * Row stride for packing a settlement's (x, y) into one integer memo key.
 *
 * 65536 — structures' own key arithmetic (y × 65536 + x), restated by value
 * for the same own-copy reason `blessedCellKeys` restates it: a plugin must
 * build with its siblings deleted. Exact for every world size this engine
 * ships (worldSize ≤ 65536 keeps x and y in their own lanes).
 */
const SETTLEMENT_KEY_STRIDE = 65536;

/**
 * What one settled monster's dispatch has already learned about its catchment.
 *
 * WHY IT EXISTS (2026-08-29 perf review, D3). `SettlednessTracker.advance`
 * reports the CURRENTLY settled set every tick, not the newly-settled ones, so
 * a monster that sits still is offered to the dispatch loop ten times a second
 * for as long as it stays. Without a memory of what was already tried, every
 * catchment town that CANNOT walk to the viewpoint — the ordinary case of a
 * river or lake between them, since fresh water is a wall to
 * LAND_WALKER_PROFILE — paid a fresh budget-exhausting A* (44.9–58.1 ms
 * measured) on every one of those ticks, for as long as the beast stayed:
 * ~50 % of every tick from ONE such town, and two blew the tick outright.
 * Remembering the proven failure turns that into one search, once.
 *
 * WHY NOT `floodReachableRegion` (shared/src/pathing.ts), which is what that
 * review's fix suggested and what settling.ts's site scan uses. A flood answers
 * a whole box at once, so one flood per catchment would beat one search per
 * town — but only if it were flooded from the VIEWPOINT, one flood serving
 * every town, and that direction is not the direction the walker walks.
 * REACHABILITY OVER THIS PROFILE IS NOT SYMMETRIC: the corner-cutting guard
 * (findRoute's, and the flood's own) tests a diagonal's two flanking cells
 * against the height of the cell it is standing ON, so a corner legal from one
 * end can be illegal from the other. Verified against the shipped modules, not
 * reasoned about: with heights base / base+MAX_STEP on the two diagonal cells
 * and base−MAX_STEP on both flanks, `findRoute` A→B succeeds, a flood from A
 * reaches B, and a flood from B does not reach A. A viewpoint-side flood would
 * therefore sometimes prove nothing while claiming to, and the failure mode is
 * a town silently barred from ever sending a pilgrim. Flooding per settlement
 * instead would be one flood per town — worse than the one search per town it
 * replaces. The memo is exact by construction: what it records is A*'s own
 * answer to the very question that will be asked again.
 */
interface CatchmentMemo {
  /** The anchor this memo was learned at. A monster that re-anchors is a
   *  different question — new viewpoint, new routes — so the memo is dropped
   *  rather than reused (SettlednessTracker re-anchors on leaving the settled
   *  circle, which also unsettles it; this comparison is the belt to that
   *  suspenders, and costs two number compares a tick). */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Packed keys (SETTLEMENT_KEY_STRIDE) of the settlements whose route to
   *  this monster's viewpoint A* has PROVEN it cannot plan — never the ones it
   *  merely ran out of pooled allowance on (see PILGRIM_DISPATCH_EXPANSION_
   *  POOL). Cleared wholesale by `forgetRouteFailures` when the terrain moves. */
  readonly unroutable: Set<number>;
}

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
 *
 * `budget` is shared's RouteBudget: a pool of node expansions this call draws
 * from and pays back into, so a caller that plans SEVERAL routes in one
 * synchronous turn (settling.ts's site scan) can cap the turn rather than each
 * call. Omitted means the default per-call ROUTE_NODE_BUDGET, which is every
 * one-route-at-a-time caller in this plugin.
 */
export function planRoute(
  world: PilgrimWorld,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  budget?: RouteBudget,
): RouteCell[] | null {
  const plan = findRoute(
    world,
    PILGRIM_WALKER_PROFILE,
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    budget,
  );
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
  /** See PanickingWalker — the fire reaction, shared by all three walker sims. */
  panicSecondsRemaining: number;
  panicFromX: number;
  panicFromY: number;
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
 * — a thin adapter over shared's `steerWithShorteningProbe`
 * (shared/src/steering.ts), which owns the steer itself. `targetX`/`targetY`
 * default to `pilgrim.goalX`/`goalY`, the walker's ultimate destination.
 *
 * STILL EXPORTED, and still the one movement rule for every little person on
 * the road: what changed 2026-08-20 is only that the rule moved to the
 * contract layer, where boats and monsters use it too. See steering.ts's
 * header for why four copies of this sweep was the bug rather than four
 * plugins' business.
 *
 * THE LADDER, NOT ONE RUNG OF IT (issue #215, 2026-08-26). This called
 * `steerAvoiding` — the single-probe rung — which is the same near-sightedness
 * that stalled fish, boats and monsters before it, and which was measured here
 * as a burning peep standing motionless for 4.3 s of an 8 s burn. Walkers were
 * simply the last mover family still on the rung; see `steerAvoiding`'s own
 * contract note for why the choice between the two was never a caller's to
 * make.
 */
export function stepWalker(
  world: PilgrimWorld,
  pilgrim: MovingWalker,
  dt: number,
  targetX: number = pilgrim.goalX,
  targetY: number = pilgrim.goalY,
  occupants: readonly Occupant[] = [],
  permits?: (x: number, y: number) => boolean,
): void {
  const desired = Math.atan2(targetY - pilgrim.y, targetX - pilgrim.x);
  // One tick's travel: the distance the walker moves, and the distance the
  // separation test is taken at (shared's `SteerOptions.stepCells`). One
  // expression, so the sweep cannot reason about a step the walker does not
  // then take.
  const stepCells = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt;
  const heading = steerWithShorteningProbe(
    world,
    PILGRIM_WALKER_PROFILE,
    pilgrim,
    desired,
    lookaheadCells(),
    { stepCells, occupants, selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS, permits },
  );
  // A ONE-CELL POCKET — genuinely nowhere legal one step away in any direction,
  // which is what null means once the ladder has run. Hold position this tick;
  // the stuck timer decides what is next, and for a walker whose stuck timer is
  // deliberately not running (see `panicStep`) this is now the only way to
  // stand still, rather than the common case it used to be.
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

// ────────────────────────────────────────────────────────────────────────────
// PANIC — the walker's reaction to fire (issue #184).
//
// A peep is not a grazer: an animal wanders, so a startled one simply turns and
// runs and there is nothing to put back afterwards. A walker is GOING SOMEWHERE
// — a leg, a goal, a planned route and an index into it — and a panic that
// trampled any of that would leave a pilgrim who had bolted from a fire walking
// backwards along a route it was no longer standing on.
//
// So panic INTERRUPTS the journey and never edits it. While it lasts, the goal
// machinery in all three sims is skipped entirely and the walker runs; when it
// ends, the ONE thing that has genuinely gone stale — the planned route, which
// started from a place the walker is no longer at — is replanned from where it
// now stands to the goal it always had. The leg, the linger, the visit, the
// attempt count and the goal itself are untouched, so the journey resumes as
// the same journey.
//
// ONE PRIMITIVE, THREE SIMS, and every one of them must call it at the TOP of
// its per-walker loop — before the linger/visit branch, because a pilgrim
// standing still watching a monster is exactly the walker most in need of being
// told the world is on fire.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Multiplier on walking speed while panicking.
 *
 * ×3, wildlife's FLEE_SPEED_MULTIPLIER — restated rather than imported, as
 * every cross-plugin number here is, because a plugin must build with the
 * others deleted. Not tuned apart from an animal's for the reason the burn
 * times are not (design, 2026-08-24 on peeps: same size, same sort of thing,
 * and a player who has learned one has learned the other): ×3 is the difference
 * between "walking" and "running" at a glance, on a peep exactly as on a grazer.
 */
export const WALKER_PANIC_SPEED_MULTIPLIER = 3;

/**
 * How long a BYSTANDER's panic lasts, in simulated seconds — a walker who saw
 * a fire start nearby, as opposed to one who is on fire.
 *
 * 2.5 s, wildlife's FLEE_DURATION_SECONDS and restated for the same reason as
 * the multiplier above. It is the length of a burst that reads as a reaction
 * rather than a change of plan: long enough to see the crowd scatter, short
 * enough that the road is orderly again before the player has finished
 * watching the fire.
 */
export const WALKER_PANIC_SECONDS = 2.5;

/**
 * How far a NEW FLAME is felt, in cells from where it appeared.
 *
 * ONE PANIC BURST, exactly: a walker runs at WALKER_PANIC_SPEED_MULTIPLIER for
 * WALKER_PANIC_SECONDS and then calms, so the distance covered in a single
 * flight is the only distance the reaction actually has to work with. Sizing
 * the alarm to it buys the invariant worth having — every walker the alarm
 * reaches can put the whole alarm radius behind it before it calms — and at
 * PILGRIM_WALK_SPEED_CELLS_PER_SECOND that is 2 × 3 × 2.5 = 15 cells, just
 * under four world units.
 *
 * SMALLER THAN THE ANIMALS' ALARM, and knowingly. Wildlife derives its radius
 * the same way and gets 48 cells, because a grazer runs three times as fast as
 * a person walks; the number differs because the thing it measures is what the
 * reactor can DO about a fire, not how big the fire is. Copying the animals'
 * 48 here — quite apart from being unimportable — would panic walkers who
 * could not clear it, which on screen is a person jogging on the spot beside a
 * fire and then stopping, still beside it.
 *
 * A walker who is still inside the alarm when a spreading fire lights its next
 * cell is simply startled again, which is the correct behaviour and needs no
 * rule of its own: they keep running while the fire keeps coming.
 */
export const FIRE_STARTLE_RADIUS_CELLS = Math.round(
  PILGRIM_WALK_SPEED_CELLS_PER_SECOND * WALKER_PANIC_SPEED_MULTIPLIER * WALKER_PANIC_SECONDS,
);

/**
 * A walker that can panic — every walker in this plugin, across all three sims.
 *
 * The panic ANCHOR is meaningful only while `panicSecondsRemaining` is positive;
 * there is deliberately no separate "is panicking" flag, so the countdown stays
 * the single definition of the state (wildlife keeps `fleeSecondsRemaining` as
 * the one definition of its own, for the same reason).
 */
export interface PanickingWalker extends RoutedWalker {
  readonly id: number;
  stuckSeconds: number;
  panicSecondsRemaining: number;
  /**
   * WHAT THIS WALKER IS RUNNING FROM, in cells — never which way it ran
   * (issue #215).
   *
   * A stored BEARING is a constant, and a constant bearing is what let a
   * panicking walker pace on the spot: the run target was a fixed offset from
   * the walker's own position, so `desired` was the same angle every tick, and
   * a walker pressed against terrain alternated between that angle and its own
   * reverse — a two-tick cycle that the two-tick broadcast interval then
   * aliased into a walker that looked perfectly frozen on the wire. Measured
   * 2026-08-26: 0.6 cells north, 0.6 cells south, ten times, while the client
   * saw one unchanging position.
   *
   * An ANCHOR has no such fixed point. "Away from here" is recomputed from the
   * walker's CURRENT position every tick, so it rotates as the walker slides
   * along an obstacle, and — the part that actually closes the bug — it makes
   * the retreat MEASURABLE, which is what `panicStep`'s veto needs.
   */
  panicFromX: number;
  panicFromY: number;
}

/**
 * Runs one panicking walker for a tick. TRUE when it panicked — the caller's
 * cue to skip everything else it would have done with this walker.
 *
 * THE PANIC RUNS THROUGH `stepWalker` LIKE ANY OTHER STEP, so a terrified peep
 * is still refused water, an unclimbable riser and another walker's body: panic
 * changes where they want to go, never what the ground will let them do. The
 * speed-up is applied by handing the step a LONGER `dt` rather than by a second
 * speed constant, which keeps the distance the separation sweep reasons about
 * and the distance actually travelled the same expression — the property
 * `stepWalker` documents as the reason it computes `stepCells` once.
 *
 * The run target is a point one whole burst ahead along the panic heading, so
 * the walker is steering at open ground rather than at a destination it could
 * "arrive" at mid-panic.
 *
 * THE PANIC BEARING IS A CONSTANT, AND THAT IS SAFE ONLY BECAUSE OF THE LADDER
 * (issue #215). The target is a fixed offset from the walker's CURRENT
 * position, so `desired` is the same angle every tick — which means a bearing
 * the steer refuses is recomputed, identically refused, and refused again for
 * the whole panic. That is exactly what was measured: 4.3 s of an 8 s burn
 * standing still. What breaks the loop is `stepWalker` going down shared's
 * shortening ladder, whose two short rungs steer from the walker's OWN
 * heading rather than from `desired` — so a walker pressed against something
 * slides along it and the bearing it is actually travelling on changes even
 * though the one it wants does not. Re-deriving the bearing from a stored
 * source point would NOT have fixed this on its own: "away from a thing that
 * has not moved, from a walker that has not moved" is the same constant.
 *
 * AND NOTHING ELSE IS WATCHING. This returns true on a tick where the walker
 * did not move, and zeroes `stuckSeconds` when the panic ends — both
 * deliberate (a panic is not a stuck walk), which is why a stalled panic was
 * invisible to the give-up path that catches a stalled journey. A panicking
 * walker has no timer behind it, so the steer itself has to be the one that
 * cannot near-sightedly give up.
 */
export function panicStep(
  world: PilgrimWorld,
  walker: PanickingWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): boolean {
  if (walker.panicSecondsRemaining <= 0) return false;

  walker.panicSecondsRemaining = Math.max(0, walker.panicSecondsRemaining - dt);

  // AWAY FROM THE ANCHOR, RE-DERIVED THIS TICK — see `PanickingWalker`'s
  // anchor for why this may not be a stored angle. Standing exactly on it
  // keeps the current heading: there is no "away" from a point you are on,
  // and inventing a direction would read as a glitch.
  const awayX = walker.x - walker.panicFromX;
  const awayY = walker.y - walker.panicFromY;
  const fleeing = awayX !== 0 || awayY !== 0 ? Math.atan2(awayY, awayX) : walker.heading;
  const anchorDistanceSq = awayX * awayX + awayY * awayY;

  stepWalker(
    world,
    walker,
    dt * WALKER_PANIC_SPEED_MULTIPLIER,
    walker.x + Math.cos(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    walker.y + Math.sin(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    occupants,
    // A PANIC MAY ONLY EVER INCREASE THE DISTANCE FROM WHAT IT IS FLEEING.
    // This is the whole cure for the two-tick cycle and it is a statement
    // about what fleeing MEANS, not a tie-break: the reverse of a step just
    // taken always closes on the anchor, so it can never be chosen, and no
    // sequence of legal steps can return the walker to where it has been.
    // Refusing every candidate is now honest — a walker with the fire on all
    // sides holds rather than pacing — and it cannot last, because the thing
    // it is failing to escape is killing it.
    (x, y) => {
      const dx = x - walker.panicFromX;
      const dy = y - walker.panicFromY;
      return dx * dx + dy * dy > anchorDistanceSq;
    },
  );

  if (walker.panicSecondsRemaining <= 0) {
    // THE JOURNEY, HANDED BACK. The route is the only part of it the panic
    // invalidated — it was planned from somewhere this walker has just run away
    // from — so it is replanned from here to the goal that never changed. A
    // null plan is the ordinary "no route, steer directly" fallback this
    // plugin already has (see Pilgrim.route), not a failure.
    walker.route = planRoute(world, walker.x, walker.y, walker.goalX, walker.goalY);
    walker.routeIndex = 0;
    // They were running, not stuck. Charging a panic to the give-up clock would
    // retire a walker for having survived a fire.
    walker.stuckSeconds = 0;
  }
  return true;
}

/**
 * Startles every walker within `radius` cells of (centerX, centerY) and points
 * it directly away, for WALKER_PANIC_SECONDS. Returns how many.
 *
 * A walker standing exactly on the centre keeps the heading it had — wildlife's
 * `startleNear` rule and its reason: there is no "away" from a point you are
 * on, and inventing a random direction would read as a glitch.
 */
export function startleWalkersNear(
  walkers: Iterable<PanickingWalker>,
  centerX: number,
  centerY: number,
  radius: number,
): number {
  const radiusSquared = radius * radius;
  let startled = 0;

  for (const walker of walkers) {
    const dx = walker.x - centerX;
    const dy = walker.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;

    walker.panicFromX = centerX;
    walker.panicFromY = centerY;
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, WALKER_PANIC_SECONDS);
    startled++;
  }
  return startled;
}

/**
 * Puts these walkers into a panic lasting `seconds`, with no direction to it —
 * they bolt the way they were already facing. Returns how many.
 *
 * FOR A WALKER WHO IS THEMSELF ALIGHT (../server/index.ts's fuel registration),
 * which differs from `startleWalkersNear` in exactly the two ways that matter:
 * there is no "away" from a fire you are carrying, and the panic lasts the
 * whole burn rather than a burst, because being on fire is a condition and not
 * an instant.
 *
 * WHY THE WHOLE BURN IS SET ONCE RATHER THAN REFRESHED WHILE IT BURNS. A
 * refresh would need this plugin to keep its own "which of mine are alight"
 * set, and fire announces only one of a burning individual's four endings to
 * the owner — it says when one burned to death, and says nothing when rain puts
 * it out or when the fire is dropped because the walker was removed by
 * something else (plugins/fire/server/entityBlaze.ts's four endings). Such a
 * set would leak, and a leaked entry is a person who runs forever. The
 * countdown needs no set: it expires on its own, and the one divergence — a
 * walker the rain saved keeps running for the rest of what would have been
 * their life — is honest, because they have just been on fire.
 */
export function panicWalkers(
  walkers: Iterable<PanickingWalker>,
  ids: readonly number[],
  seconds: number,
): number {
  if (seconds <= 0) return 0;

  let panicked = 0;
  // Iterated over the WALKERS rather than over `ids`, so the order of work is
  // this plugin's own fixed walker order and not the caller's list.
  for (const walker of walkers) {
    if (!ids.includes(walker.id)) continue;
    // THE PLACE THEY CAUGHT, which is the only honest anchor for a walker
    // carrying its own fire: there is no external thing to run from, and
    // "get away from where this happened" is both what a person does and the
    // measurable retreat `panicStep`'s veto is built on.
    walker.panicFromX = walker.x;
    walker.panicFromY = walker.y;
    // NEVER SHORTENS an existing panic: a walker startled a moment ago and set
    // alight now must not have their flight cut back to the shorter of the two.
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, seconds);
    panicked++;
  }
  return panicked;
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
  /** One CatchmentMemo per settled monster id, dropped the tick that monster
   *  stops being settled — so the map never outgrows the settled population. */
  private readonly catchmentMemos = new Map<number, CatchmentMemo>();

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
    //
    // ONE POOLED ROUTING ALLOWANCE FOR THE WHOLE TICK, minted here and handed
    // to every plan below (see PILGRIM_DISPATCH_EXPANSION_POOL): the bound has
    // to be on the tick, not on the call, because the loop below runs one
    // search per (settled monster × catchment settlement) pair.
    const dispatchBudget = createRouteBudget(PILGRIM_DISPATCH_EXPANSION_POOL);
    // Monsters that stopped being settled take their memo with them.
    for (const monsterId of this.catchmentMemos.keys()) {
      if (!settledById.has(monsterId)) this.catchmentMemos.delete(monsterId);
    }

    // Set when the tick's pooled allowance can no longer fund a search whose
    // answer would be trustworthy (see the two nulls below): no further
    // dispatch this tick can be decided honestly, so dispatch stops here and
    // the walk below still runs. The next tick starts with a fresh pool and,
    // because the candidate order is fixed, resumes on the same candidate.
    let dispatchAllowanceSpent = false;

    for (const monster of settled) {
      if (dispatchAllowanceSpent) break;
      const viewpoint = pickViewpoint(world, monster.x, monster.y);
      if (viewpoint === null) continue;

      // What this monster's dispatch has already proved about its catchment
      // (see CatchmentMemo). A monster that re-anchored asks a different
      // question, so its memo is dropped rather than trusted.
      let memo = this.catchmentMemos.get(monster.monsterId);
      if (memo !== undefined && (memo.anchorX !== monster.x || memo.anchorY !== monster.y)) {
        this.catchmentMemos.delete(monster.monsterId);
        memo = undefined;
      }

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

        // THE CHEAP QUESTION FIRST: this town's road to this beast was already
        // proved impossible, on terrain that has not moved since. Asking A*
        // again would spend a whole budget re-deriving the same "no" (see
        // CatchmentMemo for what that cost the tick).
        const settlementKey = cell.y * SETTLEMENT_KEY_STRIDE + cell.x;
        if (memo !== undefined && memo.unroutable.has(settlementKey)) continue;

        // NEVER DISPATCH A PILGRIM TO A TRIP IT CANNOT WALK: plan the route
        // before minting a walker, not after. A settlement with no legal
        // route to the viewpoint (walled in, an island, budget-exhausted —
        // see shared/src/pathing.ts) sends no pilgrim this tick rather than
        // one doomed to the stuck-timeout give-up. Try the next-nearest
        // candidate instead of the whole monster's dispatch failing.
        const homeX = cell.x + 0.5;
        const homeY = cell.y + 0.5;
        // What the pool held BEFORE this search: the test for whether its
        // answer is knowledge (below). Read before, not after, because a
        // search that fails spends everything it was offered either way.
        const allowanceBefore = dispatchBudget.remaining;
        const route = planRoute(world, homeX, homeY, viewpoint.x, viewpoint.y, dispatchBudget);
        if (route === null) {
          // TWO VERY DIFFERENT NULLS, and only one of them is knowledge. A
          // search offered LESS than a whole ROUTE_NODE_BUDGET was cut off by
          // this tick's pool rather than by its own limits: it proved nothing,
          // and recording it would silence a town that may be perfectly able to
          // walk. A search that was offered a whole budget and still said no
          // said exactly what an unpooled `planRoute` would have said (shared's
          // per-call default IS ROUTE_NODE_BUDGET) — and that is a fact about
          // this terrain, not about this tick: remember it, and stop asking.
          if (allowanceBefore < ROUTE_NODE_BUDGET) {
            dispatchAllowanceSpent = true;
            break;
          }
          if (memo === undefined) {
            memo = { anchorX: monster.x, anchorY: monster.y, unroutable: new Set<number>() };
            this.catchmentMemos.set(monster.monsterId, memo);
          }
          memo.unroutable.add(settlementKey);
          continue;
        }

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
          panicSecondsRemaining: 0,
          panicFromX: 0,
          panicFromY: 0,
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
      // PANIC FIRST, ABOVE THE LINGER BRANCH. A pilgrim standing still watching
      // a monster is the walker most in need of being told the world is on
      // fire, and it is the one the linger branch would otherwise `continue`
      // past without ever looking (see the PANIC section's header).
      if (panicStep(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants))) continue;

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
  walkers(): readonly PanickingWalker[] {
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

  /**
   * Removes one pilgrim outright — a DEATH, not a homecoming.
   *
   * Nothing else has to be unwound: the settledness tracker is keyed by MONSTER
   * rather than by pilgrim, and a settlement's blessing is derived from who is
   * abroad (blessedCellKeys) rather than stored, so a pilgrim who burns simply
   * stops being counted on the next pass. fire is the only caller.
   */
  remove(id: number): boolean {
    return this.pilgrims.delete(id);
  }

  /**
   * Forgets every proven route failure — the invalidation half of the memo
   * above. The plugin wiring calls it from `onTerrainChanged`.
   *
   * DELIBERATELY COARSE: ANY terrain change clears ALL of them, rather than
   * only the memos whose catchment the changed cells fall inside. The cheap
   * box test would be UNSOUND, and that is the reason, not the effort: what
   * makes a route illegal here is not only ground height but fresh water
   * (LAND_WALKER_PROFILE treats a river or lake as a wall — shared/src/
   * traversal.ts), and rivers are DERIVED from the whole heightmap by flow, so
   * a sculpt in one valley can move a watercourse in another. There is no box
   * around a sculpt that contains everything it can make walkable, so there is
   * no sound narrowing — and a memo wrongly kept is a town silently barred
   * from ever sending a pilgrim again, which is far worse than re-proving.
   *
   * THE COST OF THE COARSENESS IS BOUNDED AND TEMPORARY: re-proving happens
   * lazily, only for pairs the dispatch loop actually reaches, and never more
   * than one exhausted search per tick (PILGRIM_DISPATCH_EXPANSION_POOL). The
   * residual failure mode, named: while a player DRAGS a brush, every tick of
   * the drag clears the memo, so a catchment with a cut-off town pays that one
   * exhausted search (~50 ms) per sculpting tick — the pre-fix steady state,
   * now confined to the seconds a player is actively sculpting.
   */
  forgetRouteFailures(): void {
    this.catchmentMemos.clear();
  }

  clear(): void {
    this.tracker.clear();
    this.pilgrims.clear();
    this.catchmentMemos.clear();
    if (this.ownsIds) this.ids.reset();
  }
}
