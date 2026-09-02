// storms — tornadoes, hurricanes, typhoons and cyclones, as a plugin (#213).
//
// Core knows nothing about storms and must not: a rotating hazard that flattens
// what a player built is as gamey as a mechanic gets, and the design record's
// rule ("nothing gamey in core — mana, followers, reveal timing are plugins")
// puts the whole thing here. It reads the world through `heightAt` and
// `worldSize`, talks to weather through the host's sibling lookup, and writes
// the ground in exactly one place — the storm surge, behind a setting that
// ships off.
//
// SHAPE OF THE TICK:
//   1. the world rolls its spawns, one per kind, under the frequency setting;
//   2. every storm moves, ages, and is weakened by the terrain under it
//      (./storms.ts);
//   3. landfall and wind damage go out as world events;
//   4. surge, if the operator turned it on, scours a shoreline cell;
//   5. clients are told, on the cadence, fog-of-war filtered.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACTS TO A STORM, AND WHAT THIS PLUGIN DOES ABOUT IT.
//
// Nothing, yet, and deliberately. Issue #213 lists structures, flora, boats,
// wildlife and fire as the consumers of wind damage; every one of them is
// reached the way plugins always reach each other — this plugin EMITS
// `storms:damage` and `storms:landfall`, and a consumer subscribes BY NAME and
// validates the payload structurally, with no import in either direction. No
// consumer exists today; the events are the seam those follow-ups attach to,
// and emitting them costs one fan-out per storm per second.
//
// The one plugin this half depends on is WEATHER, and only to be told where the
// storm cells are (./weather-bridge.ts). No weather, no tornadoes — cyclones
// are unaffected.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, TWICE A SECOND, FOG-OF-WAR FILTERED.
//
// Every broadcast carries the ENTIRE visible storm list rather than a delta —
// wildlife's and weather's choice, with the same three consequences: it is
// self-healing (a dropped message costs half a second of staleness), it needs
// no join handshake beyond a snapshot send, and its cost is bounded by
// MAX_ACTIVE_STORMS rather than by how long the world has been running.
//
// FILTERED, unlike weather's unfiltered system list, and the difference is
// information: a weather front's position is a function of RNG and the shared
// wind alone, so it says nothing about terrain nobody has unlocked. A storm's
// is not — a cyclone forms over open water and a tornado only ever touches
// down on land, so "there is a cyclone here" IS a statement about the ground
// there. `broadcastVisible` with `skipEmpty: false` is therefore the right
// primitive: a player whose visible subset is empty must still be sent the
// empty list, or the storm they last saw would keep spinning on their screen
// after it walked out of their territory.
//
// CADENCE. 5 Hz, twice weather's, and the reason is motion. A tornado covers 10
// cells a second; at 1 Hz that is 10 cells between messages against a 6-cell
// radius — the funnel would teleport more than its own width every push, which
// no interpolation can hide. At 5 Hz it moves a third of its radius, which the
// client's own interpolation smooths out. The payload is at most three storms
// of ~110 B, so 5 Hz is ~1.7 kbit/s per client: half of one percent of what
// wildlife already spends.

import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  DEFAULT_STORM_FREQUENCY,
  DEFAULT_STORM_SURGE_MODE,
  STORMS_ALL_MESSAGE,
  STORMS_DAMAGE_EVENT,
  STORMS_FREQUENCY_SETTING_KEY,
  STORMS_LANDFALL_EVENT,
  STORMS_PLUGIN_NAME,
  STORMS_SURGE_SETTING_KEY,
  STORM_FREQUENCIES,
  STORM_SURGE_MODES,
  parseFrequency,
  parseSurgeMode,
  type StormFrequency,
  type StormKind,
  type StormState,
  type StormSurgeMode,
} from '../protocol.ts';
import { loadStorms, saveStorms, STORMS_SLICE_VERSION } from './persistence.ts';
import {
  FREQUENCY_INTERVAL_MULTIPLIERS,
  MAX_ACTIVE_STORMS,
  advanceStorms,
  livingStorms,
  meanSpawnIntervalSeconds,
  profileFor,
  resetStorms,
  setDevFrozen,
  spawnRoll,
  stormCount,
  stormRandom,
  stormStates,
  trySpawnCyclone,
  trySpawnTornado,
} from './storms.ts';
import { forceSpawnFromEnv, forceStormNear } from './dev.ts';
import { loadWeatherBridge, resetWeatherBridge } from './weather-bridge.ts';
import { tickSurge } from './surge.ts';

/**
 * Ticks between client broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See
 * this file's header for why 5 Hz and not weather's 1 Hz.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/** Events this plugin emits. Namespaced `storms:` by the host. */
export { STORMS_DAMAGE_EVENT, STORMS_LANDFALL_EVENT };

