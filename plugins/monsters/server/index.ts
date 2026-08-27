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
// regulates SINGLETONS against events: one slot per kind (per habitat until
// 2026-08-19), and the interesting code is what is allowed to fill one
// (./summoning.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, ONCE A SECOND.
//
// Every broadcast carries the entire monster list — at most one entry per
// KIND since 2026-08-19 (was per habitat), so three today. The same v1 choice
// wildlife made, with the same three consequences:
//
//   * self-healing — a dropped or reordered message costs one second of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — MAX_LIVING_MONSTERS is 3 (one per kind since
//     2026-08-19; it was 2, one per habitat), so the payload is a constant.
//
// FOG OF WAR (added issue #18, does not change the arithmetic below). "Every
// broadcast carries the entire monster list" is per RECIPIENT, not one shared
// payload: each connected player's own list is the living monsters filtered to
// chunks they have personally unlocked (WorldApi.broadcastVisible). The three
// consequences above are unchanged — in particular "no join handshake" still
// holds, because broadcastVisible re-reads world.players() and each one's own
// mask on every call, so a just-joined or just-crept player is caught up on
// the very next cycle (≤ 1 s) with no extra code.
//
// BANDWIDTH. One entry is five keys — id, kind, x, y, heading — which msgpack
// encodes in roughly 60 B including the key strings and the "cthulhu" value
// (Colyseus re-sends keys on every message; there is no schema here). An empty
// list is ~20 B, and the worst case (Cthulhu AND the kraken AND the yeti,
// possible since the 2026-08-19 per-kind slots) is ~180 B.
//
//   every tick   (10 Hz): 1 800 B/s ≈ 14.4 kbit/s per client
//   every 10th tick (1 Hz):  180 B/s ≈  1.4 kbit/s per client   ← chosen
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
// Positions are rounded to BROADCAST_POSITION_DECIMALS (1/100 cell) on the way out.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff, SculptIntent } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana, reveal, relics and wildlife plugins use.
import type {
  IntentVerdict,
  PersistenceSlice,
  SliceLoadOutcome,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  isMonsterKind,
  type MonsterState,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '../protocol.ts';
import { noteTerrainChangedInIndex, releaseHabitatIndex } from './habitat-index.ts';
import { advanceLurking } from './lurk.ts';
import { MONSTERS_SLICE_VERSION, loadMonsters, saveMonsters } from './persistence.ts';
import { RAISE_BLOCKED_REASON, reachesProtectedGround } from './protection.ts';
import {
  advanceSummoning,
  banish,
  drainMonsterTransitions,
  enforceHabitat,
  invalidateSurvey,
  livingMonsterOfKind,
  livingMonsters,
  resetSummoning,
} from './summoning.ts';

/**
 * Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10. See the
 * cadence analysis in this file's header for why 10 and not 2.
 */
export const BROADCAST_TICK_INTERVAL = 10;

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/**
 * The broadcast payload's list: every living monster at wire precision, in the
 * fixed kind order livingMonsters() iterates.
 */
export function monsterStates(): MonsterState[] {
  return livingMonsters().map((monster) => ({
    id: monster.id,
    kind: monster.kind,
    x: roundBroadcastPosition(monster.x),
    y: roundBroadcastPosition(monster.y),
    heading: roundBroadcastPosition(monster.heading),
    // The variant rides along UNROUNDED and unconditional: it is a name, not a
    // measurement, and it is spread rather than assigned so a kind that has
    // none puts no key on the wire at all (see MonsterState.variant). It never
    // changes over a monster's life, so re-sending it every second is a handful
    // of bytes for the property that a client which joined mid-life needs most
    // — there is no other message that would ever tell it which yeti this is.
    ...(monster.variant === undefined ? {} : { variant: monster.variant }),
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
/**
 * THE CHRONICLE'S EAR (2026-08-19): every arrival and departure summon/banish
 * queued (summoning.ts's pendingTransitions) leaves as a world event in the
 * same call that caused it. Restores never queue, so a rebooted world does
 * not re-announce its standing monsters.
 */
function emitTransitions(world: WorldApi): void {
  for (const transition of drainMonsterTransitions()) {
    world.emitEvent(transition.event, {
      kind: transition.kind,
      x: transition.x,
      y: transition.y,
    });
  }
}

/**
 * THE BOATS PLUGIN'S EYES (2026-08-20, issue #43): where every living monster
 * is, RIGHT NOW, as a server-side world event.
 *
 * The pre-existing `arrived`/`departed` events announce that a monster exists,
 * which is all a chronicle needs; a plugin that FIGHTS one needs to know where
 * it is every tick. Emitted per tick rather than on the broadcast cadence
 * because a fight resolves in whole seconds (plugins/boats/protocol.ts's
 * KRAKEN_ROUT_WOUNDS arithmetic) and a 1 Hz fix would quantise it visibly.
 *
 * SKIPPED ENTIRELY WHEN NOTHING IS ALIVE, which is the common case: a world
 * with no monster in it pays one array-length check per tick, not a fan-out to
 * every installed plugin.
 *
 * NOT A BROADCAST. This is the server-side event bus (WorldApi.emitEvent);
 * nothing here touches the wire, and the fog-of-war filtering that governs
 * what CLIENTS learn is unchanged and still lives in the broadcast below.
 */
function emitPositions(world: WorldApi): void {
  const living = livingMonsters();
  if (living.length === 0) return;
  world.emitEvent('positions', {
    monsters: living.map((monster) => ({
      kind: monster.kind,
      x: monster.x,
      y: monster.y,
    })),
  });
}

function simulate(world: WorldApi, dt: number): void {
  advanceSummoning(world, dt);
  advanceLurking(world, dt);
  enforceHabitat(world);
  emitTransitions(world);
  emitPositions(world);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  // FOG OF WAR (issue #18): each connected player is sent only the monsters
  // standing over chunks THEY have personally unlocked. Never skipEmpty
  // (default false) — this is a FULL-STATE replace message, so the empty
  // list a player with no visible monster gets is itself the signal that
  // whatever they used to see left their view (see WorldApi.broadcastVisible's
  // doc comment; monsters' own header above already documents the "empty
  // list ~20 B" case this reuses unchanged).
  // BOUNDED TO THE MAP HERE, not inside monsterStates(): that function is also
  // the cross-plugin query pilgrims reads through its monsters bridge, and the
  // bridge has no world to bound against (it only ever takes distances from
  // what it is given, so an unbounded hundredth of a cell is nothing to it).
  // The wire is the half that cares: a monster legally standing within half a
  // quantum of the far edge rounds to `worldSize`, which is not a cell, and
  // broadcastVisible turns every position it is handed back into a chunk index
  // and throws on an off-map one (issue #180).
  const onTheMap = monsterStates().map((monster) => ({
    ...monster,
    x: roundBroadcastCell(monster.x, world.worldSize),
    y: roundBroadcastCell(monster.y, world.worldSize),
  }));
  world.broadcastVisible(
    MONSTERS_STATE_MESSAGE,
    onTheMap,
    (monster) => ({ x: monster.x, y: monster.y }),
    (visible) => ({ monsters: visible }),
  );
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
 *   * every habitat's lair survey is invalidated, so it re-derives region sizes
 *     once the terrain settles (LAIR_SURVEY_DEBOUNCE_SECONDS). That is what
 *     turns "I drained the bay" into "it is gone" in half a second rather than
 *     five, and equally what lets a newly dug basin or a newly raised summit
 *     qualify at once (it still has to win the summon roll — arrival is never
 *     instant).
 *
 * AND THE HABITAT BITMAPS ARE REPAIRED HERE (2026-08-26), which is what makes
 * that survey cheap when it does run: the diff's cells are the only ones whose
 * habitat answer can have moved, so habitat-index.ts patches those and the fit
 * window around them instead of re-classifying the board. Done FIRST and
 * unconditionally — the index has to be right whether or not anything else in
 * this function has an opinion about the diff.
 *
 * Note this is called from inside the sculpt that caused it. It only reads
 * heights and writes plugin state — it never calls world.sculpt — so it cannot
 * feed the host's terrain-change cascade guard.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;
  noteTerrainChangedInIndex(diff);
  enforceHabitat(world);
  emitTransitions(world);
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
 * ASKED OF EVERY LIVING MONSTER, not of "the" monster: there is one per KIND
 * now (per habitat before 2026-08-19), and a guard that only consulted the
 * first would be a guard that stopped working the day the list was ordered
 * differently. Only Cthulhu answers yes today, and only one Cthulhu can exist,
 * so at most one of these ever matters — but that is a fact about the table,
 * not a property the loop should assume.
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

/**
 * The version a stored blob SAYS it was written under, or undefined when it
 * says nothing.
 *
 * WHY THIS PLUGIN STILL READS ITS OWN FIELD (see PersistenceSlice.load). The
 * host's `{ v, data }` envelope is authoritative for everything written since
 * it existed — but every byte written BEFORE it carries no envelope and reaches
 * `load` as version 1, and this plugin's own format was already past that.
 * Trusting the host's 1 over this field would run a version-1 migration over a
 * version-3 slice on the first boot after the envelope landed, which is the
 * one way this contract can destroy a world.
 */
function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveMonsters();
  },
  version: MONSTERS_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    // REFUSE, DO NOT ERASE, monsters from a newer build. loadMonsters treats an
    // unknown version as "no monsters and no cooldowns", which the next snapshot
    // would make permanent. v3/v2/v1 are all still read and migrated below.
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > MONSTERS_SLICE_VERSION) {
      return 'refuse';
    }
    loadMonsters(data);
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: MONSTERS_PLUGIN_NAME,

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  /**
   * THE WORLD ARRIVED WHOLESALE, so everything cached about its cells is void.
   *
   * The habitat bitmaps (habitat-index.ts) are a cache of per-cell answers whose
   * ONLY repair path is an applied `CellDiff`. A rollback replaces every height
   * in the world without emitting one — `World.rewindTo` swaps the cell buffer
   * and the unlock masks outright, and the boot pair `restorePersistence()` +
   * `worldCreate()` is replayed afterwards (server/src/world/rollback.ts) — so
   * without this the plugin would survey the world it had BEFORE the rollback,
   * indefinitely: the size is unchanged, so nothing else would ever notice.
   *
   * Dropping it rather than rebuilding here: the next survey builds one from the
   * world as it is by then, which keeps the O(cells) pass on the survey's
   * cadence and off the rollback's critical path.
   */
  onWorldCreate(): void {
    releaseHabitatIndex();
  },

  onIntent(intent: SculptIntent): IntentVerdict | void {
    return guardGround(intent);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  /**
   * THE ONLY WAY ANOTHER PLUGIN CAN REMOVE A MONSTER (issue #43).
   *
   * A fleet that wins says so (`boats:defeated`); this decides what that
   * means, because departure is this plugin's business and nobody else's — it
   * owns the per-kind cooldown, and `banish` is the one exit every cause has
   * always gone through, so a routed kraken gets exactly the ten-minute
   * absence a drained basin would have given it.
   *
   * VALIDATED STRUCTURALLY, like any other event: the emitter may be a
   * different version or absent entirely. An unknown or malformed kind is
   * ignored rather than guessed at — there is no safe default for "which
   * monster did you mean".
   *
   * Transitions are drained in the same call so the departure reaches the
   * chronicle now rather than on the next tick.
   */
  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    if (event !== 'boats:defeated') return;
    if (typeof payload !== 'object' || payload === null) return;
    const { kind } = payload as { kind?: unknown };
    if (typeof kind !== 'string') return;
    if (!isMonsterKind(kind)) return;
    const monster = livingMonsterOfKind(kind);
    if (monster === null) return;
    if (banish(monster)) emitTransitions(world);
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
  tickCount = 0;
  resetSummoning();
}
