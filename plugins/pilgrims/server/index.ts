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
  roundBroadcastPosition,
} from '../protocol.ts';
import { bridgedMonsters, loadMonstersBridge } from './monsters-bridge.ts';
import { applyBlessedCells, bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { bridgedTemple, loadTemplesBridge } from './temples-bridge.ts';
import { loadFireBridge, registerPilgrimsFuel } from './fire-bridge.ts';
import { Pilgrimage, WalkerIdAllocator, walkerOccupants } from './pilgrimage.ts';
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

/** The last blessed set pushed, for change detection (order-insensitive). */
let lastBlessedKeys: readonly number[] = [];

function sameKeySet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const key of b) if (!set.has(key)) return false;
  return true;
}

function simulate(world: WorldApi, dt: number): void {
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
        x: roundBroadcastPosition(p.x),
        y: roundBroadcastPosition(p.y),
        heading: roundBroadcastPosition(p.heading),
      })),
    }),
  );
}

export const plugin: TerracePlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  onWorldCreate(): void {
    // Rule 2 of the bridge pattern: kick the loads off, do not await them.
    void loadMonstersBridge();
    void loadStructuresBridge();
    void loadTemplesBridge();
    // The same pattern pointing the other way (./fire-bridge.ts): this plugin
    // TELLS fire that its walkers can burn, buffered and replayed if fire has
    // not resolved yet.
    loadFireBridge();
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
      onBurnedOut: pilgrimsBurnedOut,
      // DELIBERATELY NOT DECLARED (the default is false). This plugin has no
      // PersistenceSlice by settled design — journeys are re-derived from the
      // world, and WalkerIdAllocator restarts at 1 every process — so walker 7
      // after a restore is a different person from walker 7 before it. Fire
      // therefore drops a restored fire that named one of ours rather than
      // burning a bystander to death (plugins/fire/server/entityFuel.ts's
      // idsSurviveRestore).
    });
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
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

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetPilgrimsState(): void {
  tickCount = 0;
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
