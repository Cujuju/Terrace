// THE SETTLING SIMULATION — settlers walking out of the player's temple to
// found homes (owner, 2026-08-24: "the temple should emit settlers, and those
// settlers should go out and spawn homes").
//
// WHY IT LIVES HERE and not in the temples plugin: this is a little person on
// the road, and every little person in this world walks by ONE rule
// (pilgrimage.ts's advanceWalker), is drawn by ONE model set, and travels on
// ONE wire. A second walker population in another plugin would be a second
// copy of all three — the exact duplication wandering.ts was written into this
// plugin to avoid. The temple itself is the temples plugin's; this file only
// asks it where it stands (temples-bridge.ts).
//
// DETERMINISTIC END TO END, like both sims beside it: no rng. Time is cut into
// fixed epochs; each epoch the temple rolls the same integer hash every server
// would roll (cell × epoch), and that roll picks where the settler heads.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SETTLER FOUNDS A HOMESTEAD — FOUR HOMES, NOT ONE — AND THAT IS NOT DECOR.
//
// structures runs classic B3/S23 over the buildable ground, so a home founded
// ALONE has zero live neighbours and dies in the very next generation: a
// settler who built one house would watch it vanish fifteen seconds later, and
// the feature would read as broken rather than as cellular. The smallest thing
// that SURVIVES that rule is the 2×2 block — the canonical still life, every
// cell with exactly three neighbours — so that is what a settler builds: a
// homestead of four, one world unit of ground, stable from the moment it goes
// up and free to interact with whatever grows near it afterwards.
//
// A PARTIAL FOUNDING SELF-HEALS OR SELF-CLEARS, which is why this file does
// not need (and structures does not offer) an all-or-nothing transaction.
// Three of the four is an L-triomino: B3 births the empty corner next
// generation and S23 keeps all three, so it BECOMES the block. Two or one has
// too few neighbours to survive and is gone next generation, leaving the
// ground as it was — so the settler simply walks on to its next candidate site
// rather than the world keeping a ruin.
// ─────────────────────────────────────────────────────────────────────────────

import { cellsAcross } from '@terrace/shared';
import type { Occupant, RouteCell } from '@terrace/shared';
import { SETTLERS_CAP, hashCell, settlementRace, type PilgrimEntityState } from '../protocol.ts';
import type { SettlerRace } from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  PILGRIM_STUCK_SECONDS,
  WalkerIdAllocator,
  advanceWalker,
  isWalkableCell,
  planRoute,
  walkerOccupants,
  type MovingWalker,
  type PilgrimWorld,
} from './pilgrimage.ts';
import { canFoundStructureAt, foundStructureAt } from './structures-bridge.ts';
import type { BridgedTemple } from './temples-bridge.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment, and every distance stated in
// WORLD UNITS and converted, because each is a fact about the ground rather
// than about the grid the ground is sampled on (pilgrimage.ts's own rule, and
// the 2026-08-21 re-sample it records).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seconds between one settler leaving the temple and the next.
 *
 * 25 — a shade under two structures CA generations (15 s each), so the world
 * has had a generation to react to the last homestead before the next settler
 * chooses where to put one, and a watching player sees someone leave the
 * temple every half-minute or so: often enough to read as "this building does
 * something", rare enough that a temple left alone for an hour has not paved
 * its county.
 */
export const SETTLER_DISPATCH_SECONDS = 25;

/**
 * Closest a homestead may be founded to the temple, in cells.
 *
 * 4 WORLD UNITS — comfortably outside the temple's own two-world-unit
 * footprint (temples' TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS), so a homestead can
 * never be built up against the walls of the building its settlers walked out
 * of, and far enough that the walk reads as going somewhere.
 */
export const SETTLE_MIN_DISTANCE_CELLS = cellsAcross(4);

/**
 * Furthest a homestead may be founded from the temple, in cells.
 *
 * 20 WORLD UNITS — a little over one chunk (16), and deliberately UNDER the
 * wanderers' 48-world-unit stroll range: a settler is founding the temple's
 * OWN county, not emigrating. At walk speed the longest leg is about forty
 * seconds, which fits inside the attention of the player who just built the
 * temple and is watching to see what it does.
 */
