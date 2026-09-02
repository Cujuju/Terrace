// tornado — funnels, as a plugin (#213, split out of `storms` by #283).
//
// Core knows nothing about tornadoes and must not: a rotating hazard that
// flattens what a player built is as gamey as a mechanic gets, and the design
// record's rule ("nothing gamey in core") puts the whole thing here. It reads
// the world through `heightAt` and `worldSize`, talks to the weather hub through
// the host's sibling lookup, and writes no terrain at all.
//
// SHAPE OF THE TICK:
//   1. the world rolls one spawn, under the frequency setting;
//   2. every funnel moves, ages, and is weakened by the water under it (the kit
//      engine, ./sim.ts);
//   3. wind damage goes out as a world event;
//   4. clients are told, on the cadence, fog-of-war filtered.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACTS TO A TORNADO, AND WHAT THIS PLUGIN DOES ABOUT IT.
//
// Nothing, yet, and deliberately. Issue #213 lists structures, flora, wildlife
// and fire as the consumers of wind damage; every one of them is reached the way
// plugins always reach each other — this plugin EMITS `tornado:damage`, and a
// consumer subscribes BY NAME and validates the payload structurally, with no
// import in either direction. No consumer exists today; the event is the seam
// those follow-ups attach to, and emitting it costs one fan-out per funnel per
// second.
//
// The one plugin this half depends on is the weather HUB, and only to be told
// where the thunderstorm cells are (./weather-bridge.ts). No thunderstorms, no
// tornadoes.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, TWICE A SECOND, FOG-OF-WAR FILTERED.
//
// Every broadcast carries the ENTIRE visible funnel list rather than a delta,
// with the same three consequences as everywhere else here: it is self-healing
// (a dropped message costs half a second of staleness), it needs no join
// handshake beyond a snapshot send, and its cost is bounded by
// MAX_ACTIVE_TORNADOES rather than by how long the world has been running.
//
// FILTERED, unlike the sky plugins' unfiltered system lists, and the difference
// is information: a front's position is a function of RNG and the shared wind
// alone, so it says nothing about terrain nobody has unlocked. A tornado's is
// not — it only ever touches down on land, so "there is a tornado here" IS a
// statement about the ground there. `broadcastVisible` with `skipEmpty: false`
// is therefore the right primitive: a player whose visible subset is empty must
// still be sent the empty list, or the funnel they last saw would keep spinning
// on their screen after it walked out of their territory.
//
// CADENCE. 5 Hz, and the reason is motion. A tornado covers 10 cells a second;
// at 1 Hz that is 10 cells between messages against a 6-cell radius — the funnel
// would teleport more than its own width every push, which no interpolation can
// hide. At 5 Hz it moves a third of its radius, which the client's own
// extrapolation smooths out.

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
  DEFAULT_TORNADO_FREQUENCY,
  FREQUENCY_INTERVAL_MULTIPLIERS,
  TORNADO_ALL_MESSAGE,
  TORNADO_DAMAGE_EVENT,
  TORNADO_FREQUENCIES,
  TORNADO_FREQUENCY_SETTING_KEY,
  TORNADO_PLUGIN_NAME,
  parseFrequency,
  type TornadoFrequency,
  type TornadoState,
} from '../protocol.ts';
import { loadTornadoes, saveTornadoes, TORNADO_SLICE_VERSION } from './persistence.ts';
import {
  MAX_ACTIVE_TORNADOES,
  meanSpawnIntervalSeconds,
  tornadoes,
  trySpawnTornado,
} from './sim.ts';
import { forceSpawnFromEnv, forceTornadoNear } from './dev.ts';
import { loadWeatherBridge, resetWeatherBridge } from './weather-bridge.ts';

/**
 * Ticks between client broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See
 * this file's header for why 5 Hz.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/** Events this plugin emits. Namespaced `tornado:` by the host. */
export { TORNADO_DAMAGE_EVENT };

/** Re-exported so a test or a future HUD reaches the ceiling through the API. */
export { MAX_ACTIVE_TORNADOES };

let tickCount = 0;

/**
 * A tick that changed the roster has been seen but not yet broadcast. The
 * broadcast runs every BROADCAST_TICK_INTERVAL ticks; the engine only reports
 * `changed` while a storm is alive, so the tick on which the LAST one dies is
 * the last that says so — and if that tick is not a broadcast tick, nothing
 * would ever tell the clients the sky is empty (review 2026-08-28: a spent storm
 * spun over the player forever). This flag carries the change across to the next
 * broadcast tick.
 */
let broadcastPending = false;

/**
 * The world's setting, read ONCE in onWorldCreate.
 *
 * WorldApi.setting's own instruction: the value is fixed for the life of a
 * session (changing it persists the row and REOPENS the world, which replays
 * restore + worldCreate), so a plugin that re-read it every tick would be
 * reading a value that cannot move at a cost that can.
 */
let frequency: TornadoFrequency = DEFAULT_TORNADO_FREQUENCY;

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_TORNADO_FREQUENCY;
  tornadoes.reset();
  tornadoes.freeze(false);
  resetWeatherBridge();
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
 * interval (./sim.ts's two anchors and a lerp, which is WorldApi.difficulty's
 * own instruction) and the operator's setting scales it. `off` never reaches
 * this function — the tick returns before it.
 */
