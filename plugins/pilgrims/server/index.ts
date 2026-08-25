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

import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import {
  PILGRIMS_ENTITIES_MESSAGE,
  PILGRIMS_PLUGIN_NAME,
  roundBroadcastPosition,
} from '../protocol.ts';
import { bridgedMonsters, loadMonstersBridge } from './monsters-bridge.ts';
import { applyBlessedCells, bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { bridgedTemple, loadTemplesBridge } from './temples-bridge.ts';
import { Pilgrimage, WalkerIdAllocator, walkerOccupants } from './pilgrimage.ts';
import { Settling } from './settling.ts';
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
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

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

/** Test seam: the temple's settlers, same purpose. */
export function currentSettling(): Settling {
  return settling;
}