export const SETTLE_MAX_DISTANCE_CELLS = cellsAcross(20);

/**
 * How many directions out of the temple are tried when choosing a site, and
 * how many distances along each, from the minimum out to the maximum.
 *
 * 48 × 16 = 768 probes, MEASURED rather than reasoned (the live world,
 * snapshot 468, 2026-08-24). These were 12 × 4 = 48 on the argument that a
 * couple of dozen probes must be enough to find ground when a whole quadrant
 * is not blocked. They were not: the settle range is an annulus 16 to 80 cells
 * out — about nineteen thousand cells — and 48 probes sample a quarter of one
 * percent of it, so with only 7.2% of walkable blocks actually buildable (see
 * scanSettleSites) whole legal valleys fell between the probes. Of 421 land
 * sites on the live world, a temple could dispatch anybody from 25 at 12 × 4,
 * 35 at 24 × 8, and 42 at 48 × 16 — where it SATURATES: 96 × 32 finds not one
 * site more, so 768 probes is where the ground itself, rather than the sample,
 * becomes the limit.
 *
 * The cost at that resolution is 1.5 ms for a scan that finds nothing (the
 * worst case; a scan that succeeds stops early), paid once per dispatch
 * — one every SETTLER_DISPATCH_SECONDS — and once per temple placement press.
 */
export const SETTLE_RING_SAMPLES = 48;

export const SETTLE_DISTANCE_STEPS = 16;

/**
 * How many sites one settler may try before giving up and going home to the
 * temple (which, for a settler, means simply vanishing back into it).
 *
 * 3 — a settler whose site turned out to be unbuildable when it got there has
 * learned something the dispatch could not know (structures owns buildability;
 * this plugin deliberately keeps no copy of that predicate — see
 * `foundStructureAt`), so it is worth walking on. Three attempts bounds the
 * worst case at roughly two minutes of walking; a settler still homeless after
 * that is standing in country that will not have it, and its ONE-per-epoch
 * successor will try somewhere else anyway.
 */
export const SETTLER_SITE_ATTEMPTS = 3;

/**
 * Multiplier that packs the temple's cell into one comparable key. 65536 —
 * the stride every plugin here uses for the same job, and for the same reason:
 * the heightmap's Int16 storage caps a world edge at 32767, so no two cells
 * can collide.
 */
const TEMPLE_KEY_STRIDE = 65536;

/** Edge of the homestead block, in cells. 2 — see this file's header. */
const HOMESTEAD_EDGE_CELLS = 2;

/**
 * The fewest of a homestead's four cells that must go up for the settler to
 * count itself housed. 3 — an L-triomino becomes the block next generation
 * (header); two or fewer die out, so the settler walks on instead.
 */
const HOMESTEAD_MIN_CELLS = 3;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cell a settler's site ring is centred on — the building that sent it
 * out. A temple (`Settling.advance`) or a house (`Settling.emitFrom`); the
 * scan needs nothing else about it.
 */
interface SettleOrigin {
  readonly x: number;
  readonly y: number;
}

/** A candidate homestead: the block's anchor, and the cell a settler walks to. */
interface SettleSite {
  readonly x: number;
  readonly y: number;
  readonly goalX: number;
  readonly goalY: number;
}

/**
 * Where a settler stands the instant it steps outside.
 *
 * The temple sends its own door across the bridge because only it knows how
 * wide it is and what stands on its front face; absent (an older temples
 * build) the cell centre stands in, which is the pre-2026-08-24 behaviour and
 * the reason the field is optional.
 */
function doorOf(temple: BridgedTemple): { x: number; y: number } {
  return { x: temple.doorX ?? temple.x + 0.5, y: temple.doorY ?? temple.y + 0.5 };
}

