// THE DEV FORCE-SPAWN — an environment variable that collapses a hillside near
// the middle of the world at boot, so a developer can look at one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS, and why it is an ENV VAR rather than a setting.
//
// A slide needs steep ground, ninety seconds of rain ON that ground, and then a
// Poisson arrival whose mean is minutes. Verifying the renderer meant waiting out
// three independent random processes, which is not verification, it is luck. This
// makes the wait zero.
//
// It is NOT a PluginSettingDeclaration, deliberately, and the distinction is the
// one WorldApi.setting's doc comment draws: a setting is a choice an OPERATOR
// makes about how their world plays, offered in the world panel and persisted
// with the world. This is not a way to play — it is a way to develop, it bypasses
// both triggers the plugin exists to enforce, and putting it in the panel would
// invite somebody to turn it on for a world they care about.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO USE IT.
//
//   MUDSLIDES_DEV_FORCE=slide    collapse the steepest hillside near the centre
//
// The site is searched OUTWARD FROM THE MIDDLE OF THE WORLD, which is where a
// fresh world's revealed square is (server/src/world/initial-unlock.ts). That is
// not cosmetic: this plugin refuses to sculpt unrevealed ground at all, so a
// forced slide sited outside that square would simply not happen and the
// developer would conclude the sim was broken.
//
// Unset — which is every real deployment — this module does nothing at all.

import { startSlide, setDevFrozen, type Slide } from './slides.ts';
import { slopeAt, type MudslideWorld } from './terrain.ts';

/** The variable, and the value it accepts. */
export const MUDSLIDES_DEV_FORCE_ENV = 'MUDSLIDES_DEV_FORCE';

/**
 * How far from the centre a site is searched, in cells.
 *
 * 160 — half the edge of a fresh world's revealed square (that square is
 * INITIAL_UNLOCK_CHUNK_SPAN × CHUNK_SIZE = 320 cells), so the search covers the
 * territory a new player can see and stops at its edge rather than wandering into
 * fog. Restated rather than imported, for storms/server/dev.ts's reason: core's
 * unlock policy is not part of the plugin contract, and if it changes, a forced
 * slide lands somewhere slightly less convenient — the correct blast radius for a
 * development aid.
 */
export const DEV_SEARCH_RADIUS_CELLS = 160;

/** Cells between rings of the outward search. */
const DEV_SEARCH_STEP_CELLS = 4;

/** Samples taken around each ring. */
const DEV_SEARCH_SPOKES = 16;

/**
 * The STEEPEST startable site within the search radius, or null.
 *
 * STEEPEST RATHER THAN NEAREST, which is where this differs from storms' dev
 * search. Any patch of water will do for a cyclone; a mudslide wants the most
 * dramatic hillside available, because the whole point of the capture is to see
 * the ground move — and the first qualifying cell walking out from the centre is
 * routinely a marginal 50%-of-maximum slope whose run-out is two cells long.
 *
 * A RING SEARCH RATHER THAN A SCAN, so a tie is broken towards the middle of the
 * world (which is the revealed part) rather than towards the top-left corner of a
 * bounding box.
 */
function findSteepestSite(world: MudslideWorld): { x: number; y: number } | null {
  const centre = Math.floor(world.worldSize / 2);
  let best: { x: number; y: number } | null = null;
  let bestDrop = 0;

  for (let radius = 0; radius <= DEV_SEARCH_RADIUS_CELLS; radius += DEV_SEARCH_STEP_CELLS) {
    // The centre itself is one sample, not sixteen of the same cell.
    const spokes = radius === 0 ? 1 : DEV_SEARCH_SPOKES;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke * 2 * Math.PI) / spokes;
      const x = Math.round(centre + Math.cos(angle) * radius);
      const y = Math.round(centre + Math.sin(angle) * radius);
      const slope = slopeAt(world, x, y);
      if (slope === null) continue;
      if (slope.drop <= bestDrop) continue;
      bestDrop = slope.drop;
      best = { x, y };
    }
  }
  return best;
}

/**
 * Collapses a hillside if `MUDSLIDES_DEV_FORCE` asked for one. Call once, from
 * onWorldCreate, after the settings have been read and the slice has loaded.
 *
 * `env` is passed in rather than read from `process.env` here, for the reason
 * server/src/config.ts gives for the same choice: it keeps the one place that
 * touches the process environment visible from the caller.
 */
export function forceSlideFromEnv(
  world: MudslideWorld,
  env: Record<string, string | undefined>,
): Slide | null {
  const value = env[MUDSLIDES_DEV_FORCE_ENV]?.trim().toLowerCase();
  // Anything else — unset, empty, a typo — forces nothing. A typo here costs a
  // developer one puzzled boot; refusing to start over it would cost every real
  // deployment a way to fail.
  if (value !== 'slide' && value !== '1') return null;

  // FROZEN, for the whole life of this world: a fixture that keeps producing new
  // slides while the first one is being photographed is not a fixture.
  setDevFrozen(true);

  const site = findSteepestSite(world);
  if (site === null) {
    console.warn(
      `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: no slope steep enough within ` +
        `${DEV_SEARCH_RADIUS_CELLS} cells of the world centre`,
    );
    return null;
  }

  const slide = startSlide(world, site.x, site.y);
  if (slide === null) {
    console.warn(
      `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: (${site.x}, ${site.y}) is steep but ` +
        'has nowhere downhill to go',
    );
    return null;
  }
  console.info(
    `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: forced slide ${slide.id} at ` +
      `(${site.x}, ${site.y})`,
  );
  return slide;
}