/** Re-exported so a test or a future HUD reaches the ceiling through the API. */
export { MAX_ACTIVE_STORMS };

let tickCount = 0;

/**
 * A tick that changed the roster has been seen but not yet broadcast. The
 * broadcast runs every BROADCAST_TICK_INTERVAL ticks; `advanceStorms` only
 * reports `changed` while a storm is alive, so the tick on which the LAST
 * storm dies is the last one that says so — and if that tick is not a
 * broadcast tick, nothing would ever tell the clients the sky is empty
 * (review 2026-08-28: a spent cyclone spun over the player forever). This
 * flag carries the change across to the next broadcast tick.
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
let frequency: StormFrequency = DEFAULT_STORM_FREQUENCY;
let surgeMode: StormSurgeMode = DEFAULT_STORM_SURGE_MODE;

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_STORM_FREQUENCY;
  surgeMode = DEFAULT_STORM_SURGE_MODE;
  resetStorms();
  setDevFrozen(false);
  resetWeatherBridge();
}

/**
 * What this world's frequency setting does to a mean spawn interval.
 *
 * `off` NEVER REACHES ANY CALLER OF THIS — the tick returns before the spawner
 * runs — so it falls to `rare` rather than to a zero, which would be an
 * interval of zero seconds and therefore an infinite spawn rate. A wrong-but-
 * quiet default here would be the one kind of bug this codebase's tick loop
 * cannot survive, so the fallback is the shipped default and not a sentinel.
 */
function intervalMultiplier(): number {
  return frequency === 'common'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.common
    : FREQUENCY_INTERVAL_MULTIPLIERS.rare;
}

/**
 * Rolls one kind's arrival for this tick.
 *
 * THE TWO DIALS MULTIPLY HERE and nowhere else: difficulty picks the mean
 * interval (./storms.ts's two anchors and a lerp, which is WorldApi.difficulty's
 * own instruction) and the operator's setting scales it. `off` never reaches
 * this function — the tick returns before it.
 */
function rollSpawn(world: WorldApi, kind: StormKind, dt: number): void {
  if (stormCount(kind) >= profileFor(kind).maxActive) return;

  const meanInterval = meanSpawnIntervalSeconds(kind, world.difficulty) * intervalMultiplier();
  if (!spawnRoll(1 / meanInterval, dt)) return;

  const born = kind === 'tornado' ? trySpawnTornado(world) : trySpawnCyclone(world);
  if (born === null) return;
  console.info(
    `[storms] ${born.name ?? born.kind} formed at ` +
      `(${Math.round(born.x)}, ${Math.round(born.y)})`,
  );
}

/**
 * Sends the visible storms to one player (a join) or to everyone (the cadence).
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose
 * filtered subset is empty must still be sent the empty list. That is the only
 * way a client learns the storm it could see is gone; omitting the send would
 * leave its last non-empty payload spinning forever.
 */
function broadcastStorms(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    STORMS_ALL_MESSAGE,
    stormStates(),
    // THE EYE is what gates visibility, not the disc. A cyclone's radius is a
    // quarter of the map, so gating on "any part of it is visible" would tell
    // every player in the world about every cyclone — which is the fog-of-war
    // leak this filter exists to prevent. Gating on the eye means a player is
    // told about the storm whose centre is over ground they have unlocked,
    // which is also the storm that is actually about to hit them.
    (storm: StormState) => ({ x: Math.round(storm.x), y: Math.round(storm.y) }),
    (visible) => ({ storms: visible }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollSpawn(world, 'tornado', dt);
  rollSpawn(world, 'cyclone', dt);

  const tick = advanceStorms(world, dt);

  for (const event of tick.landfalls) world.emitEvent(STORMS_LANDFALL_EVENT, event);
  for (const event of tick.damage) world.emitEvent(STORMS_DAMAGE_EVENT, event);

  // SURGE, after the storms have moved, so a cyclone scours the shore it is
  // over now rather than the one it was over a tick ago. Gated on the setting
  // here rather than inside ./surge.ts, so the whole cost — including the
  // per-storm loop — is skipped on a world that turned it off.
  const alive = livingStorms();
  if (surgeMode === 'on') {
    for (const storm of alive) {
      tickSurge(world, storm, storm.peakIntensity * storm.envelope, dt, stormRandom);
    }
  }

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastStorms(world);
  }
}

const persistence: PersistenceSlice = {
  version: STORMS_SLICE_VERSION,
  save(): unknown {
    return saveStorms();
  },
  load(data: unknown): void {
    loadStorms(data);
  },
};