/**
 * Walks the settle ring in the rolled order and hands each candidate site to
 * `plan`; the first site `plan` accepts wins, and whatever it built comes back
 * with it.
 *
 * WHY THE ROUTE IS PLANNED INSIDE THE SCAN. Choosing a site and finding a way
 * to it used to be two steps, and every one of the three callers spelled out
 * the same sequence: pick, plan, and on `null` give up entirely. So a single
 * unreachable candidate — one homestead site across a river, on the one
 * bearing the roll happened to start at — retired a settler or cost a whole
 * epoch's dispatch, while eleven other bearings sat untried. A site nobody can
 * walk to is not a site; the scan is the right place to say so, and saying it
 * here also deletes the pick-then-plan-then-bail sequence from all three.
 *
 * THE RING IS CENTRED ON AN ORIGIN, not on the temple: a settler walks out of
 * whatever building sent it, and under a growth model where HOUSES send
 * settlers out (structures' STRUCTURES_MODEL=populous, via `emitSettlerFrom`)
 * that building is a house. Nothing else about the choice changes — the same
 * distances, the same bearings, the same two ground tests — so the temple's
 * settlers and a house's settlers cannot pick sites by two different rules.
 *
 * A RING SCAN, not a survey of the county: bearings in a fixed order starting
 * from one the roll picks, and along each bearing the distances from the
 * minimum out to the maximum, nearest first. That is cheap, it is the same
 * shape as pilgrimage.ts's own `pickViewpoint` ring, and starting at a rolled
 * bearing is what stops every settler from a given temple filing out in the
 * same direction.
 *
 * THE GROUND IS TESTED TWICE, AND BOTH TESTS BELONG TO SOMEBODY ELSE: can a
 * walker stand on the whole block (shared's traversal, via isWalkableCell),
 * and would structures take a house on each of its cells (that plugin's own
 * predicate, over the bridge — `canFoundStructureAt`). Neither is copied here.
 *
 * THE SECOND TEST USED NOT TO BE MADE (2026-08-24). The scan tested walkability
 * alone and left buildability to be discovered on arrival, on the reasoning
 * that structures owns that predicate and a copy of it here would drift. That
 * reasoning was right — and asking across the bridge honours it exactly, while
 * keeping a copy would not. Leaving the question unasked was the mistake:
 * walkable means dry ground, buildable means dry ground whose whole footprint
 * sits in one terrace band, and on the live world only 7.2% of walkable 2×2
 * blocks clear the second bar (measured, snapshot 468). A settler choosing on
 * walkability alone therefore missed roughly four times out of five, spent all
 * SETTLER_SITE_ATTEMPTS missing, and vanished — the owner's "they walk off to a
 * corner and just disappear".
 *
 * THE ARRIVAL CHECK AND THE RETRIES STAY, because the answer can change while
 * the settler walks: the ground it was promised can be sculpted away, or
 * another settlement can take the cell first. That is now a rare race rather
 * than the common case, which is exactly what SETTLER_SITE_ATTEMPTS was always
 * meant to pay for.
 */
function scanSettleSites<T>(
  world: PilgrimWorld,
  origin: SettleOrigin,
  roll: number,
  plan: (site: SettleSite) => T | null,
): { site: SettleSite; planned: T } | null {
  const bearingOffset = roll % SETTLE_RING_SAMPLES;
  const span = SETTLE_MAX_DISTANCE_CELLS - SETTLE_MIN_DISTANCE_CELLS;

  for (let s = 0; s < SETTLE_RING_SAMPLES; s++) {
    const bearing = ((bearingOffset + s) % SETTLE_RING_SAMPLES) / SETTLE_RING_SAMPLES;
    const angle = bearing * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let d = 0; d < SETTLE_DISTANCE_STEPS; d++) {
      // Nearest ring first: a settler should build in the temple's own country
      // before it walks to the edge of its range.
      const distance =
        SETTLE_MIN_DISTANCE_CELLS + (span * d) / Math.max(1, SETTLE_DISTANCE_STEPS - 1);
      const anchorX = Math.floor(origin.x + cos * distance);
      const anchorY = Math.floor(origin.y + sin * distance);
      if (!isBlockSettleable(world, anchorX, anchorY)) continue;

      const site: SettleSite = {
        x: anchorX,
        y: anchorY,
        // The goal is the block's CENTRE: the settler walks into the middle of
        // the homestead it is about to raise, not to one of its corners.
        goalX: anchorX + HOMESTEAD_EDGE_CELLS / 2,
        goalY: anchorY + HOMESTEAD_EDGE_CELLS / 2,
      };
      const planned = plan(site);
      if (planned !== null) return { site, planned };
    }
  }
  return null;
}

