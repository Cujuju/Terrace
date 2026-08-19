// previewKraken.ts — THROWAWAY preview harness for the monsters plugin's sea
// kinds, mirroring previewPilgrims.ts (see previewStructures.ts for the
// original rationale). Not part of the shipped app: reached only through
// preview-kraken.html.
//
//   ?kind=<kraken|cthulhu>  — defaults to "kraken"
//   ?view=<iso|side|front|high>  — defaults to "iso"
//   ?t=<seconds>            — a frozen animation time; defaults to 0
//
// THE WATERLINE IS THE POINT. The model is sunk to its true lurk depth
// (placement.ts's swimmer rule) against a translucent sea plane at y = 0, so a
// screenshot shows exactly what a player sees standing on the shore: what
// breaks the surface, what hides under it, and whether the mass above the
// water could plausibly be held up by the mass below it.
//
// A screenshot driver waits for `window.__previewReady === true`.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
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
  WebGLRenderer,
} from 'three';
import { createMonsterModels } from '../../plugins/monsters/client/models.ts';
import { lurkDepthOf } from '../../plugins/monsters/client/placement.ts';

// ── Lighting rig, copied from previewPilgrims.ts / render/scene.ts ──────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

const BACKDROP_COLOR = 0x808080;
/** The sea sheet: the render water's colour, half transparent so the submerged
 *  half of the animal stays readable while the waterline stays unmistakable. */
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
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

const scene = new Scene();
scene.background = new Color(BACKDROP_COLOR);

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

// The sea: y = 0 IS the waterline. The model sinks below it by its own rule.
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

// ── Framing: fit the whole animal plus a strip of sea ───────────────────────
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
