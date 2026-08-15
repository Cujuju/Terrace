// weather — rain, storms, snow and fog as drifting masses, as a plugin.
//
// Core knows nothing about weather. This half owns the whole sim (./systems.ts:
// one wind, a handful of discs, Poisson arrivals and deaths, snow siting) and
// publishes it on one namespaced message; the client half under ../client draws
// it. Core's lighting rig, its sky and its scene fog are never touched by either
// half — clear weather is the absence of a system, so a world with no weather
// looks exactly like a world without this plugin installed.
//
// It reads the world in ONE place (the snow siting test) and writes it nowhere:
// no onIntent, no sculpt, no unlock. Weather is ambience, and ambience that can
// change the ground would be a game mechanic wearing a hat.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, ONCE A SECOND.
//
// Every broadcast carries the ENTIRE system list, not a delta. The same v1
// choice wildlife and monsters made, with the same three consequences:
//
//   * self-healing — a dropped or reordered message costs one second of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — MAX_ACTIVE_SYSTEMS is a hard ceiling, so the payload is a
//     constant and not a function of how long the world has been running.
//
// ALL PLAYERS SEE THE SAME WEATHER, and the broadcast is UNFILTERED: every
// client gets every system. That is deliberate and it is safe for the same
// reason the wildlife plugin's birds are — a system's position is a function of
// RNG and the shared wind alone, so it leaks nothing about locked terrain. The
// one place this sim reads heights (snow siting) refuses to look at locked
// cells precisely so that this stays true; see SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA.
//
// BANDWIDTH. One system is eight keys — id, kind, x, y, radius, intensity, vx,
// vy — which msgpack encodes in roughly 97 B (Colyseus re-sends key strings on
// every message; there is no schema here):
//
//   id         "id" 3 B + small int 1 B                        =  4 B
//   kind       "kind" 5 B + "storm" 6 B                        = 11 B
//   x, y       "x"/"y" 2 B + float64 9 B, twice                = 22 B
//   radius     "radius" 7 B + float64 9 B                      = 16 B
//   intensity  "intensity" 10 B + float64 9 B                  = 19 B
//   vx, vy     "vx"/"vy" 3 B + float64 9 B, twice              = 24 B
//   map header                                                 =  1 B
//                                                                ─────
//                                                                 97 B
//
// (Rounded coordinates are not exactly representable in binary, so msgpack
// spends a full float64 on each rather than a short int — which is why the
// rounding in protocol.ts buys assertability and payload determinism, not
// bytes.) The message envelope — the `systems` key and the array header — is
// ~10 B, call it 20 B with Colyseus's own framing:
//
//   3 systems × 97 B + 20 B    = 311 B per message
//   every tick     (10 Hz)     = 3.1 KB/s ≈ 25 kbit/s per client
//   every 10th tick (1 Hz)     = 311 B/s ≈ 2.5 kbit/s per client   ← chosen
//   × ~10 players              ≈ 25 kbit/s of server upstream
//   a clear sky (empty list)   = 20 B/s  ≈ 0.16 kbit/s per client
//
// Both cadences are rounding error next to the wildlife plugin's ~390 kbit/s
// (this is 0.6% of it), so bandwidth is NOT what picks the cadence here — motion
// is, and it points the same way:
//
//   * the wind's ceiling is 2 cells/s, so a system moves at most 2 cells between
//     messages. Against the SMALLEST system's 24-cell radius that is 8% of the
//     mass, and the client interpolates across the gap (client/interpolation.ts)
//     — a player cannot tell it from 10 Hz, so the other 22 kbit/s buys nothing.
//     Compare the wildlife plugin, which needed 5 Hz because a fleeing fish
//     covers 1.8 cells against a body 0.7 cells long.
//   * 1 Hz is also the FLOOR, not just the choice. The client clamps its
//     interpolation window at MAX_INTERPOLATION_SECONDS (2 s), sized to ride out
//     one dropped message at this cadence. Halving to 0.5 Hz would put the
//     nominal window at the clamp with no headroom for jitter, and fronts would
//     start snapping.
//
// The 2 cells/s ceiling and this cadence are two ends of one decision: if the
// wind is ever allowed to blow harder, this interval is what has to move.
// ─────────────────────────────────────────────────────────────────────────────
//
// PERSISTENCE: NONE, DELIBERATELY — and there is no `persistence` slice at all,
// so this plugin contributes nothing to the snapshot. A system's entire state is
// how far along a drift it will have finished in a few minutes; restoring one
// resumes weather nobody was watching, and the spawner puts a fresh front up
// within SYSTEM_MEAN_SPAWN_INTERVAL_SECONDS anyway. It is the birds precedent
// (docs/DESIGN.md, "Persistence: none, deliberately") applied to the same shape
// of thing: transient ambience, where the cost of persisting is a snapshot
// field, a validation branch and a schema-version question, and the benefit is a
// difference no player can observe. A restarted server has a clear sky for a
// minute or two; that is what a clear sky looks like the rest of the time too.

import type {
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana, reveal, relics, wildlife and monsters plugins use.
import { WEATHER_PLUGIN_NAME, WEATHER_SYSTEMS_MESSAGE } from '../protocol.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  advanceWeather,
  resetWeather,
  systemStates,
  type WeatherWorld,
} from './systems.ts';

/**
 * Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10. See the
 * bandwidth and motion analysis in this file's header for why 10 and not 1.
 */
export const BROADCAST_TICK_INTERVAL = 10;

/**
 * Hard ceiling on systems in one broadcast — the number the bandwidth
 * arithmetic above multiplies by 97 B.
 *
 * It is MAX_ACTIVE_SYSTEMS re-exported under the name the budget uses, not a
 * second constant: unlike the wildlife plugin, which has two independent
 * subsystems putting entities on the wire and therefore has to add two ceilings
 * up, this plugin has exactly one source of payload.
 */
export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/**
 * THE SIM STEP. One call into ./systems.ts, then the broadcast on its cadence.
 *
 * There is deliberately nothing else here: no reactive path (weather does not
 * care what the ground does, and onTerrainChanged would fire this plugin
 * thousands of times during a held stroke to no purpose) and no intent hook
 * (weather never vetoes a sculpt — rain that stopped you building would be a
 * game mechanic, and this is ambience).
 */
function simulate(world: WorldApi, dt: number): void {
  advanceWeather(world, dt);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(WEATHER_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: WEATHER_PLUGIN_NAME,

  onWorldCreate(): void {
    // A fresh sky on every boot, whatever a snapshot restored — this plugin has
    // no persistence slice, so there is nothing to be consistent with, and
    // drawing the boot wind here rather than at module load means a host that
    // creates two worlds in one process does not have them share a wind.
    resetWeather();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetWeatherState(): void {
  tickCount = 0;
  resetWeather();
}

// Re-exported so tests and any future HUD can reach the tuning numbers through
// the plugin's own entry point rather than by importing its internals.
export { MAX_ACTIVE_SYSTEMS };
export type { WeatherWorld };