/**
 * Is every cell of the 2x2 block at this anchor ground a settler can stand on
 * AND ground structures would raise a home on? Both, per cell — a homestead
 * that can only be half built is not a homestead (see this file's header: two
 * cells of the four die out next generation).
 */
function isBlockSettleable(world: PilgrimWorld, anchorX: number, anchorY: number): boolean {
  for (let dy = 0; dy < HOMESTEAD_EDGE_CELLS; dy++) {
    for (let dx = 0; dx < HOMESTEAD_EDGE_CELLS; dx++) {
      const x = anchorX + dx;
      const y = anchorY + dy;
      if (!isWalkableCell(world, x, y)) return false;
      if (!canFoundStructureAt(world, x, y)) return false;
    }
  }
  return true;
}

/**
 * COULD A TEMPLE HERE EVER SEND ANYBODY OUT? The predicate the temples plugin
 * asks before it lets the player put a building down (owner, 2026-08-24:
 * "prevent placing the temple in a location where it cannot spawn a settler").
 *
 * It lives here, with the numbers it is made of. Every term in the answer —
 * how far a settler will walk, how big a homestead is, what ground a walker
 * will cross, what counts as a route — is this plugin's, and a copy of any of
 * them in the temples plugin would be a second opinion waiting to drift from
 * this one. So temples asks across the bridge instead, exactly as this plugin
 * asks temples where its door is.
 *
 * PURE AND SYNCHRONOUS: no settler is created and no state is touched, so the
 * placement path may call it on the press.
 */
export function canDispatchSettler(world: PilgrimWorld, temple: BridgedTemple): boolean {
  const door = doorOf(temple);
  if (!isWalkableCell(world, Math.floor(door.x), Math.floor(door.y))) return false;
  return (
    scanSettleSites(world, temple, 0, (site) =>
      planRoute(world, door.x, door.y, site.goalX, site.goalY),
    ) !== null
  );
}

/** One settler on the road out of the temple. */
interface Settler {
  readonly id: number;
  readonly race: SettlerRace;
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
  /** The homestead's anchor cell — the block runs +1 in x and y from it. */
  siteX: number;
  siteY: number;
  /**
   * The building this settler walked out of, and the centre of the ring every
   * RETRY re-scans (see retryOrRetire). Kept on the settler rather than looked
   * up again because the sender may be a house, which this plugin cannot ask
   * about after the fact.
   */
  readonly origin: SettleOrigin;
  /**
   * Does this settler's existence depend on the temple still standing?
   *
   * TRUE for a temple's own dispatch: a settler whose temple was razed
   * mid-walk retires rather than carrying on founding that temple's county,
   * which is the behaviour this plugin has always had. FALSE for one a HOUSE
   * emitted — its sender is structures' business, not this plugin's, and the
   * temple it never came out of has nothing to say about it.
   */
  readonly boundToTemple: boolean;
  /** Sites tried so far, including the one being walked to. */
  attempts: number;
  stuckSeconds: number;
  /** See pilgrimage.ts's Pilgrim.route — same contract, same fallback. */
  route: RouteCell[] | null;
  routeIndex: number;
}

/**
 * One settler's crowd: everybody else in this sim plus the walkers the caller
 * passed in, never itself. wandering.ts's `crowd`, third copy, kept local for
 * the same four-line reason that one states.
 */
