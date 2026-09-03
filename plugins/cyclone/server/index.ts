// cyclone — hurricanes, typhoons and cyclones, as a plugin (#213, split out of
// `storms` by #283).
//
// Core knows nothing about cyclones and must not: a rotating hazard that
// flattens what a player built is as gamey as a mechanic gets, and the design
// record's rule ("nothing gamey in core") puts the whole thing here. It reads
// the world through `heightAt` and `worldSize` and writes the ground in two
// places — the storm surge at the shoreline and the wind scour on struck land
// — both behind the one ground-changing setting.
//
// SHAPE OF THE TICK:
//   1. the world rolls one spawn, under the frequency setting;
//   2. every storm moves, ages, and is weakened by the land under it (the kit
//      engine, ./sim.ts);
//   3. landfall and wind damage go out as world events;
//   4. wind scour, if the operator turned ground-changing on, cuts up to
//      WIND_SCOUR_MAX_CELLS_PER_EVENT struck land cells (./wind-scour.ts);
//   5. surge, under the same setting, scours a shoreline cell;
//   6. clients are told, on the cadence, fog-of-war filtered.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACTS TO A CYCLONE, AND WHAT THIS PLUGIN DOES ABOUT IT.
//
// A CYCLONE HAS CONSEQUENCES ON LAND (owner, 2026-09-03; issue #299). Three
// siblings react, and each reached this plugin the way plugins always reach
// each other — this plugin EMITS `cyclone:damage` and `cyclone:landfall`, and a
// consumer subscribes BY NAME and validates the payload structurally, with no
// import in either direction. This plugin does not know their names, cannot
// tell whether any of them is installed, and behaves identically when none is:
//
//   * FLORA fells trees and lays crops flat inside the disc, at a roll per
//     plant per second scaled by severity — plugins/flora/server/
//     cyclone-event.ts holds its bar and its rates. The wood grows back on
//     flora's ordinary survey; the stumps outlive the storm.
//   * STRUCTURES demolishes buildings on the same arithmetic with a higher bar
//     and a much lower rate, divided again by each tier of standing, so a
//     teepee never rides out an eyewall and a watchtower usually does —
//     plugins/structures/server/cyclone-event.ts.
//   * BOATS pushes every hull in the disc along the tangential wind, clamped
//     cell by cell to water it may occupy — plugins/boats/server/
//     cyclone-event.ts. A fleet is scattered, never sunk.
//
// The LAND is this plugin's own consequence rather than a sibling's, because
// terrain is what this plugin already writes: ./wind-scour.ts, from the same
// damage the events carry, and ./surge.ts at the waterline.
//
// STILL UNCLAIMED from issue #213's list: wildlife and fire. Nothing here waits
// on them — the events are the seam, and emitting them costs one fan-out per
// storm per second whether or not anyone is listening.
//
// THIS HALF DEPENDS ON NO SIBLING AT ALL. A cyclone rides its own track rather
// than the sky's shared wind, and it is born over open water rather than under a
// cloud, so unlike the tornado plugin it needs no bridge: a world with no weather
// plugins still gets hurricanes.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, TWICE A SECOND, FOG-OF-WAR FILTERED.
//
// Every broadcast carries the ENTIRE visible storm list rather than a delta,
// with the same three consequences as everywhere else here: it is self-healing
// (a dropped message costs half a second of staleness), it needs no join
// handshake beyond a snapshot send, and its cost is bounded by
// MAX_ACTIVE_CYCLONES rather than by how long the world has been running.
//
// FILTERED, unlike the sky plugins' unfiltered system lists, and the difference
// is information: a cyclone forms over open water, so "there is a cyclone here"
// IS a statement about the ground there. `broadcastVisible` with
// `skipEmpty: false` is therefore the right primitive: a player whose visible
// subset is empty must still be sent the empty list, or the storm they last saw
// would keep spinning on their screen after it walked out of their territory.
//
// CADENCE. 5 Hz. A cyclone is slow enough not to need it, but the client's
// extrapolation window is written against this interval and a storm's death has
// to reach a client promptly whatever its speed; a payload of at most one storm
// of ~110 B makes the choice free.

import type { RotatingStorm } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_DAMAGE_EVENT,
  CYCLONE_FREQUENCIES,
  CYCLONE_FREQUENCY_SETTING_KEY,
  CYCLONE_LANDFALL_EVENT,
  CYCLONE_PLUGIN_NAME,
  CYCLONE_SURGE_MODES,
  CYCLONE_SURGE_SETTING_KEY,
  DEFAULT_CYCLONE_FREQUENCY,
  DEFAULT_CYCLONE_SURGE_MODE,
  FREQUENCY_INTERVAL_MULTIPLIERS,
  parseFrequency,
  parseSurgeMode,
  type CycloneFrequency,
  type CycloneState,
  type CycloneSurgeMode,
} from '../protocol.ts';
import { CYCLONE_SLICE_VERSION, loadCyclones, saveCyclones } from './persistence.ts';
import {
  MAX_ACTIVE_CYCLONES,
  cyclones,
  meanSpawnIntervalSeconds,
  trySpawnCyclone,
} from './sim.ts';
import { forceCycloneNear, forceSpawnFromEnv } from './dev.ts';
import { tickSurge } from './surge.ts';
import { scourStruckGround } from './wind-scour.ts';

