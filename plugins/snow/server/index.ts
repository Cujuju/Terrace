// snow — drifting fronts of falling snow over high ground, as a plugin.
//
// Core knows nothing about snow. This half owns the sim — a population of discs
// over core's disc engine (server/src/plugins/kit/discSystems.ts), with a siting
// predicate — and publishes it on one namespaced message; the client half draws
// it. Core's lighting rig, its sky and its scene fog are never touched.
//
// It reads the world in ONE place (./siting.ts) and writes it nowhere: no
// onIntent, no sculpt, no unlock.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE UNSITED ROLL, AND WHERE IT GOES (#285).
//
// Before the 2026-09-02 split, a snow spawn that could find no high ground
// BECAME RAIN — one plugin owned both kinds, so it simply changed the kind field
// on the system it was about to make. Abandoning the roll instead would silently
// make weather rarer on flat worlds, which is the opposite of what a player on a
// flat world wants: the same cloud arrived, it is just not cold enough up there
// to snow.
//
// That behaviour survives the split as a HAND-OFF BY NAME. This plugin asks the
// hub to have the kind called 'rain' birth one instead (./weather-bridge.ts,
// handOffSpawnTo). It knows the STRING 'rain' and nothing else about any rain
// plugin — no import, no type, no assumption that one exists. If there is none
// running here, or it is at its own cap, the roll is simply lost, which is the
// same amount of weather a world with no rain plugin should have.
//
// PERSISTENCE: NONE, DELIBERATELY. See rain's header for the argument.
// ─────────────────────────────────────────────────────────────────────────────

import { logInfo } from '../../../server/src/log.ts';
import type {
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { devForceEnvName, readDevForce } from '../../../server/src/plugins/kit/devForce.ts';
import { createDiscSystems } from '../../../server/src/plugins/kit/discSystems.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  SNOW_COVERAGE_FRACTION,
  SNOW_FOOTPRINT_AREA_SCALE,
  SNOW_PLUGIN_NAME,
  SNOW_SYSTEMS_MESSAGE,
} from '../protocol.ts';
import { snowRandom } from './rng.ts';
import { isSnowSite, type SnowWorld } from './siting.ts';
import {
  handOffSpawnTo,
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

/** Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10. */
export const BROADCAST_TICK_INTERVAL = 10;

/** Hard ceiling on systems in one broadcast. See MAX_ACTIVE_SYSTEMS. */
export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

/** The environment switch that parks one system over the world centre. */
export const SNOW_DEV_FORCE_ENV = devForceEnvName(SNOW_PLUGIN_NAME);

/**
 * The kind an unsited roll is handed to, BY NAME.
 *
 * A STRING, and deliberately nothing more: this plugin must keep working when
 * there is no rain plugin installed at all, and a name is the only reference
 * that degrades to "nobody answered" instead of to a module-resolution failure.
 */
export const SNOW_HAND_OFF_KIND = 'rain';

/**
 * The world this plugin is simulating, or null between worlds.
 *
 * The siting predicate needs it and the engine's `siting` hook takes no world —
 * on purpose, so the kit reads no ground of its own (see its header). It is
 * re-read on every create, so a host that opens a second world does not site the
 * first world's snow against it.
 */
let currentWorld: SnowWorld | null = null;

/**
 * THE SIM. One population of discs, drifting on the hub's wind, sited on high
 * ground.
 *
 * A candidate with no world (before the first create) fails siting rather than
 * being waved through: siting is what keeps snow off the sea, and defaulting to
 * "yes" in the one state where the answer is unknown is exactly the bug the
 * anti-cheat rule in ./siting.ts exists to prevent.
 */
const systems = createDiscSystems({
  coverageFraction: SNOW_COVERAGE_FRACTION,
  footprintAreaScale: SNOW_FOOTPRINT_AREA_SCALE,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: snowRandom,
  siting: (x, y, radius) =>
    currentWorld !== null && isSnowSite(currentWorld, x, y, radius),
  onUnsited: () => {
    // The roll is not lost yet: another kind may take it (see the header). Its
    // answer is deliberately not acted on — there is nothing left for snow to do
    // either way.
    handOffSpawnTo(SNOW_HAND_OFF_KIND);
  },
});

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/** The living systems, for tests. */
export function livingSystems(): ReturnType<typeof systems.systems> {
  return systems.systems();
}

/** The systems as they go on the wire. */
export function systemStates(): ReturnType<typeof systems.states> {
  return systems.states(windVelocity());
}

/**
 * How wet cell (x, y) is under SNOW alone, in [0, 1].
 *
 * SNOW WETS THE GROUND, exactly as the pre-split `precipitationAt` counted it: a
 * fire under falling snow is a fire under falling water with extra steps.
 */
export function wetnessAt(x: number, y: number): number {
  return systems.intensityAt(x, y);
}

function simulate(world: WorldApi, dt: number): void {
  currentWorld = world;
  systems.advance(world.worldSize, dt, windVelocity());

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(SNOW_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: SNOW_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;
    currentWorld = world;

    loadWeatherBridge(world);
    registerWithHub({
      name: SNOW_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      // NO `spawnOne`. Snow is a kind that HANDS OFF, not one that is handed to:
      // an unsited roll passed back to snow would fail siting again for the same
      // reason it failed the first time.
    });

    const forced = readDevForce(SNOW_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[snow] ${SNOW_DEV_FORCE_ENV}=1 — one snow system parked over the world centre`,
      );
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
    currentWorld = null;
  },

  actions: [
    {
      key: SNOW_PLUGIN_NAME,
      label: 'Bring snow',
      description:
        'A snow system gathers over where you are looking — high ground or not, since a person who asked for snow to look at it is not served by rain — then drifts on the wind like any other.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== SNOW_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${SNOW_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} snow systems are already in the sky` };
    }
    // `spawnAt` ignores the siting predicate, and that is the point: snow over
    // lowland included, because a person who asked for snow to look at it is not
    // served by rain.
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    world.broadcast(SNOW_SYSTEMS_MESSAGE, { systems: systemStates() });
    return { ok: true, detail: `snow system ${system.id} gathering at (${site.x}, ${site.y})` };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetSnowState(): void {
  tickCount = 0;
  systems.reset();
}

/** Test seam: the sim itself, and the world it sites against. */
export { systems as snowSystems };
export function setSnowWorld(world: SnowWorld | null): void {
  currentWorld = world;
}
