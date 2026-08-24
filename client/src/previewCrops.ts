// previewCrops.ts — THROWAWAY preview harness for the three candidate wheat
// variants in wheatVariants.ts (run brief 2026-08-23: the owner chooses
// between designs from SCREENSHOTS, so each option must be photographable in
// isolation before any of them is wired into cropModels.ts). Mirrors
// previewStructures.ts's pattern — see that file's header for the fuller
// rationale; this restates only what differs. Not part of the shipped app:
// reached only through preview-crops.html, unlinked from index.html, not
// registered in plugins/registry.ts.
//
//   ?option=<0..2>   which WHEAT_VARIANT_BUILDERS entry to draw (default 0)
//
// WHAT ONE PAGE LOAD DRAWS: one full crop plot exactly as the game would
// stand it — the tilled bed at CROP_PLOT_BED_CELL_COVERAGE of a cell, with
// FOUR stalks of the chosen variant at cropModels.ts's own cluster offsets,
// under the same bed/stem/ear colours that file uses. The camera frames the
// plot TIGHTLY (padding below the structures harness's) because the whole
// point of this exercise is legibility of individual grains; a plot fills a
// fraction of one cell, so "close" here is far closer than any building
// preview needs.
//
// The lighting rig (hemisphere + directional + ambient, ACES tone mapping) is
// copied from render/scene.ts via previewStructures.ts, so a screenshot here
// means what it would mean in the real scene.
//
// A screenshot driver navigates here once per option and waits for
// `window.__previewReady === true` before capturing the canvas — set only
// after the frame the model was actually drawn into has been presented.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { CROP_PLOT_BED_CELL_COVERAGE } from '../../plugins/flora/protocol.ts';
import {
  WHEAT_VARIANT_BUILDERS,
  WHEAT_VARIANT_NAMES,
} from '../../plugins/flora/client/wheatVariants.ts';

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
/** Neutral mid-grey backdrop — no sky, no terrain, just the plot. */
const BACKDROP_COLOR = 0x808080;
/** A slightly darker neutral disc under the bed, purely as a ground reference. */
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 2;
/**
 * Framing padding BELOW the structures harness's 1.25: a crop plot is a
 * fraction of one world cell, and the deliverable is pictures in which
 * individual KERNELS are legible — a comfortably-framed plot would render
 * them as specks. 1.05 still keeps the bounding box off the frame edge.
 */
const CAMERA_FRAMING_PADDING = 1.05;
/** Frames rendered before the screenshot flag is raised — same rationale as previewStructures.ts. */
const SETTLE_FRAME_COUNT = 3;

/**
 * Camera direction, unit vector from the plot centre — a lowish 3/4 angle so
 * grains on the near side of a head are seen face-on (the shingle overlap the
 * botanical variant is built from reads on faces, not edges), while the bed's
 * square footprint still shows.
 */
const CAMERA_DIRECTION = new Vector3(0.55, 0.35, 0.9);

// ── Plot constants, copied from cropModels.ts ─────────────────────────────
// The bed and the stalk cluster must be EXACTLY what the game draws, or the
// screenshots lie about what the owner is choosing between.

/** One crop CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

const BED_WIDTH_IN_CELLS = CROP_PLOT_BED_CELL_COVERAGE;
const BED_HEIGHT_IN_CELLS = 0.05;

/** Same 2×2 spread cropModels.ts plants — see STALK_OFFSET_IN_BED_EDGES there. */
const STALK_OFFSET_IN_BED_EDGES = 0.22;
const CROP_STALK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-STALK_OFFSET_IN_BED_EDGES, -STALK_OFFSET_IN_BED_EDGES],
  [STALK_OFFSET_IN_BED_EDGES, -STALK_OFFSET_IN_BED_EDGES],
  [-STALK_OFFSET_IN_BED_EDGES, STALK_OFFSET_IN_BED_EDGES],
  [STALK_OFFSET_IN_BED_EDGES, STALK_OFFSET_IN_BED_EDGES],
];

/** Colours copied verbatim from cropModels.ts — the palette the game uses. */
const BED_COLOR = 0x5b4630;
const STALK_COLOR = 0xd2b04a;
const EAR_COLOR = 0xe6c96a;

function readOption(): number {
  const requested = Number.parseInt(
    new URLSearchParams(window.location.search).get('option') ?? '',
    10,
  );
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), WHEAT_VARIANT_BUILDERS.length - 1)
    : 0;
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

  // Near plane well inside a plot's span (the whole model is a fraction of
  // one 0.25-unit cell) so tight framing cannot clip it.
  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.005, 100);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = SRGBColorSpace;

  return { scene, camera, renderer };
}

/** Points `camera` at `root`'s bounding sphere, nearly filling the frame. */
function frameCameraOn(camera: PerspectiveCamera, root: Group): void {
  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION.clone().normalize(), distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

function main(): void {
  const option = readOption();
  const name = WHEAT_VARIANT_NAMES[option];
  document.title = `Crop preview — ${name}`;

  const { scene, camera, renderer } = buildScene();

  // One plot, built exactly as createCropModels builds one: bed mesh plus
  // four stalk instances (stalk + ear geometry pair per stalk). Plain Meshes,
  // not InstancedMesh — there is exactly one of everything; instancing buys
  // nothing for n=1 and the harness is throwaway.
  const plot = new Group();
  plot.name = `preview:wheat-${option}`;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  const bedGeometry = new BoxGeometry(
    cells(BED_WIDTH_IN_CELLS), cells(BED_HEIGHT_IN_CELLS), cells(BED_WIDTH_IN_CELLS),
  );
  bedGeometry.translate(0, cells(BED_HEIGHT_IN_CELLS) / 2, 0);
  const bedMaterial = new MeshLambertMaterial({ color: BED_COLOR, flatShading: true });
  geometries.push(bedGeometry);
  materials.push(bedMaterial);
  plot.add(new Mesh(bedGeometry, bedMaterial));

  const { stalk: stalkGeometry, ear: earGeometry } = WHEAT_VARIANT_BUILDERS[option]();
  const stalkMaterial = new MeshLambertMaterial({ color: STALK_COLOR, flatShading: true });
  const earMaterial = new MeshLambertMaterial({ color: EAR_COLOR, flatShading: true });
  geometries.push(stalkGeometry, earGeometry);
  materials.push(stalkMaterial, earMaterial);

  const spread = cells(BED_WIDTH_IN_CELLS);
  for (const [ox, oz] of CROP_STALK_OFFSETS) {
    const stalk = new Mesh(stalkGeometry, stalkMaterial);
    stalk.position.set(ox * spread, 0, oz * spread);
    plot.add(stalk);
    const ear = new Mesh(earGeometry, earMaterial);
    ear.position.copy(stalk.position);
    plot.add(ear);
  }

  scene.add(plot);
  frameCameraOn(camera, plot);

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      // Signals the screenshot driver: the plot is drawn, the frame is
      // presented, it is safe to capture the canvas now.
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);

  // Throwaway harness: release on page unload is irrelevant, but keep the
  // dispose discipline visible and honest anyway.
  window.addEventListener('pagehide', () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  });
}

main();