function crowd(
  self: MovingWalker,
  population: readonly MovingWalker[],
  snapshot: readonly Occupant[],
  foreign: readonly Occupant[],
): Occupant[] {
  const rows: Occupant[] = [];
  for (let i = 0; i < population.length; i++) {
    if (population[i] !== self) rows.push(snapshot[i]);
  }
  for (const row of foreign) rows.push(row);
  return rows;
}

/**
 * The whole settler population, advanced one tick. Owns the epoch clock,
 * dispatch, movement, the founding and the give-up rules; the plugin wiring
 * (index.ts) only feeds it and broadcasts what it reports.
 */
export class Settling {
  private readonly settlers = new Map<number, Settler>();
  private readonly ids: WalkerIdAllocator;
  private elapsedSeconds = 0;
  /** The last epoch whose roll was taken, so each epoch dispatches exactly
   *  once regardless of tick rate. −1 = the next advance rolls epoch 0. */
  private rolledEpoch = -1;
  /**
   * The temple this clock is anchored to, as a cell key, or null for none.
   *
   * THE CLOCK BELONGS TO THE TEMPLE, NOT TO THE SERVER (owner, 2026-08-24:
   * "I don't think I've seen any settlers come out of the temple"). It used to
   * run from world create, so the epoch boundaries fell wherever boot happened
   * to put them and a temple built just after one had to stand there for most
   * of a full epoch — up to SETTLER_DISPATCH_SECONDS — before anyone came out
   * of it. Nothing was broken and nothing said so: the building simply looked
   * inert for as long as twenty-five seconds, which is exactly long enough for
   * a player to conclude it does nothing and go and do something else.
   *
   * Anchoring here makes the first settler leave on the tick the temple
   * appears, and makes "raze it and build again" a genuine restart rather than
   * a re-entry into somebody else's schedule.
   */
  private templeKey: number | null = null;

  constructor(ids?: WalkerIdAllocator) {
    this.ids = ids ?? new WalkerIdAllocator();
  }

  /**
   * `world` is BOTH the sim's terrain reader and the world handed on to
   * structures when a homestead goes up (structures holds no world of its own
   * between hooks — see its `foundStructure`). One object, so the ground a
   * settler walked over and the ground its houses are validated against can
   * never be two different worlds.
   */
  advance(
    world: PilgrimWorld,
    temple: BridgedTemple | null,
    dt: number,
    occupants: readonly Occupant[] = [],
  ): void {
    // A NEW TEMPLE RESTARTS THE CLOCK — see `templeKey`. Checked before the
    // clock advances, so the tick that first sees a temple is epoch 0 of that
    // temple's own life and dispatches immediately.
    const key = temple === null ? null : temple.y * TEMPLE_KEY_STRIDE + temple.x;
    if (key !== this.templeKey) {
      this.templeKey = key;
      this.elapsedSeconds = 0;
      this.rolledEpoch = -1;
    }

    this.elapsedSeconds += dt;

    const epoch = Math.floor(this.elapsedSeconds / SETTLER_DISPATCH_SECONDS);
    if (epoch > this.rolledEpoch) {
      this.rolledEpoch = epoch;
      if (temple !== null) this.dispatch(world, temple, epoch);
    }

    // Start-of-tick crowd snapshot — pilgrimage.ts's reasoning verbatim:
    // everyone reacts to the same world, so nobody's path depends on where it
    // sits in the iteration order.
    const own = [...this.settlers.values()];
    const ownCrowd = walkerOccupants(own);

    for (const settler of this.settlers.values()) {
      const progressed = advanceWalker(
        world,
        settler,
        dt,
        crowd(settler, own, ownCrowd, occupants),
      );
      if (progressed) settler.stuckSeconds = 0;
      else settler.stuckSeconds += dt;

      const dx = settler.goalX - settler.x;
      const dy = settler.goalY - settler.y;
      if (dx * dx + dy * dy <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        this.arrive(world, settler, temple, epoch);
        continue;
      }

      // Stuck: the route ran out or the ground closed up. Treat it exactly
      // like an unbuildable site — one attempt spent, walk on or give up —
      // rather than as its own failure mode, because to the settler it is the
      // same fact: this site cannot be reached, so it cannot be built on.
      if (settler.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        this.retryOrRetire(world, settler, temple, epoch);
      }
    }
  }