/**
 * Ticks between client broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See
 * this file's header.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/** Events this plugin emits. Namespaced `cyclone:` by the host. */
export { CYCLONE_DAMAGE_EVENT, CYCLONE_LANDFALL_EVENT };

/** Re-exported so a test or a future HUD reaches the ceiling through the API. */
export { MAX_ACTIVE_CYCLONES };

let tickCount = 0;

/**
 * A tick that changed the roster has been seen but not yet broadcast. The
 * broadcast runs every BROADCAST_TICK_INTERVAL ticks; the engine only reports
 * `changed` while a storm is alive, so the tick on which the LAST one dies is
 * the last that says so — and if that tick is not a broadcast tick, nothing
 * would ever tell the clients the sky is empty (review 2026-08-28: a spent
 * cyclone spun over the player forever). This flag carries the change across to
 * the next broadcast tick.
 */
let broadcastPending = false;

/**
 * The world's settings, read ONCE in onWorldCreate.
 *
 * WorldApi.setting's own instruction: the value is fixed for the life of a
 * session (changing it persists the row and REOPENS the world, which replays
 * restore + worldCreate), so a plugin that re-read it every tick would be
 * reading a value that cannot move at a cost that can.
 */
let frequency: CycloneFrequency = DEFAULT_CYCLONE_FREQUENCY;
let surgeMode: CycloneSurgeMode = DEFAULT_CYCLONE_SURGE_MODE;

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_CYCLONE_FREQUENCY;
  surgeMode = DEFAULT_CYCLONE_SURGE_MODE;
  cyclones.reset();
  cyclones.freeze(false);
}

/**
 * What this world's frequency setting does to the mean spawn interval.
 *
 * `off` NEVER REACHES ANY CALLER OF THIS — the tick returns before the spawner
 * runs — so it falls to `rare` rather than to a zero, which would be an interval
 * of zero seconds and therefore an infinite spawn rate. A wrong-but-quiet
 * default here would be the one kind of bug this codebase's tick loop cannot
 * survive, so the fallback is the shipped default and not a sentinel.
 */
function intervalMultiplier(): number {
  return frequency === 'common'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.common
    : FREQUENCY_INTERVAL_MULTIPLIERS.rare;
}

/**
 * Rolls this tick's arrival.
 *
 * THE TWO DIALS MULTIPLY HERE and nowhere else: difficulty picks the mean
 * interval (./sim.ts's two anchors and a lerp) and the operator's setting scales
 * it. `off` never reaches this function — the tick returns before it.
 */
function rollSpawn(world: WorldApi, dt: number): void {
  if (cyclones.count() >= MAX_ACTIVE_CYCLONES) return;

  const meanInterval = meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier();
  if (!cyclones.rollSpawn(1 / meanInterval, dt)) return;

  const born = trySpawnCyclone(world);
  if (born === null) return;
  console.info(
    `[${CYCLONE_PLUGIN_NAME}] ${born.name ?? 'a cyclone'} formed at ` +
      `(${Math.round(born.x)}, ${Math.round(born.y)})`,
  );
}

/**
 * Sends the visible storms to one player (a join) or to everyone (the cadence).
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose
 * filtered subset is empty must still be sent the empty list. That is the only
 * way a client learns the storm it could see is gone.
 */
function broadcastCyclones(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    CYCLONE_ALL_MESSAGE,
    cyclones.states(),
    // THE EYE is what gates visibility, not the disc. A cyclone's radius is a
    // quarter of the map, so gating on "any part of it is visible" would tell
    // every player in the world about every cyclone — the fog-of-war leak this
    // filter exists to prevent. Gating on the eye means a player is told about
    // the storm whose centre is over ground they have unlocked, which is also
    // the storm that is actually about to hit them. An eye still out at sea
    // beyond the map is visible to nobody, and core filters it out (#291)
    // rather than this clamping it to the edge.
    (storm: CycloneState) => ({ x: Math.round(storm.x), y: Math.round(storm.y) }),
    (visible) => ({ storms: visible }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollSpawn(world, dt);

  const tick = cyclones.advance(world, dt);

  for (const event of tick.landfalls) world.emitEvent(CYCLONE_LANDFALL_EVENT, event);
  for (const event of tick.damage) world.emitEvent(CYCLONE_DAMAGE_EVENT, event);

  // THE LAND ITSELF (issue #299), after the event has gone out, so a consumer
  // reacting to the wind sees the ground the wind found rather than the ground
  // this left. Gated on the SAME setting as the surge and not on a sibling of
  // its own: see ./wind-scour.ts for what it does, and ../protocol.ts's
  // CYCLONE_SURGE_SETTING_KEY for why one switch covers both.
  if (surgeMode === 'on') {
    for (const event of tick.damage) scourStruckGround(world, event);
  }

  // SURGE, after the storms have moved, so a cyclone scours the shore it is over
  // now rather than the one it was over a tick ago. Gated on the setting here
  // rather than inside ./surge.ts, so the whole cost — including the per-storm
  // loop — is skipped on a world that turned it off.
  if (surgeMode === 'on') {
    for (const storm of cyclones.storms()) {
      tickSurge(world, storm, storm.peakIntensity * storm.envelope, dt, cyclones.random);
    }
  }

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastCyclones(world);
  }
}

