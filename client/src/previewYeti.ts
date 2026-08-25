// previewYeti.ts — THROWAWAY preview harness for the monsters plugin's LAND
// kind, mirroring previewKraken.ts and previewPilgrims.ts (see
// previewStructures.ts for the original rationale). Not part of the shipped
// app: reached only through preview-yeti.html.
//
//   ?view=<iso|side|front|face|hips|scale>  — defaults to "iso"
//   ?t=<seconds>                       — frozen animation time; defaults to 0
//   ?peep=<0|1>                        — force the peep off/on; by default he
//                                        is present in every view but "face"
//
// THE PEEP IS THE POINT. This animal's size is stated as a RATIO — the owner's
// 2026-08-24 ceiling is "no more than two times taller than one of the peeps" —
// and a ratio cannot be reviewed in an empty studio. So a pilgrim stands beside
// him at the same ground plane in every framing but the head-shot, and the
// "scale" view is a flat side-on elevation of the two, which is the shot that
// measures rather than flatters.
//
// GROUND, NOT WATERLINE: he is a walker, so his origin sits ON y = 0 (the two
// swimmers hang below it). Nothing here sinks him.
//
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
import { createMonsterModels } from '../../plugins/monsters/client/models.ts';
import {
  YETI_HEAD_CENTER_HEIGHT,
  YETI_HIPS_WIDTH,
  YETI_HIP_HEIGHT,
  YETI_TOTAL_HEIGHT,
} from '../../plugins/monsters/client/yeti-anatomy.ts';
import { STRIDE_HZ, createPilgrimModels } from '../../plugins/pilgrims/client/models.ts';

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
/**
 * The studio floor is SNOW, not the neutral grey the other harnesses use.
 *
 * He is a white animal that lives on band 9 and above, and the client paints
 * that band 0xf2f4f6 — the single hardest thing about reading this model is
 * white-on-white, and a grey floor would hide exactly the failure the review
 * has to catch. Cross-referenced against the palette, not imported, for the
 * reason yeti-anatomy.ts's colour block gives.
 */
const GROUND_COLOR = 0xf2f4f6;
const GROUND_RADIUS = 2.5;
const GROUND_SEGMENTS = 48;
const CAMERA_FRAMING_PADDING = 1.2;
const SETTLE_FRAME_COUNT = 3;

/** Gap between the yeti's axis and the peep's, world units. */
const PEEP_SPACING = 0.7;
/** The walk phase the peep is frozen at — mid-swing, so he reads as a walker. */
const PEEP_STRIDE_PHASE = 0.25;

/**
 * Camera directions. "face" is the head-shot the fangs and horns are reviewed
 * in and frames the head alone; "scale" is the only one that is not a studio
 * shot at all — see SCALE_VIEW_PULLBACK.
 */
const CAMERA_VIEWS = {
  iso: new Vector3(0.7, 0.35, 0.7),
  side: new Vector3(0.02, 0.05, 1),
  front: new Vector3(1, 0.15, 0.08),
  face: new Vector3(1, 0.55, 0.35),
  hips: new Vector3(0.85, 0.3, 0.6),
  scale: new Vector3(0.55, 0.22, 0.9),
} as const;

/**
 * How much further back the "scale" camera sits than a framing that fills the
 * shot with the subject.
 *
 * 3.2, and the number is the whole point of the view: every other framing here
 * flatters the model by filling the screen with it, and NONE of them is what a
 * player sees. This one pulls back to roughly the game's orbit distance, where
 * the only things left of the animal are his silhouette, his mass against the
 * peep beside him, and whether the horns still read. A model that survives this
 * shot is finished; one that only survives the close-ups is not.
 */
const SCALE_VIEW_PULLBACK = 3.2;

type CameraView = keyof typeof CAMERA_VIEWS;

const query = new URLSearchParams(window.location.search);
const viewParam = query.get('view');
const view: CameraView =
  viewParam !== null && viewParam in CAMERA_VIEWS ? (viewParam as CameraView) : 'iso';
const timeParam = Number(query.get('t') ?? '0');
const seconds = Number.isFinite(timeParam) ? timeParam : 0;
const peepParam = query.get('peep');
const showPeep = peepParam === null ? view !== 'face' && view !== 'hips' : peepParam === '1';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

const scene = new Scene();
scene.background = new Color(BACKDROP_COLOR);

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
const yeti = monsters.create('yeti');
yeti.animate(seconds, 0);
subject.add(yeti.root);

if (showPeep) {
  const pilgrims = createPilgrimModels();
  const peep = pilgrims.create('rudy');
  // animate() is a pure function of the clock, so this phase IS that pose.
  peep.animate(PEEP_STRIDE_PHASE / STRIDE_HZ, 0);

  // HE STANDS ACROSS THE CAMERA, NEVER IN FRONT OF IT. A fixed offset put the
  // peep on the far side of the yeti in every Z-axis framing, where he is
  // simply hidden — and a scale comparison in which one of the two subjects is
  // occluded is worse than no comparison, because it still looks like a shot.
  // So the offset goes on whichever horizontal axis the camera is looking
  // ACROSS, which is the axis the two of them can both be seen on.
  const direction = CAMERA_VIEWS[view];
  const offsetOnX = Math.abs(direction.z) > Math.abs(direction.x);
  if (offsetOnX) {
    peep.root.position.x = PEEP_SPACING;
    // The model faces +X, so this turns him back towards the yeti at the origin.
    peep.root.rotation.y = Math.PI;
  } else {
    peep.root.position.z = PEEP_SPACING;
    // Rotating +X by +90° about Y sends it to -Z — again, towards the yeti. A
    // peep looking UP at the animal is what makes the height difference read as
    // a fact about the world rather than a diagram.
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

// FRAMED ON THE HEAD, not on the whole subject, in the head-shot: the point of
// that view is the face, and a box fitted to the model would put it in the
// middle distance with the feet.
const box = new Box3().setFromObject(subject);
const center =
  view === 'face'
    ? new Vector3(0, YETI_HEAD_CENTER_HEIGHT, 0)
    : view === 'hips'
      ? new Vector3(0, YETI_HIP_HEIGHT, 0)
      : box.getCenter(new Vector3());
const size = box.getSize(new Vector3());
const radius =
  view === 'face'
    ? YETI_TOTAL_HEIGHT - YETI_HEAD_CENTER_HEIGHT
    : view === 'hips'
      ? YETI_HIPS_WIDTH
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
