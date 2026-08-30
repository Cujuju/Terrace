// previewRivers.ts — THROWAWAY preview harness for the river rig, mirroring
// previewBoats.ts. Not part of the shipped app: reached only through
// preview-rivers.html.
//
//   ?scene=<fork|meander|terrace|basin|stairpools|cliffs>
//                                 — fixture; defaults to "fork"
//   ?view=<iso|side|top>           — camera angle; defaults to "iso"
//   ?zoom=<number>                 — camera distance multiplier; defaults to 1
//   ?at=<cellX>,<cellZ>            — the point the camera LOOKS AT, in CELL
//                                  coordinates; defaults to the world centre.
//                                  Malformed or out-of-bounds input falls back
//                                  to the centre rather than throwing.
//   ?dir=<x>,<y>,<z>               — free camera DIRECTION (a vector,
//                                  normalised), overriding ?view when present;
//                                  defaults to ?view's vector. Malformed,
//                                  zero-length or non-finite input falls back
//                                  to ?view rather than throwing.
// ?zoom keeps its meaning under ?at: it multiplies the camera's DISTANCE from
// the look-at point, so `?at=<a cliff>&zoom=0.15` frames that cliff close up.
//
// WHAT THIS EXISTS TO SHOW, and why the live client could not. The two things
// under test — "a channel reads as a smoothed polyline, not a row of squares"
// and "a river that has two ways down takes both" — need terrain of a KNOWN
// shape, lit well enough to see, held still. In the live world the shape is
// whatever the players sculpted, the daynight plugin owns the lighting (and
// rewrites it ten times a second, which no screenshot driver can outvote), and
// rivers only exist where somebody happened to build a hill. Here the
// heightmap is built by hand, so the fork is guaranteed and its position is
// known before the frame is drawn.
//
// It drives the REAL modules, not a copy: `createTerrainMeshes` for the ground
// and `createRiverRig` for the water, over a real `TerrainMirror`. What it
// stubs is only the things a preview has no business having — a server, a
// network, and a day/night cycle.
//
// A screenshot driver waits for `window.__previewReady === true`.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  SEA_LEVEL,
  SPRING_MIN_HEIGHT_ABOVE_SEA,
  cellIndex,
  chunkIndex,
  chunksPerEdge,
  computeRiverNetwork,
  riverPoints,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { createTerrainMirror, type TerrainMirror } from './terrain/mirror.ts';
import { createTerrainMeshes } from './render/terrainMeshes.ts';
import { chunkContourLoops } from './terrain/vertexGrid.ts';
import { createRiverRig } from './render/riverRig.ts';
import { createDrawnGround } from './terrain/drawnGround.ts';

// ── Lighting rig, copied from previewBoats.ts / render/scene.ts ──────────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const BACKDROP_COLOR = 0x9fc7e8;
const SETTLE_FRAME_COUNT = 6;

/**
 * The fixture world's edge, in cells. One chunk (CHUNK_SIZE) is too small to
 * hold a course with room either side of it; four chunks is the smallest that
 * frames a whole river without the frame being mostly empty ground.
 */
const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 4;

/**
 * Every fixture's summit, in height units. Comfortably over
 * SPRING_MIN_HEIGHT_ABOVE_SEA so the peak always qualifies as a spring, with
 * enough headroom left for a long staircase down to the sea.
 */
const SUMMIT_HEIGHT = SEA_LEVEL + SPRING_MIN_HEIGHT_ABOVE_SEA * 4;

/**
 * Height lost per cell of descent, in height units.
 *
 * A QUARTER OF A BAND, so a band edge — and therefore a waterfall — comes
 * every four cells. The first fixture dropped two whole bands per cell, which
 * put a plunge-pool effect (three ripple rings and a foam dome) on EVERY cell
 * of every course; the water underneath was completely hidden by its own
 * spray, and the shot said nothing about the ribbon it was meant to show.
 * `?descent=<height units per cell>` overrides it for a deliberately dramatic
 * staircase.
 */
