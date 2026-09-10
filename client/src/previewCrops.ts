import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  DirectionalLight,
  HemisphereLight,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CROP_PLOT_CLUSTER_CELL_SPAN,
  CROP_STALKS_PER_PLOT,
  CROP_STALK_OFFSETS,
  cropStalkVariation,
} from '../../plugins/flora/protocol.ts';
import {
  WHEAT_VARIANT_BUILDERS,
  WHEAT_VARIANT_NAMES,
} from '../../plugins/flora/client/wheatVariants.ts';

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
const GROUND_RADIUS = 2;
const CAMERA_FRAMING_PADDING = 1.2;
const SETTLE_FRAME_COUNT = 3;

const CAMERA_DIRECTION = new Vector3(0.55, 0.35, 0.9);

const cells = (n: number): number => n * CELL_WORLD_SIZE;

const CLUSTER_SPAN_IN_CELLS = CROP_PLOT_CLUSTER_CELL_SPAN;

const PREVIEW_CELL_X = 7;
const PREVIEW_CELL_Y = 11;

const STALK_COLOR = 0xd2b04a;
const EAR_COLOR = 0xe6c96a;

function readOption(): number {
  const requested = Number.parseInt(
    new URLSearchParams(window.location.search).get('option') ?? '',
    10,
  );
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), WHEAT_VARIANT_BUILDERS.length - 1)
    : 0;
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

  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.005, 100);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);
  renderer.outputColorSpace = SRGBColorSpace;

  return { scene, camera, renderer };
}

function frameCameraOn(camera: PerspectiveCamera, root: Group): void {
  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION.clone().normalize(), distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

async function main(): Promise<void> {
  const option = readOption();
  const name = WHEAT_VARIANT_NAMES[option];
  document.title = `Crop preview — ${name}`;

  const { scene, camera, renderer } = buildScene();
  await renderer.init();

  const plot = new Group();
  plot.name = `preview:wheat-${option}`;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  const { stalk: stalkGeometry, ear: earGeometry } = WHEAT_VARIANT_BUILDERS[option]!();
  const stalkMaterial = new MeshLambertMaterial({ color: STALK_COLOR, flatShading: true });
  const earMaterial = new MeshLambertMaterial({ color: EAR_COLOR, flatShading: true });
  geometries.push(stalkGeometry, earGeometry);
  materials.push(stalkMaterial, earMaterial);

  const spread = cells(CLUSTER_SPAN_IN_CELLS);
  for (let index = 0; index < CROP_STALKS_PER_PLOT; index++) {
    const [ox, oz] = CROP_STALK_OFFSETS[index]!;
    const roll = cropStalkVariation(PREVIEW_CELL_X, PREVIEW_CELL_Y, index);

    const stalk = new Mesh(stalkGeometry, stalkMaterial);
    stalk.position.set((ox + roll.jitterX) * spread, 0, (oz + roll.jitterZ) * spread);
    stalk.rotation.y = roll.yaw;
    stalk.scale.set(1, roll.height, 1);
    plot.add(stalk);

    const ear = new Mesh(earGeometry, earMaterial);
    ear.position.copy(stalk.position);
    ear.rotation.y = stalk.rotation.y;
    ear.scale.copy(stalk.scale);
    plot.add(ear);
  }

  scene.add(plot);
  frameCameraOn(camera, plot);

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
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  });
}

void main();
