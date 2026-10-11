import type { PluginActionOutcome, PluginActionSite } from '../types.ts';
import { readDevForce } from './devForce.ts';
import { DEV_SEARCH_RADIUS_CELLS, searchOutwardFromCentre } from './devSite.ts';
import type { RotatingStorm, RotatingStorms, RotatingStormWorld } from './rotatingStormTypes.ts';

export interface RotatingStormSummonSpec {
  readonly storms: RotatingStorms;
  readonly world: RotatingStormWorld;
  readonly site: PluginActionSite;
  accepts(world: RotatingStormWorld, x: number, y: number): boolean;
  readonly forcedEnv: string;
  readonly ceiling: number;
  // The storms, in the form their ceiling takes: "1 cyclone", "2 tornadoes".
  readonly noun: string;
  // The ground the kind needs under it: "land", "open water".
  readonly sitingNoun: string;
  // The dev force: park the sky on this one storm once a site is found.
  readonly forceNear?: boolean;
}

export interface RotatingStormDevSpec {
  readonly storms: RotatingStorms;
  readonly pluginName: string;
  accepts(world: RotatingStormWorld, x: number, y: number): boolean;
  readonly noun: string;
  readonly sitingNoun: string;
  readonly envName: string;
}

export interface RotatingStormDev {
  forceFromEnv(world: RotatingStormWorld, env?: Record<string, string | undefined>): void;
  forceNear(
    world: RotatingStormWorld,
    centre: { readonly x: number; readonly y: number },
  ): { readonly storm: RotatingStorm | null; readonly detail: string };
}

// The summon rule every rotating-storm kind shares: a parked or full sky
// refuses with its own message; otherwise the storm lands at full strength on
// the nearest accepted ground.
export function summonRotatingStorm(
  spec: RotatingStormSummonSpec,
): RotatingStorm | PluginActionOutcome {
  if (spec.storms.isFrozen()) {
    return {
      ok: false,
      detail: `${spec.forcedEnv} is set — the sky is parked; unset it and restart`,
    };
  }
  if (!Number.isFinite(spec.site.x) || !Number.isFinite(spec.site.y)) {
    return { ok: false, detail: 'that is not a place in this world' };
  }
  const parks = spec.forceNear === true;
  if (!parks && spec.storms.count() >= spec.ceiling) {
    return {
      ok: false,
      detail: `${spec.ceiling} ${spec.noun} ${spec.ceiling === 1 ? 'is' : 'are'} already in the air`,
    };
  }

  const found = searchOutwardFromCentre(
    spec.world.worldSize,
    (x, y) => spec.accepts(spec.world, x, y),
    spec.site,
  );
  if (found === null) {
    return {
      ok: false,
      detail:
        `no ${spec.sitingNoun} within ${DEV_SEARCH_RADIUS_CELLS} cells of ` +
        `(${spec.site.x}, ${spec.site.y})`,
    };
  }

  if (parks) {
    spec.storms.clear();
    spec.storms.freeze(true);
  }
  const storm = spec.storms.spawnAt(spec.world, found.x, found.y);
  storm.envelope = 1;
  return storm;
}

export function isRotatingStormRefusal(
  result: RotatingStorm | PluginActionOutcome,
): result is PluginActionOutcome {
  return 'ok' in result;
}

// The dev force both kinds copied: park the sky on one storm, at the world
// centre or wherever the caller points, and say so on the console.
export function createRotatingStormDev(spec: RotatingStormDevSpec): RotatingStormDev {
  function forceNear(
    world: RotatingStormWorld,
    centre: { readonly x: number; readonly y: number },
  ): { readonly storm: RotatingStorm | null; readonly detail: string } {
    const summoned = summonRotatingStorm({
      storms: spec.storms,
      world,
      site: centre,
      accepts: spec.accepts,
      forcedEnv: spec.envName,
      ceiling: spec.storms.maxActive,
      noun: spec.noun,
      sitingNoun: spec.sitingNoun,
      forceNear: true,
    });
    if (isRotatingStormRefusal(summoned)) return { storm: null, detail: summoned.detail };
    return {
      storm: summoned,
      detail: `${summoned.name ?? spec.pluginName} at (${summoned.x}, ${summoned.y})`,
    };
  }

  return {
    forceNear,

    forceFromEnv(world: RotatingStormWorld, env = process.env): void {
      if (!readDevForce(spec.envName, env)) return;
      const centre = { x: Math.floor(world.worldSize / 2), y: Math.floor(world.worldSize / 2) };
      const { storm, detail } = forceNear(world, centre);
      if (storm === null) {
        console.warn(`[${spec.pluginName}] ${spec.envName}: ${detail}`);
        return;
      }
      console.info(`[${spec.pluginName}] ${spec.envName}: forced ${detail}`);
    },
  };
}