const DESCENT_PER_CELL = (() => {
  const raw = Number(new URLSearchParams(window.location.search).get('descent'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BAND_HEIGHT / 4;
})();

type SceneName = 'fork' | 'meander' | 'terrace' | 'basin' | 'stairpools' | 'cliffs';

/**
 * Lowers a spring cell's four neighbours to just under it.
 *
 * A cell with anything at or above it beside it is not a local maximum, so
 * without this a fixture can produce no spring — and therefore no river — at
 * all. One unit under the summit is enough: it clears the maximum test while
 * staying far above the channel, so it can never be mistaken for a way down.
 */
function openSpring(mirror: TerrainMirror, x: number, y: number): void {
  const map = mirror.map;
  const summit = map.cells[cellIndex(map, x, y)]!;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= PREVIEW_WORLD_SIZE || ny >= PREVIEW_WORLD_SIZE) continue;
    const index = cellIndex(map, nx, ny);
    map.cells[index] = Math.min(map.cells[index]!, summit - 1);
  }
}

/**
 * FORK — a square cone, one DESCENT_PER_CELL per ring.
 *
 * The shape a symmetric brush stroke makes, and the whole point of the shot:
 * the summit's four neighbours are EXACTLY tied, so the water has four equally
 * good ways down and takes all four. Under the old tie-break it took one and
 * the other three sides of the hill stayed dry.
 *
 * Same-ring cells tie all the way down as well, but a tie only forks the
 * course where the tied cells are strictly BELOW the current one — which, on a
 * cone, is only at the summit. So this draws four courses, not a flood.
 */
function buildFork(mirror: TerrainMirror): void {
  const map = mirror.map;
  const centre = Math.floor(PREVIEW_WORLD_SIZE / 2);
  /** Rings between the summit and the shore — the cone must END inside the
   *  fixture. A cone still above SEA_LEVEL at the map border leaves its whole
   *  outer ring flat and equal, which reads to the tracer as one enormous
   *  closed basin: the first course pools all the way round the border and
   *  every other branch merges into it two cells in. */
  const RINGS_TO_SHORE = Math.floor(PREVIEW_WORLD_SIZE / 2) - 4;
  const dropPerRing = Math.max(DESCENT_PER_CELL, Math.ceil(SUMMIT_HEIGHT / RINGS_TO_SHORE));
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const ring = Math.max(Math.abs(x - centre), Math.abs(y - centre));
      map.cells[cellIndex(map, x, y)] = SUMMIT_HEIGHT - ring * dropPerRing;
    }
  }
}

/**
 * Fills the map with a plain hillside falling away to the south at
 * `dropPerRow`, and returns that hillside's height at a given row.
 *
 * A RAMP RATHER THAN A WALLED SLOT (the fixture this replaced). Filling
 * everything with one tall constant made the channel a one-cell canyon
 * hundreds of units deep, and the screenshot showed a crack in a mesa instead
 * of a river on a hill. A ramp puts the carved channel just under terrain that
 * is already sloping the same way, which is what real ground around a river
 * looks like.
 *
 * `dropPerRow` is the caller's to match to its own channel: a channel that
 * wanders sideways covers more cells than it does rows, so it descends faster
 * per ROW than it does per cell, and a hillside that ignored that would end up
 * hundreds of units above the water it is supposed to bank.
 * RIDGE_CLEARANCE_BANDS is how far those banks stand over the water.
 */
const RIDGE_CLEARANCE_BANDS = 2;
function fillHillside(mirror: TerrainMirror, dropPerRow: number): (row: number) => number {
  const map = mirror.map;
  const heightAtRow = (row: number): number =>
    SUMMIT_HEIGHT + RIDGE_CLEARANCE_BANDS * BAND_HEIGHT - row * dropPerRow;
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    const h = heightAtRow(y);
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) map.cells[cellIndex(map, x, y)] = h;
  }
  return heightAtRow;
}

/**
 * MEANDER: one channel carved into the hillside that turns repeatedly — a
 * 4-connected staircase of hard 90° corners, which is exactly the shape that
 * used to render as a row of disconnected squares.
 */
function buildMeander(mirror: TerrainMirror): void {
  const map = mirror.map;
  /** Cells travelled between turns. */
  const RUN_CELLS = 3;
  // The channel covers RUN_CELLS east then RUN_CELLS south, so it spends two
  // cells of descent for every one row it advances — see fillHillside.
  fillHillside(mirror, DESCENT_PER_CELL * 2);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  let x = 3;
  let y = 1;
  let h = SUMMIT_HEIGHT;
  set(x, y, h); // the spring
  let goingEast = true;
  while (x < PREVIEW_WORLD_SIZE - 2 && y < PREVIEW_WORLD_SIZE - 2) {
    for (let i = 0; i < RUN_CELLS; i++) {
      if (goingEast) x++;
      else y++;
      if (x >= PREVIEW_WORLD_SIZE - 1 || y >= PREVIEW_WORLD_SIZE - 1) break;
      h -= DESCENT_PER_CELL;
      set(x, y, h);
    }
    goingEast = !goingEast;
  }
  openSpring(mirror, 3, 1);
}

