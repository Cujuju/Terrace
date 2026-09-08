// Matched before/after screenshots of the terrain surface: the CPU mesher and
// the GPU renderer (?gpuTerrain=1) at an identical camera, one flag apart.
//
//   node client/scripts/gpuTerrainShots.mjs [--browser=windows|linux] [--scene=<id>,...]
//                                           [--world=<name>,...] [--out=<dir>]
//
// WHY THE PAGE DRIVES ITSELF. Only Windows -> WSL localhost is open across the
// WSL2 NAT boundary (scripts/gpu-bench.md), so an inbound CDP socket to the
// real-GPU browser times out. The page therefore poses its own camera and POSTs
// its own frames back to the dev server that served it, which works unchanged
// for the SwiftShader browser inside WSL.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  BAND_HEIGHT,
  CELL_WORLD_SIZE,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  TERRAIN_LOD_NEAR_N,
  cellCoordToWorld,
} from '../../shared/src/constants.ts';
import { decodeColumnSpans } from '../../server/src/persistence/codec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '../..');

/** World units per height unit; the client's HEIGHT_WORLD_SCALE. */
const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
const CHUNK_WORLD_SIZE = CHUNK_SIZE * CELL_WORLD_SIZE;

// Ports. NEVER 2567/5173 — those are the owner's own stack (scripts/gpu-bench.md).
const SERVER_PORT = Number(process.env.TERRACE_SHOT_SERVER_PORT ?? 2591);
const VITE_PORT = Number(process.env.TERRACE_SHOT_VITE_PORT ?? 5191);

const VIEWPORT_WIDTH = Number(process.env.TERRACE_SHOT_WIDTH ?? 1600);
const VIEWPORT_HEIGHT = Number(process.env.TERRACE_SHOT_HEIGHT ?? 900);

/** Downscaled JPEG copy of every shot, so a whole set fits one Artifact page. */
const CONTACT_IMAGE_WIDTH = 1100;
const CONTACT_IMAGE_QUALITY = 0.82;

const SERVER_LISTEN_TIMEOUT_MS = 180_000;
const SERVER_LISTEN_MARKER = 'listening on ws://';
const RUN_TIMEOUT_MS = 900_000;
const POLL_INTERVAL_MS = 250;

// Page-side settle. The world streams in chunk by chunk and every camera move
// rebuilds LOD, so a shot waits for the draw counters to stop moving.
const SETTLE_MIN_MS = 8_000;
const SETTLE_MAX_MS = 240_000;
const SETTLE_STABLE_MS = 3_000;
const POSE_SETTLE_MIN_MS = 2_500;
const POSE_SETTLE_MAX_MS = 90_000;

// GPU/CPU frame-time sampling, once a pose has settled. 150 frames gives p99
// single-frame resolution (needs >=100 samples) with headroom, and stays under
// a few seconds even on the slowest measured config (2048 N=4, no LOD, 38ms).
const GPU_TIMING_SAMPLE_FRAMES = 150;
const GPU_TIMING_MAX_WAIT_MS = 60_000;

const WORLDS_RELATIVE_DIR = 'server/data/worlds';
const WORLDS_DIR_ENV_VAR = 'TERRACE_SHOT_WORLDS_DIR';
const ACTIVE_WORLD_FILE = '.active';

// server/data/worlds is untracked, so a worktree has to reach the main checkout.
function resolveWorldsDir() {
  const override = process.env[WORLDS_DIR_ENV_VAR];
  if (override !== undefined && override !== '') return override;
  const here = resolve(REPO_ROOT, WORLDS_RELATIVE_DIR);
  if (existsSync(here)) return here;
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const main = resolve(dirname(commonDir), WORLDS_RELATIVE_DIR);
  if (existsSync(main)) return main;
  throw new Error(`no ${WORLDS_RELATIVE_DIR} at ${here} or ${main}; set ${WORLDS_DIR_ENV_VAR}`);
}

const WORLDS_SOURCE_DIR = resolveWorldsDir();

// Anything that moves or changes the light diverges between two separately
// booted runs, and a pair must differ only by the terrain flag. Disabled in the
// throwaway copy, so both variants render the same scene under scene.ts's noon
// sky. Flora is in the list because canopy hides the surface under review.
const NONDETERMINISTIC_PLUGINS = [
  'daynight',
  'weather',
  'rain',
  'snow',
  'fog',
  'thunderstorm',
  'tornado',
  'cyclone',
  'volcanoes',
  'mudslides',
  'fire',
  'flora',
  'wildlife',
  'pilgrims',
  'boats',
  'monsters',
  'saucers',
  'populous',
];

// Everything else the registry ships; --core-only leaves nothing but the terrain and sea.
const CORE_ONLY_EXTRA_PLUGINS = [
  'mana',
  'invite',
  'relics',
  'hydro',
  'structures',
  'temples',
  'chronicle',
  'music',
];

const SNAPSHOT_QUERY =
  'select id, world_size, heightmap, mask from snapshots order by id desc limit 1';

const SHOT_PLAN_PATH = '/__shots/plan';
const SHOT_FRAME_PATH = '/__shots/frame';
const SHOT_DONE_PATH = '/__shots/done';