  /** Arrived: build if the ground will have it, otherwise walk on. */
  private arrive(
    world: PilgrimWorld,
    settler: Settler,
    temple: BridgedTemple | null,
    epoch: number,
  ): void {
    let raised = 0;
    for (let dy = 0; dy < HOMESTEAD_EDGE_CELLS; dy++) {
      for (let dx = 0; dx < HOMESTEAD_EDGE_CELLS; dx++) {
        // The world travels across the bridge with the request — see advance().
        if (foundStructureAt(world, settler.siteX + dx, settler.siteY + dy)) raised++;
      }
    }

    if (raised >= HOMESTEAD_MIN_CELLS) {
      // Housed. The settler IS the household now, so it leaves the road — the
      // same despawn a wanderer makes on reaching home.
      this.settlers.delete(settler.id);
      return;
    }
    this.retryOrRetire(world, settler, temple, epoch);
  }

  /**
   * Sends a settler on to its next candidate site, or retires it once it has
   * spent SETTLER_SITE_ATTEMPTS. Retiring is a plain despawn: a settler is not
   * carrying anything home and there is no blessing to withdraw.
   */
  private retryOrRetire(
    world: PilgrimWorld,
    settler: Settler,
    temple: BridgedTemple | null,
    epoch: number,
  ): void {
    if (settler.attempts >= SETTLER_SITE_ATTEMPTS) {
      this.settlers.delete(settler.id);
      return;
    }
    // See Settler.boundToTemple: only the temple's own people go home when the
    // temple is gone.
    if (settler.boundToTemple && temple === null) {
      this.settlers.delete(settler.id);
      return;
    }

    // The next site is rolled from the settler's OWN id as well as the epoch,
    // so two settlers dispatched in the same epoch that both fail do not both
    // re-target the same cell — and it stays deterministic, because the id
    // sequence is.
    const found = scanSettleSites(
      world,
      settler.origin,
      hashCell(epoch, settler.id + settler.attempts),
      (candidate) => planRoute(world, settler.x, settler.y, candidate.goalX, candidate.goalY),
    );
    if (found === null) {
      this.settlers.delete(settler.id);
      return;
    }
    const { site, planned: route } = found;

    settler.siteX = site.x;
    settler.siteY = site.y;
    settler.goalX = site.goalX;
    settler.goalY = site.goalY;
    settler.attempts++;
    settler.stuckSeconds = 0;
    settler.route = route;
    settler.routeIndex = 0;
  }

  /** One epoch's dispatch: at most one settler leaves the temple. */
  private dispatch(world: PilgrimWorld, temple: BridgedTemple, epoch: number): void {
    if (this.settlers.size >= SETTLERS_CAP) return;

    const roll = hashCell(hashCell(temple.x, temple.y) ^ epoch, epoch);
    // OUT OF THE DOOR, not out of the middle of the building — and NEVER to a
    // trip it cannot walk, the rule both sims beside this one keep. The scan
    // enforces the second while it picks for the first, so a temple sends
    // nobody this epoch only when its whole county is unreachable, not when
    // one rolled bearing was.
    const { x: doorX, y: doorY } = doorOf(temple);
    const found = scanSettleSites(world, temple, roll, (candidate) =>
      planRoute(world, doorX, doorY, candidate.goalX, candidate.goalY),
    );
    if (found === null) return;
    const { site, planned: route } = found;

    const id = this.ids.allocate();
    this.settlers.set(id, {
      id,
      // The temple's district decides the people who come out of it, the same
      // derivation structures uses for every settlement — so a temple's
      // homesteads are its own neighbourhood's folk, not a third race.
      race: settlementRace(temple.x, temple.y),
      x: doorX,
      y: doorY,
      heading: Math.atan2(site.goalY - doorY, site.goalX - doorX),
      goalX: site.goalX,
      goalY: site.goalY,
      siteX: site.x,
      siteY: site.y,
      origin: { x: temple.x, y: temple.y },
      boundToTemple: true,
      attempts: 1,
      stuckSeconds: 0,
      route,
      routeIndex: 0,
    });
  }