/**
 * TERRACE: a straight channel down a staircase whose treads are several cells
 * long, so each band edge is a distinct riser. Shows how the ribbon crosses a
 * terrace lip — the one place its height is not continuous.
 */
function buildTerrace(mirror: TerrainMirror): void {
  const map = mirror.map;
  /** Cells per tread — long enough that a tread is visibly flat. */
  const TREAD_CELLS = 4;
  // A straight channel advances one row per cell, so the hillside matches it.
  fillHillside(mirror, DESCENT_PER_CELL);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const x = Math.floor(PREVIEW_WORLD_SIZE / 2);
  set(x, 1, SUMMIT_HEIGHT);
  for (let y = 2; y < PREVIEW_WORLD_SIZE; y++) {
    const tread = Math.floor((y - 2) / TREAD_CELLS);
    // Minus 2·(y - 1) as well as the tread drop, for two reasons: within a
    // tread the channel must still fall (or the course sees no strictly-lower
    // neighbour and pools), and its FIRST cell must land strictly under the
    // summit-minus-one that openSpring leaves the other three neighbours at —
    // otherwise all four tie and three dead-end branches fork off the spring.
    set(x, y, SUMMIT_HEIGHT - tread * DESCENT_PER_CELL * TREAD_CELLS - 2 * (y - 1));
  }
  openSpring(mirror, x, 1);
}

/**
 * BASIN: a straight channel that runs into a walled bowl, fills it, and spills
 * out of the one gap in its rim — the fixture for LAKE geometry.
 *
 * The other three fixtures never pool: every one of their courses always has a
 * strictly lower neighbour, so `fillBasin` is never reached and the pool mesh
 * stays empty. A lake needs a closed depression, and its outline is only worth
 * looking at if that depression is not a rectangle — so the bowl is a disc
 * (which the cell lattice can only approximate, which is the whole point) with
 * one lobe pushed out of its east side, giving the outline both convex arcs and
 * a concave neck to round.
 */
function buildBasin(mirror: TerrainMirror): void {
  const map = mirror.map;
  /**
   * Radius of the bowl, in cells.
   *
   * BOUNDED BY THE TRACE BUDGET, not by taste: one river may spend
   * `map.size * RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER` cells in total
   * (shared/src/rivers.ts), the channel above the bowl spends about half the
   * fixture's edge getting here, and `fillBasin` stops dead when the rest runs
   * out — leaving a lake with a straight, budget-shaped cut across it that
   * says nothing about the outline this fixture exists to show. A disc of this
   * radius plus its lobe is roughly 76 cells against the ~96 left, which
   * leaves the whole shape inside the budget with room to spare.
   */
  const BOWL_RADIUS_CELLS = PREVIEW_WORLD_SIZE / 14;
  /** Radius of the lobe budding off the bowl's east side. */
  const LOBE_RADIUS_CELLS = BOWL_RADIUS_CELLS / 2;
  /** How deep the bowl's floor sits under the rim it fills to, in bands. Two,
   *  so the lake surface is unambiguously above the floor's own band and the
   *  shot cannot be read as "the water is just the ground's colour". */
  const BOWL_DEPTH_BANDS = 2;

  // A straight channel advances one row per cell, as in TERRACE.
  const hillsideAtRow = fillHillside(mirror, DESCENT_PER_CELL);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const channelX = Math.floor(PREVIEW_WORLD_SIZE / 2);
  const bowlCentreY = Math.floor(PREVIEW_WORLD_SIZE / 2);
  const bowlRimHeight = hillsideAtRow(bowlCentreY + BOWL_RADIUS_CELLS);
  const bowlFloorHeight = bowlRimHeight - BOWL_DEPTH_BANDS * BAND_HEIGHT;

  set(channelX, 1, SUMMIT_HEIGHT);
  for (let y = 2; y < PREVIEW_WORLD_SIZE; y++) {
    // The same "must fall within the tread" rule buildTerrace explains: the
    // channel descends 2 units per row over the tread drop so no cell of it
    // ever ties with its successor.
    set(channelX, y, SUMMIT_HEIGHT - DESCENT_PER_CELL * (y - 1) - 2 * (y - 1));
  }

  // The bowl is stamped AFTER the channel, so the channel's own cells inside it
  // are flooded flat rather than left as a groove through the lake floor.
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const dx = x - channelX;
      const dy = y - bowlCentreY;
      const inBowl = Math.hypot(dx, dy) <= BOWL_RADIUS_CELLS;
      const inLobe =
        Math.hypot(dx - BOWL_RADIUS_CELLS, dy) <= LOBE_RADIUS_CELLS;
      if (inBowl || inLobe) set(x, y, bowlFloorHeight);
    }
  }
  openSpring(mirror, channelX, 1);
}

