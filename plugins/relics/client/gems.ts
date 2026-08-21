// Relic presentation and picking, as pure functions.
//
// Everything in this module is deliberately free of Three.js, the DOM and
// Solid, so it is unit-testable headless — the same split the core client
// makes (design §8 "Testing": rendering is verified manually, the maths under
// it is tested). client/index.ts is the thin imperative shell that calls into
// this.

import {
  CELL_WORLD_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';
import type { RelicView, SkillId, SkillKind } from '../protocol.ts';
import { skillInfo } from '../protocol.ts';

/**
 * World units per cell edge — re-exported from @terrace/shared so this file's
 * callers keep their import site.
 *
 * THE API GAP THIS RESTATEMENT NAMED IS CLOSED, and not the way it proposed
 * (2026-08-21). It used to be a local `= 1`, correct only because a cell
 * happened to be a world unit, with a note that a `cellToWorld` on the ctx was
 * the right fix. The re-sample made every such restatement wrong at once, so
 * the ratio moved into shared instead — which every plugin can already import,
 * unlike client/src/config.ts (that module reads `import.meta.env` and would
 * drag Vite's ambient types into this package's compile). A ctx method would
 * have solved it for plugins that render through the ctx and left this plugin's
 * pure-arithmetic modules, which have no ctx, exactly where they were.
 */
export { CELL_WORLD_SIZE };

/**
 * Emissive colour per skill category. Category, not skill: a player learns
 * three colours and can then read any relic in the world at a glance, including
 * ones carrying skills added after they last played.
 *
 * Amber / crimson / azure are chosen to stay separable against the terrain
 * palette (greens and browns) and against the sea (blue-grey) — the azure is
 * pushed light and saturated for exactly that reason.
 */
export const SKILL_KIND_COLOR: Readonly<Record<SkillKind, number>> = {
  passive: 0xffb347,
  active: 0xff5c5c,
  perk: 0x4fc3f7,
};

export function relicColor(skill: SkillId): number {
  return SKILL_KIND_COLOR[skillInfo(skill).kind];
}

/**
 * The same colour as a CSS string, so the HUD's swatch for a skill and the gem
 * in the world are the one value. Padded to six digits — '#4fc3f7' is fine but
 * a colour whose top byte is zero would otherwise emit a four-digit string that
 * CSS reads as #RGBA.
 */
export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Gem half-height, in WORLD UNITS. Under half a unit so two adjacent gems never touch. */
export const GEM_RADIUS_CELLS = 0.45;

/**
 * How far above the rendered surface a gem floats, in WORLD UNITS — a vertical
 * offset, so it never touched the horizontal re-sample. One and a bit units:
 * clear of a single terrace riser (BAND_WORLD_HEIGHT is a quarter of a world
 * unit, client/src/config.ts) so a gem on a step is never half-buried in the
 * step above it, and low enough to still read as "on" that cell.
 */
export const GEM_HOVER_CELLS = 1.2;

/** Peak-to-centre bob, in WORLD UNITS. A quarter unit: motion you notice, not
 * motion that moves the gem off the cell it marks. */
export const GEM_BOB_AMPLITUDE_CELLS = 0.25;

/** Seconds per bob cycle. Slow — this is idle ambience, not an alert. */
export const GEM_BOB_PERIOD_S = 3;

/** Rotations per second about the vertical axis. 6 s a turn: the facets catch
 * the light in sequence rather than strobing. */
export const GEM_SPIN_TURNS_PER_S = 1 / 6;

const TAU = Math.PI * 2;

/**
 * A per-relic phase offset in [0, GEM_BOB_PERIOD_S), derived from the relic id.
 *
 * Without it every gem in the world bobs and spins in perfect lockstep, which
 * reads as a UI animation rather than as objects. A hash of the id (rather than
 * a random draw) keeps a given relic's phase stable across the re-broadcasts of
 * the relic list, so a gem does not jump when a keepalive arrives.
 *
 * FNV-1a, 32-bit: short, no dependencies, and well-spread on the short
 * ascending ids this plugin generates ("r1", "r2", …), which a naive
 * character-sum hash would map to adjacent phases.
 */
export function gemPhaseFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x100000000) * GEM_BOB_PERIOD_S;
}

/** Vertical bob offset in world units at a given elapsed time. */
export function gemBobOffset(elapsedS: number, phaseS: number): number {
  return Math.sin(((elapsedS + phaseS) / GEM_BOB_PERIOD_S) * TAU) * GEM_BOB_AMPLITUDE_CELLS;
}

/** Spin angle in radians at a given elapsed time. */
export function gemSpinAngle(elapsedS: number, phaseS: number): number {
  return (elapsedS + phaseS) * GEM_SPIN_TURNS_PER_S * TAU;
}

/**
 * PICKING TOLERANCE, in cells, around the terrain cell under the cursor.
 *
 * WHY THIS IS A PROXIMITY TEST AND NOT A RAYCAST. The natural implementation is
 * to raycast the plugin's own layer, but ClientPluginCtx exposes no camera (and
 * the app's camera is never added to the scene, so it cannot be found by
 * walking up from `layer` either — client/src/render/scene.ts). What the ctx
 * DOES expose is pickTerrainCell, the app's own click → ground ray. So a click
 * is resolved to a ground cell and a relic near that cell is claimed.
 *
 * 4 WORLD UNITS, converted (owner, 2026-08-14: "make the hitbox for relics two
 * times larger" — doubled from the original 2). It is a distance on the ground
 * measured against a gem the player is aiming at, so it is stated in the units
 * the gem is modelled in rather than in samples of the terrain. The floor of
 * the sizing is parallax: a gem floats GEM_HOVER_CELLS above the surface, so
 * the ray that visually passes through it lands on the ground a little beyond
 * it — at the default 55° polar orbit that offset is on the order of one world
 * unit. Everything above the
 * floor is deliberate generosity: a relic is a pickup, pickups should be
 * forgiving to click (doubly so on touch, where the finger hides the gem),
 * and the server validates the CLAIM, not the aim (see the identity notes in
 * server/index.ts), so a loose tolerance costs nothing. Relics spawn far
 * apart, and `relicUnderCell` resolves to the NEAREST candidate anyway, so
 * even overlapping tolerances still claim the gem actually clicked.
 *
 * Cross-referenced in the report as the second half of the same API gap as
 * CELL_WORLD_SIZE above (whose half is now closed — see its comment); a
 * `pickPluginObject` on the ctx would replace this one.
 */
export const RELIC_PICK_RADIUS_CELLS = cellsAcross(4);

/**
 * The relic a click on `cell` should claim: the nearest one within the
 * tolerance, or null. Nearest rather than first so that two relics close
 * together still resolve to the one actually clicked.
 */
export function relicUnderCell(
  relics: readonly RelicView[],
  cell: { x: number; y: number },
): RelicView | null {
  const limitSquared = RELIC_PICK_RADIUS_CELLS * RELIC_PICK_RADIUS_CELLS;

  let best: RelicView | null = null;
  let bestSquared = Number.POSITIVE_INFINITY;

  for (const relic of relics) {
    const dx = relic.x - cell.x;
    const dy = relic.y - cell.y;
    const squared = dx * dx + dy * dy;
    if (squared > limitSquared || squared >= bestSquared) continue;
    best = relic;
    bestSquared = squared;
  }

  return best;
}

/** Whole seconds a cooldown has left, as the HUD counts it down. */
export function cooldownLabelSeconds(remainingS: number): number {
  return Math.ceil(remainingS);
}
