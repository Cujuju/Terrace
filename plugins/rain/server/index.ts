// rain — drifting fronts of falling water, as a plugin.
//
// Core knows nothing about rain. This half owns the sim — a population of discs
// over core's disc engine (server/src/plugins/kit/discSystems.ts) — and publishes
// it on one namespaced message; the client half under ../client draws it. Core's
// lighting rig, its sky and its scene fog are never touched by either half: clear
// weather is the absence of a system, so a world with no rain looks exactly like
// a world without this plugin installed.
//
// It reads the world NOWHERE and writes it nowhere: no onIntent, no sculpt, no
// unlock. Rain is ambience, and ambience that can change the ground would be a
// game mechanic wearing a hat.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT NEEDS FROM ITS NEIGHBOURS, AND IN WHICH DIRECTION.
//
// THE WIND comes from the `weather` hub, through a bridge (./weather-bridge.ts):
// there is one wind for the whole world, because the sky moves as a piece.
// BEING IN THE SKY is told to the hub inward, by registering — "how wet is this
// cell" is a union over an OPEN set of kinds, and an open set registers with the
// thing that asks the question rather than being enumerated by it.
//
// SYNC: FULL STATE, ONCE A SECOND. Every broadcast carries the ENTIRE system
// list, not a delta — self-healing (a dropped message costs one second of
// staleness), no join handshake (a joining client is caught up by the next
// broadcast), and bounded (MAX_ACTIVE_SYSTEMS is a hard ceiling, so the payload
// is a constant and not a function of uptime).
//
// ALL PLAYERS SEE THE SAME RAIN, and the broadcast is UNFILTERED: every client
// gets every system. That is deliberate and it is safe for the same reason the
// wildlife plugin's birds are — a system's position is a function of RNG and the
// shared wind alone, so it leaks nothing about locked terrain. This plugin never
// reads a height, so there is nothing it could leak.
//
// PERSISTENCE: NONE, DELIBERATELY, and there is no `persistence` slice at all. A
// system's entire state is how far along a drift it will have finished in a few
// minutes; restoring one resumes weather nobody was watching. It is the birds
// precedent (docs/DESIGN.md, "Persistence: none, deliberately").
// ─────────────────────────────────────────────────────────────────────────────

import { logInfo } from '../../../server/src/log.ts';
import type {
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement every plugin in this repo uses.
import { devForceEnvName, readDevForce } from '../../../server/src/plugins/kit/devForce.ts';
import { createDiscSystems } from '../../../server/src/plugins/kit/discSystems.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  RAIN_COVERAGE_FRACTION,
  RAIN_FOOTPRINT_AREA_SCALE,
  RAIN_PLUGIN_NAME,
  RAIN_SYSTEMS_MESSAGE,
} from '../protocol.ts';
import { rainRandom } from './rng.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

/**
 * Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10.
 *
 * MOTION PICKS THE CADENCE, not bandwidth: the wind's ceiling is 2 world units
 * per second (plugins/weather/server/wind.ts, WIND_MAX_SPEED_CELLS_PER_SECOND =
 * cellsAcross(2) = 8 cells/s), so a system moves at most 8 cells between
 * messages — under 5% of the SMALLEST system's 166-cell radius since
 * RAIN_FOOTPRINT_AREA_SCALE enlarged the band (it was 8% of the base 96-cell
 * floor) — and the client interpolates across the gap, so a player cannot tell
 * it from 10 Hz. 1 Hz is also the FLOOR: the client clamps its
 * interpolation window at MAX_INTERPOLATION_SECONDS (2 s), sized to ride out one
 * dropped message at this cadence, so halving to 0.5 Hz would put the nominal
 * window at the clamp with no headroom and fronts would start snapping.
 *
 * At ~90 B per system, 7 systems is ~650 B a second per client — a rounding
 * error next to the wildlife plugin's ~390 kbit/s.
 */
export const BROADCAST_TICK_INTERVAL = 10;