/**
 * STAIRPOOLS — a channel down a hillside that drops into a small basin every
 * few cells, fills it, spills over its lip and does it again.
 *
 * This is the shape the owner photographed (2026-08-21, a chain of pools down
 * a slope with bare terrace between them) and the one that exercises EVERY
 * join the water has: flowing → pool, pool → flowing, and both across a
 * terrace step. `basin` has one lake and tests the outline; this tests the
 * seams, four times in one shot, which is what a single-lake fixture cannot
 * do.
 */
function buildStairPools(mirror: TerrainMirror): void {
  const map = mirror.map;
  /**
   * Cells of ordinary channel between one basin and the next, overridable with
   * `?gap=<cells>`.
   *
   * At 1 the basins are close enough that a pool's spillway is already under
   * the water of the pool below it, so the course steps POOLED → POOLED with
   * no flowing cell in between — a different join from the one the default
   * spacing tests, and the one the owner's stacked-pool screenshot is of.
   */
  const CELLS_BETWEEN_POOLS = (() => {
    const raw = Number(new URLSearchParams(window.location.search).get('gap'));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
  })();
  /** Half-width of a basin, in cells — 2 gives a 5-cell-wide bowl, wide
   *  enough that its outline is a shape rather than a dot. */
  const POOL_HALF_WIDTH_CELLS = 2;
  /** How far a basin's floor sits under the channel that feeds it, in bands.
   *  Over one, so the drop into the pool is always a real terrace step and
   *  never a same-band slide — the join under test. */
  const POOL_DEPTH_BANDS = 2;
  /** How many basins the chain holds. Four fits the per-river trace budget
   *  (2 × world size) alongside the channel that connects them. */
  const POOL_COUNT = 4;

  // The banks fall at the CHANNEL's rate, not the plain DESCENT_PER_CELL the
  // other fixtures use. The channel here descends DESCENT_PER_CELL + 2 per row
  // (see channelAtRow), so a hillside falling any slower pulls away from it a
  // couple of units every row and the channel is a canyon fifty units deep by
  // the bottom of the shot — which hides the very stream this fixture exists
  // to look at behind its own near wall.
  fillHillside(mirror, DESCENT_PER_CELL + 2);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const channelX = Math.floor(PREVIEW_WORLD_SIZE / 2);
  /**
   * The channel's height at a row, measured DOWN FROM THE SPRING rather than
   * from the hillside beside it (buildTerrace's rule, and for its reason): a
   * hillside that starts RIDGE_CLEARANCE_BANDS above the summit is higher than
   * the spring for the first rows, so a channel cut relative to it runs uphill
   * and the very first cell pools instead of flowing. The extra 2 per row is
   * what keeps the channel falling inside a terrace tread, so it only pools
   * where a basin was actually carved.
   */
  const channelAtRow = (row: number): number =>
    SUMMIT_HEIGHT - (DESCENT_PER_CELL + 2) * (row - 1);

  set(channelX, 1, SUMMIT_HEIGHT);
  for (let y = 2; y < PREVIEW_WORLD_SIZE; y++) set(channelX, y, channelAtRow(y));

  for (let pool = 0; pool < POOL_COUNT; pool++) {
    const centreY = 4 + (pool + 1) * CELLS_BETWEEN_POOLS + pool * (2 * POOL_HALF_WIDTH_CELLS + 1);
    const floor = channelAtRow(centreY) - POOL_DEPTH_BANDS * BAND_HEIGHT;
    for (let dy = -POOL_HALF_WIDTH_CELLS; dy <= POOL_HALF_WIDTH_CELLS; dy++) {
      for (let dx = -POOL_HALF_WIDTH_CELLS; dx <= POOL_HALF_WIDTH_CELLS; dx++) {
        // A rounded bowl, so the outline has curves to get right.
        if (Math.hypot(dx, dy) > POOL_HALF_WIDTH_CELLS + 0.5) continue;
        const x = channelX + dx;
        const y = centreY + dy;
        if (y < 2 || y >= PREVIEW_WORLD_SIZE - 1) continue;
        set(x, y, floor);
      }
    }
  }
  openSpring(mirror, channelX, 1);
}

