// previewBoats.ts — THROWAWAY preview harness for the boats plugin, mirroring
// previewPilgrims.ts. Not part of the shipped app: reached only through
// preview-boats.html, not registered in plugins/registry.ts.
//
//   ?state=<sailing|fighting>  — one boat alone; absent, BOTH side by side,
//                                which is the shot that proves the fighting
//                                sail actually reads differently
//   ?view=<iso|side|front|top> — defaults to "iso"
//   ?t=<seconds>               — animation clock; defaults to 0.6 (mid-stroke)
//
// A WATERLINE PLANE, unlike the other harnesses' ground disc: this model's
// whole vertical contract is BOAT_WATERLINE_LIFT — the hull is meant to sit
// half-submerged — and a shot without a water surface cannot show whether it
// does. Same reason preview-kraken.html grew one.
//
// The lighting rig and framing are previewPilgrims.ts's, copied verbatim.
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
import warBoatUrl from '../../plugins/boats/client/assets/war-boat.glb?url';
import { loadRigAsset } from './render/rigAsset.ts';
import {
  BOAT_WATERLINE_LIFT,
  createBoatModels,
  preloadBoatModels,
} from '../../plugins/boats/client/models.ts';

// ── Lighting rig, copied from previewPilgrims.ts / render/scene.ts ────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
/** The sea, at the studio's own scale. Opaque here on purpose: this shot is
 *  about where the waterline cuts the hull, and translucency would blur it. */
const WATER_COLOR = 0x2f6f8f;
const WATER_RADIUS = 3;
const CAMERA_FRAMING_PADDING = 1.3;
const SETTLE_FRAME_COUNT = 3;

/** Gap between the two boats in the side-by-side shot, world units. */
const PAIR_SPACING = 1.1;

const CAMERA_VIEWS = {
  iso: new Vector3(0.6, 0.45, 0.85),
  side: new Vector3(0.05, 0.12, 1),
  front: new Vector3(1, 0.25, 0.08),
  top: new Vector3(0.01, 1, 0.01),
} as const;

type CameraView = keyof typeof CAMERA_VIEWS;

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGLRenderer } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);

  // The waterline, at world Y 0 — exactly where render/water.ts draws the sea
  // and exactly what BOAT_WATERLINE_LIFT is measured against.
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

  // The asset first: createBoatModels bakes from the installed kit.
  // The preview has no plugin host: it stands in for ctx.loadRigAsset with the
  // loader itself, at the same 'lamps-only' policy the plugin's preload asks
  // for (plugins/boats/client/models.ts) — the environment is a metals-only
  // concern this page has no material for.
  await preloadBoatModels(
    { loadRigAsset: (url) => loadRigAsset(url, null) },
    warBoatUrl,
  );
  const models = createBoatModels();
  const subject = new Group();
  states.forEach((fighting, index) => {
    const model = models.create();
    // animate() is a pure function of the clock, so this IS the pose at `t`.
    // Phase 0 for both, so the pair differ ONLY by their fighting state —
    // which is the comparison this shot exists to make.
    model.animate(clock, 0, fighting);
    model.root.position.y = BOAT_WATERLINE_LIFT;
    model.root.position.z = (index - (states.length - 1) / 2) * PAIR_SPACING;
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

void main();
