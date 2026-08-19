// previewStructures.ts — THROWAWAY preview harness for the structures
// plugin. Not part of the shipped app: reached only through preview.html (a
// separate Vite entry point next to index.html, unlinked from it), and not
// registered in plugins/registry.ts. Exists solely so every tier's model —
// and the Durand's variant — can be screenshotted in isolation against a
// neutral backdrop, one per page load, driven by this page's own query
// string:
//
//   ?tier=<0..STRUCTURE_TIER_COUNT-1>   — that tier's standard model
//   ?durands=1                          — the Durand's variant (forces the
//                                         top tier regardless of ?tier)
//   ?flash=on|off                       — durands=1 only: freezes the sign's
//                                         flash at its brightest ("on") or
//                                         dimmest ("off") point, so a driver
//                                         can capture both halves of the
//                                         flash without waiting on real time
//
// The lighting rig (hemisphere + directional + ambient, ACES tone mapping)
// is copied from render/scene.ts's own recipe — "nicely lit" here means "lit
// the way the real game lights it", not a bespoke studio setup. Only the
// background and the addition of a small ground disc (so a building does not
// look like it is floating with no reference plane) are preview-specific.
//
// A screenshot driver navigates here once per combination above and waits
// for `window.__previewReady === true` before capturing the canvas — set at
// the bottom of this file, only after the frame the building was actually
// drawn into has been presented.

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
  type Group,
} from 'three';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_TIER_COUNT,
} from '../../plugins/structures/protocol.ts';
import {
  createStructureModels,
  DURANDS_SIGN_FLASH_PERIOD_SECONDS,
  type StructurePlacement,
} from '../../plugins/structures/client/models.ts';
import { isDurandsCell } from '../../plugins/structures/client/durands.ts';

// ── Lighting rig, copied from render/scene.ts (see that file for the tuning
// history behind each number — this preview borrows the values, not just the
// shape, so a screenshot here means what it would mean in the real scene). ──
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

// ── Preview-only presentation ────────────────────────────────────────────
/** Neutral mid-grey backdrop — no sky, no terrain, just the model. */
const BACKDROP_COLOR = 0x808080;
/** A slightly darker neutral disc under the model, purely as a ground reference. */
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 3;
/**
 * How much headroom the camera leaves around the model's bounding sphere.
 * 1.25 reads as "framed close" (the brief's own words) while still leaving a
 * hair of margin so the model's silhouette does not clip the frame edge.
 */
const CAMERA_FRAMING_PADDING = 1.25;
/** Frames rendered before the screenshot flag is raised — lets the WebGL
 * context's first-frame setup cost (shader compiles, texture upload) land
 * before the driver captures, rather than possibly catching a partial frame. */
const SETTLE_FRAME_COUNT = 3;

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/**
 * Finds the lowest-coordinate cell whose top-tier roll matches `wantDurands`,
 * scanning row-major from (0, 0). isDurandsCell's own share (~1 in 6, see
 * ./durands.ts) means both directions of this search terminate almost
 * immediately; the small upper bound is only a defensive backstop against an
 * unexpected all-one-way region, not a tuned budget — see the thrown error.
 *
 * Needed for BOTH directions, not just the Durand's one: a plain `?tier=5`
 * request must land on a cell that does NOT roll Durand's, or the standard
 * watchtower screenshot would silently come back as the Durand's skin
 * instead — cell (0, 0) itself happens to roll Durand's, which is exactly
 * the bug a hardcoded (0, 0) here would have shipped.
 */
function findTopTierCell(wantDurands: boolean): { x: number; y: number } {
  const SCAN_EDGE = 64;
  for (let y = 0; y < SCAN_EDGE; y++) {
    for (let x = 0; x < SCAN_EDGE; x++) {
      if (isDurandsCell(MAX_STRUCTURE_TIER, x, y) === wantDurands) return { x, y };
    }
  }
  throw new Error(
    `preview: found no ${wantDurands ? '' : 'non-'}Durand's cell in the first ${SCAN_EDGE}x${SCAN_EDGE} cells`,
  );
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

/** Points `camera` at `object`'s bounding sphere, close enough to fill the frame with `CAMERA_FRAMING_PADDING` of headroom. */
function frameCameraOn(camera: PerspectiveCamera, object: { root: Group }): void {
  const box = new Box3().setFromObject(object.root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  const direction = new Vector3(0.6, 0.45, 0.85).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

function main(): void {
  const query = readQuery();
  const durandsRequested = query.get('durands') === '1';
  const flashOn = query.get('flash') !== 'off';
  const requestedTier = Number(query.get('tier') ?? '0');
  const tier = durandsRequested
    ? MAX_STRUCTURE_TIER
    : Math.min(Math.max(requestedTier, 0), STRUCTURE_TIER_COUNT - 1);

  const { scene, camera, renderer } = buildScene();

  const models = createStructureModels();
  scene.add(models.root);

  // Below the top tier, isDurandsCell is false for every cell by contract
  // (see ./durands.ts), so (0, 0) is fine there; AT the top tier, (0, 0)
  // itself happens to roll Durand's, which is why the plain-model case also
  // has to search rather than hardcode a cell — see findTopTierCell's own
  // comment.
  const cell = tier === MAX_STRUCTURE_TIER ? findTopTierCell(durandsRequested) : { x: 0, y: 0 };
  const placement: StructurePlacement = {
    x: cell.x,
    z: cell.y,
    groundY: 0,
    tier,
    scale: 1,
    yaw: 0,
  };
  models.apply([placement]);

  if (durandsRequested) {
    // A single animate() call sets the flash clock to exactly `dt` seconds
    // since attach (models.ts's elapsed accumulator starts at 0) — a quarter
    // period lands the sine wave at its peak (sign at its brightest), three
    // quarters lands it at its trough (sign at its dimmest). See
    // models.ts's animate() for the same formula this mirrors.
    const quarterPeriod = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 4;
    models.animate(flashOn ? quarterPeriod : quarterPeriod * 3);
  }

  frameCameraOn(camera, models);

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      // Signals the screenshot driver: the building is drawn, the frame is
      // presented, it is safe to capture the canvas now.
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);
}

main();