/**
 * CLIFFS — a channel down a gently descending shelf that then drops off a
 * SHEER escarpment of many terrace bands in ONE cell of horizontal travel,
 * lands on a shelf below, and does it AGAIN at a different height before
 * running on to the sea.
 *
 * This is the ONLY fixture whose river crosses many bands in a single step.
 * Every other scene descends DESCENT_PER_CELL — a quarter of a band per cell —
 * so the tallest step anywhere is about one band, and every waterfall-fix
 * regression to date has passed on them and failed only on TALL falls, where
 * the ribbon must plunge a dozen-plus bands while the curtain, the spray and
 * the underlying face all have to agree where the ground is. Two cliffs of
 * DIFFERENT heights (see UPPER_CLIFF_BANDS / LOWER_CLIFF_BANDS) mean a fix
 * that only works for one drop size fails visibly here.
 *
 * Geometry contract (each point exists because its absence silently yields NO
 * river):
 * - the channel always keeps a strictly lower CARDINAL neighbour along its
 *   path (banks sit ABOVE it, never beside it at its own height), so the
 *   trace flows instead of pooling;
 * - `openSpring` clears the summit's neighbours, for the reason its own
 *   comment gives;
 * - the whole descent fits between the fixture summit and SEA_LEVEL, so the
 *   course reaches the sea instead of being truncated by its trace budget;
 * - each cliff is ONE cell of horizontal travel for the WHOLE drop, because
 *   the defect under test only appears when many bands are crossed in a step.
 */
/** Bands dropped by the FIRST cliff the channel goes over. TALL on purpose:
 *  a multi-band drop is where the geometry keeps failing. */
const UPPER_CLIFF_BANDS = 12;
/** Bands dropped by the SECOND cliff — deliberately DIFFERENT from the
 *  first, so a fix tuned to one drop size shows as a failure on the other. */
const LOWER_CLIFF_BANDS = 20;
/** Gentle descent per cell along a shelf, in height units. Small, so the
 *  shelves read as nearly-flat ground and every dramatic drop in the shot is
 *  concentrated at the two cliffs. */
const SHELF_DESCENT_PER_CELL = 2;
/** Last row of the upper shelf — the lip of the first cliff. The drop lands
 *  on the next row (one cell of horizontal travel: see the fixture contract). */
const CLIFF1_LIP_ROW = 14;
/** Last row of the middle shelf — the lip of the second cliff. */
const CLIFF2_LIP_ROW = 34;
/**
 * This fixture's OWN summit, in height units above sea level, counted in
 * bands. It CANNOT be the shared SUMMIT_HEIGHT: that sits 16 bands above the
 * sea, and two cliffs of 12 and 20 bands alone need 32, so a course under
 * SUMMIT_HEIGHT would run out of height and be cut off before the sea. Forty
 * bands covers both cliffs, both shelves' gentle descent and the run-out to
 * the coast, stays far under MAX_HEIGHT, and clears
 * SPRING_MIN_HEIGHT_ABOVE_SEA several times over.
 */
const CLIFFS_SUMMIT_BANDS_ABOVE_SEA = 40;
const CLIFFS_SUMMIT_HEIGHT = CLIFFS_SUMMIT_BANDS_ABOVE_SEA * BAND_HEIGHT;
/** First row of the middle shelf — where the first cliff LANDS. */
const CLIFF1_BASE_ROW = CLIFF1_LIP_ROW + 1;
/** First row of the lower shelf — where the second cliff LANDS. */
const CLIFF2_BASE_ROW = CLIFF2_LIP_ROW + 1;
/** Cells of gentle descent on the shelf above each cliff. */
const UPPER_SHELF_STEPS = CLIFF1_LIP_ROW - 1;
const MID_SHELF_STEPS = CLIFF2_LIP_ROW - CLIFF1_BASE_ROW;