const persistence: PersistenceSlice = {
  version: CYCLONE_SLICE_VERSION,
  save(): unknown {
    return saveCyclones();
  },
  load(data: unknown): void {
    loadCyclones(data);
  },
};

export const plugin: TerracePlugin = {
  name: CYCLONE_PLUGIN_NAME,

  settings: [
    {
      key: CYCLONE_FREQUENCY_SETTING_KEY,
      values: CYCLONE_FREQUENCIES,
      defaultValue: DEFAULT_CYCLONE_FREQUENCY,
    },
    {
      key: CYCLONE_SURGE_SETTING_KEY,
      values: CYCLONE_SURGE_MODES,
      defaultValue: DEFAULT_CYCLONE_SURGE_MODE,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    // The snapshot has already been restored by the time this runs — the host
    // calls the slice's `load` BEFORE this hook — so the storms themselves are
    // deliberately NOT touched here: resetting would discard a restored cyclone.
    // Only the SESSION-SCOPED state is reset: the tick counter and the settings.
    tickCount = 0;
    // The freeze belongs to the world that set it, so it is cleared here and
    // re-set below only if THIS world was forced.
    cyclones.freeze(false);

    frequency = parseFrequency(world.setting(CYCLONE_FREQUENCY_SETTING_KEY));
    surgeMode = parseSurgeMode(world.setting(CYCLONE_SURGE_SETTING_KEY));

    if (frequency === 'off') return;

    // THE DEV FORCE-SPAWN (./dev.ts) — a no-op unless CYCLONE_DEV_FORCE is set,
    // which it is in no real deployment. It runs AFTER the restore, and clears
    // the sky itself, so a world booted with it twice still holds exactly one.
    forceSpawnFromEnv(world, process.env);

    console.info(
      `[${CYCLONE_PLUGIN_NAME}] frequency: ${frequency}, surge: ${surgeMode}, ` +
        `difficulty ${world.difficulty} → one every ~${Math.round(
          meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier(),
        )}s`,
    );
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, so there is nothing to
    // release — but its sim state belongs to the world that is closing, and
    // leaving it standing would hand the next world this one's hurricanes.
    resetSessionState();
  },

  // THE ADMIN PANEL'S DEBUG SPAWN (server plugins/types.ts,
  // PluginActionDeclaration): the same birth the spawn roll uses, on the water
  // ./dev.ts's search picks near the operator's view.
  actions: [
    {
      key: 'cyclone',
      label: 'Spawn a cyclone',
      description:
        'A cyclone over the nearest open water to where you are looking, at full strength.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== 'cyclone') return { ok: false, detail: `no such action "${key}"` };
    // `off` stops the sim as well as the spawner (onTick), so a storm born now
    // would hang in the sky unmoving — refused rather than left there.
    if (frequency === 'off') {
      return { ok: false, detail: 'cyclones are off for this world — set the frequency first' };
    }
    if (cyclones.count() >= MAX_ACTIVE_CYCLONES) {
      return {
        ok: false,
        detail: `${MAX_ACTIVE_CYCLONES} cyclone${MAX_ACTIVE_CYCLONES === 1 ? ' is' : 's are'} already in the air`,
      };
    }
    const { storm, detail } = forceCycloneNear(world, site);
    if (storm === null) return { ok: false, detail };
    // Clients are told now rather than on the next broadcast tick.
    broadcastPending = false;
    broadcastCyclones(world);
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    // `off` stops the SPAWNER AND THE SIM, which is stronger than it needs to be
    // and deliberately so: a world switched to `off` mid-session reopens
    // (WorldApi.setting), so any storm still in the air is restored from the
    // slice and would otherwise spin in place forever with nothing to age it.
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // A joining client is caught up within 200 ms by the next broadcast anyway;
    // this exists so the sky is right on the FIRST frame they render rather than
    // a beat later — the difference between "there was already a hurricane here"
    // and "a hurricane appeared as I arrived".
    if (frequency === 'off') return;
    broadcastCyclones(world, player.id);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetCycloneState(): void {
  resetSessionState();
}

/**
 * THE LIVE STORMS, re-exported for other plugins (the entry point IS this
 * plugin's compatibility surface).
 *
 * A sibling that wants to ask "is this cell in a gale?" — fire, most obviously,
 * whose spread already reads the weather hub's wind — can duck-type this member
 * rather than reaching into ./sim.ts and coupling to a file layout. Nothing does
 * yet; the `cyclone:damage` event is the push half of the same seam.
 */
export function livingCyclones(): readonly RotatingStorm[] {
  return cyclones.storms();
}
