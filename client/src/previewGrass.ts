import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { grassCoversCell, type CropCell, type GrassCell } from '../../plugins/flora/protocol.ts';
import { createGrassModels } from '../../plugins/flora/client/grassModels.ts';
import { grassPlacementsFor } from '../../plugins/flora/client/grassPlacement.ts';
import { createCropModels } from '../../plugins/flora/client/cropModels.ts';
import { cropPlacementsFor } from '../../plugins/flora/client/cropPlacement.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const GROUND_COLOR = 0x6f9e4c;

const SETTLE_FRAME_COUNT = 3;

const DEFAULT_FRAME_WORLD_UNITS = 10;
const DEFAULT_PATCH_CELLS = 40;

const CAMERA_DIRECTION = new Vector3(0, 0.57, 0.82);

function readNumber(name: string, fallback: number): number {
  const raw = Number.parseFloat(new URLSearchParams(window.location.search).get(name) ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function main(): void {
  const frameWorldUnits = readNumber('frame', DEFAULT_FRAME_WORLD_UNITS);
  const patchCells = Math.round(readNumber('cells', DEFAULT_PATCH_CELLS));
  document.title = `Grass preview — ${patchCells} cells, ${frameWorldUnits} world units framed`;

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);

  const patchWorld = patchCells * CELL_WORLD_SIZE;
  const ground = new Mesh(
    new PlaneGeometry(patchWorld * 2, patchWorld * 2),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  const grassCells: GrassCell[] = [];
  for (let y = 0; y < patchCells; y++) {
    for (let x = 0; x < patchCells; x++) {
      if (grassCoversCell(x, y)) grassCells.push({ x, y });
    }
  }
  const grass = createGrassModels();
  grass.apply(grassPlacementsFor(grassCells, () => 0).placements);
  scene.add(grass.root);

  const referenceCell: CropCell = {
    x: Math.floor(patchCells / 2),
    y: Math.floor(patchCells / 2),
  };
  const crops = createCropModels();
  crops.apply(cropPlacementsFor([referenceCell], () => 0).placements);
  scene.add(crops.root);

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    window.innerWidth / window.innerHeight,
    0.005,
    200,
  );
  const distance = frameWorldUnits / (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
  const centre = new Vector3(
    referenceCell.x * CELL_WORLD_SIZE,
    0,
    referenceCell.y * CELL_WORLD_SIZE,
  );
  camera.position.copy(centre).addScaledVector(CAMERA_DIRECTION.clone().normalize(), distance);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
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

  window.addEventListener('pagehide', () => {
    grass.dispose();
    crops.dispose();
  });
}

main();