function buildCliffs(mirror: TerrainMirror): void {
  const map = mirror.map;
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  // Heights of each shelf's channel end-to-end, derived so the arithmetic
  // stays readable against the band constants above.
  const upperLipHeight = CLIFFS_SUMMIT_HEIGHT - UPPER_SHELF_STEPS * SHELF_DESCENT_PER_CELL;
  const midShelfTopHeight = upperLipHeight - UPPER_CLIFF_BANDS * BAND_HEIGHT;
  const lowerLipHeight = midShelfTopHeight - MID_SHELF_STEPS * SHELF_DESCENT_PER_CELL;
  const lowerShelfTopHeight = lowerLipHeight - LOWER_CLIFF_BANDS * BAND_HEIGHT;
  // The lower shelf must spend its remaining rows getting DOWN TO the sea, or
  // the course ends mid-slope and `reachedSea` stays false — the fixture's own
  // success criterion. Same self-matching trick buildFork uses for its cone.
  const LOWER_SHELF_STEPS = PREVIEW_WORLD_SIZE - 2 - CLIFF2_BASE_ROW;
  const LOWER_SHELF_DROP_PER_CELL = Math.ceil(lowerShelfTopHeight / LOWER_SHELF_STEPS);

  /**
   * The channel's height at a row: gently down each shelf, then ONE SHEER
   * multi-band step at each cliff row boundary. Clamped at SEA_LEVEL so the
   * flat coastal run never dips under the map's floor.
   */
  const channelAtRow = (row: number): number => {
    if (row <= CLIFF1_LIP_ROW) {
      return CLIFFS_SUMMIT_HEIGHT - (row - 1) * SHELF_DESCENT_PER_CELL;
    }
    if (row <= CLIFF2_LIP_ROW) {
      return midShelfTopHeight - (row - CLIFF1_BASE_ROW) * SHELF_DESCENT_PER_CELL;
    }
    return Math.max(
      SEA_LEVEL,
      lowerShelfTopHeight - (row - CLIFF2_BASE_ROW) * LOWER_SHELF_DROP_PER_CELL,
    );
  };

  // Banks first, full-width rows of them standing RIDGE_CLEARANCE_BANDS over
  // the channel at every row — INCLUDING the cliff rows, so the escarpment is
  // a plateau EDGE the whole width of the fixture rather than a slot canyon.
  // A straight channel advances one row per cell (as in TERRACE), so a shelf
  // built at the channel's own rate hugs it with no canyon to hide behind.
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    const shelfRow = Math.min(Math.max(y, 1), PREVIEW_WORLD_SIZE - 2);
    const bank = channelAtRow(shelfRow) + RIDGE_CLEARANCE_BANDS * BAND_HEIGHT;
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) set(x, y, bank);
  }
  // Then the channel itself, one cell wide, down the middle.
  const channelX = Math.floor(PREVIEW_WORLD_SIZE / 2);
  for (let y = 1; y < PREVIEW_WORLD_SIZE - 1; y++) set(channelX, y, channelAtRow(y));

  openSpring(mirror, channelX, 1);
}

const SCENE_BUILDERS: Record<SceneName, (mirror: TerrainMirror) => void> = {
  fork: buildFork,
  meander: buildMeander,
  terrace: buildTerrace,
  basin: buildBasin,
  stairpools: buildStairPools,
  cliffs: buildCliffs,
};

