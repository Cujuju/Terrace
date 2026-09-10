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
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  SEA_LEVEL,
  cellIndex,
  chunkIndex,
  chunksPerEdge,
  spanAt,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { createTerrainMirror, type TerrainMirror } from './terrain/mirror.ts';
import { createTerrainMeshes } from './render/terrainMeshes.ts';
import { createLayerEdgeOverlay } from './render/layerEdgeOverlay.ts';
import { archFixtureAim, carveArchFixture } from './terrain/archFixture.ts';

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

const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 6;

const GROUND_HEIGHT = SEA_LEVEL + BAND_HEIGHT * 2 + BAND_HEIGHT / 2;

const GROUND_ROLL = BAND_HEIGHT / 3;

const GROUND_ROLL_CELLS = 23;

type CameraView = 'iso' | 'mouth' | 'inside' | 'cave' | 'top';

const CAMERA_VIEWS: Record<CameraView, Vector3> = {
  iso: new Vector3(0.7, 0.6, 0.7),
  mouth: new Vector3(0, 0.16, -1),
  inside: new Vector3(0.25, 0.07, -1),
  cave: new Vector3(0.1, 0.14, -1),
  top: new Vector3(0, 1, 0.0001),
};

const CAMERA_DISTANCE_FRACTION = 0.85;

const BORE_VIEW_DISTANCE_FRACTION = 0.3;

const query = new URLSearchParams(window.location.search);

function readView(): CameraView {
  const raw = query.get('view');
  return raw !== null && raw in CAMERA_VIEWS ? (raw as CameraView) : 'iso';
}

function readEdges(): boolean {
  return query.get('edges') === '1';
}

function readZoom(): number {
  const raw = Number(query.get('zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function buildGround(mirror: TerrainMirror): void {
  const map = mirror.map;
  for (let z = 0; z < PREVIEW_WORLD_SIZE; z++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const swell =
        Math.sin((x / GROUND_ROLL_CELLS) * Math.PI * 2) *
        Math.cos((z / GROUND_ROLL_CELLS) * Math.PI * 2);
      map.cells[cellIndex(map, x, z)] = Math.round(GROUND_HEIGHT + swell * GROUND_ROLL);
    }
  }
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;

const scene = new Scene();
scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(1000);
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
buildGround(mirror);
const chunkCols = chunksPerEdge(PREVIEW_WORLD_SIZE);
const allChunks: number[] = [];
for (let cz = 0; cz < chunkCols; cz++) {
  for (let cx = 0; cx < chunkCols; cx++) {
    const index = chunkIndex(PREVIEW_WORLD_SIZE, cx, cz);
    mirror.received.add(index);
    allChunks.push(index);
  }
}

const carvedChunks = carveArchFixture(mirror);

const terrainGroup = new Group();
scene.add(terrainGroup);
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(allChunks);
meshes.flush();
meshes.settle({ assumeQuiet: true });

const edgeOverlay = readEdges()
  ? createLayerEdgeOverlay(terrainGroup, mirror, PREVIEW_WORLD_SIZE, meshes.drawnGround())
  : null;
for (const chunkIdx of allChunks) edgeOverlay?.refreshChunk(chunkIdx);

const aim = archFixtureAim(PREVIEW_WORLD_SIZE);
const view = readView();
const zoom = readZoom();

const VIEW_TARGETS: Record<CameraView, { cell: { x: number; z: number }; near: boolean }> = {
  iso: { cell: aim.crest, near: false },
  mouth: { cell: aim.archBore, near: true },
  inside: { cell: aim.archBore, near: true },
  cave: { cell: aim.caveMouth, near: true },
  top: { cell: aim.crest, near: false },
};

const target = VIEW_TARGETS[view];

const targetY = spanAt(mirror.map, target.cell.x, target.cell.z, 0).ceiling;

const lookAt = new Vector3(
  (target.cell.x + 0.5) * CELL_WORLD_SIZE,
  targetY * HEIGHT_WORLD_SCALE,
  (target.cell.z + 0.5) * CELL_WORLD_SIZE,
);

const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;
const distance =
  span * (target.near ? BORE_VIEW_DISTANCE_FRACTION : CAMERA_DISTANCE_FRACTION) * zoom;

const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.1,
  4000,
);
camera.position.copy(lookAt).addScaledVector(CAMERA_VIEWS[view], distance);
camera.lookAt(lookAt);

let frames = 0;
function animate(): void {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  frames++;
  if (frames === SETTLE_FRAME_COUNT) {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
    (window as unknown as { __previewCarvedChunks?: unknown }).__previewCarvedChunks =
      carvedChunks.size;
    (window as unknown as { __previewLayeredColumns?: unknown }).__previewLayeredColumns =
      mirror.map.columnSpans.size;
    (window as unknown as { __previewSpansAt?: unknown }).__previewSpansAt = (
      x: number,
      z: number,
    ): { floor: number; ceiling: number }[] => {
      const packed = mirror.map.columnSpans.get(cellIndex(mirror.map, x, z));
      if (packed === undefined) return [spanAt(mirror.map, x, z, 0)];
      const out: { floor: number; ceiling: number }[] = [];
      for (let k = 0; k < packed.length / 2; k++) {
        out.push({ floor: packed[k * 2]!, ceiling: packed[k * 2 + 1]! });
      }
      return out;
    };
  }
}
animate();
