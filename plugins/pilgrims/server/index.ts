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
import { Pilgrimage } from './pilgrimage.ts';

/**
 * Ticks between broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10 —
 * wildlife's cadence, chosen by wildlife's arithmetic: the fastest pilgrim
 * covers 0.1 cells between messages, far under what interpolation smooths.
 */
export const BROADCAST_TICK_INTERVAL = 2;

let tickCount = 0;
let pilgrimage = new Pilgrimage();

/** The last blessed set pushed, for change detection (order-insensitive). */
let lastBlessedKeys: readonly number[] = [];

function sameKeySet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const key of b) if (!set.has(key)) return false;
  return true;
}

function simulate(world: WorldApi, dt: number): void {
  pilgrimage.advance(world, bridgedMonsters(), bridgedStructures(), dt);

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
    pilgrimage.states(),
    (pilgrim) => ({ x: Math.floor(pilgrim.x), y: Math.floor(pilgrim.y) }),
    (visible) => ({
      pilgrims: visible.map((p) => ({
        id: p.id,
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
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetPilgrimsState(): void {
  tickCount = 0;
  pilgrimage = new Pilgrimage();
  lastBlessedKeys = [];
}

/** Test seam: the live population, for suites asserting on the sim's state. */
export function currentPilgrimage(): Pilgrimage {
  return pilgrimage;
}
