// thunderstorm — rain that also throws lightning, as a plugin.
//
// Core knows nothing about thunderstorms. This half owns the sim — a population
// of discs over core's disc engine (server/src/plugins/kit/discSystems.ts), plus
// the bolts (./lightning.ts) — and publishes both on namespaced messages; the
// client half draws them.
//
// A THUNDERSTORM IS RAIN PLUS LIGHTNING rather than a `hasLightning` flag on
// rain, because every consumer switches on the kind anyway (particle rig,
// opacity, whether a bolt schedule is armed) and a boolean would make two rows
// of that table depend on two fields instead of one. After the 2026-09-02 split
// it is also literally a different plugin, which is the same statement with
// teeth: delete this folder and the world has rain and no lightning.
//
// It reads the world in ONE place — the strike siting in ./lightning.ts, which
// reads heights and NOT the unlock mask. That is the pre-split behaviour
// unchanged: a strike's cell travels to every client anyway, because the fire it
// starts does.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO CHANNELS FOR ONE BOLT, AND THEY ARE NOT REDUNDANT.
//
// `thunderstorm:strikes` (a broadcast) is for the CLIENTS, which draw the bolt.
// `emitEvent('strikes', …)` is for other SERVER plugins — fire lights what was
// struck — by name and with no import in either direction. The host prefixes the
// plugin's own name, so the event arrives as `thunderstorm:strikes`
// (plugins/fire/server/index.ts subscribes to exactly that).
//
// ON THE TICK THEY HAPPEN, rather than on the 1 Hz broadcast cadence: a bolt is
// an instant, and holding one for up to a second so it could ride the next
// systems message would put the flash somewhere it visibly does not belong and
// delay the fire it starts by the same amount.
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
  THUNDERSTORM_COVERAGE_FRACTION,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  packStrikes,
} from '../protocol.ts';
import { rollStrikes } from './lightning.ts';
import { thunderstormRandom } from './rng.ts';
import {
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
export const THUNDERSTORM_DEV_FORCE_ENV = devForceEnvName(THUNDERSTORM_PLUGIN_NAME);

/**
 * THE SIM. One population of discs, drifting on the hub's wind.
 *
 * No siting predicate: a storm forms anywhere, including over open sea, which is
 * both true and what keeps lightning possible on a world with no land — the dry
 * bolt refuses the sea, but a storm's bolt lands wherever the storm is.
 */
const systems = createDiscSystems({
  coverageFraction: THUNDERSTORM_COVERAGE_FRACTION,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: thunderstormRandom,
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
 * How wet cell (x, y) is under a THUNDERSTORM alone, in [0, 1] — a storm is rain,
 * harder, and the pre-split `precipitationAt` counted the `storm` kind exactly
 * like `rain`.
 */
export function wetnessAt(x: number, y: number): number {
  return systems.intensityAt(x, y);
}

/**
 * Births one system now, within this plugin's own cap, and says whether it did.
 *
 * Offered to the hub so a kind that loses a birth to its own siting rule can hand
 * the roll on (#285). Nothing hands one here today; it costs three lines and
 * makes this plugin an equal member of the register.
 */
export function spawnOne(): boolean {
  if (systems.isForced()) return false;
  if (systems.systems().length >= systems.capFor(currentWorldSize)) return false;
  return systems.spawnOne(currentWorldSize) !== null;
}

/** The world's size in cells, captured at create; see rain's copy of this note. */
let currentWorldSize = 0;

function simulate(world: WorldApi, dt: number): void {
  currentWorldSize = world.worldSize;
  systems.advance(world.worldSize, dt, windVelocity());

  const strikes = rollStrikes(world, systems.systems(), dt);
  if (strikes.length > 0) {
    // THE BOLT IS FILTERED PER PLAYER, THE FIRE IS NOT (owner, 2026-09-02).
    //
    // A STRIKE HAS A CELL, unlike the systems above — a mass's position leaks
    // nothing about the map, which is why those stay unfiltered by design, but
    // a bolt names the exact cell it hit. Sent to everybody, a client could
    // draw a bolt standing on floor it has never been sent, over the frontier
    // mist, and #291's rule (off the map is visible to nobody) would not have
    // been applied to the one message in this plugin that carries a place.
    // `skipEmpty`, so a player who can see none of this tick's strikes is sent
    // nothing at all rather than an empty list.
    //
    // The EVENT is unchanged and carries every strike: it is what sets forests
    // alight (../../fire), and the fire is the world's, not a picture drawn for
    // whoever happened to be looking. A player who has not revealed that ground
    // still walks into the burn when they get there.
    world.broadcastVisible(
      THUNDERSTORM_STRIKES_MESSAGE,
      strikes,
      (strike) => strike,
      (visible) => ({ strikes: packStrikes(visible) }),
      { skipEmpty: true },
    );
    world.emitEvent(THUNDERSTORM_STRIKES_MESSAGE, { strikes: packStrikes(strikes) });
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: THUNDERSTORM_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;
    currentWorldSize = world.worldSize;

    loadWeatherBridge(world);
    registerWithHub({
      name: THUNDERSTORM_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      spawnOne,
    });

    const forced = readDevForce(THUNDERSTORM_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[thunderstorm] ${THUNDERSTORM_DEV_FORCE_ENV}=1 — one thunderstorm parked over the world centre`,
      );
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
  },

  actions: [
    {
      key: THUNDERSTORM_PLUGIN_NAME,
      label: 'Bring a thunderstorm',
      description:
        'A thunderstorm gathers over where you are looking, then drifts on the wind like any other system — and throws bolts while it is there.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== THUNDERSTORM_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${THUNDERSTORM_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} thunderstorms are already in the sky` };
    }
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    world.broadcast(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: systemStates() });
    return {
      ok: true,
      detail: `thunderstorm ${system.id} gathering at (${site.x}, ${site.y})`,
    };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetThunderstormState(): void {
  tickCount = 0;
  systems.reset();
}

/** Test seam: the sim itself, for a suite that drives it without a host. */
export { systems as thunderstormSystems };