const CAMERA_VIEWS = {
  iso: new Vector3(0.75, 0.75, 0.9),
  side: new Vector3(0.95, 0.3, 0.35),
  top: new Vector3(0.01, 1, 0.35),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function query<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

const sceneName = query(
  'scene',
  ['fork', 'meander', 'terrace', 'basin', 'stairpools', 'cliffs'] as const,
  'fork',
);
const view = query('view', ['iso', 'side', 'top'] as const, 'iso');
const zoom = Number(new URLSearchParams(window.location.search).get('zoom') ?? '1') || 1;

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const scene = new Scene();
scene.background = new Color(BACKDROP_COLOR);
scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(400);
scene.add(sun);

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

// The mirror, with EVERY chunk marked received: this fixture has no reveal
// gate, and the river rig treats an unreceived chunk as inactive terrain.
const mirror = createTerrainMirror(PREVIEW_WORLD_SIZE);
SCENE_BUILDERS[sceneName](mirror);
const chunkCols = chunksPerEdge(PREVIEW_WORLD_SIZE);
const allChunks: number[] = [];
for (let cy = 0; cy < chunkCols; cy++) {
  for (let cx = 0; cx < chunkCols; cx++) {
    const index = chunkIndex(PREVIEW_WORLD_SIZE, cx, cy);
    mirror.received.add(index);
    allChunks.push(index);
  }
}

const terrainGroup = new Group();
scene.add(terrainGroup);
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(allChunks);
meshes.flush();
// The world is built and nothing more is coming, which is the moment a client
// gets from its frame hook and a harness has to name for itself: give the
// super-meshes their headroom now rather than on a later edit (issue #229).
// `assumeQuiet` because this harness IS the assertion: the build above is
// everything this page will ever draw, and the wall clock cannot know that.
meshes.settle({ assumeQuiet: true });

// The rig's own frame hook: this harness has no animation loop worth the name,
// so handlers are collected and called once per rendered frame below.
const frameHandlers: ((dt: number) => void)[] = [];
const rivers = createRiverRig(scene, (handler) => {
  frameHandlers.push(handler);
  return () => {};
});
rivers.forceRefresh(mirror, createDrawnGround(mirror, meshes.drawnGround()));

// Frame the fixture's own river, not the whole fixture: the interesting thing
// is the water, and the walls around it are just there to keep the course
// honest.
const network = computeRiverNetwork(mirror.map);
const wet = network.rivers.flatMap((river) => riverPoints(river));
const wetHeights = wet.map((p) => mirror.map.cells[cellIndex(mirror.map, p.x, p.y)]!);
// Framed on the WHOLE fixture, centred vertically on the water: the river's
// own XZ extent can be two cells wide, which would put the camera underground.
const centre = new Vector3(
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
  ((Math.min(...wetHeights) + Math.max(...wetHeights)) / 2) * HEIGHT_WORLD_SCALE,
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
);
const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;

/** Offset from a cell's corner to its centre, in cells — what `?at=` aims at. */
const CELL_CENTRE_OFFSET = 0.5;

/**
 * `?at=<cellX>,<cellZ>` — the CELL the camera looks at. Null (meaning: fall
 * back to the world centre) when absent, malformed, non-finite, or outside
 * the fixture — an aim at nothing must not become a crash or an underground
 * camera; this harness is driven by scripts that iterate on URLs.
 */
function parseLookAtCell(): { x: number; z: number } | null {
  const raw = new URLSearchParams(window.location.search).get('at');
  if (raw === null) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= PREVIEW_WORLD_SIZE || cz >= PREVIEW_WORLD_SIZE) return null;
  return { x, z };
}

/**
 * `?dir=<x>,<y>,<z>` — a free camera direction, normalised, overriding
 * `?view`. Null (fall back to `?view`) when absent, malformed, non-finite,
 * or zero-length — a zero vector has no direction to normalise.
 */
function parseCameraDirection(): Vector3 | null {
  const raw = new URLSearchParams(window.location.search).get('dir');
  if (raw === null) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const v = new Vector3(nums[0]!, nums[1]!, nums[2]!);
  if (v.lengthSq() === 0) return null;
  return v.normalize();
}

const lookAtCell = parseLookAtCell();
const lookAt =
  lookAtCell === null
    ? centre
    : new Vector3(
        (lookAtCell.x + CELL_CENTRE_OFFSET) * CELL_WORLD_SIZE,
        mirror.map.cells[cellIndex(mirror.map, Math.floor(lookAtCell.x), Math.floor(lookAtCell.z))]! *
          HEIGHT_WORLD_SCALE,
        (lookAtCell.z + CELL_CENTRE_OFFSET) * CELL_WORLD_SIZE,
      );
// An explicit ?dir replaces the named view outright (it is normalised, so its
// length carries no scale); otherwise the view vector is used exactly as
// before, unnormalised, so the default framing is bit-identical to the old
// behaviour.
const viewOffset = parseCameraDirection() ?? CAMERA_VIEWS[view as CameraView];

const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.copy(lookAt).addScaledVector(viewOffset, span * 0.85 * zoom);
camera.lookAt(lookAt);