  /**
   * SEND ONE SETTLER OUT OF THE BUILDING AT (x, y) — the structures-facing
   * surface (owner brief, 2026-08-25: under STRUCTURES_MODEL=populous a house
   * that fills up emits a settler, who founds the next house).
   *
   * THE SAME SETTLER AS THE TEMPLE'S, deliberately and to the letter: the same
   * population and the same cap (SETTLERS_CAP), the same site scan, the same
   * two ground tests, the same walk, the same founding on arrival, the same
   * retries. Only the ring's centre differs. A second walker population for
   * houses would be a second copy of the walk rule, the model set and the wire
   * — the duplication this file's header exists to refuse.
   *
   * NOT ON THE TEMPLE'S EPOCH CLOCK: this is not a dispatch, it is a request
   * from another plugin that already has its own cadence (structures' growth
   * interval). The temple's own epoch is untouched, so a world with both a
   * temple and populous houses runs the two senders independently.
   *
   * DETERMINISTIC without an rng, like everything else here: the bearing comes
   * from the emitting cell hashed against the settler's own id, and the id
   * sequence is deterministic.
   *
   * Returns whether anyone came out. FALSE IS ORDINARY — the crowd is at its
   * cap, or nowhere in this building's county is both reachable and buildable.
   */
  emitFrom(world: PilgrimWorld, x: number, y: number): boolean {
    if (this.settlers.size >= SETTLERS_CAP) return false;

    const origin: SettleOrigin = { x, y };
    // The centre of the emitting cell, not its corner: a settler steps out
    // into the middle of the ground its house stands on.
    const startX = x + 0.5;
    const startY = y + 0.5;

    const id = this.ids.allocate();
    const found = scanSettleSites(world, origin, hashCell(hashCell(x, y), id), (candidate) =>
      planRoute(world, startX, startY, candidate.goalX, candidate.goalY),
    );
    if (found === null) return false;
    const { site, planned: route } = found;

    this.settlers.set(id, {
      id,
      // The emitting house's own district, the same derivation the temple's
      // settlers use — a house's people are its neighbourhood's folk.
      race: settlementRace(x, y),
      x: startX,
      y: startY,
      heading: Math.atan2(site.goalY - startY, site.goalX - startX),
      goalX: site.goalX,
      goalY: site.goalY,
      siteX: site.x,
      siteY: site.y,
      origin,
      boundToTemple: false,
      attempts: 1,
      stuckSeconds: 0,
      route,
      routeIndex: 0,
    });
    return true;
  }

  /** Wire rows for the broadcast, insertion (spawn) order. */
  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const settler of this.settlers.values()) {
      rows.push({
        id: settler.id,
        kind: 'settler',
        race: settler.race,
        x: settler.x,
        y: settler.y,
        heading: settler.heading,
      });
    }
    return rows;
  }

  populationCount(): number {
    return this.settlers.size;
  }

  /** See Pilgrimage.walkers() — same contract, same caller (index.ts). */
  walkers(): readonly MovingWalker[] {
    return [...this.settlers.values()];
  }

  /**
   * Removes one settler outright — a DEATH, not an arrival.
   *
   * The only caller is fire (index.ts's fuel registration): a settler that
   * burned to death never reaches the cell it was walking to, so it must not go
   * through the arrival path that founds a home there. Returns whether this sim
   * had them; the other two walker sims are asked in turn.
   */
  remove(id: number): boolean {
    return this.settlers.delete(id);
  }

  clear(): void {
    this.settlers.clear();
    this.elapsedSeconds = 0;
    this.rolledEpoch = -1;
    this.templeKey = null;
  }
}
