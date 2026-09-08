import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  type Object3D,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  DEFAULT_SIZE_CLASS,
  isWildlifeSpecies,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../../plugins/wildlife/protocol.ts';
import { createWildlifeModels } from '../../plugins/wildlife/client/models.ts';
import { MOVER_GAITS, type MoverGait } from './plugins/kit/moverGait.ts';
import { loadRigAsset } from './render/rigAsset.ts';
import { installSpeciesAsset } from '../../plugins/wildlife/client/species/assetSpecies.ts';
import { SPECIES_ASSETS } from '../../plugins/wildlife/client/species/assets.ts';

const PREVIEW_POPULATION = 1;

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
const GROUND_RADIUS = 4;
const GROUND_DROP_WORLD_UNITS = 0.02;
const CAMERA_FRAMING_PADDING = 1.25;
const SETTLE_FRAME_COUNT = 3;

const DEFAULT_SPECIES: WildlifeSpecies = 'whale';

const CAMERA_VIEWS = {
  iso: new Vector3(0.6, 0.45, 0.85),
  side: new Vector3(0.05, 0.12, 1),
  top: new Vector3(0.05, 1, 0.35),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function readSpecies(query: URLSearchParams): WildlifeSpecies {
  const requested = query.get('species');
  return requested !== null && isWildlifeSpecies(requested) ? requested : DEFAULT_SPECIES;
}

function readSizeClass(query: URLSearchParams): WildlifeSizeClass {
  const requested = query.get('class');
  return (WILDLIFE_SIZE_CLASSES as readonly string[]).includes(requested ?? '')
    ? (requested as WildlifeSizeClass)
    : DEFAULT_SIZE_CLASS;
}

function readView(query: URLSearchParams): CameraView {
  const requested = query.get('view');
  return requested !== null && requested in CAMERA_VIEWS ? (requested as CameraView) : 'iso';
}

function readVariant(query: URLSearchParams): number {
  const requested = Number.parseInt(query.get('variant') ?? '', 10);
  return Number.isFinite(requested) ? requested : 0;
}

function readSeconds(query: URLSearchParams): number {
  return Number.parseFloat(query.get('t') ?? '0') || 0;
}

function readPhase(query: URLSearchParams): number {
  return Number.parseFloat(query.get('phase') ?? '0') || 0;
}

function readGait(query: URLSearchParams): MoverGait {
  const named = query.get('gait');
  return MOVER_GAITS.find((gait) => gait === named) ?? 'walk';
}

function buildScene(): {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  ground: Mesh;
} {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);

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

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = SRGBColorSpace;

  return { scene, camera, renderer, ground };
}

function drawnBounds(objects: readonly Object3D[]): Box3 {
  const box = new Box3();
  for (const object of objects) {
    if (!(object instanceof InstancedMesh) || object.count === 0) continue;
    object.boundingBox = null;
    object.computeBoundingBox();
    box.union(object.boundingBox!);
  }
  return box;
}

let ZOOM = 1;

function frameCameraOn(camera: PerspectiveCamera, box: Box3, view: CameraView): void {
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2) / ZOOM;

  const direction = CAMERA_VIEWS[view].clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

async function installAssets(): Promise<void> {
  for (const { spec, url } of SPECIES_ASSETS) {
    installSpeciesAsset(spec, await loadRigAsset(url, null));
  }
}

function main(): void {
  const query = readQuery();
  const species = readSpecies(query);
  const sizeClass = readSizeClass(query);
  const view = readView(query);

  const { scene, camera, renderer, ground } = buildScene();

  const models = createWildlifeModels(PREVIEW_POPULATION);
  const group = new Group();
  for (const object of models.objects) group.add(object);
  scene.add(group);

  models.beginFrame(readSeconds(query));
  models.draw(species, sizeClass, readVariant(query), readPhase(query), readGait(query), 0, 0, 0, 0);
  models.endFrame();

  const drawnBox = drawnBounds(models.objects);
  const bodyHeight = drawnBox.max.y - drawnBox.min.y;
  ground.position.y =
    readGait(query) === 'walk'
      ? Math.min(0, drawnBox.min.y - GROUND_DROP_WORLD_UNITS)
      : drawnBox.min.y - bodyHeight - GROUND_DROP_WORLD_UNITS;

  ZOOM = Number.parseFloat(query.get('zoom') ?? '1') || 1;
  frameCameraOn(camera, drawnBox, view);

  let triangles = 0;
  for (const object of models.objects) {
    const geometry = (object as Mesh).geometry;
    const index = geometry.getIndex();
    triangles += (index ? index.count : geometry.getAttribute('position').count) / 3;
  }
  (window as unknown as { __previewStats: unknown }).__previewStats = {
    species,
    sizeClass,
    poolSurfaces: models.objects.length,
    poolTriangles: triangles,
    bounds: { min: drawnBox.min.toArray(), max: drawnBox.max.toArray() },
  };

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

void installAssets().then(main);