let frames = 0;
function animate(): void {
  requestAnimationFrame(animate);
  for (const handler of frameHandlers) handler(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === SETTLE_FRAME_COUNT) {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
    (window as unknown as { __previewScene?: unknown }).__previewScene = scene;
    // Debug probe: the height the terrain ACTUALLY renders at a world XZ,
    // found by raycasting the built mesh — the ground truth a ribbon's own
    // height rule has to agree with.
    (window as unknown as { __previewPickY?: unknown }).__previewPickY = (
      worldX: number,
      worldZ: number,
    ): number | null => {
      const ray = new Raycaster(
        new Vector3(worldX, 10_000, worldZ),
        new Vector3(0, -1, 0),
      );
      const hits = ray.intersectObject(terrainGroup, true);
      return hits.length > 0 ? hits[0]!.point.y : null;
    };
    // Debug probes for MEASURING rather than eyeballing: the derived network
    // itself, the fixture's raw heightmap, and the terrain group — hiding the
    // ground is how "the water is missing" is told apart from "the water is
    // drawn inside the hill", which the first two rounds of the terrace-face
    // bug were both misdiagnosed without.
    (window as unknown as { __previewNetwork?: unknown }).__previewNetwork = network;
    (window as unknown as { __previewTerrain?: unknown }).__previewTerrain = terrainGroup;
    (window as unknown as { __previewHeightAt?: unknown }).__previewHeightAt = (
      x: number,
      y: number,
    ): number => mirror.map.cells[cellIndex(mirror.map, x, y)]!;
    // The WATER's own drawn height at a world XZ — the twin of
    // __previewPickY, so "where is the ribbon" and "where is the ground" are
    // measured the same way, off the same drawn meshes, instead of one being
    // measured and the other assumed.
    (window as unknown as { __previewPickWaterY?: unknown }).__previewPickWaterY = (
      worldX: number,
      worldZ: number,
    ): number | null => {
      const ray = new Raycaster(new Vector3(worldX, 10_000, worldZ), new Vector3(0, -1, 0));
      const hits = ray.intersectObjects(
        scene.children.filter((child) => child !== terrainGroup),
        true,
      );
      return hits.length > 0 ? hits[0]!.point.y : null;
    };
    // The terrain's OWN smoothed band outline, for the chunk holding a cell —
    // the line the mesh actually draws a terrace face along. Comparing a
    // water rule against this is how "the curtain is missing" is told apart
    // from "the curtain is a tenth of a cell behind the face".
    (window as unknown as { __previewContour?: unknown }).__previewContour = (
      cellXCoord: number,
      cellYCoord: number,
      threshold: number,
    ): { x: number; z: number; onBorder: boolean }[][] =>
      chunkContourLoops(
        mirror,
        Math.floor(cellXCoord / CHUNK_SIZE),
        Math.floor(cellYCoord / CHUNK_SIZE),
        threshold,
      );
    // How much of the drawn water the CAMERA can actually see: cast a ray from
    // the camera at each sample of every course and ask what it hits first.
    // "The water is continuous" and "the player can see that it is continuous"
    // are different claims, and only this one answers the second.
    (window as unknown as { __previewVisibility?: unknown }).__previewVisibility = (): {
      samples: number;
      visible: number;
      hiddenRuns: number[][];
    } => {
      const water = scene.children.filter((child) => child !== terrainGroup);
      const ray = new Raycaster();
      let samples = 0;
      let visible = 0;
      const hiddenRuns: number[][] = [];
      let run: number[] | null = null;
      for (const river of network.rivers) {
        for (const course of river.courses) {
          for (const point of course.points) {
            const target = new Vector3(
              point.x * CELL_WORLD_SIZE,
              (point.pooled
                ? (point.poolHeight ?? 0)
                : mirror.map.cells[cellIndex(mirror.map, point.x, point.y)]!) * HEIGHT_WORLD_SCALE,
              point.y * CELL_WORLD_SIZE,
            );
            const direction = target.clone().sub(camera.position).normalize();
            ray.set(camera.position, direction);
            const ground = ray.intersectObject(terrainGroup, true)[0];
            const wet = ray.intersectObjects(water, true)[0];
            samples++;
            const seen = wet !== undefined && (ground === undefined || wet.distance <= ground.distance + 1e-4);
            if (seen) {
              visible++;
              run = null;
            } else {
              if (run === null) {
                run = [point.x, point.y];
                hiddenRuns.push(run);
              }
            }
          }
        }
      }
      return { samples, visible, hiddenRuns };
    };
    (window as unknown as { __previewInfo?: unknown }).__previewInfo = {
      scene: sceneName,
      rivers: network.rivers.length,
      courses: network.rivers.map((river) => river.courses.map((c) => c.points.length)),
      waterfalls: network.rivers.reduce((n, river) => n + river.waterfalls.length, 0),
    };
  }
}
animate();