/** Hard ceiling on systems in one broadcast. See MAX_ACTIVE_SYSTEMS. */
export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

/** The environment switch that parks one system over the world centre. */
export const RAIN_DEV_FORCE_ENV = devForceEnvName(RAIN_PLUGIN_NAME);

/**
 * THE SIM. One population of discs, drifting on the hub's wind.
 *
 * No siting predicate: rain falls anywhere, including over open sea, which is
 * both true and what keeps weather arriving on a world with no land at all.
 */
const systems = createDiscSystems({
  coverageFraction: RAIN_COVERAGE_FRACTION,
  footprintAreaScale: RAIN_FOOTPRINT_AREA_SCALE,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: rainRandom,
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
 * How wet cell (x, y) is under RAIN alone, in [0, 1] — the hub takes the max
 * across every kind (plugins/weather/server/registry.ts) and fire asks the hub.
 *
 * A HARD-EDGED DISC, matching how the client draws a system's footprint: a soft
 * falloff would put out fires at a range no player can see the rain reaching.
 */
export function wetnessAt(x: number, y: number): number {
  return systems.intensityAt(x, y);
}

/**
 * Births one system now, within this plugin's own cap, and says whether it did.
 *
 * THE HAND-OFF (#285). It is on the entry this plugin registers with the hub so
 * that another kind whose own siting rule refused a birth can pass the roll to
 * rain BY NAME — which is how snow's fallback to rain survives the split without
 * either plugin importing the other.
 */
export function spawnOne(): boolean {
  if (systems.isForced()) return false;
  if (systems.systems().length >= systems.capFor(currentWorldSize)) return false;
  return systems.spawnOne(currentWorldSize) !== null;
}

/**
 * The world's size in cells, captured at create.
 *
 * The sim needs it on every tick and the hand-off above needs it with no world
 * in hand — `spawnOne` is called by the HUB, which has no way to pass one. It is
 * the world's own size, re-read on every create, so a host that opens a second
 * world does not size the first world's sky against it.
 */
let currentWorldSize = 0;

function simulate(world: WorldApi, dt: number): void {
  currentWorldSize = world.worldSize;
  systems.advance(world.worldSize, dt, windVelocity());

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(RAIN_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: RAIN_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // A fresh sky on every boot, whatever a snapshot restored — this plugin has
    // no persistence slice, so there is nothing to be consistent with.
    systems.reset();
    tickCount = 0;
    currentWorldSize = world.worldSize;

    loadWeatherBridge(world);
    registerWithHub({
      name: RAIN_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      spawnOne,
    });

    // THE DEV OVERRIDE, read here and nowhere else. Applied AFTER the reset,
    // because the reset is what clears the sky the override then parks its one
    // system in.
    const forced = readDevForce(RAIN_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[rain] ${RAIN_DEV_FORCE_ENV}=1 — one rain system parked over the world centre`,
      );
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
  },

  // THE ADMIN PANEL'S DEBUG SPAWN (server plugins/types.ts,
  // PluginActionDeclaration).
  // Groups this plugin's cards in the admin panel; see TerracePlugin.archetype.
  archetype: 'weather',
  actions: [
    {
      key: RAIN_PLUGIN_NAME,
      label: 'Bring rain',
      description:
        'A rain system gathers over where you are looking, then drifts on the wind like any other.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== RAIN_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    // Under the environment override the sky holds exactly one parked system and
    // the sim never looks at any other; a second one would sit there forever,
    // ungathered.
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${RAIN_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} rain systems are already in the sky` };
    }
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    // Told now rather than at the 1 Hz cadence, so the gather starts on screen
    // the moment the button is pressed.
    world.broadcast(RAIN_SYSTEMS_MESSAGE, { systems: systemStates() });
    return { ok: true, detail: `rain system ${system.id} gathering at (${site.x}, ${site.y})` };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetRainState(): void {
  tickCount = 0;
  systems.reset();
}

/** Test seam: the sim itself, for a suite that drives it without a host. */
export { systems as rainSystems };
