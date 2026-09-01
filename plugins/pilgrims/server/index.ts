// pilgrims — server half: the plugin wiring around ./pilgrimage.ts.
//
// Core knows nothing about pilgrims. This half polls the two optional sibling
// plugins through their bridges (monsters: where the beasts are; structures:
// where the towns are, and the route-blessing write-back), advances the
// deterministic simulation, and publishes full state on wildlife's cadence.
// The client half under ../client draws it and holds no authority.
//
// DIFFICULTY: deliberately unread. Pilgrimage is ambience and reward, not
// challenge — a hard world's monsters already settle less often (they are
// summoned against harder bars), so a second dial here would double-count.
//
// PERSISTENCE: deliberately none — wildlife's flock reasoning verbatim: a
// pilgrimage is a journey in progress, re-derived from live monster and
// settlement state within seconds of a restart; restoring one would resume a
// walk nobody was watching. The blessing set re-asserts on the first tick.

import { nearestWithinReach } from '@terrace/shared';
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import {
  PILGRIMS_ENTITIES_MESSAGE,
  PILGRIMS_PLUGIN_NAME,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '../protocol.ts';
import { bridgedMonsters, loadMonstersBridge } from './monsters-bridge.ts';
import { applyBlessedCells, bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { bridgedTemple, loadTemplesBridge } from './temples-bridge.ts';
import { closeFireBridge, loadFireBridge, registerPilgrimsFuel } from './fire-bridge.ts';
import { FIRE_IGNITED_EVENT_NAME, parseIgnitedPositions } from './fire-event.ts';
import {
  FIRE_STARTLE_RADIUS_CELLS,
  Pilgrimage,
  WalkerIdAllocator,
  panicWalkers,
  startleWalkersNear,
  walkerOccupants,
  type PanickingWalker,
} from './pilgrimage.ts';
import { Settling, canDispatchSettler } from './settling.ts';
import { Wandering } from './wandering.ts';

/**
 * Ticks between broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10 —
 * wildlife's cadence, chosen by wildlife's arithmetic: the fastest pilgrim
 * covers 0.1 cells between messages, far under what interpolation smooths.
 */
export const BROADCAST_TICK_INTERVAL = 2;

let tickCount = 0;
// One id sequence across BOTH walker populations — the client keys views by
// bare id (see WalkerIdAllocator's note).
let walkerIds = new WalkerIdAllocator();
let pilgrimage = new Pilgrimage(walkerIds);
let wandering = new Wandering(walkerIds);
let settling = new Settling(walkerIds);

/**
 * The live world, stashed on every tick for `emitSettlerFrom` — which is
 * called from ANOTHER plugin's clock rather than from one of this plugin's own
 * hooks, and so is handed no world of its own. structures keeps its own
 * `fuelWorld` for the identical reason, and this is the same seam: the sim
 * needs a world to plan a route across, and the caller has no way to give it
 * one that would be namespaced to this plugin.
 *
 * Null until the first tick, which makes an emission before the world is
 * running an ordinary "nobody came out" rather than a crash.
 */
let lastWorld: WorldApi | null = null;

/** The last blessed set pushed, for change detection (order-insensitive). */
let lastBlessedKeys: readonly number[] = [];

function sameKeySet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const key of b) if (!set.has(key)) return false;
  return true;
}

