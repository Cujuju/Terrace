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

export const TORNADO_DEV_FORCE_ENV = devForceEnvName(TORNADO_PLUGIN_NAME);

function isLand(world: RotatingStormWorld, x: number, y: number): boolean {
  return !isWaterAt(world, x, y);
}

export function forceSpawnFromEnv(
  world: RotatingStormWorld,
  env: Record<string, string | undefined>,
): void {
  if (!readDevForce(TORNADO_DEV_FORCE_ENV, env)) return;

  tornadoes.clear();

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
  storm.envelope = 1;
  console.info(
    `[${TORNADO_PLUGIN_NAME}] ${TORNADO_DEV_FORCE_ENV}: forced a tornado at ` +
      `(${site.x}, ${site.y})`,
  );
}

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
