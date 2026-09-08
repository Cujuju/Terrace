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

export const CYCLONE_DEV_FORCE_ENV = devForceEnvName(CYCLONE_PLUGIN_NAME);

function isWater(world: RotatingStormWorld, x: number, y: number): boolean {
  return isWaterAt(world, x, y);
}

export function forceSpawnFromEnv(
  world: RotatingStormWorld,
  env: Record<string, string | undefined>,
): void {
  if (!readDevForce(CYCLONE_DEV_FORCE_ENV, env)) return;

  cyclones.clear();

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
  storm.envelope = 1;
  console.info(
    `[${CYCLONE_PLUGIN_NAME}] ${CYCLONE_DEV_FORCE_ENV}: forced ${storm.name ?? 'a cyclone'} ` +
      `at (${site.x}, ${site.y})`,
  );
}

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