export const plugin: TerracePlugin = {
  name: STORMS_PLUGIN_NAME,

  settings: [
    {
      key: STORMS_FREQUENCY_SETTING_KEY,
      values: STORM_FREQUENCIES,
      defaultValue: DEFAULT_STORM_FREQUENCY,
    },
    {
      key: STORMS_SURGE_SETTING_KEY,
      values: STORM_SURGE_MODES,
      defaultValue: DEFAULT_STORM_SURGE_MODE,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    // The snapshot has already been restored by the time this runs, so the
    // reset here would wipe it — which is why it runs BEFORE nothing and the
    // storm list is not touched: resetSessionState clears the sim, so it must
    // be followed by a re-load. It is not: the host calls the slice's `load`
    // BEFORE this hook, so resetting here would discard a restored cyclone.
    //
    // Only the SESSION-SCOPED state is reset instead: the tick counter, the
    // settings and the sibling bridge. The storms themselves are whatever the
    // slice restored, or empty on a fresh world.
    tickCount = 0;
    // The freeze belongs to the world that set it, so it is cleared here and
    // re-set below only if THIS world was forced.
    setDevFrozen(false);
    resetWeatherBridge();

    frequency = parseFrequency(world.setting(STORMS_FREQUENCY_SETTING_KEY));
    surgeMode = parseSurgeMode(world.setting(STORMS_SURGE_SETTING_KEY));
    loadWeatherBridge(world);

    if (frequency === 'off') return;

    // THE DEV FORCE-SPAWN (./dev.ts) — a no-op unless STORMS_DEV_FORCE is set,
    // which it is in no real deployment. It runs AFTER the restore, so a world
    // booted with it twice gets two storms rather than one; that is the correct
    // behaviour for a development aid whose whole purpose is "put one there
    // now", and the ordinary despawn cleans up after it.
    forceSpawnFromEnv(world, process.env);

    console.info(
      `[storms] frequency: ${frequency}, surge: ${surgeMode}, ` +
        `difficulty ${world.difficulty} → a tornado every ~${Math.round(
          meanSpawnIntervalSeconds('tornado', world.difficulty) * intervalMultiplier(),
        )}s`,
    );
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, so there is nothing to
    // release — but its sim state belongs to the world that is closing, and
    // leaving it standing would hand the next world this one's hurricanes.
    resetSessionState();
  },

  // THE ADMIN PANEL'S DEBUG SPAWNS (server plugins/types.ts,
  // PluginActionDeclaration): `spawnStormAt`, the same birth the spawn roll
  // uses, on the ground ./dev.ts's search picks near the operator's view.
  actions: [
    {
      key: 'tornado',
      label: 'Spawn a tornado',
      description: 'A funnel on the nearest land to where you are looking, at full strength.',
    },
    {
      key: 'cyclone',
      label: 'Spawn a cyclone',
      description: 'A cyclone over the nearest open water to where you are looking, at full strength.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== 'tornado' && key !== 'cyclone') return { ok: false, detail: `no such action "${key}"` };
    // `off` stops the sim as well as the spawner (onTick), so a storm born now
    // would hang in the sky unmoving — refused rather than left there.
    if (frequency === 'off') {
      return { ok: false, detail: 'storms are off for this world — set the frequency first' };
    }
    const cap = profileFor(key).maxActive;
    if (stormCount(key) >= cap) {
      return { ok: false, detail: `${cap} ${key}${cap === 1 ? ' is' : 's are'} already in the air` };
    }
    const { storm, detail } = forceStormNear(world, key, site);
    if (storm === null) return { ok: false, detail };
    // Clients are told now rather than on the next broadcast tick.
    broadcastPending = false;
    broadcastStorms(world);
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    // `off` stops the SPAWNER AND THE SIM, which is stronger than it needs to
    // be and deliberately so: a world switched to `off` mid-session reopens
    // (WorldApi.setting), so any storm still in the air is restored from the
    // slice and would otherwise spin in place forever with nothing to age it.
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // A joining client is caught up within 200 ms by the next broadcast anyway;
    // this exists so the sky is right on the FIRST frame they render rather
    // than a beat later, which is the difference between "there was already a
    // hurricane here" and "a hurricane appeared as I arrived".
    if (frequency === 'off') return;
    broadcastStorms(world, player.id);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetStormsState(): void {
  resetSessionState();
}

/**
 * THE LIVE STORMS, re-exported for other plugins (the entry point IS this
 * plugin's compatibility surface, which is weather/server/index.ts's own
 * argument for re-exporting `currentWind` there).
 *
 * A sibling that wants to ask "is this cell in a gale?" — fire, most obviously,
 * whose spread already reads weather's wind — can duck-type this member rather
 * than reaching into ./storms.ts and coupling to a file layout. Nothing does
 * yet; the `storms:damage` event is the push half of the same seam.
 */
export { livingStorms };
