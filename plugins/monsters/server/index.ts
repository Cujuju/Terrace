// monsters — the thing in the water and the thing on the mountain, as a plugin.
//
// Core knows nothing about monsters. This half owns the whole sim (the habitat
// survey, the per-habitat singleton lifecycle, the stochastic arrival, lurking,
// and persistence), publishes it on one namespaced message, and VETOES the
// sculpts a monster will not permit (./protection.ts); the client half under
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
// Every broadcast carries the entire monster list — at most one entry per
// habitat, so two today. The same v1 choice wildlife made, with the same three
// consequences:
//
//   * self-healing — a dropped or reordered message costs one second of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — MAX_LIVING_MONSTERS is 2, so the payload is a constant.
//
// BANDWIDTH. One entry is five keys — id, kind, x, y, heading — which msgpack
// encodes in roughly 60 B including the key strings and the "cthulhu" value
// (Colyseus re-sends keys on every message; there is no schema here). An empty
// list is ~20 B, and the worst case (a sea monster AND a yeti) is ~120 B.
//
//   every tick   (10 Hz): 1 200 B/s ≈ 9.6 kbit/s per client
//   every 10th tick (1 Hz):  120 B/s ≈ 1.0 kbit/s per client   ← chosen
//
// Both are rounding error next to wildlife's ~210 kbit/s, so bandwidth is NOT
// what picks the cadence here — motion is, and it points the same way:
//
//   * wildlife chose 5 Hz because its fastest species covers 0.6 cells between
//     updates. Cthulhu lurks at 0.25 cells/s (./kinds.ts), so a ONE-SECOND
//     window is 0.25 cells — less than half wildlife's per-window travel, and
//     1/28th of the monster's own 7-cell width. The fastest kind in the table
//     is the kraken at 0.6 cells/s (the yeti ambles at 0.45), which is exactly
//     wildlife's per-window figure at a fifth of its cadence. Interpolation (client/
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

import type { CellDiff, SculptIntent } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana, reveal, relics and wildlife plugins use.
import type {
  IntentVerdict,
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
import { RAISE_BLOCKED_REASON, reachesProtectedGround } from './protection.ts';
import {
  advanceSummoning,
  enforceHabitat,
  invalidateSurvey,
  livingMonsters,
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

/**
 * The broadcast payload's list: every living monster at wire precision, in the
 * fixed habitat order livingMonsters() iterates.
 */
export function monsterStates(): MonsterState[] {
  return livingMonsters().map((monster) => ({
    id: monster.id,
    kind: monster.kind,
    x: roundBroadcastPosition(monster.x),
    y: roundBroadcastPosition(monster.y),
    heading: roundBroadcastPosition(monster.heading),
  }));
}

/**
 * THE SIM STEP — CRITICAL PATH.
 *
 * Fixed order, once per host tick:
 *   1. summoning — clock, cooldowns, the periodic per-habitat lair survey with
 *      its collapse test, and the arrival rolls. Nothing else may create or
 *      destroy a monster;
 *   2. lurking — the slow wander, which steers around anything that is not
 *      unlocked ground of the monster's own habitat;
 *   3. habitat check — a monster standing somewhere invalid is banished. Step 2
 *      vetoes bad steps, so in practice this catches the case where the TERRAIN
 *      moved out from under it. It runs anyway, unconditionally: it is two
 *      lookups per monster, and it is the invariant "a monster is always inside
 *      its habitat" made true by construction rather than by trusting step 2;
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
 *   * if the edit moved the ground out from under a monster — raised the seabed
 *     under the kraken, took the snow off the peak under the yeti — it leaves
 *     immediately;
 *   * every habitat's lair survey is invalidated, so the next tick re-derives
 *     region sizes. That is what turns "I drained the bay" into "it is gone"
 *     within a tick, and equally what lets a newly dug basin or a newly raised
 *     summit qualify at once (it still has to win the summon roll — arrival is
 *     never instant).
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

/**
 * THE INTENT VETO. Runs inside the host's interceptor chain, after core has
 * established that the intent is structurally valid and aimed at an unlocked
 * chunk (server/src/intent/pipeline.ts steps 1–2).
 *
 * One question, asked of each living monster: does this RAISE reach ground it
 * protects (./protection.ts)? Nothing else here inspects intents, and a world
 * with no monster in it — or one holding only kinds that do not protect their
 * ground — pays one empty loop per sculpt.
 *
 * ASKED OF EVERY LIVING MONSTER, not of "the" monster: there is one per habitat
 * now, and a guard that only consulted the first would be a guard that stopped
 * working the day the list was ordered differently. Only Cthulhu answers yes
 * today, and only one Cthulhu can exist, so at most one of these ever matters —
 * but that is a fact about the table, not a property the loop should assume.
 *
 * `deny` and never `modify`: a raise the monster refuses is not a smaller raise
 * somewhere else, and rewriting a player's aim would be a stranger thing to do
 * to them than refusing it.
 */
function guardGround(intent: SculptIntent): IntentVerdict | void {
  for (const monster of livingMonsters()) {
    if (!reachesProtectedGround(intent, monster)) continue;
    return { kind: 'deny', reason: RAISE_BLOCKED_REASON };
  }
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

  onIntent(intent: SculptIntent): IntentVerdict | void {
    return guardGround(intent);
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
