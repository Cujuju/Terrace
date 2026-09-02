// THE DEV FORCE-SPAWN — an environment variable that puts a storm in the middle
// of the world at boot, so a developer can look at one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS, and why it is an ENV VAR rather than a setting.
//
// A cyclone arrives every forty minutes on a default world and every six on the
// harshest one, over water, somewhere. That is the right frequency for a game
// and the wrong one for looking at the thing you just wrote: verifying the
// renderer meant waiting out a Poisson process, which is not verification, it
// is luck. This makes the wait zero.
//
// It is NOT a PluginSettingDeclaration, deliberately, and the distinction is
// the one WorldApi.setting's doc comment draws: a setting is a choice an
// OPERATOR makes about how their world plays, offered in the world panel and
// persisted with the world. This is not a way to play — it is a way to develop,
// it bypasses the rules the plugin exists to enforce (./storms.ts's
// `spawnStormAt`), and putting it in the panel would invite somebody to turn it
// on for a world they care about.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO USE IT.
//
//   STORMS_DEV_FORCE=tornado   one funnel, on the nearest land to the centre
//   STORMS_DEV_FORCE=cyclone   one cyclone, on the nearest open water
//   STORMS_DEV_FORCE=both      one of each
//
// The site is searched OUTWARD FROM THE MIDDLE OF THE WORLD, which is where a
// fresh world's unlocked square is (server/src/world/initial-unlock.ts). That
// is not cosmetic: this plugin's broadcast is fog-of-war filtered on the eye's
// cell, so a storm sited outside the unlocked square is a storm no client is
// ever told about — the developer would see an empty sky and conclude the
// renderer was broken.
//
// Unset — which is every real deployment — this module does nothing at all.

import { SEA_LEVEL } from '@terrace/shared';
import {
  DEV_SEARCH_RADIUS_CELLS,
  DEV_SEARCH_STEP_CELLS,
} from '../../../server/src/plugins/kit/devSite.ts';
import { clearStorms, setDevFrozen, spawnStormAt, type Storm, type StormWorld } from './storms.ts';
import type { StormKind } from '../protocol.ts';

/** The variable, and the three values it accepts. */
export const STORMS_DEV_FORCE_ENV = 'STORMS_DEV_FORCE';

// The reach — how far out a forced site may be looked for, and how coarsely —
// is the plugin kit's (server/src/plugins/kit/devSite.ts), because mudslides'
// force-spawn wanted exactly the same two numbers for exactly the same reason.
// THE SEARCH ITSELF STAYED HERE: this one wants the NEAREST patch of the right
// ground, so it walks outward in rings; mudslides' wants the BEST hillside, so
// it scans a grid. See the kit module's header.
export { DEV_SEARCH_RADIUS_CELLS, DEV_SEARCH_STEP_CELLS };

/** Samples taken around each ring. */
const DEV_SEARCH_SPOKES = 16;

/**
 * How far around a candidate must match it, in cells.
 *
 * THIRTY-TWO — eight world units. Without this the search returns the FIRST
 * cell of the right kind, which walking outward from a sea centre means the
 * very edge of the first beach: the forced tornado stood in the surf and
 * photographed as a waterspout. Requiring the four cells this far out to agree
 * puts a forced funnel on ground that is properly inland (and a forced cyclone
 * in water that is properly open) without needing a second area test.
 */
const DEV_SITE_CLEARANCE_CELLS = 32;

/** The four bearings a candidate's clearance is checked along. */
const CLEARANCE_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The first cell at or near the centre that is water (for a cyclone) or land
 * (for a tornado), or null if the search found none.
 *
 * A RING SEARCH RATHER THAN A SCAN, because the answer wanted is "as close to
 * the middle as possible": an ordinary raster scan would find the site nearest
 * the top-left corner of the search box instead.
 */
/** Is (x, y) the kind of ground this search wants? */
function matchesKind(world: StormWorld, x: number, y: number, wantWater: boolean): boolean {
  return (world.heightAt(x, y) <= SEA_LEVEL) === wantWater;
}

function findSite(
  world: StormWorld,
  wantWater: boolean,
  // The boot-time force searches from the middle of the world; the admin
  // panel's action (`forceStormNear`) from wherever the operator is looking.
  centre: { x: number; y: number } = {
    x: Math.floor(world.worldSize / 2),
    y: Math.floor(world.worldSize / 2),
  },
): { x: number; y: number } | null {
  for (let radius = 0; radius <= DEV_SEARCH_RADIUS_CELLS; radius += DEV_SEARCH_STEP_CELLS) {
    // The centre itself is one sample, not sixteen of the same cell.
    const spokes = radius === 0 ? 1 : DEV_SEARCH_SPOKES;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke * 2 * Math.PI) / spokes;
      const x = Math.round(centre.x + Math.cos(angle) * radius);
      const y = Math.round(centre.y + Math.sin(angle) * radius);
      if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
      if (!matchesKind(world, x, y, wantWater)) continue;
      // Clearance: the same kind of ground DEV_SITE_CLEARANCE_CELLS away on
      // every bearing. A sample that falls outside the world fails, which keeps
      // a forced storm off the map edge as well as off the shoreline.
      let clear = true;
      for (const [dx, dy] of CLEARANCE_OFFSETS) {
        const cx = x + dx * DEV_SITE_CLEARANCE_CELLS;
        const cy = y + dy * DEV_SITE_CLEARANCE_CELLS;
        if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) {
          clear = false;
          break;
        }
        if (!matchesKind(world, cx, cy, wantWater)) {
          clear = false;
          break;
        }
      }
      if (clear) return { x, y };
    }
  }
  return null;
}

