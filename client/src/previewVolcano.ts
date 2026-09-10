import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import { BAND_HEIGHT, CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';
import {
  FLOW_RADIUS_WORLD_UNITS,
  LAVA_COOL_SECONDS,
  VENT_MIN_BANDS_ABOVE_SEA,
  GENESIS_CONE_BANDS,
  WORLD_UNITS_PER_BAND,
  type LavaCellState,
} from '../../plugins/volcanoes/protocol.ts';
import { nextFlowCell } from '../../plugins/volcanoes/server/flow.ts';
import { createLavaFlow } from '../../plugins/volcanoes/client/lavaFlow.ts';
import { createPlume } from '../../plugins/volcanoes/client/plume.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const SETTLE_FRAME_COUNT = 4;

const BACKDROP_COLOR = 0x33405a;

const GRID_CELLS = 96;
const VENT_CELL = GRID_CELLS / 2;

const SUMMIT_HEIGHT = (VENT_MIN_BANDS_ABOVE_SEA + GENESIS_CONE_BANDS) * BAND_HEIGHT;

const CONE_FOOT_CELLS = cellsAcross(10);

const RIVER_ROW = GRID_CELLS - 10;
const RIVER_HALF_WIDTH_CELLS = 2;

const GULLY_DIRECTION = new Vector3(0.35, 0, 1).normalize();
const GULLY_DEPTH_HEIGHT_UNITS = BAND_HEIGHT * 1.6;
const GULLY_WIDTH_CELLS = 9;

const FLOW_CELLS_DRAWN = 64;

function heightAtCell(cx: number, cy: number): number {
  const dx = cx - VENT_CELL;
  const dy = cy - VENT_CELL;
  const distance = Math.hypot(dx, dy);

  const coneFalloff = Math.min(1, distance / CONE_FOOT_CELLS);
  const cone = SUMMIT_HEIGHT * (1 - coneFalloff * coneFalloff);

  const plain = (VENT_MIN_BANDS_ABOVE_SEA * BAND_HEIGHT * (GRID_CELLS - cy)) / GRID_CELLS;

  const alongX = dx * GULLY_DIRECTION.x + dy * GULLY_DIRECTION.z;
  const acrossDistance = Math.abs(dx * GULLY_DIRECTION.z - dy * GULLY_DIRECTION.x);
  const gully =
    alongX > 0
      ? GULLY_DEPTH_HEIGHT_UNITS * Math.exp(-((acrossDistance / GULLY_WIDTH_CELLS) ** 2))
      : 0;

  const riverDistance = Math.abs(cy - RIVER_ROW);
  const riverCut =
    riverDistance <= RIVER_HALF_WIDTH_CELLS ? BAND_HEIGHT * 1.2 : 0;

  return Math.max(0, cone + plain - gully - riverCut);
}

function bandOfHeight(height: number): number {
  return Math.floor(height / BAND_HEIGHT);
}
function capWorldY(cx: number, cy: number): number {
  return bandOfHeight(heightAtCell(cx, cy)) * WORLD_UNITS_PER_BAND;
}

function isRiverCell(cx: number, cy: number): boolean {
  return Math.abs(cy - RIVER_ROW) <= RIVER_HALF_WIDTH_CELLS && cx > 4 && cx < GRID_CELLS - 4;
}

const BAND_COLORS: readonly Color[] = [
  new Color(0.78, 0.72, 0.52),
  new Color(0.62, 0.71, 0.42),
  new Color(0.48, 0.64, 0.34),
  new Color(0.42, 0.58, 0.31),
  new Color(0.46, 0.54, 0.35),
  new Color(0.45, 0.41, 0.33),
  new Color(0.36, 0.32, 0.29),
  new Color(0.29, 0.25, 0.23),
  new Color(0.23, 0.20, 0.19),
  new Color(0.18, 0.16, 0.15),
  new Color(0.14, 0.13, 0.13),
];

function colorForBand(band: number): Color {
  const index = Math.min(BAND_COLORS.length - 1, Math.max(0, band));
  return BAND_COLORS[index]!;
}

function buildTerrain(): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];

  const half = CELL_WORLD_SIZE / 2;

  function pushTriangle(a: Vector3, b: Vector3, c: Vector3, color: Color): void {
    for (const v of [a, b, c]) positions.push(v.x, v.y, v.z);
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  }

  for (let cy = 0; cy < GRID_CELLS; cy++) {
    for (let cx = 0; cx < GRID_CELLS; cx++) {
      const band = bandOfHeight(heightAtCell(cx, cy));
      const y = band * WORLD_UNITS_PER_BAND;
      const color = isRiverCell(cx, cy) ? new Color(0.20, 0.42, 0.58) : colorForBand(band);

      const x0 = cx * CELL_WORLD_SIZE - half;
      const x1 = x0 + CELL_WORLD_SIZE;
      const z0 = cy * CELL_WORLD_SIZE - half;
      const z1 = z0 + CELL_WORLD_SIZE;

      pushTriangle(new Vector3(x0, y, z0), new Vector3(x0, y, z1), new Vector3(x1, y, z1), color);
      pushTriangle(new Vector3(x0, y, z0), new Vector3(x1, y, z1), new Vector3(x1, y, z0), color);

      const neighbours: ReadonlyArray<readonly [number, number, Vector3, Vector3]> = [
        [cx + 1, cy, new Vector3(x1, y, z0), new Vector3(x1, y, z1)],
        [cx, cy + 1, new Vector3(x1, y, z1), new Vector3(x0, y, z1)],
      ];
      for (const [nx, ny, edgeA, edgeB] of neighbours) {
        if (nx >= GRID_CELLS || ny >= GRID_CELLS) continue;
        const neighbourY = bandOfHeight(heightAtCell(nx, ny)) * WORLD_UNITS_PER_BAND;
        if (neighbourY >= y) continue;
        const lowA = new Vector3(edgeA.x, neighbourY, edgeA.z);
        const lowB = new Vector3(edgeB.x, neighbourY, edgeB.z);
        const riser = color.clone().multiplyScalar(0.82);
        pushTriangle(edgeA, edgeB, lowB, riser);
        pushTriangle(edgeA, lowB, lowA, riser);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();

  return new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
}

function walkFlow(ageOfIndex: (index: number, total: number) => number): LavaCellState[] {
  const world = {
    worldSize: GRID_CELLS,
    heightAt: heightAtCell,
  };
  const freshwater = {
    at: (x: number, y: number) => (isRiverCell(x, y) ? ('channel' as const) : ('none' as const)),
  };

  const cells: LavaCellState[] = [];
  const visited = new Set<number>([VENT_CELL * 0x10000 + VENT_CELL]);
  let x = VENT_CELL;
  let y = VENT_CELL;

  for (let i = 0; i < FLOW_CELLS_DRAWN; i++) {
    const next = nextFlowCell(world, freshwater, x, y, visited);
    if (typeof next === 'string') break;
    x = next.x;
    y = next.y;
    visited.add(x * 0x10000 + y);
    cells.push({ x, y, ageSeconds: 0 });
  }

  return cells.map((cell, index) => ({
    ...cell,
    ageSeconds: ageOfIndex(index, cells.length),
  }));
}

type SceneName = 'dormant' | 'erupting' | 'cooling' | 'steam';
type ViewName = 'iso' | 'low' | 'close' | 'top';

const CAMERA_VIEWS: Record<ViewName, { direction: Vector3; distance: number; targetY: number }> = {
  iso: { direction: new Vector3(0.55, 0.5, 0.95), distance: 30, targetY: 1.4 },
  low: { direction: new Vector3(0.2, 0.12, 1), distance: 26, targetY: 1.8 },
  close: { direction: new Vector3(0.5, 0.45, 0.8), distance: 9, targetY: 0.6 },
  top: { direction: new Vector3(0.01, 1, 0.02), distance: 26, targetY: 0 },
};

async function main(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const sceneName = (query.get('scene') ?? 'erupting') as SceneName;
  const viewName = (query.get('view') ?? 'iso') as ViewName;
  const clock = Number(query.get('t') ?? '3.2');

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(60);
  scene.add(sun);

  scene.add(buildTerrain());

  const layer = new Group();
  scene.add(layer);

  const flow = createLavaFlow();
  layer.add(flow.root);
  if (sceneName !== 'dormant') {
    const cells =
      sceneName === 'cooling'
        ? walkFlow((index, total) => LAVA_COOL_SECONDS * (1 - (index / total) * 0.35))
        : walkFlow((index, total) => (LAVA_COOL_SECONDS * 0.75 * (total - index)) / total);
    flow.replaceAll(cells, clock, (cellX, cellY) => capWorldY(cellX, cellY));
  }

  const plume = createPlume();
  layer.add(plume.root);
  if (sceneName === 'erupting' || sceneName === 'steam') {
    plume.apply([
      { id: 1, x: VENT_CELL, y: VENT_CELL, groundY: capWorldY(VENT_CELL, VENT_CELL) },
    ]);
    plume.update(10, clock);
  }
  flow.update(clock);

  const view = CAMERA_VIEWS[viewName] ?? CAMERA_VIEWS.iso;
  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    window.innerWidth / window.innerHeight,
    0.5,
    400,
  );
  const centre = new Vector3(
    VENT_CELL * CELL_WORLD_SIZE,
    view.targetY,
    VENT_CELL * CELL_WORLD_SIZE,
  );
  if (viewName === 'close') {
    centre.set(
      (VENT_CELL + 14) * CELL_WORLD_SIZE,
      capWorldY(VENT_CELL + 14, VENT_CELL + 26),
      (VENT_CELL + 26) * CELL_WORLD_SIZE,
    );
  }
  camera.position.copy(centre).addScaledVector(view.direction.clone().normalize(), view.distance);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  await renderer.init();
  scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);
  renderer.outputColorSpace = SRGBColorSpace;

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);
}

void main();

void FLOW_RADIUS_WORLD_UNITS;
