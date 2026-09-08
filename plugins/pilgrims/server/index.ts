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

export const BROADCAST_TICK_INTERVAL = 2;

let tickCount = 0;
let walkerIds = new WalkerIdAllocator();
let pilgrimage = new Pilgrimage(walkerIds);
let wandering = new Wandering(walkerIds);
let settling = new Settling(walkerIds);

let lastWorld: WorldApi | null = null;

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

  const pilgrimCrowd = walkerOccupants(pilgrimage.walkers());
  const wandererCrowd = walkerOccupants(wandering.walkers());
  const settlerCrowd = walkerOccupants(settling.walkers());

  pilgrimage.advance(world, bridgedMonsters(), settlements, dt, [
    ...wandererCrowd,
    ...settlerCrowd,
  ]);
  wandering.advance(world, settlements, dt, [...pilgrimCrowd, ...settlerCrowd]);
  settling.advance(world, bridgedTemple(), dt, [...pilgrimCrowd, ...wandererCrowd]);

  const blessed = pilgrimage.blessedCellKeys();
  if (!sameKeySet(blessed, lastBlessedKeys)) {
    applyBlessedCells(blessed);
    lastBlessedKeys = blessed;
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  world.broadcastVisible(
    PILGRIMS_ENTITIES_MESSAGE,
    [...pilgrimage.states(), ...wandering.states(), ...settling.states()],
    (walker) => ({ x: Math.floor(walker.x), y: Math.floor(walker.y) }),
    (visible) => ({
      pilgrims: visible.map((p) => ({
        ...p,
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
    loadMonstersBridge(world);
    loadStructuresBridge(world);
    loadTemplesBridge(world);
    loadFireBridge(world);
    registerPilgrimsFuel({
      name: PILGRIMS_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const walker = burnableWalkerAt(x, y);
        if (walker === null) return null;
        return {
          id: walker.id,
          fuel: { burnSeconds: PILGRIMS_BURN_SECONDS },
          distanceCells: walker.distanceCells,
        };
      },
      positionOf: walkerPosition,
      flammable: function* () {
        for (const walker of allWalkers()) {
          yield {
            sourceName: PILGRIMS_PLUGIN_NAME,
            id: walker.id,
            fuel: { burnSeconds: PILGRIMS_BURN_SECONDS },
            x: walker.x,
            y: walker.y,
            radiusCells: WALKER_BODY_RADIUS_CELLS,
          };
        }
      },
      onBurnedOut: pilgrimsBurnedOut,
      onIgnited: pilgrimsIgnited,
    });
  },

  onWorldClose(): void {
    applyBlessedCells([]);
    closeFireBridge();
    resetPilgrimsState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(): void {
    pilgrimage.forgetRouteFailures();
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event !== FIRE_IGNITED_EVENT_NAME) return;
    reactToFire(payload);
  },
};

export const PILGRIMS_BURN_SECONDS = 8;

const FIRE_CELL_REACH = 0.5;

function allWalkerStates(): Array<{ id: number; x: number; y: number }> {
  return [...pilgrimage.states(), ...wandering.states(), ...settling.states()];
}

const WALKER_BODY_RADIUS_CELLS = 0;

function* allWalkers(): Generator<{ id: number; x: number; y: number }> {
  yield* pilgrimage.states();
  yield* wandering.states();
  yield* settling.states();
}

function burnableWalkerAt(x: number, y: number): { id: number; distanceCells: number } | null {
  const nearest = nearestWithinReach(allWalkerStates(), x, y, FIRE_CELL_REACH, (walker) => walker);
  return nearest === null
    ? null
    : { id: nearest.item.id, distanceCells: nearest.distanceCells };
}

function walkerPosition(id: number): { x: number; y: number } | null {
  const walker = allWalkerStates().find((candidate) => candidate.id === id);
  return walker === undefined ? null : { x: walker.x, y: walker.y };
}

function* allWalkerObjects(): Generator<PanickingWalker> {
  yield* pilgrimage.walkers();
  yield* wandering.walkers();
  yield* settling.walkers();
}

function reactToFire(payload: unknown): void {
  const ignited = parseIgnitedPositions(payload);
  if (ignited === null) return;

  for (const at of ignited) {
    startleWalkersNear(allWalkerObjects(), at.x, at.y, FIRE_STARTLE_RADIUS_CELLS);
  }
}

function pilgrimsIgnited(ids: readonly number[]): void {
  panicWalkers(allWalkerObjects(), ids, PILGRIMS_BURN_SECONDS);
}

function pilgrimsBurnedOut(ids: readonly number[]): void {
  for (const id of ids) {
    if (pilgrimage.remove(id)) continue;
    if (wandering.remove(id)) continue;
    settling.remove(id);
  }
}

export function emitSettlerFrom(x: number, y: number): boolean {
  if (lastWorld === null) return false;
  return settling.emitFrom(lastWorld, x, y);
}

export function resetPilgrimsState(): void {
  tickCount = 0;
  lastWorld = null;
  walkerIds = new WalkerIdAllocator();
  pilgrimage = new Pilgrimage(walkerIds);
  wandering = new Wandering(walkerIds);
  settling = new Settling(walkerIds);
  lastBlessedKeys = [];
}

export function currentPilgrimage(): Pilgrimage {
  return pilgrimage;
}

export function currentWandering(): Wandering {
  return wandering;
}

export { canDispatchSettler };

export function currentSettling(): Settling {
  return settling;
}
