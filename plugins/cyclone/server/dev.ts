// THE DEV FORCE-SPAWN — an environment variable that puts a cyclone on the
// nearest open water to the middle of the world at boot, so a developer can look
// at one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS, and why it is an ENV VAR rather than a setting.
//
// A cyclone arrives every forty minutes on a default world and every six on the
// harshest one, over water, somewhere. That is the right frequency for a game
// and the wrong one for looking at the thing you just wrote: verifying the
// renderer meant waiting out a Poisson process, which is not verification, it is
// luck. This makes the wait zero.
//
// It is NOT a PluginSettingDeclaration, deliberately, and the distinction is the
// one WorldApi.setting's doc comment draws: a setting is a choice an OPERATOR
// makes about how their world plays, offered in the world panel and persisted
// with the world. This is not a way to play — it is a way to develop, it
// bypasses the rules this plugin exists to enforce, and putting it in the panel
// would invite somebody to turn it on for a world they care about.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO USE IT: `CYCLONE_DEV_FORCE=1` — one cyclone, over the nearest open
// water to the centre, frozen at full strength.
//
// The site is searched OUTWARD FROM THE MIDDLE OF THE WORLD, which is where a
// fresh world's unlocked square is (server/src/world/initial-unlock.ts). That is
// not cosmetic: this plugin's broadcast is fog-of-war filtered on the eye's
// cell, so a storm sited outside the unlocked square is a storm no client is
// ever told about — the developer would see an empty sky and conclude the
// renderer was broken.
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
import { CYCLONE_PLUGIN_NAME } from '../protocol.ts';
import { cyclones, isWaterAt } from './sim.ts';

/** The variable this plugin's switch is spelled as: `CYCLONE_DEV_FORCE`. */
export const CYCLONE_DEV_FORCE_ENV = devForceEnvName(CYCLONE_PLUGIN_NAME);

/**
 * The cell test the site search runs.
 *
 * WATER, CELL BY CELL, rather than the disc-fraction test a natural birth uses
 * (./sim.ts's `isOpenWater`): the search's own clearance rule already demands
 * the same ground 32 cells out on four bearings, which is what puts a forced
 * cyclone in water that is properly open. Asking for the area test as well would
 * be two overlapping definitions of "open water" for a development aid.
 */
function isWater(world: RotatingStormWorld, x: number, y: number): boolean {
  return isWaterAt(world, x, y);
}

/**
 * Spawns a cyclone if `CYCLONE_DEV_FORCE` asked for one. Call once, from
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
  if (!readDevForce(CYCLONE_DEV_FORCE_ENV, env)) return;

  // EVERYTHING ELSE IN THE AIR IS DROPPED FIRST, so a forced world holds EXACTLY
  // the storm that was asked for.
  //
  // Without this the hook adds to whatever the persistence slice restored, and
  // since a developer restarts the server repeatedly against the same world, the
  // second boot showed two cyclones and the third would have shown three — which
  // is what the first in-world capture caught. Dropping the list is safe here in
  // a way it would never be on the tick path: this only ever runs when the
  // switch is set, and the whole point of that variable is that this world is a
  // fixture.
  cyclones.clear();

  // FROZEN, for the whole life of this world. A forced world is a fixture, and a
  // fixture that walks away is not one — see the kit engine's `freeze`.
  cyclones.freeze(true);

  const site = searchOutwardFromCentre(world.worldSize, (x, y) => isWater(world, x, y));
  if (site === null) {
    console.warn(
      `[${CYCLONE_PLUGIN_NAME}] ${CYCLONE_DEV_FORCE_ENV}: no open water within ` +
        `${DEV_SEARCH_RADIUS_CELLS} cells of the world centre`,
    );
    return;
  }
  const storm = cyclones.spawnAt(world, site.x, site.y);
  // Straight to full strength: a forced storm exists to be looked at, and
  // waiting out the profile's 45-second spin-up would reintroduce exactly the
  // wait this module removes.
  storm.envelope = 1;
  console.info(
    `[${CYCLONE_PLUGIN_NAME}] ${CYCLONE_DEV_FORCE_ENV}: forced ${storm.name ?? 'a cyclone'} ` +
      `at (${site.x}, ${site.y})`,
  );
}

/**
 * THE ADMIN PANEL'S CYCLONE (2026-09-01): one storm over the nearest open water
 * to `centre` — the cell the operator is looking at — at full strength, and one
 * line saying where it went.
 *
 * NOT `forceSpawnFromEnv`: that clears the sky and freezes what is in it, because
 * it is building a photographic fixture. This adds one storm to a world that
 * goes on being a world; the ordinary despawn cleans up after it.
 */
export function forceCycloneNear(
  world: RotatingStormWorld,
  centre: { readonly x: number; readonly y: number },
): { readonly storm: RotatingStorm | null; readonly detail: string } {
  const site = searchOutwardFromCentre(world.worldSize, (x, y) => isWater(world, x, y), centre);
  if (site === null) {
    return {
      storm: null,
      detail: `no open water within ${DEV_SEARCH_RADIUS_CELLS} cells of (${centre.x}, ${centre.y})`,
    };
  }
  const storm = cyclones.spawnAt(world, site.x, site.y);
  storm.envelope = 1;
  return { storm, detail: `${storm.name ?? 'a cyclone'} spawned at (${site.x}, ${site.y})` };
}
