// weather — THE HUB. The world's wind, and the register every kind of weather
// joins the sky through.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PLUGIN IS AFTER 2026-09-02 (#283, #285).
//
// It used to be the whole sky: one sim, four kinds drawn by weight, one
// broadcast. It is now the two things about the sky that are facts of the WORLD
// rather than of any one kind:
//
//   * THE WIND. One heading and one speed for the whole map (./wind.ts). Every
//     kind plugin reads it through a bridge and drifts on it, which is what
//     keeps "the sky moves as a piece" true across four independent folders.
//   * THE REGISTER. rain, thunderstorm, snow and fog each register inward
//     (./registry.ts), and this plugin answers the union questions on their
//     behalf: how wet a cell is, and what is in the sky.
//
// IT HAS NO WIRE AND NO CLIENT HALF. Nothing about a wind or a register is
// something to draw — every pixel of weather belongs to a kind plugin and
// travels on that plugin's own message — so this plugin is absent from
// client/src/plugins/registry.ts entirely rather than registered there as a
// no-op with a zero draw budget. A plugin with no client half is the ordinary
// case here (`reveal` and `populous` have none either).
//
// IT HAS NO PERSISTENCE, DELIBERATELY, and there is no `persistence` slice at
// all. A wind is a heading and a speed that will have wandered somewhere else in
// a few minutes; restoring one resumes weather nobody was watching. It is the
// birds precedent (docs/DESIGN.md, "Persistence: none, deliberately").
//
// COMPATIBILITY: `currentWind` and `precipitationAt` are still exported from
// this file under the same names and the same shapes, so fire's and mudslides'
// bridges (plugins/*/server/weather-bridge.ts) resolve exactly as they did
// before the split and were not edited.
// ─────────────────────────────────────────────────────────────────────────────

import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement every plugin in this repo uses.
import { resetSkyRegistry } from './registry.ts';
import { advanceWind, resetWind } from './wind.ts';

/** Plugin name on the server, and the key `WorldApi.sibling` answers to. */
export const WEATHER_PLUGIN_NAME = 'weather';

export const plugin: TerracePlugin = {
  name: WEATHER_PLUGIN_NAME,

  onWorldCreate(): void {
    // A fresh wind on every boot, whatever a snapshot restored — this plugin has
    // no persistence slice, so there is nothing to be consistent with, and
    // drawing the boot wind here rather than at module load means a host that
    // creates two worlds in one process does not have them share a wind.
    //
    // THE REGISTRY IS NOT CLEARED HERE. Plugins create in load order and this
    // one sorts after every kind, so the four kinds have already registered by
    // the time this runs; clearing here would empty the sky at every boot. It is
    // cleared on close instead, below.
    resetWind();
  },

  onWorldClose(): void {
    // Every kind unregisters itself on close as well; this is the backstop that
    // makes the hub's own state unreachable from a world that has ended, per the
    // 2026-08-25 revocation rule.
    resetSkyRegistry();
  },

  onTick(_world: WorldApi, dt: number): void {
    // THE WHOLE TICK. The wind veers ONCE per tick and nothing else happens
    // here, which is what makes "every system this tick is displaced by the same
    // vector" a property of the code rather than a coincidence: each kind reads
    // `currentWind()` and applies it to all of its own masses in one pass.
    //
    // ORDER, NAMED: plugins tick in load order and `weather` sorts last, so the
    // kinds drift on the wind as it stood at the END of the previous tick — one
    // tick (0.1 s at the shipped TICK_HZ) of lag against the pre-split sim,
    // where the veer ran first. Coherence is untouched (every kind reads the
    // same value within a tick), and the lag is four orders of magnitude below
    // the ~20°-per-hour rate the wind actually veers at.
    advanceWind(dt);
  },
};

/**
 * THE WIND, for other plugins (2026-08-24, for fire's spread; unchanged by the
 * decomposition).
 *
 * Through the entry point rather than ./wind.ts because a bridge duck-types the
 * module it imports (plugins/fire/server/weather-bridge.ts), so what this file
 * exports IS this plugin's compatibility surface. A consumer reaching into
 * ./wind.ts would be coupling to a file layout instead of to an API.
 *
 * Read-only by construction — `currentWind` returns the live object as Readonly,
 * and only advanceWind ever writes it.
 */
export { currentWind, windVelocity, type Wind } from './wind.ts';

/**
 * THE UNION QUESTIONS, for other plugins. `precipitationAt` is what fire and
 * mudslides have always called; `livingSystems` is what phase 2's tornado will
 * filter by kind. Both are answered out of the register rather than out of a sim
 * this plugin no longer runs.
 */
export {
  livingSystems,
  precipitationAt,
  registerSkyKind,
  resetSkyRegistry,
  spawnSkyKind,
  type SkyCell,
  type SkyKindEntry,
  type SkyKindSystem,
} from './registry.ts';

/** Test seam: drops the wind and the register so a suite starts from zero. */
export function resetWeatherState(): void {
  resetSkyRegistry();
  resetWind();
}