function rollSpawn(world: WorldApi, dt: number): void {
  if (tornadoes.count() >= MAX_ACTIVE_TORNADOES) return;

  const meanInterval = meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier();
  if (!tornadoes.rollSpawn(1 / meanInterval, dt)) return;

  const born = trySpawnTornado(world);
  if (born === null) return;
  console.info(
    `[${TORNADO_PLUGIN_NAME}] a tornado touched down at ` +
      `(${Math.round(born.x)}, ${Math.round(born.y)})`,
  );
}

/**
 * Sends the visible funnels to one player (a join) or to everyone (the cadence).
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose
 * filtered subset is empty must still be sent the empty list. That is the only
 * way a client learns the funnel it could see is gone; omitting the send would
 * leave its last non-empty payload spinning forever.
 */
function broadcastTornadoes(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    TORNADO_ALL_MESSAGE,
    tornadoes.states(),
    // THE FUNNEL'S OWN CELL is what gates visibility: a player is told about the
    // tornado standing on ground they have unlocked, which is also the one that
    // is about to hit them. A funnel that has walked off the map is visible to
    // nobody and is filtered out by core (#291), not clamped to the edge here.
    (storm: TornadoState) => ({ x: Math.round(storm.x), y: Math.round(storm.y) }),
    (visible) => ({ storms: visible }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollSpawn(world, dt);

  const tick = tornadoes.advance(world, dt);
  for (const event of tick.damage) world.emitEvent(TORNADO_DAMAGE_EVENT, event);

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastTornadoes(world);
  }
}

const persistence: PersistenceSlice = {
  version: TORNADO_SLICE_VERSION,
  save(): unknown {
    return saveTornadoes();
  },
  load(data: unknown): void {
    loadTornadoes(data);
  },
};

export const plugin: TerracePlugin = {
  name: TORNADO_PLUGIN_NAME,

  settings: [
    {
      key: TORNADO_FREQUENCY_SETTING_KEY,
      values: TORNADO_FREQUENCIES,
      defaultValue: DEFAULT_TORNADO_FREQUENCY,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    // The snapshot has already been restored by the time this runs — the host
    // calls the slice's `load` BEFORE this hook — so the storms themselves are
    // deliberately NOT touched here: resetting would discard what was restored.
    // Only the SESSION-SCOPED state is reset: the tick counter, the setting and
    // the sibling bridge.
    tickCount = 0;
    // The freeze belongs to the world that set it, so it is cleared here and
    // re-set below only if THIS world was forced.
    tornadoes.freeze(false);
    resetWeatherBridge();

    frequency = parseFrequency(world.setting(TORNADO_FREQUENCY_SETTING_KEY));
    loadWeatherBridge(world);

    if (frequency === 'off') return;

    // THE DEV FORCE-SPAWN (./dev.ts) — a no-op unless TORNADO_DEV_FORCE is set,
    // which it is in no real deployment. It runs AFTER the restore, and clears
    // the sky itself, so a world booted with it twice still holds exactly one.
    forceSpawnFromEnv(world, process.env);

    console.info(
      `[${TORNADO_PLUGIN_NAME}] frequency: ${frequency}, difficulty ` +
        `${world.difficulty} → one every ~${Math.round(
          meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier(),
        )}s`,
    );
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, so there is nothing to
    // release — but its sim state belongs to the world that is closing, and
    // leaving it standing would hand the next world this one's funnels.
    resetSessionState();
  },

  // THE ADMIN PANEL'S DEBUG SPAWN (server plugins/types.ts,
  // PluginActionDeclaration): the same birth the spawn roll uses, on the ground
  // ./dev.ts's search picks near the operator's view.
  actions: [
    {
      key: 'tornado',
      label: 'Spawn a tornado',
      description: 'A funnel on the nearest land to where you are looking, at full strength.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== 'tornado') return { ok: false, detail: `no such action "${key}"` };
    // `off` stops the sim as well as the spawner (onTick), so a funnel born now
    // would hang in the sky unmoving — refused rather than left there.
    if (frequency === 'off') {
      return { ok: false, detail: 'tornadoes are off for this world — set the frequency first' };
    }
    if (tornadoes.count() >= MAX_ACTIVE_TORNADOES) {
      return {
        ok: false,
        detail: `${MAX_ACTIVE_TORNADOES} tornadoes are already in the air`,
      };
    }
    const { storm, detail } = forceTornadoNear(world, site);
    if (storm === null) return { ok: false, detail };
    // Clients are told now rather than on the next broadcast tick.
    broadcastPending = false;
    broadcastTornadoes(world);
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    // `off` stops the SPAWNER AND THE SIM, which is stronger than it needs to be
    // and deliberately so: a world switched to `off` mid-session reopens
    // (WorldApi.setting), so any funnel still in the air is restored from the
    // slice and would otherwise spin in place forever with nothing to age it.
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // A joining client is caught up within 200 ms by the next broadcast anyway;
    // this exists so the sky is right on the FIRST frame they render rather than
    // a beat later.
    if (frequency === 'off') return;
    broadcastTornadoes(world, player.id);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetTornadoState(): void {
  resetSessionState();
}

/**
 * THE LIVE FUNNELS, re-exported for other plugins (the entry point IS this
 * plugin's compatibility surface, which is the weather hub's own argument for
 * re-exporting `currentWind` there).
 *
 * A sibling that wants to ask "is this cell in a gale?" — fire, most obviously,
 * whose spread already reads the hub's wind — can duck-type this member rather
 * than reaching into ./sim.ts and coupling to a file layout. Nothing does yet;
 * the `tornado:damage` event is the push half of the same seam.
 */
export function livingTornadoes(): readonly RotatingStorm[] {
  return tornadoes.storms();
}
