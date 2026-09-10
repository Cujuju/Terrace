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
import { DEFAULT_YETI_VARIANT, isYetiVariant } from '../../plugins/monsters/protocol.ts';
import { MOVER_GAITS, type MoverGait } from './plugins/kit/moverGait.ts';
import { createMonsterModels } from '../../plugins/monsters/client/models.ts';
import { YETI_VARIANT_METRICS } from '../../plugins/monsters/client/yeti-anatomy.ts';
import { STRIDE_HZ, createPilgrimModels } from '../../plugins/pilgrims/client/models.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
const GROUND_COLOR = 0xf2f4f6;
const GROUND_RADIUS = 2.5;
const GROUND_SEGMENTS = 48;
const CAMERA_FRAMING_PADDING = 1.2;
const SETTLE_FRAME_COUNT = 3;

const PEEP_SPACING = 0.7;
const PEEP_STRIDE_PHASE = 0.25;

const CAMERA_VIEWS = {
  iso: new Vector3(0.7, 0.35, 0.7),
  side: new Vector3(0.02, 0.05, 1),
  front: new Vector3(1, 0.15, 0.08),
  face: new Vector3(1, 0.28, 0.32),
  hips: new Vector3(0.85, 0.3, 0.6),
  scale: new Vector3(0.55, 0.22, 0.9),
} as const;

const SCALE_VIEW_PULLBACK = 3.2;

const FACE_VIEW_MARGIN = 2.4;

type CameraView = keyof typeof CAMERA_VIEWS;

const query = new URLSearchParams(window.location.search);
const viewParam = query.get('view');
const view: CameraView =
  viewParam !== null && viewParam in CAMERA_VIEWS ? (viewParam as CameraView) : 'iso';
const timeParam = Number(query.get('t') ?? '0');
const seconds = Number.isFinite(timeParam) ? timeParam : 0;
const variantParam = query.get('variant');
const variant = isYetiVariant(variantParam) ? variantParam : DEFAULT_YETI_VARIANT;
const gaitParam = query.get('gait');
const gait: MoverGait = MOVER_GAITS.find((named) => named === gaitParam) ?? 'walk';
const peepParam = query.get('peep');
const showPeep = peepParam === null ? view !== 'face' && view !== 'hips' : peepParam === '1';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
await renderer.init();

const scene = new Scene();
scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);

const ground = new Mesh(
  new CircleGeometry(GROUND_RADIUS, GROUND_SEGMENTS),
  new MeshLambertMaterial({ color: GROUND_COLOR }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
scene.add(sun);

const subject = new Group();

const monsters = createMonsterModels();
const yeti = monsters.create('yeti', variant);
yeti.animate(seconds, 0, gait);
subject.add(yeti.root);

if (showPeep) {
  const pilgrims = createPilgrimModels();
  const peep = pilgrims.create('rudy');
  peep.animate(gait === 'walk' ? PEEP_STRIDE_PHASE / STRIDE_HZ : seconds, 0, gait);

  const direction = CAMERA_VIEWS[view];
  const offsetOnX = Math.abs(direction.z) > Math.abs(direction.x);
  if (offsetOnX) {
    peep.root.position.x = PEEP_SPACING;
    peep.root.rotation.y = Math.PI;
  } else {
    peep.root.position.z = PEEP_SPACING;
    peep.root.rotation.y = Math.PI / 2;
  }
  subject.add(peep.root);
}

scene.add(subject);

const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.02,
  100,
);

const box = new Box3().setFromObject(subject);
const metrics = YETI_VARIANT_METRICS[variant];
const center =
  view === 'face'
    ? new Vector3(0, metrics.headCenterHeight, 0)
    : view === 'hips'
      ? new Vector3(0, metrics.hipHeight, 0)
      : box.getCenter(new Vector3());
const size = box.getSize(new Vector3());
const radius =
  view === 'face'
    ? metrics.headRadius * FACE_VIEW_MARGIN
    : view === 'hips'
      ? metrics.hipsWidth
      : Math.max(size.x, size.y, size.z) * 0.5;

const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
const pullback = view === 'scale' ? SCALE_VIEW_PULLBACK : 1;
const distance =
  (radius * CAMERA_FRAMING_PADDING * pullback) / Math.sin(verticalFovRadians / 2);
camera.position.copy(center).addScaledVector(CAMERA_VIEWS[view].clone().normalize(), distance);
camera.lookAt(center);
camera.updateProjectionMatrix();

declare global {
  interface Window {
    __previewReady?: boolean;
  }
}

let framesRendered = 0;
function renderFrame(): void {
  renderer.render(scene, camera);
  framesRendered += 1;
  if (framesRendered >= SETTLE_FRAME_COUNT) {
    window.__previewReady = true;
    return;
  }
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);
