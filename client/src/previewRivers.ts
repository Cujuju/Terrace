import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
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

const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 4;

const SUMMIT_HEIGHT = SEA_LEVEL + SPRING_MIN_HEIGHT_ABOVE_SEA * 4;

const DESCENT_PER_CELL = (() => {
  const raw = Number(new URLSearchParams(window.location.search).get('descent'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BAND_HEIGHT / 4;
})();

type SceneName = 'fork' | 'meander' | 'terrace' | 'basin' | 'stairpools' | 'cliffs';

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

function buildFork(mirror: TerrainMirror): void {
  const map = mirror.map;
  const centre = Math.floor(PREVIEW_WORLD_SIZE / 2);
  const RINGS_TO_SHORE = Math.floor(PREVIEW_WORLD_SIZE / 2) - 4;
  const dropPerRing = Math.max(DESCENT_PER_CELL, Math.ceil(SUMMIT_HEIGHT / RINGS_TO_SHORE));
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const ring = Math.max(Math.abs(x - centre), Math.abs(y - centre));
      map.cells[cellIndex(map, x, y)] = SUMMIT_HEIGHT - ring * dropPerRing;
    }
  }
}

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

function buildMeander(mirror: TerrainMirror): void {
  const map = mirror.map;
  const RUN_CELLS = 3;
  fillHillside(mirror, DESCENT_PER_CELL * 2);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  let x = 3;
  let y = 1;
  let h = SUMMIT_HEIGHT;
  set(x, y, h);
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

function buildTerrace(mirror: TerrainMirror): void {
  const map = mirror.map;
  const TREAD_CELLS = 4;
  fillHillside(mirror, DESCENT_PER_CELL);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const x = Math.floor(PREVIEW_WORLD_SIZE / 2);
  set(x, 1, SUMMIT_HEIGHT);
  for (let y = 2; y < PREVIEW_WORLD_SIZE; y++) {
    const tread = Math.floor((y - 2) / TREAD_CELLS);
    set(x, y, SUMMIT_HEIGHT - tread * DESCENT_PER_CELL * TREAD_CELLS - 2 * (y - 1));
  }
  openSpring(mirror, x, 1);
}

function buildBasin(mirror: TerrainMirror): void {
  const map = mirror.map;
  const BOWL_RADIUS_CELLS = PREVIEW_WORLD_SIZE / 14;
  const LOBE_RADIUS_CELLS = BOWL_RADIUS_CELLS / 2;
  const BOWL_DEPTH_BANDS = 2;

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
    set(channelX, y, SUMMIT_HEIGHT - DESCENT_PER_CELL * (y - 1) - 2 * (y - 1));
  }

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

function buildStairPools(mirror: TerrainMirror): void {
  const map = mirror.map;
  const CELLS_BETWEEN_POOLS = (() => {
    const raw = Number(new URLSearchParams(window.location.search).get('gap'));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
  })();
  const POOL_HALF_WIDTH_CELLS = 2;
  const POOL_DEPTH_BANDS = 2;
  const POOL_COUNT = 4;

  fillHillside(mirror, DESCENT_PER_CELL + 2);
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const channelX = Math.floor(PREVIEW_WORLD_SIZE / 2);
  const channelAtRow = (row: number): number =>
    SUMMIT_HEIGHT - (DESCENT_PER_CELL + 2) * (row - 1);

  set(channelX, 1, SUMMIT_HEIGHT);
  for (let y = 2; y < PREVIEW_WORLD_SIZE; y++) set(channelX, y, channelAtRow(y));

  for (let pool = 0; pool < POOL_COUNT; pool++) {
    const centreY = 4 + (pool + 1) * CELLS_BETWEEN_POOLS + pool * (2 * POOL_HALF_WIDTH_CELLS + 1);
    const floor = channelAtRow(centreY) - POOL_DEPTH_BANDS * BAND_HEIGHT;
    for (let dy = -POOL_HALF_WIDTH_CELLS; dy <= POOL_HALF_WIDTH_CELLS; dy++) {
      for (let dx = -POOL_HALF_WIDTH_CELLS; dx <= POOL_HALF_WIDTH_CELLS; dx++) {
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

const UPPER_CLIFF_BANDS = 12;
const LOWER_CLIFF_BANDS = 20;
const SHELF_DESCENT_PER_CELL = 2;
const CLIFF1_LIP_ROW = 14;
const CLIFF2_LIP_ROW = 34;
const CLIFFS_SUMMIT_BANDS_ABOVE_SEA = 40;
const CLIFFS_SUMMIT_HEIGHT = CLIFFS_SUMMIT_BANDS_ABOVE_SEA * BAND_HEIGHT;
const CLIFF1_BASE_ROW = CLIFF1_LIP_ROW + 1;
const CLIFF2_BASE_ROW = CLIFF2_LIP_ROW + 1;
const UPPER_SHELF_STEPS = CLIFF1_LIP_ROW - 1;
const MID_SHELF_STEPS = CLIFF2_LIP_ROW - CLIFF1_BASE_ROW;

function buildCliffs(mirror: TerrainMirror): void {
  const map = mirror.map;
  const set = (x: number, y: number, h: number): void => {
    map.cells[cellIndex(map, x, y)] = h;
  };

  const upperLipHeight = CLIFFS_SUMMIT_HEIGHT - UPPER_SHELF_STEPS * SHELF_DESCENT_PER_CELL;
  const midShelfTopHeight = upperLipHeight - UPPER_CLIFF_BANDS * BAND_HEIGHT;
  const lowerLipHeight = midShelfTopHeight - MID_SHELF_STEPS * SHELF_DESCENT_PER_CELL;
  const lowerShelfTopHeight = lowerLipHeight - LOWER_CLIFF_BANDS * BAND_HEIGHT;
  const LOWER_SHELF_STEPS = PREVIEW_WORLD_SIZE - 2 - CLIFF2_BASE_ROW;
  const LOWER_SHELF_DROP_PER_CELL = Math.ceil(lowerShelfTopHeight / LOWER_SHELF_STEPS);

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

  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    const shelfRow = Math.min(Math.max(y, 1), PREVIEW_WORLD_SIZE - 2);
    const bank = channelAtRow(shelfRow) + RIDGE_CLEARANCE_BANDS * BAND_HEIGHT;
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) set(x, y, bank);
  }
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
scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(400);
scene.add(sun);

const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
await renderer.init();
scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);

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
meshes.settle({ assumeQuiet: true });

const frameHandlers: ((dt: number) => void)[] = [];
const rivers = createRiverRig(scene, (handler) => {
  frameHandlers.push(handler);
  return () => {};
});
rivers.forceRefresh(mirror, createDrawnGround(mirror, meshes.drawnGround()));

const network = computeRiverNetwork(mirror.map);
const wet = network.rivers.flatMap((river) => riverPoints(river));
const wetHeights = wet.map((p) => mirror.map.cells[cellIndex(mirror.map, p.x, p.y)]!);
const centre = new Vector3(
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
  ((Math.min(...wetHeights) + Math.max(...wetHeights)) / 2) * HEIGHT_WORLD_SCALE,
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
);
const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;

const CELL_CENTRE_OFFSET = 0.5;

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
    (window as unknown as { __previewNetwork?: unknown }).__previewNetwork = network;
    (window as unknown as { __previewTerrain?: unknown }).__previewTerrain = terrainGroup;
    (window as unknown as { __previewHeightAt?: unknown }).__previewHeightAt = (
      x: number,
      y: number,
    ): number => mirror.map.cells[cellIndex(mirror.map, x, y)]!;
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
