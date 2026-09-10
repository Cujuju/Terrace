import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, cellIndex, chunkIndex, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { createTerrainMirror, type TerrainMirror } from './terrain/mirror.ts';
import { createTerrainMeshes } from './render/terrainMeshes.ts';
import { createWater } from './render/water.ts';
import { WATER_SHADE_SPAN_BANDS } from './terrain/waterDepth.ts';
import { skyStateAtPhase } from '../../plugins/daynight/client/sky.ts';
import { installWaterBandClock } from './render/water/waterBands.ts';
import { depthToWaterAlpha, waterDepthWorldUnits } from './terrain/waterDepth.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const SUN_DISTANCE_WORLD_UNITS = 1000;
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const BACKDROP_COLOR = 0x9fc7e8;
const SETTLE_FRAME_COUNT = 6;

const MIDNIGHT_PHASE = 0.75;

const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 8;

const STAIRCASE_MAX_DEPTH_BANDS = WATER_SHADE_SPAN_BANDS + 2;

const STAIRCASE_DRY_BANDS = 2;

const OCEAN_MEDIAN_DEPTH_BANDS = 12;
const OCEAN_RELIEF_BANDS = 2;

const STAIRCASE_TREAD_CELLS = Math.floor(
  PREVIEW_WORLD_SIZE / (STAIRCASE_MAX_DEPTH_BANDS + STAIRCASE_DRY_BANDS + 1),
);

function setCell(mirror: TerrainMirror, x: number, y: number, height: number): void {
  mirror.map.cells[cellIndex(mirror.map, x, y)] = height;
}

function buildStaircase(mirror: TerrainMirror): void {
  for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
    const tread = Math.floor(x / STAIRCASE_TREAD_CELLS);
    const bandsBelowSea = tread - STAIRCASE_DRY_BANDS;
    const height = SEA_LEVEL - bandsBelowSea * BAND_HEIGHT;
    for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) setCell(mirror, x, y, height);
  }
}

function buildOcean(mirror: TerrainMirror): void {
  const centre = PREVIEW_WORLD_SIZE / 2;
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.sqrt(dx * dx + dy * dy);
      const depthBands = OCEAN_MEDIAN_DEPTH_BANDS + OCEAN_RELIEF_BANDS * Math.cos(Math.PI * r);
      const height =
        r < 0.2
          ? SEA_LEVEL + Math.round((0.2 - r) * 20) * BAND_HEIGHT
          : SEA_LEVEL - Math.round(depthBands) * BAND_HEIGHT;
      setCell(mirror, x, y, height);
    }
  }
}

const SCENE_BUILDERS: Record<string, (mirror: TerrainMirror) => void> = {
  staircase: buildStaircase,
  ocean: buildOcean,
};

const CAMERA_VIEWS: Record<string, Vector3> = {
  iso: new Vector3(0.8, 0.75, 0.8),
  side: new Vector3(0, 0.18, 1),
  top: new Vector3(0, 1, 0.001),
};

const params = new URLSearchParams(window.location.search);
const sceneName = params.get('scene') ?? 'staircase';
const view = params.get('view') ?? 'iso';
const zoomRaw = Number(params.get('zoom'));
const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
const builder = SCENE_BUILDERS[sceneName] ?? buildStaircase;
const isNight = params.get('light') === 'night';

const scene = new Scene();
const hemisphere = new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY);
scene.add(hemisphere);
const ambient = new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY);
scene.add(ambient);
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
scene.add(sun);

let backdropColor = BACKDROP_COLOR;
if (isNight) {
  const night = skyStateAtPhase(MIDNIGHT_PHASE);
  sun.position
    .set(night.sunDirection.x, night.sunDirection.y, night.sunDirection.z)
    .normalize()
    .multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  sun.color.setHex(night.sunColor);
  sun.intensity = night.sunIntensity;
  hemisphere.color.setHex(night.hemisphereSkyColor);
  hemisphere.groundColor.setHex(night.hemisphereGroundColor);
  hemisphere.intensity = night.hemisphereIntensity;
  ambient.color.setHex(night.ambientColor);
  ambient.intensity = night.ambientIntensity;
  backdropColor = night.backgroundColor;
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
await renderer.init();
scene.background = backgroundRadiance(backdropColor, renderer);

const mirror = createTerrainMirror(PREVIEW_WORLD_SIZE);
builder(mirror);
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
const waterGroup = new Group();
scene.add(waterGroup);
const water = createWater(waterGroup, PREVIEW_WORLD_SIZE);
water.setWorldSize(PREVIEW_WORLD_SIZE);
water.sync(mirror);
water.refresh(mirror, allChunks);
installWaterBandClock((handler) => {
  frameHandlers.push(handler);
  return () => {};
});

const centre = new Vector3(
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
  SEA_LEVEL * HEIGHT_WORLD_SCALE,
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
);
const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;
const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.1,
  8000,
);
camera.position.copy(centre).addScaledVector(CAMERA_VIEWS[view] ?? CAMERA_VIEWS.iso, span * 0.85 * zoom);
camera.lookAt(centre);

let frames = 0;
function animate(): void {
  requestAnimationFrame(animate);
  for (const handler of frameHandlers) handler(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === SETTLE_FRAME_COUNT) {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
    (window as unknown as { __previewAlphaAtBands?: unknown }).__previewAlphaAtBands = (
      bands: number,
    ): number => depthToWaterAlpha(waterDepthWorldUnits(SEA_LEVEL - bands * BAND_HEIGHT));
    (window as unknown as { __previewWater?: unknown }).__previewWater = waterGroup;
  }
}
animate();
