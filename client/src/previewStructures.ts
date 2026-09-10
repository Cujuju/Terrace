import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_TIER_COUNT,
  settlementRace,
  type SettlerRace,
} from '../../plugins/structures/protocol.ts';
import timberHouseUrl from '../../plugins/structures/client/assets/timber-house.glb?url';
import {
  createStructureModels,
  preloadStructureModels,
  DURANDS_MARQUEE_BULB_PERIOD_SECONDS,
  DURANDS_SIGN_FLASH_PERIOD_SECONDS,
  type StructurePlacement,
} from '../../plugins/structures/client/models.ts';
import { FISHING_HUT_BUILDERS, fishingHutVariantIndex } from '../../plugins/structures/client/fishingHuts.ts';
import { isDurandsCell } from '../../plugins/structures/client/durands.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 3;
const CAMERA_FRAMING_PADDING = 1.25;
const SETTLE_FRAME_COUNT = 3;

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function findTopTierCell(wantDurands: boolean): { x: number; y: number } {
  const SCAN_EDGE = 64;
  for (let y = 0; y < SCAN_EDGE; y++) {
    for (let x = 0; x < SCAN_EDGE; x++) {
      if (isDurandsCell(MAX_STRUCTURE_TIER, x, y) === wantDurands) return { x, y };
    }
  }
  throw new Error(
    `preview: found no ${wantDurands ? '' : 'non-'}Durand's cell in the first ${SCAN_EDGE}x${SCAN_EDGE} cells`,
  );
}

function findCoastalCell(variant: number): { x: number; y: number } {
  const SCAN_EDGE = 64;
  for (let y = 0; y < SCAN_EDGE; y++) {
    for (let x = 0; x < SCAN_EDGE; x++) {
      if (fishingHutVariantIndex(x, y) === variant) return { x, y };
    }
  }
  throw new Error(`preview: no cell in the first ${SCAN_EDGE}x${SCAN_EDGE} rolls fishing hut ${variant}`);
}

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGPURenderer } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();

  const ground = new Mesh(
    new CircleGeometry(GROUND_RADIUS, 32),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.05, 100);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);
  renderer.outputColorSpace = SRGBColorSpace;

  return { scene, camera, renderer };
}

const VIEW_DIRECTIONS: Readonly<Record<string, Vector3>> = {
  front: new Vector3(0.6, 0.45, 0.85),
  rear: new Vector3(-0.6, 0.45, -0.85),
  left: new Vector3(-0.85, 0.45, 0.6),
  right: new Vector3(0.85, 0.45, -0.6),
  top: new Vector3(0.01, 1, 0.01),
};

function frameCameraOn(camera: PerspectiveCamera, object: { root: Group }, view: string): void {
  const box = new Box3().setFromObject(object.root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  const direction = (VIEW_DIRECTIONS[view] ?? VIEW_DIRECTIONS.front).clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

const BESIDE_SPACING_WORLD_UNITS = 1.2;

async function main(): Promise<void> {
  const query = readQuery();
  const durandsRequested = query.get('durands') === '1';
  const hutParam = query.get('hut');
  const hutRequested = hutParam !== null && Number.isInteger(Number(hutParam));
  const hutVariant = hutRequested
    ? Math.min(Math.max(Number(hutParam), 0), FISHING_HUT_BUILDERS.length - 1)
    : -1;
  const flashOn = query.get('flash') !== 'off';
  const bulbPhaseParam = query.get('bulbphase');
  const requestedTier = Number(query.get('tier') ?? '0');
  const tier = durandsRequested || hutRequested
    ? MAX_STRUCTURE_TIER
    : Math.min(Math.max(requestedTier, 0), STRUCTURE_TIER_COUNT - 1);

  const { scene, camera, renderer } = buildScene();
  await renderer.init();

  await preloadStructureModels(timberHouseUrl);
  const models = createStructureModels();
  scene.add(models.root);

  const cell = hutRequested
    ? findCoastalCell(hutVariant)
    : tier === MAX_STRUCTURE_TIER
      ? findTopTierCell(durandsRequested)
      : { x: 0, y: 0 };
  const raceParam = query.get('race');
  const race: SettlerRace =
    raceParam === 'rudy' || raceParam === 'uno' ? raceParam : settlementRace(cell.x, cell.y);
  const placement: StructurePlacement = {
    x: cell.x,
    z: cell.y,
    cellX: cell.x,
    cellY: cell.y,
    groundY: 0,
    tier,
    scale: 1,
    yaw: 0,
    race,
    site: hutRequested ? 'coastal' : 'inland',
  };
  const besideParam = query.get('beside');
  const placements: StructurePlacement[] = [placement];
  if (besideParam !== null && Number.isInteger(Number(besideParam))) {
    const besideTier = Math.min(Math.max(Number(besideParam), 0), STRUCTURE_TIER_COUNT - 1);
    const besideCell = besideTier === MAX_STRUCTURE_TIER ? findTopTierCell(false) : { x: 0, y: 0 };
    placements.push({
      ...placement,
      x: placement.x + BESIDE_SPACING_WORLD_UNITS,
      cellX: besideCell.x,
      cellY: besideCell.y,
      tier: besideTier,
    });
  }
  models.apply(placements);

  if (durandsRequested) {
    let dt: number;
    if (bulbPhaseParam === 'a' || bulbPhaseParam === 'b') {
      const marqueeQuarterPeriod = DURANDS_MARQUEE_BULB_PERIOD_SECONDS / 4;
      dt =
        bulbPhaseParam === 'a'
          ? marqueeQuarterPeriod
          : marqueeQuarterPeriod + DURANDS_MARQUEE_BULB_PERIOD_SECONDS / 2;
    } else {
      const quarterPeriod = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 4;
      dt = flashOn ? quarterPeriod : quarterPeriod * 3;
    }
    models.animate(dt);
  }

  frameCameraOn(camera, models, query.get('view') ?? 'front');

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      (window as unknown as { __previewStats: unknown }).__previewStats = {
        tiers: placements.map((placed) => placed.tier),
        race,
        drawCalls: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
      };
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);
}

void main();
