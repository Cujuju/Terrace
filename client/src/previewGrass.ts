// previewGrass.ts — THROWAWAY harness for the meadow (owner, 2026-08-24:
// "I don't see the grass spawning"). Mirrors previewCrops.ts's pattern; see
// that file's header for the fuller rationale. Not part of the shipped app:
// reached only through preview-grass.html, unlinked from index.html, not
// registered in plugins/registry.ts.
//
// WHY THIS EXISTS RATHER THAN A CLOSE-UP OF ONE TUFT. The question is not
// "does a blade look right", it is "is a tuft VISIBLE AT PLAY DISTANCE" —
// which a tight studio crop cannot answer at any zoom, because it answers the
// opposite question. So this draws a PATCH of ground at the real cell size,
// with tufts on exactly the cells grassCoversCell picks, at the real density,
// through the REAL createGrassModels/grassPlacementsFor path, plus one wheat
// plot through the real crop path as a known-visible reference — and frames
// it the way the game's camera would.
//
//   ?frame=<world units of view height>   default 10, the game's closest zoom
//                                         (config.ts's CAMERA_CLOSEST_VIEW_WORLD_UNITS)
//   ?cells=<patch edge in cells>          default 40 (10 world units)
//
// A screenshot driver waits for `window.__previewReady === true`.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { grassCoversCell, type CropCell, type GrassCell } from '../../plugins/flora/protocol.ts';
import { createGrassModels } from '../../plugins/flora/client/grassModels.ts';
import { grassPlacementsFor } from '../../plugins/flora/client/grassPlacement.ts';
import { createCropModels } from '../../plugins/flora/client/cropModels.ts';
import { cropPlacementsFor } from '../../plugins/flora/client/cropPlacement.ts';

// ── Lighting rig, copied from previewCrops.ts / render/scene.ts ───────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

/**
 * The ground tone. Band 4 of the land ramp ("grass") from
 * terrain/bandColors.ts — restated rather than imported because the point of
 * this harness is whether a TUFT separates from the ground it stands on, and
 * that answer is worthless against a neutral studio grey.
 */
const GROUND_COLOR = 0x6f9e4c;

/** Frames rendered before the screenshot flag is raised — previewCrops.ts's rationale. */
const SETTLE_FRAME_COUNT = 3;

/** Default view height in world units — the game's closest zoom. */
const DEFAULT_FRAME_WORLD_UNITS = 10;
/** Default patch edge in cells. 40 cells = 10 world units, i.e. one frame's worth. */
const DEFAULT_PATCH_CELLS = 40;

/**
 * Camera elevation, as a unit direction from the patch centre. A 35° pitch —
 * roughly where the game's orbit camera sits in ordinary play, and the angle
 * at which a thin upright thing is hardest to see (straight down hides its
 * height, straight on hides the ground it stands on).
 */
const CAMERA_DIRECTION = new Vector3(0, 0.57, 0.82);

function readNumber(name: string, fallback: number): number {
  const raw = Number.parseFloat(new URLSearchParams(window.location.search).get(name) ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function main(): void {
  const frameWorldUnits = readNumber('frame', DEFAULT_FRAME_WORLD_UNITS);
  const patchCells = Math.round(readNumber('cells', DEFAULT_PATCH_CELLS));
  document.title = `Grass preview — ${patchCells} cells, ${frameWorldUnits} world units framed`;

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);

  const patchWorld = patchCells * CELL_WORLD_SIZE;
  const ground = new Mesh(
    new PlaneGeometry(patchWorld * 2, patchWorld * 2),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  // THE REAL PATH, not a re-implementation of it: whatever the game would
  // draw for these cells is what appears here, including the cap, the
  // per-blade rolls and the instancing.
  const grassCells: GrassCell[] = [];
  for (let y = 0; y < patchCells; y++) {
    for (let x = 0; x < patchCells; x++) {
      if (grassCoversCell(x, y)) grassCells.push({ x, y });
    }
  }
  const grass = createGrassModels();
  grass.apply(grassPlacementsFor(grassCells, () => 0).placements);
  scene.add(grass.root);

  // One wheat plot near the middle as a KNOWN-VISIBLE reference: the owner can
  // already see crops in the game, so anything markedly smaller than this in
  // the picture is something they will not see.
  const referenceCell: CropCell = {
    x: Math.floor(patchCells / 2),
    y: Math.floor(patchCells / 2),
  };
  const crops = createCropModels();
  crops.apply(cropPlacementsFor([referenceCell], () => 0).placements);
  scene.add(crops.root);

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    window.innerWidth / window.innerHeight,
    0.005,
    200,
  );
  // Distance that frames exactly `frameWorldUnits` of world height —
  // config.ts's CAMERA_MIN_DISTANCE derivation, restated for an arbitrary
  // framing rather than the closest one.
  const distance = frameWorldUnits / (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
  const centre = new Vector3(
    referenceCell.x * CELL_WORLD_SIZE,
    0,
    referenceCell.y * CELL_WORLD_SIZE,
  );
  camera.position.copy(centre).addScaledVector(CAMERA_DIRECTION.clone().normalize(), distance);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = SRGBColorSpace;

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

  window.addEventListener('pagehide', () => {
    grass.dispose();
    crops.dispose();
  });
}

main();