const VARIANTS = [
  { id: 'cpu', label: 'CPU mesher (default)', query: '' },
  { id: 'gpu', label: 'GPU renderer (?gpuTerrain=1)', query: 'gpuTerrain=1' },
];

const BROWSERS = {
  linux: {
    id: 'linux',
    label: 'Linux headless Chrome (SwiftShader)',
    binary: '/usr/bin/google-chrome',
    host: '127.0.0.1',
  },
  windows: {
    id: 'windows',
    label: 'Windows headless Chrome (discrete GPU)',
    binary: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    host: 'localhost',
  },
};

// --- the scenes -------------------------------------------------------------
// A pose is a target cell plus a spherical eye offset, so a pair is identical by
// construction and a run reproduces the last one. Elevation/azimuth reproduce
// the study in .terrain-options/gpu (overview 35/45, sheer close-up 24/250).
const OVERVIEW_ELEVATION_DEGREES = 35;
const OVERVIEW_AZIMUTH_DEGREES = 45;
/** The shipped bench's overview distance: eye (110.2, 45.9, 110.2) about (63.875, 0, 63.875). */
const OVERVIEW_DISTANCE_WORLD_UNITS = 80;
// Square to the wall, from its low side, low enough to see the face rather than
// the plateau behind it. The azimuth is the low side's own bearing: +x is 90.
const SHEER_ELEVATION_DEGREES = 8;
const SHEER_MACRO_ELEVATION_DEGREES = 5;
const SHEER_LOW_SIDE_EAST_AZIMUTH_DEGREES = 90;
const SHEER_LOW_SIDE_WEST_AZIMUTH_DEGREES = 270;
/** Fits the whole drop with a quarter of its height as margin. */
const SHEER_FRAMING_MARGIN = 1.25;
// Mirrors client/src/config.ts, which cannot be imported here: it reads
// import.meta.env, which plain Node does not define.
const CAMERA_FOV_DEGREES = 55;
/** Close enough that one cell of tread structure is a tenth of the frame. */
const SHEER_MACRO_DISTANCE_WORLD_UNITS = 2;

function distanceFraming(worldUnitsTall) {
  const halfFov = (CAMERA_FOV_DEGREES * Math.PI) / 180 / 2;
  return (worldUnitsTall * SHEER_FRAMING_MARGIN) / 2 / Math.tan(halfFov);
}
const SHORE_ELEVATION_DEGREES = 18;
const SHORE_AZIMUTH_DEGREES = 200;
const SHORE_DISTANCE_WORLD_UNITS = 28;
/** A grazing eye puts near and far LOD in one frame; 6 degrees is the shallowest
 *  angle that still clears the foreground ridge. */
const LOD_ELEVATION_DEGREES = 6;
const LOD_DISTANCE_WORLD_UNITS = 60;
/** Keeps the grazing view off the world edge, where it would look at sky. */
const LOD_INTERIOR_FRACTION = 0.3;
/** Outside the revealed region, looking back in: the quadrant 13068c7 fixed. */
const FRONTIER_ELEVATION_DEGREES = 22;
const FRONTIER_AZIMUTH_DEGREES = 225;
const FRONTIER_DISTANCE_WORLD_UNITS = 44;
const FRONTIER_INSET_CHUNKS = 1;
const CAVE_ELEVATION_DEGREES = 12;
const CAVE_AZIMUTH_DEGREES = 300;
const CAVE_DISTANCE_WORLD_UNITS = 7;

