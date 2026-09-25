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
import { installRigTextureTranscoder } from './render/rigTextureTranscoder.ts';
import {
  STRUCTURE_TIERS,
  settlementRace,
  type SettlerRace,
} from '../../plugins/structures/protocol.ts';
import {
  createStructureModels,
  DURANDS_MARQUEE_BULB_PERIOD_SECONDS,
  DURANDS_SIGN_FLASH_PERIOD_SECONDS,
  type StructurePlacement,
} from '../../plugins/structures/client/models.ts';
import { FISHING_HUT_NAMES } from '../../plugins/structures/client/fishingHuts.ts';
import { preloadAuthoredStructures } from '../../plugins/structures/client/authoredAssets.ts';
import { buildingKindOf, tierOfKind } from '../../plugins/structures/settlementRules.ts';

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

/** Only the GLB kit has these: the procedural fallback draws nothing for them. */
const KIT_ONLY_BUILDINGS: ReadonlySet<string> = new Set(['ricks', 'flipper-shrimp']);

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function clampIndex(value: string | null, length: number): number {
  return Math.min(Math.max(Number(value ?? '0') || 0, 0), length - 1);
}

/** ?building=<id>; the older ?durands, ?ricks, ?flipper, ?hut=N and ?tier=N still name one. */
function requestedBuilding(query: URLSearchParams): string {
  const named = query.get('building');
  if (named !== null) return named;
  if (query.get('durands') === '1') return 'durands';
  if (query.get('ricks') === '1') return 'ricks';
  if (query.get('flipper') === '1') return 'flipper-shrimp';
  if (query.get('hut') !== null) return FISHING_HUT_NAMES[clampIndex(query.get('hut'), FISHING_HUT_NAMES.length)]!;
  return STRUCTURE_TIERS[clampIndex(query.get('tier'), STRUCTURE_TIERS.length)]!;
}

function kindOf(id: string): number {
  const kind = buildingKindOf(id);
  if (kind === null) throw new Error(`preview: ${id} is not a building in spawn-bands.json`);
  return kind;
}

function buildScene(unlit: boolean): { scene: Scene; camera: PerspectiveCamera; renderer: WebGPURenderer } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();

  const ground = new Mesh(
    new CircleGeometry(GROUND_RADIUS, 32),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, unlit ? 0 : HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, unlit ? 0 : AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, unlit ? 0 : SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.05, 100);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  scene.background = backgroundRadiance(unlit ? 0x080b10 : BACKDROP_COLOR, renderer);
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
  const building = requestedBuilding(query);
  const kind = kindOf(building);
  const quality = query.get('quality') === 'original' ? 'original' : 'low';
  const flashOn = query.get('flash') !== 'off';
  const bulbPhaseParam = query.get('bulbphase');

  const { scene, camera, renderer } = buildScene(query.get('unlit') === '1');
  await renderer.init();
  installRigTextureTranscoder(renderer);

  const useKit = KIT_ONLY_BUILDINGS.has(building) || query.get('quality') !== null;
  const kit = useKit ? await preloadAuthoredStructures(quality) : undefined;
  const models = createStructureModels(kit);
  scene.add(models.root);

  const raceParam = query.get('race');
  const race: SettlerRace = raceParam === 'rudy' || raceParam === 'uno' ? raceParam : settlementRace(0, 0);
  const placement: StructurePlacement = {
    x: 0,
    z: 0,
    cellX: 0,
    cellY: 0,
    groundY: 0,
    tier: tierOfKind(kind),
    kind,
    scale: 1,
    yaw: 0,
    race,
    site: 'inland',
  };
  const besideParam = query.get('beside');
  const placements: StructurePlacement[] = [placement];
  if (besideParam !== null) {
    const besideKind = kindOf(
      buildingKindOf(besideParam) === null
        ? STRUCTURE_TIERS[clampIndex(besideParam, STRUCTURE_TIERS.length)]!
        : besideParam,
    );
    placements.push({
      ...placement,
      x: placement.x + BESIDE_SPACING_WORLD_UNITS,
      tier: tierOfKind(besideKind),
      kind: besideKind,
    });
  }
  models.apply(placements);

  if (building === 'durands') {
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
        buildings: [building, ...(besideParam === null ? [] : [besideParam])],
        quality: kit === undefined ? 'legacy' : quality,
        unlit: query.get('unlit') === '1',
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
