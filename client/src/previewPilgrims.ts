// previewPilgrims.ts — THROWAWAY preview harness for the pilgrims plugin,
// mirroring previewWildlife.ts (see previewStructures.ts for the original
// rationale). Not part of the shipped app: reached only through
// preview-pilgrims.html, not registered in plugins/registry.ts.
//
//   ?race=<rudy|uno>   — one figure alone; absent, BOTH races side by side,
//                        which is the shot that proves the silhouettes differ
//   ?view=<iso|side|front>                       — defaults to "iso"
//   ?stride=<0..1>     — phase of the walk cycle; defaults to 0.25 (mid-swing,
//                        the pose that shows the legs and tail actually move)
//
// The lighting rig and framing are previewWildlife.ts's, copied verbatim.
// A screenshot driver waits for `window.__previewReady === true`.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { STRIDE_HZ, createPilgrimModels } from '../../plugins/pilgrims/client/models.ts';
import { isSettlerRace, type SettlerRace } from '../../plugins/pilgrims/protocol.ts';

// ── Lighting rig, copied from previewWildlife.ts / render/scene.ts ────────
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
const CAMERA_FRAMING_PADDING = 1.25;
const SETTLE_FRAME_COUNT = 3;

/** Gap between the two figures in the side-by-side shot, world units. */
const PAIR_SPACING = 0.55;

const CAMERA_VIEWS = {
  iso: new Vector3(0.6, 0.45, 0.85),
  side: new Vector3(0.05, 0.12, 1),
  front: new Vector3(1, 0.25, 0.08),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGLRenderer } {
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

  return { scene, camera, renderer };
}

function frameCameraOn(camera: PerspectiveCamera, subject: Group, view: CameraView): void {
  const box = new Box3().setFromObject(subject);
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

function main(): void {
  const query = new URLSearchParams(window.location.search);
  const raceParam = query.get('race');
  const races: SettlerRace[] = isSettlerRace(raceParam) ? [raceParam] : ['rudy', 'uno'];
  const viewParam = query.get('view');
  const view: CameraView =
    viewParam !== null && viewParam in CAMERA_VIEWS ? (viewParam as CameraView) : 'iso';
  const stride = Number(query.get('stride') ?? '0.25');

  const { scene, camera, renderer } = buildScene();

  const models = createPilgrimModels();
  const subject = new Group();
  races.forEach((race, index) => {
    const model = models.create(race);
    // Mid-stride pose at the requested cycle phase — animate() is a pure
    // function of the clock, so `stride / STRIDE_HZ` seconds IS that phase.
    model.animate(stride / STRIDE_HZ, 0);
    model.root.position.z = (index - (races.length - 1) / 2) * PAIR_SPACING;
    subject.add(model.root);
  });
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

main();