const SCENES = [
  {
    id: 'overview',
    world: 'frostwick-hollows',
    look: 'The whole surface at the shipped bench pose. Compare band colour, silhouette and coastline.',
    pose: (w) => ({
      target: { cell: w.centre, height: 0 },
      elevation: OVERVIEW_ELEVATION_DEGREES,
      azimuth: OVERVIEW_AZIMUTH_DEGREES,
      distance: OVERVIEW_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'sheer-wall',
    world: 'frostwick-hollows',
    look:
      `The whole drop. The mesher spreads it over about three quarters of a cell as one tread ` +
      `per band; the GPU surface is a staircase of up to ${TERRAIN_LOD_NEAR_N} sub-cell steps ` +
      `straddling the cell boundary.`,
    pose: (w) => ({
      target: { cell: w.sheer.centre, height: w.sheer.midHeight },
      elevation: SHEER_ELEVATION_DEGREES,
      azimuth: w.sheer.azimuth,
      distance: distanceFraming(w.sheer.dropWorldUnits),
    }),
  },
  {
    id: 'sheer-wall-macro',
    world: 'frostwick-hollows',
    look: `Ten cells of the same wall, close enough to count the ${TERRAIN_LOD_NEAR_N} steps.`,
    pose: (w) => ({
      target: { cell: w.sheer.centre, height: w.sheer.midHeight },
      elevation: SHEER_MACRO_ELEVATION_DEGREES,
      azimuth: w.sheer.azimuth,
      distance: SHEER_MACRO_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'shoreline',
    world: 'frostwick-hollows',
    look: 'Where the surface meets water. Look for the waterline sitting on the same tread in both.',
    pose: (w) => ({
      target: { cell: w.shore.cell, height: 0 },
      elevation: SHORE_ELEVATION_DEGREES,
      azimuth: SHORE_AZIMUTH_DEGREES,
      distance: SHORE_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'lod-boundary',
    world: 'frostwick-hollows',
    look:
      'A grazing view so near and far LOD share the frame. Look along the seam for see-through ' +
      'tears and for fins standing above the surface.',
    pose: (w) => ({
      target: { cell: w.relief.cell, height: w.relief.height },
      elevation: LOD_ELEVATION_DEGREES,
      azimuth: w.relief.outwardAzimuth,
      distance: LOD_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'caves',
    world: 'frostwick-hollows',
    look:
      'KNOWN INCOMPLETE — spans in the shader are Phase 2f and in progress, so the GPU path is ' +
      'expected to be wrong on layered columns. Not a defect.',
    pose: (w) => ({
      target: { cell: w.cave.cell, height: w.cave.height },
      elevation: CAVE_ELEVATION_DEGREES,
      azimuth: CAVE_AZIMUTH_DEGREES,
      distance: CAVE_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'chunk-frontier',
    world: 'reach-of-wildfall',
    look:
      'The north-west corner of the revealed region, from outside it. 13068c7 stopped the GPU ' +
      'drawing chunks it never received as sea-level plateaus; 51d7cfd kept the surface flat to ' +
      'the boundary instead of ramping to zero.',
    pose: (w) => ({
      target: { cell: w.frontier.cell, height: w.frontier.height },
      elevation: FRONTIER_ELEVATION_DEGREES,
      azimuth: FRONTIER_AZIMUTH_DEGREES,
      distance: FRONTIER_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'wildfall-overview',
    world: 'reach-of-wildfall',
    look: 'The revealed region of the 2048-cell world, whole.',
    pose: (w) => ({
      target: { cell: w.centre, height: 0 },
      elevation: OVERVIEW_ELEVATION_DEGREES,
      azimuth: OVERVIEW_AZIMUTH_DEGREES,
      distance: OVERVIEW_DISTANCE_WORLD_UNITS,
    }),
  },
  {
    id: 'wildfall-shore',
    world: 'reach-of-wildfall',
    look: 'A second shoreline, in the gentler world. River channels reach the sea here.',
    pose: (w) => ({
      target: { cell: w.shore.cell, height: 0 },
      elevation: SHORE_ELEVATION_DEGREES,
      azimuth: SHORE_AZIMUTH_DEGREES,
      distance: SHORE_DISTANCE_WORLD_UNITS,
    }),
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { browser: 'windows', scenes: null, worlds: null, out: null, coreOnly: false };
  for (const arg of argv) {
    const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=') : [null, null];
    if (key === 'browser') out.browser = value;
    else if (key === 'scene') out.scenes = value.split(',');
    else if (key === 'world') out.worlds = value.split(',');
    else if (key === 'out') out.out = value;
    else if (key === 'core-only') out.coreOnly = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (BROWSERS[out.browser] === undefined) {
    throw new Error(`--browser must be one of ${Object.keys(BROWSERS).join(', ')}`);
  }
  return out;
}

// --- reading the world ------------------------------------------------------

function readSnapshot(worldName) {
  const file = join(WORLDS_SOURCE_DIR, `${worldName}.db`);
  if (!existsSync(file)) throw new Error(`no world database at ${file}`);
  const require_ = createRequire(join(REPO_ROOT, 'server/package.json'));
  const Database = require_('better-sqlite3');
  const db = new Database(file, { readonly: true });
  const row = db.prepare(SNAPSHOT_QUERY).get();
  db.close();
  if (row === undefined) throw new Error(`${worldName} has no snapshot row`);
  const size = row.world_size;
  const heights = new Int16Array(new Uint8Array(row.heightmap).buffer.slice(0), 0, size * size);
  return { name: worldName, size, heights, mask: new Uint8Array(row.mask), snapshotId: row.id };
}

/** The landmarks each scene aims at, found in the snapshot rather than assumed. */
function findLandmarks(snapshot) {
  const { size, heights, mask } = snapshot;
  const chunksPerEdge = size / CHUNK_SIZE;
  const at = (x, y) => heights[y * size + x];
  const revealed = (cx, cy) => (mask[(cy * chunksPerEdge + cx) >> 3] >> ((cy * chunksPerEdge + cx) & 7)) & 1;

  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let cy = 0; cy < chunksPerEdge; cy++) {
    for (let cx = 0; cx < chunksPerEdge; cx++) {
      if (revealed(cx, cy) === 0) continue;
      minX = Math.min(minX, cx * CHUNK_SIZE);
      minY = Math.min(minY, cy * CHUNK_SIZE);
      maxX = Math.max(maxX, cx * CHUNK_SIZE + CHUNK_SIZE - 1);
      maxY = Math.max(maxY, cy * CHUNK_SIZE + CHUNK_SIZE - 1);
    }
  }
  if (maxX < 0) throw new Error(`${snapshot.name} has no revealed chunk`);
  const centre = { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 };

  // A wall worth photographing stands between two dry cells and has quiet ground
  // on both sides, so the drop is the only thing in frame.
  const WALL_MIN_DROP_UNITS = 8 * BAND_HEIGHT;
  const WALL_DRY_FLOOR_UNITS = BAND_HEIGHT;
  const WALL_QUIET_RADIUS_CELLS = 2;
  const WALL_QUIET_TOLERANCE_UNITS = 3 * BAND_HEIGHT;
  let wall = null;
  for (let y = minY + WALL_QUIET_RADIUS_CELLS; y <= maxY - WALL_QUIET_RADIUS_CELLS; y++) {
    for (let x = minX + WALL_QUIET_RADIUS_CELLS; x < maxX - WALL_QUIET_RADIUS_CELLS; x++) {
      const lo = at(x, y);
      const hi = at(x + 1, y);
      if (lo <= WALL_DRY_FLOOR_UNITS || hi <= WALL_DRY_FLOOR_UNITS) continue;
      const drop = Math.abs(hi - lo);
      if (drop < WALL_MIN_DROP_UNITS) continue;
      const lowSideEast = hi < lo;
      let quiet = 0;
      for (let j = -WALL_QUIET_RADIUS_CELLS; j <= WALL_QUIET_RADIUS_CELLS; j++) {
        if (Math.abs(at(x - WALL_QUIET_RADIUS_CELLS, y + j) - lo) < WALL_QUIET_TOLERANCE_UNITS) quiet++;
        if (Math.abs(at(x + 1 + WALL_QUIET_RADIUS_CELLS, y + j) - hi) < WALL_QUIET_TOLERANCE_UNITS) quiet++;
      }
      const score = quiet * WALL_MIN_DROP_UNITS + drop;
      if (wall === null || score > wall.score) {
        wall = { x, y, drop, lo: Math.min(lo, hi), hi: Math.max(lo, hi), quiet, score, lowSideEast };
      }
    }
  }

  // A shoreline is dry ground touching sea, scored by how much sea and how much
  // relief share its neighbourhood.
  const SHORE_RADIUS_CELLS = 12;
  const SHORE_WATER_SCORE_CAP = 300;
  const SHORE_RELIEF_WEIGHT = 1 / 4;
  const SHORE_STEP_CELLS = 2;
  let shore = null;
  for (let y = minY + SHORE_RADIUS_CELLS; y <= maxY - SHORE_RADIUS_CELLS; y += SHORE_STEP_CELLS) {
    for (let x = minX + SHORE_RADIUS_CELLS; x <= maxX - SHORE_RADIUS_CELLS; x += SHORE_STEP_CELLS) {
      if (at(x, y) <= 0) continue;
      if (at(x + 1, y) > 0 && at(x - 1, y) > 0 && at(x, y + 1) > 0 && at(x, y - 1) > 0) continue;
      let water = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = -SHORE_RADIUS_CELLS; j <= SHORE_RADIUS_CELLS; j++) {
        for (let i = -SHORE_RADIUS_CELLS; i <= SHORE_RADIUS_CELLS; i++) {
          const v = at(x + i, y + j);
          if (v <= 0) water++;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const score = Math.min(water, SHORE_WATER_SCORE_CAP) + (hi - lo) * SHORE_RELIEF_WEIGHT;
      if (shore === null || score > shore.score) shore = { x, y, water, score };
    }
  }

  // The busiest neighbourhood, for the grazing LOD view.
  const RELIEF_RADIUS_CELLS = 24;
  const RELIEF_STEP_CELLS = 8;
  const insetX = Math.round((maxX - minX) * LOD_INTERIOR_FRACTION);
  const insetY = Math.round((maxY - minY) * LOD_INTERIOR_FRACTION);
  let relief = null;
  for (let y = minY + insetY; y <= maxY - insetY; y += RELIEF_STEP_CELLS) {
    for (let x = minX + insetX; x <= maxX - insetX; x += RELIEF_STEP_CELLS) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = -RELIEF_RADIUS_CELLS; j <= RELIEF_RADIUS_CELLS; j += SHORE_STEP_CELLS) {
        for (let i = -RELIEF_RADIUS_CELLS; i <= RELIEF_RADIUS_CELLS; i += SHORE_STEP_CELLS) {
          const v = at(x + i, y + j);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (lo < 0) continue;
      if (relief === null || hi - lo > relief.spread) relief = { x, y, spread: hi - lo, height: at(x, y) };
    }
  }
  if (relief === null) relief = { x: centre.x, y: centre.y, spread: 0, height: at(centre.x | 0, centre.y | 0) };

  const frontierCell = {
    x: minX + FRONTIER_INSET_CHUNKS * CHUNK_SIZE,
    y: minY + FRONTIER_INSET_CHUNKS * CHUNK_SIZE,
  };

  const toWorld = (cell) => ({ x: cellCoordToWorld(cell.x), z: cellCoordToWorld(cell.y) });
  return {
    revealed: { minX, minY, maxX, maxY },
    centre,
    sheer:
      wall === null
        ? null
        : {
            centre: { x: wall.x + 1, y: wall.y + 0.5 },
            midHeight: (wall.lo + wall.hi) / 2,
            drop: wall.drop,
            dropWorldUnits: wall.drop * HEIGHT_WORLD_SCALE,
            azimuth: wall.lowSideEast
              ? SHEER_LOW_SIDE_EAST_AZIMUTH_DEGREES
              : SHEER_LOW_SIDE_WEST_AZIMUTH_DEGREES,
            lo: wall.lo,
            hi: wall.hi,
            cell: { x: wall.x, y: wall.y },
          },
    shore: shore === null ? null : { cell: { x: shore.x + 0.5, y: shore.y + 0.5 }, water: shore.water },
    relief: {
      cell: { x: relief.x + 0.5, y: relief.y + 0.5 },
      height: relief.height,
      spread: relief.spread,
      // Eye outside the target, looking back through it: the deepest run of
      // terrain the world can offer, so near and far LOD share the frame.
      outwardAzimuth:
        (Math.atan2(relief.x - centre.x, relief.y - centre.y) * 180) / Math.PI,
    },
    frontier: {
      cell: { x: frontierCell.x + 0.5, y: frontierCell.y + 0.5 },
      height: at(frontierCell.x, frontierCell.y),
    },
    cave: null,
    toWorld,
  };
}

/** The deepest layered column, if this world has any. */
function findCave(snapshot) {
  const file = join(WORLDS_SOURCE_DIR, `${snapshot.name}.db`);
  const require_ = createRequire(join(REPO_ROOT, 'server/package.json'));
  const Database = require_('better-sqlite3');
  const db = new Database(file, { readonly: true });
  const row = db.prepare('select column_spans from snapshots order by id desc limit 1').get();
  db.close();
  if (row?.column_spans == null || row.column_spans.length === 0) return null;
  return { blob: new Uint8Array(row.column_spans) };
}

function poseToWorld(pose) {
  const elevation = (pose.elevation * Math.PI) / 180;
  const azimuth = (pose.azimuth * Math.PI) / 180;
  const target = {
    x: cellCoordToWorld(pose.target.cell.x),
    y: pose.target.height * HEIGHT_WORLD_SCALE,
    z: cellCoordToWorld(pose.target.cell.y),
  };
  const d = pose.distance;
  return {
    target,
    eye: {
      x: target.x + d * Math.cos(elevation) * Math.sin(azimuth),
      y: target.y + d * Math.sin(elevation),
      z: target.z + d * Math.cos(elevation) * Math.cos(azimuth),
    },
  };
}

// --- the page-side driver ---------------------------------------------------
// Injected into the real client's index.html. It needs no imports: the DEV-only
// globalThis.__terraceRenderer is enough to wrap render(), and wrapping render()
// hands it the live camera. Pinning the pose there also beats the ground-
// clearance nudge, which runs just before the draw.
const DRIVER_SCRIPT = `
(async () => {
  const plan = await (await fetch(${JSON.stringify(SHOT_PLAN_PATH)})).json();
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pageErrors = [];
  const fail = (message) =>
    post(${JSON.stringify(SHOT_DONE_PATH)}, { ok: false, error: String(message), pageErrors });
  window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => pageErrors.push(String(e.reason)));
  try {
    const deadline = Date.now() + plan.readyTimeoutMs;
    while (globalThis.__terraceRenderer === undefined) {
      if (Date.now() > deadline) throw new Error('__terraceRenderer never appeared; is this a DEV build?');
      await new Promise((r) => setTimeout(r, plan.pollIntervalMs));
    }
    const renderer = globalThis.__terraceRenderer;
    const original = renderer.render.bind(renderer);
    const gl = renderer.getContext();

    // EXT_disjoint_timer_query_webgl2: real GPU time per frame, TIME_ELAPSED_EXT
    // between back-to-back queries. Absent under SwiftShader/ANGLE-no-ext.
    const NANOSECONDS_PER_MS = 1e6;
    // Bounds the query backlog so a stalled readback can't leak GL query objects.
    const MAX_PENDING_GPU_QUERIES = 64;
    function createGpuTimer() {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return { supported: false, mark() {}, stop() {}, samples: () => [] };
      const resolved = [];
      let pending = [];
      let open = null;
      const closeOpen = () => {
        if (open === null) return;
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(open);
        open = null;
        while (pending.length > MAX_PENDING_GPU_QUERIES) {
          const dropped = pending.shift();
          if (dropped !== undefined) gl.deleteQuery(dropped);
        }
      };
      const collect = () => {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
        const kept = [];
        for (const query of pending) {
          if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
            kept.push(query);
            continue;
          }
          if (!disjoint) resolved.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / NANOSECONDS_PER_MS);
          gl.deleteQuery(query);
        }
        pending = kept;
      };
      return {
        supported: true,
        mark() {
          collect();
          closeOpen();
          const query = gl.createQuery();
          if (query === null) return;
          gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          open = query;
        },
        stop() {
          closeOpen();
          collect();
          for (const query of pending) gl.deleteQuery(query);
          pending = [];
        },
        samples: () => resolved,
      };
    }

    const percentile = (values, p) => {
      const sorted = values.slice().sort((a, b) => a - b);
      if (sorted.length === 0) return null;
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };

    let pinned = null;
    let capture = null;
    let frames = 0;
    let counters = '';
    let gpuTimer = createGpuTimer();
    let sampling = false;
    let frameIntervals = [];
    let lastFrameAt = null;
    renderer.render = (scene, camera) => {
      const onScreen = renderer.getRenderTarget() === null;
      if (onScreen && pinned !== null) {
        camera.position.set(pinned.eye.x, pinned.eye.y, pinned.eye.z);
        camera.lookAt(pinned.target.x, pinned.target.y, pinned.target.z);
      }
      if (onScreen && sampling) gpuTimer.mark();
      const out = original(scene, camera);
      if (!onScreen) return out;
      frames++;
      if (sampling) {
        const now = performance.now();
        if (lastFrameAt !== null) frameIntervals.push(now - lastFrameAt);
        lastFrameAt = now;
      }
      const info = renderer.info.render;
      counters = info.triangles + '/' + info.calls + '/' + renderer.info.memory.geometries;
      if (capture !== null) {
        const take = capture;
        capture = null;
        take(renderer.domElement);
      }
      return out;
    };

    // One GPU/CPU frame-time sample per pinned pose, isolated from settle-phase
    // frames and from the previous pose's queries by a fresh timer each call.
    const sampleTiming = () =>
      new Promise((resolveTiming) => {
        gpuTimer.stop();
        gpuTimer = createGpuTimer();
        frameIntervals = [];
        lastFrameAt = null;
        sampling = true;
        const deadline = Date.now() + plan.gpuTimingMaxWaitMs;
        const poll = () => {
          if (frameIntervals.length >= plan.gpuTimingSampleFrames || Date.now() > deadline) {
            sampling = false;
            gpuTimer.stop();
            const gpuSamples = gpuTimer.samples();
            resolveTiming({
              frames: frameIntervals.length,
              timedOut: Date.now() > deadline,
              cpuMsP50: percentile(frameIntervals, 0.5),
              cpuMsP99: percentile(frameIntervals, 0.99),
              gpuTimerSupported: gpuTimer.supported,
              gpuFrames: gpuSamples.length,
              gpuMsP50: percentile(gpuSamples, 0.5),
              gpuMsP99: percentile(gpuSamples, 0.99),
            });
            return;
          }
          setTimeout(poll, plan.pollIntervalMs);
        };
        poll();
      });

    const rendererName = (() => {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    })();

    const settle = async (minMs, maxMs) => {
      const started = Date.now();
      let last = null;
      let stableSince = Date.now();
      while (Date.now() - started < maxMs) {
        await new Promise((r) => setTimeout(r, plan.pollIntervalMs));
        if (counters !== last) { last = counters; stableSince = Date.now(); continue; }
        if (Date.now() - started < minMs) continue;
        if (Date.now() - stableSince >= plan.settleStableMs) return Date.now() - started;
      }
      return Date.now() - started;
    };

    const grab = () =>
      new Promise((resolve) => {
        capture = (canvas) => {
          const full = canvas.toDataURL('image/png');
          const scale = plan.contactWidth / canvas.width;
          const small = document.createElement('canvas');
          small.width = plan.contactWidth;
          small.height = Math.round(canvas.height * scale);
          small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
          resolve({ full, contact: small.toDataURL('image/jpeg', plan.contactQuality), width: canvas.width, height: canvas.height });
        };
      });

    await settle(plan.settleMinMs, plan.settleMaxMs);
    for (const scene of plan.scenes) {
      pinned = { eye: scene.eye, target: scene.target };
      await settle(plan.poseSettleMinMs, plan.poseSettleMaxMs);
      // GPU_DISJOINT_EXT can invalidate a whole window (e.g. another process on
      // this GPU forcing a clock/power-state change mid-sample); one retry
      // recovers it rather than reporting a silent zero.
      let timing = await sampleTiming();
      if (timing.gpuTimerSupported && timing.gpuFrames === 0) timing = await sampleTiming();
      const shot = await grab();
      await post(${JSON.stringify(SHOT_FRAME_PATH)}, {
        scene: scene.id,
        renderer: rendererName,
        counters,
        frames,
        width: shot.width,
        height: shot.height,
        png: shot.full,
        contact: shot.contact,
        timing,
      });
    }
    await post(${JSON.stringify(SHOT_DONE_PATH)}, { ok: true, renderer: rendererName, pageErrors });
  } catch (error) {
    await fail(error && error.stack ? error.stack : error);
  }
})();
`;

// --- the stack --------------------------------------------------------------

function stageWorld(worldName, stackDir, coreOnly) {
  const worldsDir = join(stackDir, 'worlds');
  mkdirSync(worldsDir, { recursive: true });
  // A COPY, never the live file: the owner's server may be mid-write.
  const copy = join(worldsDir, `${worldName}.db`);
  copyFileSync(join(WORLDS_SOURCE_DIR, `${worldName}.db`), copy);
  writeFileSync(join(worldsDir, ACTIVE_WORLD_FILE), worldName);
  const require_ = createRequire(join(REPO_ROOT, 'server/package.json'));
  const db = new (require_('better-sqlite3'))(copy);
  db.exec('CREATE TABLE IF NOT EXISTS disabled_plugins (plugin TEXT NOT NULL PRIMARY KEY)');
  const insert = db.prepare('INSERT OR IGNORE INTO disabled_plugins (plugin) VALUES (?)');
  for (const plugin of NONDETERMINISTIC_PLUGINS) insert.run(plugin);
  if (coreOnly) for (const plugin of CORE_ONLY_EXTRA_PLUGINS) insert.run(plugin);
  db.close();
  return worldsDir;
}

async function startGameServer(worldsDir, stackDir, logs) {
  const child = spawn('node', ['src/index.ts'], {
    cwd: join(REPO_ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      WORLDS_DIR: worldsDir,
      DB_PATH: join(stackDir, 'unused.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let listening = false;
  const onData = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (text.includes(SERVER_LISTEN_MARKER)) listening = true;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const deadline = Date.now() + SERVER_LISTEN_TIMEOUT_MS;
  while (!listening && Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${logs.join('')}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!listening) throw new Error(`server never printed "${SERVER_LISTEN_MARKER}":\n${logs.join('')}`);
  return child;
}

function shotsPlugin(state) {
  const readBody = (req) =>
    new Promise((res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res(Buffer.concat(chunks).toString()));
    });
  return {
    name: 'terrace-gpu-terrain-shots',
    transformIndexHtml: () => [
      { tag: 'script', children: DRIVER_SCRIPT, injectTo: 'body' },
    ],
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === SHOT_PLAN_PATH) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(state.plan));
          return;
        }
        if (req.method !== 'POST' || (req.url !== SHOT_FRAME_PATH && req.url !== SHOT_DONE_PATH)) {
          next();
          return;
        }
        const path = req.url;
        void readBody(req).then((body) => {
          const payload = JSON.parse(body);
          if (path === SHOT_FRAME_PATH) state.onFrame(payload);
          else state.onDone(payload);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

async function startVite(state, cacheDir) {
  process.env.VITE_SERVER_PORT = String(SERVER_PORT);
  const server = await createViteServer({
    root: CLIENT_ROOT,
    cacheDir,
    logLevel: 'error',
    plugins: [shotsPlugin(state)],
    server: { port: VITE_PORT, strictPort: true, host: '0.0.0.0' },
  });
  await server.listen();
  return server;
}

function launchBrowser(browser, url, profileDir) {
  const flags = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    // Matches scripts/gpu-bench.sh: with vsync on, frame time pins to the
    // display's refresh rate and a timing sample stops meaning anything.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ];
  if (browser.id === 'linux') {
    flags.push('--no-sandbox', '--enable-unsafe-swiftshader', `--user-data-dir=${profileDir.posix}`);
  } else {
    flags.push(`--user-data-dir=${profileDir.windows}`);
  }
  const child = spawn(browser.binary, [...flags, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  return child;
}

function killBrowser(browser, child, profileDir) {
  try {
    child.kill('SIGKILL');
  } catch {}
  if (browser.id !== 'windows') return;
  // A Windows chrome.exe outlives the WSL process that exec'd it. Matched on
  // this run's own profile directory, so it can only ever name its own.
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${profileDir.leaf}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ],
      { stdio: 'ignore' },
    );
  } catch {}
}

function makeProfileDir(browser, runId) {
  const leaf = `terrace-shots-${runId}`;
  if (browser.id === 'linux') {
    const posix = join(tmpdir(), leaf);
    mkdirSync(posix, { recursive: true });
    return { leaf, posix, windows: null, cleanup: () => rmSync(posix, { recursive: true, force: true }) };
  }
  const home = execFileSync('powershell.exe', ['-NoProfile', '-Command', '$env:USERPROFILE'], {
    encoding: 'utf8',
  }).trim();
  const windows = `${home}\\${leaf}`;
  const posix = execFileSync('wslpath', ['-u', windows], { encoding: 'utf8' }).trim();
  return { leaf, posix, windows, cleanup: () => rmSync(posix, { recursive: true, force: true }) };
}

// --- the run ----------------------------------------------------------------

async function shootWorld({ worldName, scenes, browser, outDir, stackDir, cacheDir, sha, results, coreOnly }) {
  const snapshot = readSnapshot(worldName);
  const landmarks = findLandmarks(snapshot);
  landmarks.cave = caveLandmark(snapshot, landmarks);
  const usable = scenes.filter((scene) => {
    const needs = scene.id.startsWith('sheer') ? landmarks.sheer : scene.id === 'caves' ? landmarks.cave : true;
    if (needs === null) {
      results.skipped.push({ scene: scene.id, world: worldName, why: `${worldName} has no such landmark` });
      return false;
    }
    return true;
  });
  if (usable.length === 0) return;

  const worldsDir = stageWorld(worldName, stackDir, coreOnly);
  const serverLogs = [];
  let gameServer = null;
  let vite = null;
  try {
    gameServer = await startGameServer(worldsDir, stackDir, serverLogs);
    for (const variant of VARIANTS) {
      const state = { plan: null, onFrame: null, onDone: null };
      const posed = usable.map((scene) => {
        const pose = poseToWorld(scene.pose(landmarks));
        return { id: scene.id, eye: pose.eye, target: pose.target };
      });
      state.plan = {
        scenes: posed,
        readyTimeoutMs: SERVER_LISTEN_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        settleMinMs: SETTLE_MIN_MS,
        settleMaxMs: SETTLE_MAX_MS,
        settleStableMs: SETTLE_STABLE_MS,
        poseSettleMinMs: POSE_SETTLE_MIN_MS,
        poseSettleMaxMs: POSE_SETTLE_MAX_MS,
        contactWidth: CONTACT_IMAGE_WIDTH,
        contactQuality: CONTACT_IMAGE_QUALITY,
        gpuTimingSampleFrames: GPU_TIMING_SAMPLE_FRAMES,
        gpuTimingMaxWaitMs: GPU_TIMING_MAX_WAIT_MS,
      };
      let finish = null;
      const finished = new Promise((res) => {
        finish = res;
      });
      state.onFrame = (payload) => {
        const base = `${payload.scene}.${variant.id}`;
        const png = Buffer.from(payload.png.split(',')[1], 'base64');
        writeFileSync(join(outDir, `${base}.png`), png);
        writeFileSync(join(outDir, `${base}.jpg`), Buffer.from(payload.contact.split(',')[1], 'base64'));
        results.frames.push({
          scene: payload.scene,
          variant: variant.id,
          world: worldName,
          browser: browser.id,
          renderer: payload.renderer,
          counters: payload.counters,
          width: payload.width,
          height: payload.height,
          timing: payload.timing,
          sha,
          file: `${base}.png`,
          contact: `${base}.jpg`,
        });
        const t = payload.timing ?? {};
        const gpuMs =
          t.gpuTimerSupported === true
            ? `gpu p50/p99=${t.gpuMsP50?.toFixed(2)}/${t.gpuMsP99?.toFixed(2)}ms (n=${t.gpuFrames})`
            : 'gpu timer unsupported';
        console.log(
          `  ${base.padEnd(28)} ${payload.width}x${payload.height} ${payload.counters} ` +
            `cpu p50/p99=${t.cpuMsP50?.toFixed(2)}/${t.cpuMsP99?.toFixed(2)}ms ${gpuMs}`,
        );
      };
      state.onDone = (payload) => finish(payload);

      vite = await startVite(state, cacheDir);
      const query = [variant.query, `shots=${variant.id}`].filter((q) => q !== '').join('&');
      const url = `http://${browser.host}:${VITE_PORT}/?${query}`;
      const profileDir = makeProfileDir(browser, `${worldName}-${variant.id}-${process.pid}`);
      console.log(`${worldName} / ${variant.id} / ${browser.id}: ${url}`);
      const child = launchBrowser(browser, url, profileDir);
      try {
        const outcome = await Promise.race([
          finished,
          sleep(RUN_TIMEOUT_MS).then(() => ({ ok: false, error: `no report within ${RUN_TIMEOUT_MS}ms` })),
        ]);
        if (outcome.ok !== true) {
          results.errors.push({ world: worldName, variant: variant.id, error: outcome.error });
          console.error(`  FAILED: ${outcome.error}`);
        }
      } finally {
        killBrowser(browser, child, profileDir);
        profileDir.cleanup();
        await vite.close();
        vite = null;
      }
    }
  } finally {
    if (vite !== null) await vite.close().catch(() => {});
    if (gameServer !== null) gameServer.kill('SIGKILL');
  }
}

/** Layered columns live in the span table; a world without one gets no cave shot. */
function caveLandmark(snapshot, landmarks) {
  const spans = findCave(snapshot);
  if (spans === null) return null;
  const table = decodeColumnSpans(spans.blob, snapshot.size * snapshot.size, snapshot.name);
  let best = null;
  for (const [index, list] of table) {
    if (list.length < 2) continue;
    const x = index % snapshot.size;
    const y = Math.floor(index / snapshot.size);
    if (x < landmarks.revealed.minX || x > landmarks.revealed.maxX) continue;
    if (y < landmarks.revealed.minY || y > landmarks.revealed.maxY) continue;
    const void_ = list[1].floor - list[0].ceiling;
    if (best === null || void_ > best.void_) {
      best = { x, y, void_, roof: list[1].floor, floor: list[0].ceiling };
    }
  }
  if (best === null) return null;
  return {
    cell: { x: best.x + 0.5, y: best.y + 0.5 },
    height: (best.floor + best.roof) / 2,
    voidUnits: best.void_,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = BROWSERS[args.browser];
  if (!existsSync(browser.binary)) throw new Error(`no browser at ${browser.binary}`);

  const sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const outDir = args.out ?? join(mkdtempSync(join(tmpdir(), 'gpu-terrain-shots-')), 'shots');
  mkdirSync(outDir, { recursive: true });
  const stackDir = mkdtempSync(join(tmpdir(), 'gpu-terrain-stack-'));
  const cacheDir = join(tmpdir(), 'gpu-terrain-shots-vite-cache');

  const wanted = SCENES.filter(
    (scene) =>
      (args.scenes === null || args.scenes.includes(scene.id)) &&
      (args.worlds === null || args.worlds.includes(scene.world)),
  );
  const worlds = [...new Set(wanted.map((scene) => scene.world))];
  const results = { sha, browser: browser.id, browserLabel: browser.label, frames: [], errors: [], skipped: [] };

  try {
    for (const worldName of worlds) {
      await shootWorld({
        worldName,
        scenes: wanted.filter((scene) => scene.world === worldName),
        browser,
        outDir,
        stackDir,
        cacheDir,
        sha,
        results,
        coreOnly: args.coreOnly,
      });
    }
  } finally {
    rmSync(stackDir, { recursive: true, force: true });
  }

  const manifest = {
    ...results,
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    scenes: SCENES.map((scene) => ({ id: scene.id, world: scene.world, look: scene.look })),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${results.frames.length} frames in ${outDir}`);
  if (results.skipped.length > 0) console.log('skipped:', JSON.stringify(results.skipped));
  if (results.errors.length > 0) {
    console.error('errors:', JSON.stringify(results.errors, null, 2));
    process.exitCode = 1;
  }
}

await main();
// Vite and the CDP sockets leave handles open; without this the run never exits.
process.exit(process.exitCode ?? 0);