function simulate(world: WorldApi, dt: number): void {
  lastWorld = world;
  const settlements = bridgedStructures();

  // EACH SIM STEERS AROUND THE OTHER'S WALKERS (owner, 2026-08-20: "they tend
  // to run into each other"). The two populations share a wire, a client and a
  // pavement, but they are separate objects that cannot see each other's
  // lists — so this, the one place that holds both, is where the crossing
  // introduction is made. Snapshots are taken BEFORE either sim advances, so
  // pilgrims and wanderers react to the same start-of-tick world and neither
  // gets the advantage of moving second.
  const pilgrimCrowd = walkerOccupants(pilgrimage.walkers());
  const wandererCrowd = walkerOccupants(wandering.walkers());
  const settlerCrowd = walkerOccupants(settling.walkers());

  pilgrimage.advance(world, bridgedMonsters(), settlements, dt, [
    ...wandererCrowd,
    ...settlerCrowd,
  ]);
  // The ambient walkers (card 26): same towns, no monsters, no blessing.
  wandering.advance(world, settlements, dt, [...pilgrimCrowd, ...settlerCrowd]);
  // The temple's own people (owner, 2026-08-24): out of its door, into a
  // homestead. `world` travels INTO the sim rather than only being read by it
  // — a founding is validated against this same world on the far side of the
  // structures bridge; see Settling.advance.
  settling.advance(world, bridgedTemple(), dt, [...pilgrimCrowd, ...wandererCrowd]);

  // Push the blessing only when the route set actually changed — structures'
  // replace semantics make re-sends harmless, but a write per tick would be
  // noise in every trace of both plugins.
  const blessed = pilgrimage.blessedCellKeys();
  if (!sameKeySet(blessed, lastBlessedKeys)) {
    applyBlessedCells(blessed);
    lastBlessedKeys = blessed;
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  // FOG OF WAR: full-state replace message, so never skipEmpty — the only way
  // a client learns a pilgrim left its view is the next list omitting it
  // (WorldApi.broadcastVisible's own doc, wildlife's identical call).
  world.broadcastVisible(
    PILGRIMS_ENTITIES_MESSAGE,
    // Every walker kind on the one wire: pilgrims, then wanderers, then
    // settlers — fixed concatenation order, so the payload is deterministic.
    [...pilgrimage.states(), ...wandering.states(), ...settling.states()],
    (walker) => ({ x: Math.floor(walker.x), y: Math.floor(walker.y) }),
    (visible) => ({
      pilgrims: visible.map((p) => ({
        id: p.id,
        kind: p.kind,
        race: p.race,
        // Bounded to the map, not merely rounded: a walker legally standing
        // within half a quantum of the far edge rounds to `worldSize`, which
        // is not a cell (issue #180). `positionOf` above floors the LIVE
        // position and so was never exposed, but the wire is read by consumers
        // that do turn a coordinate back into a cell.
        x: roundBroadcastCell(p.x, world.worldSize),
        y: roundBroadcastCell(p.y, world.worldSize),
        heading: roundBroadcastPosition(p.heading),
      })),
    }),
  );
}

export const plugin: TerracePlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // The bridge pattern, host-mediated: each of these is one synchronous
    // question about who is running as that plugin in THIS world.
    loadMonstersBridge(world);
    loadStructuresBridge(world);
    loadTemplesBridge(world);
    // The same pattern pointing the other way (./fire-bridge.ts): this plugin
    // TELLS fire that its walkers can burn, buffered and replayed by the
    // bridge; the host says whether fire is running here at all.
    loadFireBridge(world);
    registerPilgrimsFuel({
      name: PILGRIMS_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const walker = burnableWalkerAt(x, y);
        if (walker === null) return null;
        return {
          id: walker.id,
          fuel: { burnSeconds: PILGRIMS_BURN_SECONDS, height: PILGRIMS_FUEL_HEIGHT },
          distanceCells: walker.distanceCells,
        };
      },
      positionOf: walkerPosition,
      // What a nearby flame can reach — a walker who strays into a burning
      // wood catches, which is the whole reason to run from one.
      flammable: function* () {
        for (const walker of allWalkers()) {
          yield {
            sourceName: PILGRIMS_PLUGIN_NAME,
            id: walker.id,
            fuel: { burnSeconds: PILGRIMS_BURN_SECONDS, height: PILGRIMS_FUEL_HEIGHT },
            x: walker.x,
            y: walker.y,
            radiusCells: WALKER_BODY_RADIUS_CELLS,
          };
        }
      },
      onBurnedOut: pilgrimsBurnedOut,
      onIgnited: pilgrimsIgnited,
      // DELIBERATELY NOT DECLARED (the default is false). This plugin has no
      // PersistenceSlice by settled design — journeys are re-derived from the
      // world, and WalkerIdAllocator restarts at 1 every process — so walker 7
      // after a restore is a different person from walker 7 before it. Fire
      // therefore drops a restored fire that named one of ours rather than
      // burning a bystander to death (plugins/fire/server/entityFuel.ts's
      // idsSurviveRestore).
    });
  },

  /**
   * EVERY WALKER BELONGS TO ONE WORLD (issue #167). This plugin persists
   * nothing by settled design, so a close is the end of every journey in it:
   * the three sims, the id allocator and the WorldApi this module stashes for
   * the structures-facing `emitSettlerFrom` all go.
   *
   * THE BLESSING IS RELEASED THROUGH THE BRIDGE FIRST, and the order matters:
   * `applyBlessedCells([])` clears this plugin's buffered claim AND pushes the
   * empty set into structures, so the town this world's routes were prospering
   * is not left blessed by a pilgrimage that no longer exists. Structures'
   * own close does the same from its side; this half is what makes the claim
   * disappear even when structures is not the plugin being closed.
   */
  onWorldClose(): void {
    applyBlessedCells([]);
    // The registration fire holds is withdrawn by the bridge that made it
    // (issue #208): a source left standing is asked for fuel every spread
    // step of the NEXT world, whether or not this plugin is in it.
    closeFireBridge();
    resetPilgrimsState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  /**
   * GROUND THAT MOVED CAN OPEN A ROAD THAT WAS SHUT. The pilgrimage sim
   * remembers which towns provably cannot walk to which settled monster, so it
   * stops re-deriving that answer ten times a second (issue #266); this is the
   * only event that can make such an answer wrong, and so it is the whole of
   * the invalidation. Deliberately ignores the diff and the sculptor — see
   * `Pilgrimage.forgetRouteFailures` for why no narrower rule is sound.
   */
  onTerrainChanged(): void {
    pilgrimage.forgetRouteFailures();
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event !== FIRE_IGNITED_EVENT_NAME) return;
    reactToFire(payload);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Fire
//
// A peep burns the way an animal does — it keeps walking while it is alight and
// then falls — so this plugin registers into fire's ENTITY registry
// (plugins/fire/server/entityFuel.ts), not its cell one.
//
// ALL THREE WALKER SIMS AT ONCE, behind one registration. A pilgrim, a wanderer
// and a settler are three different journeys and one kind of thing to a fire;
// they already share one id allocator, so an id identifies a walker uniquely
// across all three and the registry needs to know nothing about which is which.
// ────────────────────────────────────────────────────────────────────────────

/**
 * How long a burning peep lives, in simulated seconds.
 *
 * The same 8 s a grazer gets (wildlife's WILDLIFE_BURN_SECONDS), and
 * deliberately not tuned apart from it: they are the same size, made of the
 * same sort of thing, and a player who has learned how long an animal takes to
 * die has learned this too. Restated rather than imported for the reason every
 * cross-plugin number here is — plugins must build with the others deleted.
 */
export const PILGRIMS_BURN_SECONDS = 8;

/**
 * Flame size for a burning peep, in world units.
 *
 * A peep stands about half a world unit; 0.55 puts the flame at roughly their
 * own height, so it reads as a person alight rather than as a bonfire they
 * happen to be standing in.
 */
export const PILGRIMS_FUEL_HEIGHT = 0.55;

/**
 * How close a walker must be to a cell for that cell's fire to be ON them, in
 * cells. Half a cell — the cell they are standing in, wildlife's rule and its
 * reason: the player torched the cell the peep is drawn on.
 */
const FIRE_CELL_REACH = 0.5;

/** Every walker this plugin has, across all three journeys. */
function allWalkerStates(): Array<{ id: number; x: number; y: number }> {
  return [...pilgrimage.states(), ...wandering.states(), ...settling.states()];
}

/**
 * A WALKER HAS NO BODY WORTH MODELLING, so fire measures its reach to the point
 * they stand on (../../fire/server/entityFuel.ts's FlammableIndividual).
 *
 * NOT `FIRE_CELL_REACH`, which is a different quantity that happens to be a
 * number too: that one is the half-cell BOX a torch click covers, and reusing
 * it here would quietly let a walker catch from half a cell further away than
 * the ground they are standing on does.
 */
const WALKER_BODY_RADIUS_CELLS = 0;

/**
 * Every walker, one at a time, for fire's spread sweep.
 *
 * A GENERATOR rather than `allWalkerStates()` because this is asked while
 * anything in the world is burning, and that function builds three arrays and
 * spreads them into a fourth on every call.
 */
function* allWalkers(): Generator<{ id: number; x: number; y: number }> {
  yield* pilgrimage.states();
  yield* wandering.states();
  yield* settling.states();
}

/**
 * The walker standing on this cell, or null — the NEAREST one, and how far away
 * they are.
 *
 * Nearest rather than first match, and the distance reported rather than
 * discarded, for `nearestWithinReach`'s reason and so that fire can rank a peep
 * standing dead centre on this cell against a boat claiming it from two cells
 * offshore (plugins/fire/server/entityFuel.ts).
 */
function burnableWalkerAt(x: number, y: number): { id: number; distanceCells: number } | null {
  const nearest = nearestWithinReach(allWalkerStates(), x, y, FIRE_CELL_REACH, (walker) => walker);
  return nearest === null
    ? null
    : { id: nearest.item.id, distanceCells: nearest.distanceCells };
}

/** Where this walker is now — null once they are gone. */
function walkerPosition(id: number): { x: number; y: number } | null {
  const walker = allWalkerStates().find((candidate) => candidate.id === id);
  return walker === undefined ? null : { x: walker.x, y: walker.y };
}

/**
 * EVERY WALKER THIS PLUGIN HAS, as the live objects rather than the wire rows —
 * what the two panic paths below mutate.
 *
 * `states()` is deliberately not used for this: it builds COPIES for the
 * broadcast, and a panic written into a copy would be discarded silently. The
 * order is the same fixed one the wire uses (pilgrims, wanderers, settlers), so
 * the work happens in a defined order rather than an incidental one.
 */
function* allWalkerObjects(): Generator<PanickingWalker> {
  yield* pilgrimage.walkers();
  yield* wandering.walkers();
  yield* settling.walkers();
}

/**
 * THE REACTIVE PATH, FIRE (issue #184): something, somewhere, caught — scatter
 * whoever is standing near it.
 *
 * BY NAME, NEVER BY IMPORT (server/src/plugins/types.ts's emitEvent doc, and
 * ./fire-event.ts's header): fire's plugin name is the whole of the coupling,
 * and a world with no fire plugin simply never sees this event.
 *
 * EVERY IGNITION IN THE BATCH IS ITS OWN ALARM rather than one alarm at the
 * batch's centroid. A tick's ignitions are not one thing — a spreading front's
 * far edge, a bolt across the valley, someone alight somewhere else entirely —
 * and their mean can easily be a place where nothing is burning at all. Each is
 * applied in turn, in the order fire listed them, which is fire's own fixed
 * roll order.
 */
function reactToFire(payload: unknown): void {
  const ignited = parseIgnitedPositions(payload);
  if (ignited === null) return;

  for (const at of ignited) {
    startleWalkersNear(allWalkerObjects(), at.x, at.y, FIRE_STARTLE_RADIUS_CELLS);
  }
}

/**
 * These walkers just caught fire — the OWNER'S half of the reaction, and the
 * counterpart of `reactToFire` above.
 *
 * TWO HOOKS, AND BOTH ARE NEEDED, because they answer different questions. The
 * `fire:ignited` world event says something SOMEWHERE caught, which is how a
 * bystander learns to run. This callback says something OF THIS PLUGIN'S
 * caught, which is how the person learns they are alight. Serving the second
 * from the first would mean matching an event position back against this
 * plugin's own walkers and guessing which of them the fire meant — a question
 * fire has already answered, exactly, by calling this.
 *
 * The panic lasts the whole burn (pilgrimage.ts's `panicWalkers`), so a burning
 * peep runs for as long as they are alive instead of calming down a third of
 * the way through their death.
 *
 * AND IT SPREADS THE FIRE, which is the point and not a side effect (owner,
 * 2026-08-26): a panicking peep at three times walking speed sets light to
 * every cell they cross (plugins/fire/server/spread.ts's
 * SELF_AND_NEIGHBOUR_OFFSETS). Nothing here suppresses, slows or shortens it.
 */
function pilgrimsIgnited(ids: readonly number[]): void {
  panicWalkers(allWalkerObjects(), ids, PILGRIMS_BURN_SECONDS);
}

/**
 * These burned to death. Asked of each sim in turn — an id belongs to exactly
 * one of them, and none of them mind being asked about an id that is not
 * theirs.
 */
function pilgrimsBurnedOut(ids: readonly number[]): void {
  for (const id of ids) {
    if (pilgrimage.remove(id)) continue;
    if (wandering.remove(id)) continue;
    settling.remove(id);
  }
}

/**
 * SEND ONE SETTLER OUT OF THE BUILDING AT (x, y) — THE STRUCTURES-FACING
 * SURFACE (owner brief, 2026-08-25). Under structures' populous growth model a
 * house that fills up sends its people out to found the next one, and this is
 * how it asks; that plugin duck-types this off this module through its own
 * dynamic-import bridge, exactly as this plugin reaches structures.
 *
 * ONE WALKER POPULATION, NOT TWO: the settler this creates is the temple's
 * settler in every respect except where its site ring is centred — same cap,
 * same site scan, same walk, same founding, same wire (see Settling.emitFrom).
 *
 * Returns whether anyone came out. FALSE IS ORDINARY: the world has not
 * ticked yet, the settler crowd is at SETTLERS_CAP, or nowhere in that
 * building's county is both reachable and buildable.
 */
export function emitSettlerFrom(x: number, y: number): boolean {
  if (lastWorld === null) return false;
  return settling.emitFrom(lastWorld, x, y);
}

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetPilgrimsState(): void {
  tickCount = 0;
  lastWorld = null;
  walkerIds = new WalkerIdAllocator();
  pilgrimage = new Pilgrimage(walkerIds);
  wandering = new Wandering(walkerIds);
  settling = new Settling(walkerIds);
  lastBlessedKeys = [];
}

/** Test seam: the live population, for suites asserting on the sim's state. */
export function currentPilgrimage(): Pilgrimage {
  return pilgrimage;
}

/** Test seam: the ambient population, same purpose. */
export function currentWandering(): Wandering {
  return wandering;
}

/**
 * COULD A TEMPLE ON THIS GROUND EVER SEND ANYBODY OUT? THE TEMPLES-FACING
 * SURFACE: that plugin duck-types this off this module through the dynamic-
 * import bridge pattern (plugins/relics/server/mana-bridge.ts owns the
 * pattern's four rules) and refuses a placement that would answer no, so a
 * player cannot put down a building that is inert by construction.
 *
 * IT IS THE MIRROR OF THE BRIDGE ALREADY RUNNING THE OTHER WAY — this plugin
 * asks temples where its door is, temples asks this one whether anyone can use
 * it — and it is the right direction for the question, because every term in
 * the answer (how far a settler walks, how big a homestead is, what ground a
 * walker crosses, what counts as a route) is this plugin's. A copy in temples
 * would be a second opinion waiting to drift.
 *
 * A plain read: nothing here is created, and no settler state is touched.
 */
export { canDispatchSettler };

/** Test seam: the temple's settlers, same purpose. */
export function currentSettling(): Settling {
  return settling;
}
