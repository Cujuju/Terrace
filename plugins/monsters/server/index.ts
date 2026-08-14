// monsters — the thing in the water, as a plugin.
//
// Core knows nothing about monsters. This half owns the whole sim (deep-water
// survey, the singleton lifecycle, the stochastic arrival, lurking, and
// persistence) and publishes it on one namespaced message; the client half under
// ../client draws it.
//
// It is the wildlife plugin's structure applied to the opposite problem. Where
// wildlife regulates a POPULATION against a habitat-derived target, this
// regulates a SINGLETON against an event: there is one slot, and the interesting
// code is what is allowed to fill it (./summoning.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, ONCE A SECOND.
//
// Every broadcast carries the entire monster list — which is zero or one entry.
// The same v1 choice wildlife made, with the same three consequences:
//
//   * self-healing — a dropped or reordered message costs one second of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — MAX_LIVING_MONSTERS is 1, so the payload is a constant.
//
// BANDWIDTH. The payload is five keys — id, kind, x, y, heading — which msgpack
// encodes in roughly 60 B including the key strings and the "cthulhu" value
// (Colyseus re-sends keys on every message; there is no schema here). An empty
// list is ~20 B.
//
//   every tick   (10 Hz): 600 B/s ≈ 4.8 kbit/s per client
//   every 10th tick (1 Hz):  60 B/s ≈ 0.5 kbit/s per client   ← chosen
//
// Both are rounding error next to wildlife's ~210 kbit/s, so bandwidth is NOT
// what picks the cadence here — motion is, and it points the same way:
//
//   * wildlife chose 5 Hz because its fastest species covers 0.6 cells between
//     updates. Cthulhu lurks at 0.25 cells/s (./kinds.ts), so a ONE-SECOND
//     window is 0.25 cells — less than half wildlife's per-window travel, and
//     1/28th of the monster's own 7-cell width. Interpolation (client/
//     interpolation.ts) renders that as a continuous glide; a player cannot tell
//     it from 10 Hz, so the other 4.3 kbit/s buys literally nothing.
//   * 1 Hz is also the FLOOR, not just the choice. The client interpolates
//     across the measured message gap and clamps that window (MAX_INTERPOLATION_
//     SECONDS = 2 s, sized to ride out one dropped message at this cadence).
//     Halving to 0.5 Hz would put the nominal window at the clamp with no
//     headroom for jitter, and the monster would start snapping.
//
// Positions are rounded to MONSTER_POSITION_DECIMALS (1/100 cell) on the way out.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana, reveal, relics and wildlife plugins use.
import type {
  PersistenceSlice,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  type MonsterState,
  roundBroadcastPosition,
} from '../protocol.ts';
import { advanceLurking } from './lurk.ts';
import { loadMonsters, saveMonsters } from './persistence.ts';
import {
  advanceSummoning,
  enforceHabitat,
  invalidateSurvey,
  livingMonster,
  resetSummoning,
} from './summoning.ts';

/**
 * Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10. See the
 * cadence analysis in this file's header for why 10 and not 2.
 */
export const BROADCAST_TICK_INTERVAL = 10;

/**
 * The WorldApi, captured at onWorldCreate. onTerrainChanged is not handed one
 * (see the same note in the reveal and wildlife plugins), and the reactive path
 * needs to re-check habitat validity, so it must be stashed.
 */
let api: WorldApi | null = null;

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/** The broadcast payload's list: zero or one monster at wire precision. */
export function monsterStates(): MonsterState[] {
  const monster = livingMonster();
  if (monster === null) return [];
  return [
    {
      id: monster.id,
      kind: monster.kind,
      x: roundBroadcastPosition(monster.x),
      y: roundBroadcastPosition(monster.y),
      heading: roundBroadcastPosition(monster.heading),
    },
  ];
}

/**
 * THE SIM STEP — CRITICAL PATH.
 *
 * Fixed order, once per host tick:
 *   1. summoning — clock, cooldown, the periodic lair survey with its collapse
 *      test, and the arrival roll. Nothing else may create or destroy a monster;
 *   2. lurking — the slow wander, which steers around anything that is not deep
 *      unlocked water;
 *   3. habitat check — a monster standing somewhere invalid is banished. Step 2
 *      vetoes bad steps, so in practice this catches the case where the TERRAIN
 *      moved out from under it. It runs anyway, unconditionally: it is two
 *      lookups, and it is the invariant "the monster is always in deep water"
 *      made true by construction rather than by trusting step 2;
 *   4. broadcast, on the cadence.
 *
 * Steps 1–3 are all driven by `dt`; nothing here reads a wall clock.
 */
function simulate(world: WorldApi, dt: number): void {
  advanceSummoning(world, dt);
  advanceLurking(world, dt);
  enforceHabitat(world);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(MONSTERS_STATE_MESSAGE, { monsters: monsterStates() });
}

/**
 * THE REACTIVE PATH.
 *
 * Fired after any applied edit with the FULL server-side diff. Two effects, both
 * about not making a player wait out the survey interval to see the consequence
 * of their own sculpt:
 *
 *   * if the edit raised the ground out from under the monster, it submerges
 *     immediately;
 *   * the lair survey is invalidated, so the next tick re-derives region sizes.
 *     That is what turns "I drained the bay" into "it is gone" within a tick,
 *     and equally what lets a newly dug basin qualify at once (it still has to
 *     win the summon roll — arrival is never instant).
 *
 * Note this is called from inside the sculpt that caused it. It only reads
 * heights and writes plugin state — it never calls world.sculpt — so it cannot
 * feed the host's terrain-change cascade guard.
 */
function reactToTerrain(diff: readonly CellDiff[]): void {
  if (api === null || diff.length === 0) return;
  enforceHabitat(api);
  invalidateSurvey();
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveMonsters();
  },
  load(data: unknown): void {
    loadMonsters(data);
  },
};

export const plugin: TerracePlugin = {
  name: MONSTERS_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    api = world;
    // Any snapshot has already been restored by the time this runs, so the slot
    // here holds either nothing (fresh world) or the persisted monster.
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(diff: readonly CellDiff[]): void {
    reactToTerrain(diff);
  },

  persistence,
};

/**
 * Test seam: drops all accumulated state so a suite can start from zero.
 *
 * Deliberately does NOT restore the random source (./rng.ts): a suite installs a
 * seeded generator once and resets sim state many times, and a reset that
 * silently re-armed Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export function resetMonstersState(): void {
  api = null;
  tickCount = 0;
  resetSummoning();
}
