// previewTemple.ts — THROWAWAY preview harness for the temples plugin, in the
// mould of previewYeti.ts / previewPilgrims.ts (previewStructures.ts holds the
// original rationale). Not part of the shipped app: reached only through
// preview-temple.html.
//
//   ?view=<iso|front|summit|scale>  — defaults to "iso"
//   ?t=<seconds>                    — frozen crown time; defaults to 0
//   ?sky=<day|dusk>                 — defaults to "day"
//   ?peep=<0|1>                     — force the peep off/on; on by default
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BACKDROP IS THE EXPERIMENT. Every other harness here stands its subject
// against a neutral studio grey, and for this subject that would be a rigged
// test: the crown's whole defect was that it was drawn ADDITIVELY and so
// vanished against a BRIGHT sky (celestial.ts's DAYLIGHT block). Grey has
// headroom to add into; the daylit sky does not. So the background is
// render/scene.ts's own SKY_COLOR, cross-referenced rather than imported for
// the same reason the yeti harness cross-references the snow band — the shot
// must fail exactly where the game fails.
//
// `?sky=dusk` swaps in a darkened sky, which is the ONLY thing the additive
// bloom shell is for. If the crown reads at dusk but not at day, the fix has
// not landed.
// ─────────────────────────────────────────────────────────────────────────────
//
// THE PEEP IS THE RULER. The temple is a landmark whose size is stated against
// a settlement — one of the little people beside it is what turns "a pyramid"
// into "a pyramid this big" (the same argument previewYeti.ts makes for a
// ratio the owner stated in peeps).
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
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  TEMPLE_DOOR_OFFSET_CELLS,
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS,
} from '../../plugins/temples/protocol.ts';
import { TEMPLE_HEIGHT, createTempleModels } from '../../plugins/temples/client/temple.ts';
import { STRIDE_HZ, createPilgrimModels } from '../../plugins/pilgrims/client/models.ts';

// ── Lighting rig, copied from render/scene.ts ───────────────────────────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

/** The dusk backdrop: the same hue taken down to a fifth of its value. Not a
 *  daynight model — just "the sky is dark now", which is all the additive
 *  bloom shell is being asked about. */
const DUSK_SKY_COLOR = 0x1b2536;
/** How much of the daylight rig survives into the dusk shot. */
const DUSK_LIGHT_SCALE = 0.35;

/** Grass, so the plinth meets ground rather than floating on a grey card. */
const GROUND_COLOR = 0x7e9a55;
const GROUND_SEGMENTS = 64;
const CAMERA_FRAMING_PADDING = 1.15;
const SETTLE_FRAME_COUNT = 3;

/** The studio floor, as a multiple of the temple's footprint span. */
const GROUND_RADIUS_SPANS = 2.2;
/** Where the peep stands, as a multiple of the span, measured from the
 *  temple's axis — clear of the plinth, close enough to compare against. */
const PEEP_OFFSET_SPANS = 0.85;
/** The walk phase the peep is frozen at — mid-swing, so he reads as a walker. */
const PEEP_STRIDE_PHASE = 0.25;

/**
 * Camera directions.
 *
 *   iso    — the three-quarter view the building is designed to be seen in.
 *   front  — square on +X: the stair, the shrine doorway and the two ground
 *            portals all at once, which is the only shot that shows whether
 *            the openings are portrait.
 *   summit — the crown alone, framed on the air above the lintel.
 *   scale  — pulled back to roughly the game's orbit distance.
 */
const CAMERA_VIEWS = {
  iso: new Vector3(0.75, 0.42, 0.65),
  front: new Vector3(1, 0.16, 0.06),
  summit: new Vector3(0.72, 0.3, 0.62),
  scale: new Vector3(0.7, 0.3, 0.68),
} as const;

/** How much further back the "scale" camera sits than a filling framing —
 *  previewYeti.ts's SCALE_VIEW_PULLBACK, and the same argument: a model that
 *  only survives the close-ups is not finished. */
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
/**
 * `?peep=door` stands the settler where the SERVER spawns one — the door cell
 * (temples/protocol.ts's TEMPLE_DOOR_OFFSET_CELLS), rather than beside the
 * building as a ruler.
 *
 * It exists because that offset is a number nobody can check by reading it:
 * the question it answers is "does the person standing there look like they
 * just walked out of the door, or like they are standing inside the bottom
 * step" — and the bottom tread juts further out than the plinth does, which is
 * exactly how the previous value got it wrong.
 */
const peepAtDoor = peepParam === 'door';

const span = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS;

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

const scene = new Scene();
scene.background = new Color(dusk ? DUSK_SKY_COLOR : SKY_COLOR);

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
// The standing temple is built hidden — the plugin shows it when the server
// says one exists — so the harness is the thing that reveals it.
temple.standing.visible = true;
temple.animate(seconds);
subject.add(temple.standing);

if (showPeep) {
  const pilgrims = createPilgrimModels();
  const peep = pilgrims.create('rudy');
  // animate() is a pure function of the clock, so this phase IS that pose.
  peep.animate(PEEP_STRIDE_PHASE / STRIDE_HZ, 0);
  // On the door, facing away from the building — the pose a settler holds for
  // the first step of its walk.
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

// The summit shot is framed on the CROWN, not on the building: a box fitted to
// the whole subject puts the star in the top corner with the masonry filling
// the frame, which is the shot that hid the defect in the first place.
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
