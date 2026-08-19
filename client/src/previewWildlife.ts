// previewWildlife.ts — THROWAWAY preview harness for the wildlife plugin,
// mirroring previewStructures.ts's own pattern for the structures plugin
// (see that file's header for the fuller rationale; this restates only what
// differs). Not part of the shipped app: reached only through
// preview-wildlife.html (a separate Vite entry point next to index.html,
// unlinked from it), and not registered in plugins/registry.ts. Exists so
// any species' model can be screenshotted in isolation against a neutral
// backdrop, one per page load, driven by this page's own query string:
//
//   ?species=<fish|whale|deepsea|grazer|bird>   — defaults to "whale"
//   ?class=<small|medium|large>                 — defaults to "medium"
//   ?view=<iso|side|top>                        — defaults to "iso"
//
// The lighting rig (hemisphere + directional + ambient, ACES tone mapping)
// and the ground-disc/backdrop/camera-framing choices are copied verbatim
// from previewStructures.ts, which itself copies the real scene's own recipe
// — see that file for the tuning history behind each number.
//
// A screenshot driver navigates here once per species and waits for
// `window.__previewReady === true` before capturing the canvas — set at the
// bottom of this file, only after the frame the creature was actually drawn
// into has been presented.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
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
import { createWildlifeModels, type CreatureModel } from '../../plugins/wildlife/client/models.ts';

// ── Lighting rig, copied from previewStructures.ts / render/scene.ts ──────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

// ── Preview-only presentation ────────────────────────────────────────────
/** Neutral mid-grey backdrop — no sky, no water, just the model. */
const BACKDROP_COLOR = 0x808080;
/** A slightly darker neutral disc under the model, purely as a scale reference. */
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 4;
/** Same framing padding previewStructures.ts uses — "framed close" with a hair of margin. */
const CAMERA_FRAMING_PADDING = 1.25;
/** Frames rendered before the screenshot flag is raised — same rationale as previewStructures.ts. */
const SETTLE_FRAME_COUNT = 3;

const DEFAULT_SPECIES: WildlifeSpecies = 'whale';

/**
 * Named camera directions, unit vectors from the model's centre. 'iso' is the
 * same 3/4 angle previewStructures.ts frames every building from, kept as the
 * default so a wildlife screenshot means the same thing a structures one
 * does. 'side' and 'top' exist only for this plugin's own models — a nearly
 * flat lateral view is what actually checks a tapered body profile, and a
 * near-top-down view is what checks pectoral-fin left/right symmetry —
 * neither of which the 3/4 angle alone can confirm.
 */
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

/** Points `camera` at `model.root`'s bounding sphere, filling the frame with `CAMERA_FRAMING_PADDING` of headroom. */
function frameCameraOn(camera: PerspectiveCamera, model: CreatureModel, view: CameraView): void {
  const box = new Box3().setFromObject(model.root);
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
  const query = readQuery();
  const species = readSpecies(query);
  const sizeClass = readSizeClass(query);
  const view = readView(query);

  const { scene, camera, renderer } = buildScene();

  const models = createWildlifeModels();
  const model = models.create(species, sizeClass);
  // Rest pose: an explicit animate(0, 0) call, not an unrotated default left
  // implicit, so the frame captured is documented rather than incidental.
  model.animate(0, 0);
  scene.add(model.root);

  frameCameraOn(camera, model, view);

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      // Signals the screenshot driver: the creature is drawn, the frame is
      // presented, it is safe to capture the canvas now.
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);
}

main();
