// THE DEV FORCE-SPAWN — an environment variable that puts a funnel in the middle
// of the world at boot, so a developer can look at one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS, and why it is an ENV VAR rather than a setting.
//
// A tornado arrives every ten minutes on a default world and every ninety
// seconds on the harshest one, somewhere, and only where a thunderstorm happens
// to be. That is the right frequency for a game and the wrong one for looking at
// the thing you just wrote: verifying the renderer meant waiting out a Poisson
// process, which is not verification, it is luck. This makes the wait zero.
//
// It is NOT a PluginSettingDeclaration, deliberately, and the distinction is the
// one WorldApi.setting's doc comment draws: a setting is a choice an OPERATOR
// makes about how their world plays, offered in the world panel and persisted
// with the world. This is not a way to play — it is a way to develop, it
// bypasses the rules this plugin exists to enforce, and putting it in the panel
// would invite somebody to turn it on for a world they care about.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO USE IT: `TORNADO_DEV_FORCE=1` — one funnel, on the nearest land to the
// centre, frozen at full strength.
//
// The site is searched OUTWARD FROM THE MIDDLE OF THE WORLD, which is where a
// fresh world's unlocked square is (server/src/world/initial-unlock.ts). That is
// not cosmetic: this plugin's broadcast is fog-of-war filtered on the funnel's
// cell, so one sited outside the unlocked square is one no client is ever told
// about — the developer would see an empty sky and conclude the renderer was
// broken.
//
// Unset — which is every real deployment — this module does nothing at all.

import {
  DEV_SEARCH_RADIUS_CELLS,
  searchOutwardFromCentre,
} from '../../../server/src/plugins/kit/devSite.ts';
import { devForceEnvName, readDevForce } from '../../../server/src/plugins/kit/devForce.ts';
import type {
  RotatingStorm,
  RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { TORNADO_PLUGIN_NAME } from '../protocol.ts';
import { isWaterAt, tornadoes } from './sim.ts';

/** The variable this plugin's switch is spelled as: `TORNADO_DEV_FORCE`. */
export const TORNADO_DEV_FORCE_ENV = devForceEnvName(TORNADO_PLUGIN_NAME);

/** Land, and land for some way around it — see the kit's clearance rule. */
function isLand(world: RotatingStormWorld, x: number, y: number): boolean {
  return !isWaterAt(world, x, y);
}

/**
 * Spawns a funnel if `TORNADO_DEV_FORCE` asked for one. Call once, from
 * onWorldCreate, after the settings have been read.
 *
 * `env` is passed in rather than read from `process.env` here, for the reason
 * server/src/config.ts gives for the same choice: it keeps the one place that
 * touches the process environment visible from the caller.
 */
export function forceSpawnFromEnv(
  world: RotatingStormWorld,
  env: Record<string, string | undefined>,
): void {
  if (!readDevForce(TORNADO_DEV_FORCE_ENV, env)) return;

  // EVERYTHING ELSE IN THE AIR IS DROPPED FIRST, so a forced world holds EXACTLY
  // the funnel that was asked for.
  //
  // Without this the hook adds to whatever the persistence slice restored, and
  // since a developer restarts the server repeatedly against the same world, the
  // second boot showed two and the third would have shown three — which is what
  // the first in-world capture caught. Dropping the list is safe here in a way
  // it would never be on the tick path: this only ever runs when the switch is
  // set, and the whole point of that variable is that this world is a fixture.
  tornadoes.clear();

  // FROZEN, for the whole life of this world. A forced world is a fixture, and a
  // fixture that walks away is not one — see the kit engine's `freeze` for the
  // frame-rate arithmetic that makes this the only way to photograph a tornado.
  tornadoes.freeze(true);

  const site = searchOutwardFromCentre(world.worldSize, (x, y) => isLand(world, x, y));
  if (site === null) {
    console.warn(
      `[${TORNADO_PLUGIN_NAME}] ${TORNADO_DEV_FORCE_ENV}: no land within ` +
        `${DEV_SEARCH_RADIUS_CELLS} cells of the world centre`,
    );
    return;
  }
  const storm = tornadoes.spawnAt(world, site.x, site.y);
  // Straight to full strength: a forced storm exists to be looked at, and
  // waiting out the profile's spin-up would reintroduce exactly the wait this
  // module removes.
  storm.envelope = 1;
  console.info(
    `[${TORNADO_PLUGIN_NAME}] ${TORNADO_DEV_FORCE_ENV}: forced a tornado at ` +
      `(${site.x}, ${site.y})`,
  );
}

/**
 * THE ADMIN PANEL'S TORNADO (2026-09-01): one funnel on the nearest land to
 * `centre` — the cell the operator is looking at — at full strength, and one
 * line saying where it went.
 *
 * NOT `forceSpawnFromEnv`: that clears the sky and freezes what is in it,
 * because it is building a photographic fixture. This adds one funnel to a world
 * that goes on being a world; the ordinary despawn cleans up after it.
 */
export function forceTornadoNear(
  world: RotatingStormWorld,
  centre: { readonly x: number; readonly y: number },
): { readonly storm: RotatingStorm | null; readonly detail: string } {
  const site = searchOutwardFromCentre(world.worldSize, (x, y) => isLand(world, x, y), centre);
  if (site === null) {
    return {
      storm: null,
      detail:
        `no land within ${DEV_SEARCH_RADIUS_CELLS} cells of (${centre.x}, ${centre.y})`,
    };
  }
  const storm = tornadoes.spawnAt(world, site.x, site.y);
  storm.envelope = 1;
  return { storm, detail: `a tornado touched down at (${site.x}, ${site.y})` };
}
