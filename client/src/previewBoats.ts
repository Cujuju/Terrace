import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  DirectionalLight,
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
import warBoatUrl from '../../plugins/boats/client/assets/war-boat.glb?url';
import { loadRigAsset } from './render/rigAsset.ts';
import {
  BOAT_SHAPE,
  createBoatModels,
  preloadBoatModels,
} from '../../plugins/boats/client/models.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
const WATER_COLOR = 0x2f6f8f;
const WATER_RADIUS = 3;
const CAMERA_FRAMING_PADDING = 1.3;
const SETTLE_FRAME_COUNT = 3;

const FRAME_ON_POSED_VERTICES = true;

const PAIR_SPACING = 1.1;

const CAMERA_VIEWS = {
  iso: new Vector3(0.6, 0.45, 0.85),
  side: new Vector3(0.05, 0.12, 1),
  front: new Vector3(1, 0.25, 0.08),
  top: new Vector3(0.01, 1, 0.01),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGPURenderer } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();

  const water = new Mesh(
    new CircleGeometry(WATER_RADIUS, 48),
    new MeshLambertMaterial({ color: WATER_COLOR }),
  );
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

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

function frameCameraOn(camera: PerspectiveCamera, subject: Group, view: CameraView): void {
  subject.updateMatrixWorld(true);
  const box = new Box3().setFromObject(subject, FRAME_ON_POSED_VERTICES);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  const direction = CAMERA_VIEWS[view].clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

async function main(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const stateParam = query.get('state');
  const states: boolean[] =
    stateParam === 'sailing' ? [false] : stateParam === 'fighting' ? [true] : [false, true];
  const viewParam = query.get('view');
  const view: CameraView =
    viewParam !== null && viewParam in CAMERA_VIEWS ? (viewParam as CameraView) : 'iso';
  const clock = Number(query.get('t') ?? '0.6');

  const { scene, camera, renderer } = buildScene();
  await renderer.init();

  await preloadBoatModels(
    { loadRigAsset: (url) => loadRigAsset(url, null) },
    warBoatUrl,
  );
  const models = createBoatModels();
  const subject = new Group();
  for (const object of models.objects) subject.add(object);
  models.beginFrame();
  states.forEach((fighting, index) => {
    models.create().draw(
      0,
      BOAT_SHAPE.waterlineLift,
      (index - (states.length - 1) / 2) * PAIR_SPACING,
      0,
      clock,
      0,
      clock,
      fighting,
    );
  });
  models.commitFrame();
  scene.add(subject);

  frameCameraOn(camera, subject, view);

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
