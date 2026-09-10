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
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  TEMPLE_DOOR_OFFSET_CELLS,
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS,
} from '../../plugins/temples/protocol.ts';
import { TEMPLE_HEIGHT, createTempleModels } from '../../plugins/temples/client/temple.ts';
import { STRIDE_HZ, createPilgrimModels } from '../../plugins/pilgrims/client/models.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const DUSK_SKY_COLOR = 0x1b2536;
const DUSK_LIGHT_SCALE = 0.35;

const GROUND_COLOR = 0x7e9a55;
const GROUND_SEGMENTS = 64;
const CAMERA_FRAMING_PADDING = 1.15;
const SETTLE_FRAME_COUNT = 3;

const GROUND_RADIUS_SPANS = 2.2;
const PEEP_OFFSET_SPANS = 0.85;
const PEEP_STRIDE_PHASE = 0.25;

const CAMERA_VIEWS = {
  iso: new Vector3(0.75, 0.42, 0.65),
  front: new Vector3(1, 0.16, 0.06),
  summit: new Vector3(0.72, 0.3, 0.62),
  scale: new Vector3(0.7, 0.3, 0.68),
} as const;

const SCALE_VIEW_PULLBACK = 2.6;

type CameraView = keyof typeof CAMERA_VIEWS;

const query = new URLSearchParams(window.location.search);
const viewParam = query.get('view');
const view: CameraView =
  viewParam !== null && viewParam in CAMERA_VIEWS ? (viewParam as CameraView) : 'iso';
const timeParam = Number(query.get('t') ?? '0');
const seconds = Number.isFinite(timeParam) ? timeParam : 0;
const dusk = query.get('sky') === 'dusk';
const peepParam = query.get('peep');
const showPeep = peepParam === null ? view !== 'summit' : peepParam !== '0';
const peepAtDoor = peepParam === 'door';

const span = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS;

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
await renderer.init();

const scene = new Scene();
scene.background = backgroundRadiance(dusk ? DUSK_SKY_COLOR : SKY_COLOR, renderer);

const ground = new Mesh(
  new CircleGeometry(span * GROUND_RADIUS_SPANS, GROUND_SEGMENTS),
  new MeshLambertMaterial({ color: GROUND_COLOR }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const lightScale = dusk ? DUSK_LIGHT_SCALE : 1;
scene.add(
  new HemisphereLight(
    dusk ? DUSK_SKY_COLOR : SKY_COLOR,
    GROUND_BOUNCE_COLOR,
    HEMISPHERE_LIGHT_INTENSITY * lightScale,
  ),
);
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY * lightScale));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY * lightScale);
sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
scene.add(sun);

const subject = new Group();

const temple = createTempleModels();
temple.standing.visible = true;
temple.animate(seconds);
subject.add(temple.standing);

if (showPeep) {
  const pilgrims = createPilgrimModels();
  const peep = pilgrims.create('rudy');
  peep.animate(PEEP_STRIDE_PHASE / STRIDE_HZ, 0);
  const direction = CAMERA_VIEWS[view];
  if (peepAtDoor) {
    peep.root.position.x = TEMPLE_DOOR_OFFSET_CELLS * CELL_WORLD_SIZE;
    peep.root.rotation.y = Math.PI / 2;
  } else if (Math.abs(direction.z) > Math.abs(direction.x)) {
    peep.root.position.x = span * PEEP_OFFSET_SPANS;
    peep.root.rotation.y = Math.PI;
  } else {
    peep.root.position.z = span * PEEP_OFFSET_SPANS;
    peep.root.rotation.y = Math.PI / 2;
  }
  subject.add(peep.root);
}

scene.add(subject);

const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.02,
  200,
);

const box = new Box3().setFromObject(subject);
const boxCenter = box.getCenter(new Vector3());
const boxSize = box.getSize(new Vector3());
const crownTop = box.max.y;
const center =
  view === 'summit'
    ? new Vector3(0, (TEMPLE_HEIGHT + crownTop) / 2, 0)
    : boxCenter;
const radius =
  view === 'summit'
    ? Math.max(crownTop - TEMPLE_HEIGHT, span * 0.5) * 0.5
    : Math.max(boxSize.x, boxSize.y, boxSize.z) * 0.5;

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