/** Which kinds this world was asked to force, from the environment. */
function requestedKinds(value: string | undefined): readonly StormKind[] {
  switch (value?.trim().toLowerCase()) {
    case 'tornado':
      return ['tornado'];
    case 'cyclone':
      return ['cyclone'];
    case 'both':
      return ['tornado', 'cyclone'];
    default:
      // Anything else — unset, empty, a typo — forces nothing. A typo here
      // costs a developer one puzzled boot; refusing to start over it would
      // cost every real deployment a way to fail.
      return [];
  }
}

/**
 * Spawns whatever `STORMS_DEV_FORCE` asked for. Call once, from onWorldCreate,
 * after the settings have been read.
 *
 * `env` is passed in rather than read from `process.env` here, for the reason
 * server/src/config.ts gives for the same choice: it keeps the one place that
 * touches the process environment visible from the caller.
 */
export function forceSpawnFromEnv(
  world: StormWorld,
  env: Record<string, string | undefined>,
): void {
  const kinds = requestedKinds(env[STORMS_DEV_FORCE_ENV]);
  if (kinds.length === 0) return;

  // EVERYTHING ELSE IN THE AIR IS DROPPED FIRST, so a forced world holds
  // EXACTLY the storms that were asked for.
  //
  // Without this the hook adds to whatever the persistence slice restored, and
  // since a developer restarts the server repeatedly against the same world,
  // the second boot showed two cyclones and the third would have shown three —
  // which is what the first in-world capture caught. Dropping the list is safe
  // here in a way it would never be on the tick path: this only ever runs when
  // STORMS_DEV_FORCE is set, and the whole point of that variable is that this
  // world is a fixture.
  clearStorms();

  // FROZEN, for the whole life of this world. A forced world is a fixture, and
  // a fixture that walks away is not one — see setDevFrozen for the frame-rate
  // arithmetic that makes this the only way to photograph a tornado.
  setDevFrozen(true);

  for (const kind of kinds) {
    const site = findSite(world, kind === 'cyclone');
    if (site === null) {
      console.warn(
        `[storms] ${STORMS_DEV_FORCE_ENV}=${kind}: no ` +
          `${kind === 'cyclone' ? 'open water' : 'land'} within ` +
          `${DEV_SEARCH_RADIUS_CELLS} cells of the world centre`,
      );
      continue;
    }
    const storm = spawnStormAt(world, kind, site.x, site.y);
    // Straight to full strength: a forced storm exists to be looked at, and
    // waiting out CYCLONE_PROFILE's 45-second spin-up would reintroduce exactly
    // the wait this module removes.
    storm.envelope = 1;
    console.info(
      `[storms] ${STORMS_DEV_FORCE_ENV}: forced ${storm.name ?? storm.kind} ` +
        `at (${site.x}, ${site.y})`,
    );
  }
}

/**
 * THE ADMIN PANEL'S STORM (2026-09-01): one storm of `kind` on the nearest
 * qualifying ground to `centre` — the cell the operator is looking at — at
 * full strength, and one line saying where it went.
 *
 * NOT `forceSpawnFromEnv`: that clears the sky and freezes every storm in it,
 * because it is building a photographic fixture. This adds one storm to a
 * world that goes on being a world; the ordinary despawn cleans up after it.
 */
export function forceStormNear(
  world: StormWorld,
  kind: StormKind,
  centre: { x: number; y: number },
): { readonly storm: Storm | null; readonly detail: string } {
  const site = findSite(world, kind === 'cyclone', centre);
  if (site === null) {
    return {
      storm: null,
      detail:
        `no ${kind === 'cyclone' ? 'open water' : 'land'} within ${DEV_SEARCH_RADIUS_CELLS} ` +
        `cells of (${centre.x}, ${centre.y})`,
    };
  }
  const storm = spawnStormAt(world, kind, site.x, site.y);
  // Straight to full strength, for the boot-time force's reason: a forced
  // storm exists to be looked at now.
  storm.envelope = 1;
  return { storm, detail: `${storm.name ?? storm.kind} spawned at (${site.x}, ${site.y})` };
}
