import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import { createMonsterModels } from '../../plugins/monsters/client/models.ts';
import { lurkDepthOf } from '../../plugins/monsters/client/placement.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
const WATER_COLOR = 0x2f6f9e;
const WATER_OPACITY = 0.55;
const WATER_EXTENT = 40;
const CAMERA_FRAMING_PADDING = 1.3;
const SETTLE_FRAME_COUNT = 3;

const CAMERA_VIEWS = {
  iso: new Vector3(0.7, 0.35, 0.7),
  side: new Vector3(0.05, 0.1, 1),
  front: new Vector3(1, 0.15, 0.08),
  high: new Vector3(0.5, 1, 0.5),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function readParams(): { kind: 'kraken' | 'cthulhu'; view: CameraView; t: number } {
  const params = new URLSearchParams(location.search);
  const kindRaw = params.get('kind');
  const viewRaw = params.get('view');
  const tRaw = Number(params.get('t') ?? '0');
  return {
    kind: kindRaw === 'cthulhu' ? 'cthulhu' : 'kraken',
    view: viewRaw !== null && viewRaw in CAMERA_VIEWS ? (viewRaw as CameraView) : 'iso',
    t: Number.isFinite(tRaw) ? tRaw : 0,
  };
}

const { kind, view, t } = readParams();

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

const hemisphere = new HemisphereLight(
  SKY_COLOR,
  GROUND_BOUNCE_COLOR,
  HEMISPHERE_LIGHT_INTENSITY,
);
scene.add(hemisphere);
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION);
scene.add(sun);
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));

const water = new Mesh(
  new PlaneGeometry(WATER_EXTENT, WATER_EXTENT),
  new MeshBasicMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: WATER_OPACITY,
    side: DoubleSide,
    depthWrite: false,
  }),
);
water.rotation.x = -Math.PI / 2;
scene.add(water);

const models = createMonsterModels();
const model = models.create(kind);
model.root.position.y = -lurkDepthOf(kind);
model.animate(t, 0);
scene.add(model.root);

const bounds = new Box3().setFromObject(model.root);
const center = bounds.getCenter(new Vector3());
const size = bounds.getSize(new Vector3());
const radius = Math.max(size.x, size.y, size.z) * 0.5 * CAMERA_FRAMING_PADDING;

const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.1,
  200,
);
const distance = radius / Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);
camera.position.copy(CAMERA_VIEWS[view]).normalize().multiplyScalar(distance).add(center);
camera.lookAt(center);

declare global {
  interface Window {
    __previewReady?: boolean;
  }
}

let frames = 0;
function frame(): void {
  renderer.render(scene, camera);
  frames += 1;
  if (frames >= SETTLE_FRAME_COUNT) {
    window.__previewReady = true;
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
