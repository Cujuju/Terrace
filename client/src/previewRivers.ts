// previewRivers.ts — THROWAWAY preview harness for the river rig, mirroring
// previewBoats.ts. Not part of the shipped app: reached only through
// preview-rivers.html.
//
//   ?scene=<fork|meander|terrace>  — which fixture to build; defaults to "fork"
//   ?view=<iso|side|top>           — camera angle; defaults to "iso"
//   ?zoom=<number>                 — camera distance multiplier; defaults to 1
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
import { createRiverRig } from './render/riverRig.ts';

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

type SceneName = 'fork' | 'meander' | 'terrace';

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

const SCENE_BUILDERS: Record<SceneName, (mirror: TerrainMirror) => void> = {
  fork: buildFork,
  meander: buildMeander,
  terrace: buildTerrace,
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

const sceneName = query('scene', ['fork', 'meander', 'terrace'] as const, 'fork');
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

// The rig's own frame hook: this harness has no animation loop worth the name,
// so handlers are collected and called once per rendered frame below.
const frameHandlers: ((dt: number) => void)[] = [];
const rivers = createRiverRig(scene, (handler) => {
  frameHandlers.push(handler);
  return () => {};
});
rivers.forceRefresh(mirror);

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
const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.copy(centre).addScaledVector(CAMERA_VIEWS[view as CameraView], span * 0.85 * zoom);
camera.lookAt(centre);

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
    (window as unknown as { __previewInfo?: unknown }).__previewInfo = {
      scene: sceneName,
      rivers: network.rivers.length,
      courses: network.rivers.map((river) => river.courses.map((c) => c.points.length)),
      waterfalls: network.rivers.reduce((n, river) => n + river.waterfalls.length, 0),
    };
  }
}
animate();
