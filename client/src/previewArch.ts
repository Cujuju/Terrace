// previewArch.ts — THROWAWAY preview harness for the layered-column fixture,
// mirroring previewRivers.ts. Not part of the shipped app: reached only through
// preview-arch.html.
//
//   ?view=<iso|mouth|inside|cave|top>  — camera angle; defaults to "iso"
//   ?zoom=<number>                     — distance multiplier; defaults to 1
//
// WHAT THIS EXISTS TO SHOW, and why the live client could not. Step 3 of the
// layered-column work (#129) asks one question: does the terraced look — the
// band palette, the skirts, the lighting — survive a CEILING? Answering it
// means looking at an underside, and the live client cannot deliver that shot
// in this environment: SwiftShader renders the full game at roughly five
// minutes a frame on a 2048² world, while a fixture this size takes about ten
// seconds. The daynight plugin also rewrites the lighting ten times a second,
// which no screenshot driver can outvote.
//
// It drives the REAL modules, not a copy: `createTerrainMeshes` over a real
// `TerrainMirror`, carved by the REAL `carveArchFixture` the client itself
// calls at join. What it stubs is only what a preview has no business having —
// a server, a network, and a day/night cycle.
//
// A screenshot driver waits for `window.__previewReady === true`.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  SEA_LEVEL,
  cellIndex,
  chunkIndex,
  chunksPerEdge,
  spanAt,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { createTerrainMirror, type TerrainMirror } from './terrain/mirror.ts';
import { createTerrainMeshes } from './render/terrainMeshes.ts';
import { archFixtureAim, carveArchFixture } from './terrain/archFixture.ts';

// ── Lighting rig, copied from previewRivers.ts / render/scene.ts ─────────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const BACKDROP_COLOR = 0x9fc7e8;
const SETTLE_FRAME_COUNT = 6;

/**
 * The fixture world's edge, in cells. Six chunks — 96 cells — is the smallest
 * multiple of CHUNK_SIZE that holds the mound (61 × 29 cells) with ground
 * visible on every side of it, so the mound reads as standing ON terrain
 * rather than as filling the frame.
 */
const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 6;

/**
 * The ground the mound stands on, in height units — two and a half bands above
 * sea level, deliberately MID-BAND so the roll below never crosses a boundary.
 *
 * Above SEA_LEVEL so the water renderer draws nothing over the fixture, and
 * clear of the bedrock floor so the tunnel's lower span is a real span rather
 * than the empty one `setColumn` rejects.
 */
const GROUND_HEIGHT = SEA_LEVEL + BAND_HEIGHT * 2 + BAND_HEIGHT / 2;

/**
 * How far the ground rolls either side of that, in height units.
 *
 * A THIRD of a band, around a ground height sitting MID-BAND, so the swell
 * never crosses a band boundary. It crossed one in the first pass, and every
 * crossing is a contour: the plain around the mound came out tiled with
 * lozenges that had nothing to do with the fixture and read as terrain detail
 * in the shot. Kept non-zero so the tunnel floor is not a machined plane.
 */
const GROUND_ROLL = BAND_HEIGHT / 3;

/** Wavelength of the ground roll, in cells — a slow swell, not a ripple. */
const GROUND_ROLL_CELLS = 23;

type CameraView = 'iso' | 'mouth' | 'inside' | 'cave' | 'top';

/**
 * Camera directions, as offsets FROM the point being looked at. The three that
 * matter are the low ones: an underside is invisible from above, which is
 * exactly why the default client camera would never have shown this.
 */
const CAMERA_VIEWS: Record<CameraView, Vector3> = {
  iso: new Vector3(0.7, 0.6, 0.7),
  // Low and square-on to the -Z mouth: the shot that frames the opening.
  mouth: new Vector3(0, 0.16, -1),
  // Lower and closer, angled — the roof's underside fills the upper frame.
  inside: new Vector3(0.25, 0.07, -1),
  cave: new Vector3(0.1, 0.14, -1),
  top: new Vector3(0, 1, 0.0001),
};

/** How far back the camera sits, as a fraction of the world's span. */
const CAMERA_DISTANCE_FRACTION = 0.85;

/** Closer framings for the views whose subject is one bore, not the mound. */
const BORE_VIEW_DISTANCE_FRACTION = 0.3;

const query = new URLSearchParams(window.location.search);

function readView(): CameraView {
  const raw = query.get('view');
  return raw !== null && raw in CAMERA_VIEWS ? (raw as CameraView) : 'iso';
}

function readZoom(): number {
  const raw = Number(query.get('zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * The ground under the whole fixture: a slow two-axis swell around
 * GROUND_HEIGHT. Integer heights, because that is what a heightmap holds.
 */
function buildGround(mirror: TerrainMirror): void {
  const map = mirror.map;
  for (let z = 0; z < PREVIEW_WORLD_SIZE; z++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const swell =
        Math.sin((x / GROUND_ROLL_CELLS) * Math.PI * 2) *
        Math.cos((z / GROUND_ROLL_CELLS) * Math.PI * 2);
      map.cells[cellIndex(map, x, z)] = Math.round(GROUND_HEIGHT + swell * GROUND_ROLL);
    }
  }
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;

const scene = new Scene();
scene.background = new Color(BACKDROP_COLOR);
scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(1000);
scene.add(sun);

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

// Every chunk marked received BEFORE the carve: the fixture skips any cell
// whose chunk has not arrived (in the live client that is the reveal gate),
// and this harness has no reveal gate at all.
const mirror = createTerrainMirror(PREVIEW_WORLD_SIZE);
buildGround(mirror);
const chunkCols = chunksPerEdge(PREVIEW_WORLD_SIZE);
const allChunks: number[] = [];
for (let cz = 0; cz < chunkCols; cz++) {
  for (let cx = 0; cx < chunkCols; cx++) {
    const index = chunkIndex(PREVIEW_WORLD_SIZE, cx, cz);
    mirror.received.add(index);
    allChunks.push(index);
  }
}

const carvedChunks = carveArchFixture(mirror);

const terrainGroup = new Group();
scene.add(terrainGroup);
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(allChunks);
meshes.flush();

const aim = archFixtureAim(PREVIEW_WORLD_SIZE);
const view = readView();
const zoom = readZoom();

/** The cell each view is pointed at, and how close it sits. */
const VIEW_TARGETS: Record<CameraView, { cell: { x: number; z: number }; near: boolean }> = {
  iso: { cell: aim.crest, near: false },
  mouth: { cell: aim.archBore, near: true },
  inside: { cell: aim.archBore, near: true },
  cave: { cell: aim.caveMouth, near: true },
  top: { cell: aim.crest, near: false },
};

const target = VIEW_TARGETS[view];

/**
 * The height to aim at: the TUNNEL FLOOR where the target cell was carved, so
 * the opening sits in the middle of the frame rather than the roof filling it.
 * `spanAt(..., 0)` is the lowest span, whose ceiling is that floor; on a cell
 * that was left solid it is the only span, and its ceiling is the surface.
 */
const targetY = spanAt(mirror.map, target.cell.x, target.cell.z, 0).ceiling;

const lookAt = new Vector3(
  (target.cell.x + 0.5) * CELL_WORLD_SIZE,
  targetY * HEIGHT_WORLD_SCALE,
  (target.cell.z + 0.5) * CELL_WORLD_SIZE,
);

const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;
const distance =
  span * (target.near ? BORE_VIEW_DISTANCE_FRACTION : CAMERA_DISTANCE_FRACTION) * zoom;

const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.1,
  4000,
);
camera.position.copy(lookAt).addScaledVector(CAMERA_VIEWS[view], distance);
camera.lookAt(lookAt);

let frames = 0;
function animate(): void {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  frames++;
  if (frames === SETTLE_FRAME_COUNT) {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
    // Probes for MEASURING rather than eyeballing: whether the carve ran at
    // all, and what a column actually holds. "The arch is invisible" and "the
    // arch was never carved" look identical in a screenshot.
    (window as unknown as { __previewCarvedChunks?: unknown }).__previewCarvedChunks =
      carvedChunks.size;
    (window as unknown as { __previewLayeredColumns?: unknown }).__previewLayeredColumns =
      mirror.map.columnSpans.size;
    (window as unknown as { __previewSpansAt?: unknown }).__previewSpansAt = (
      x: number,
      z: number,
    ): { floor: number; ceiling: number }[] => {
      const packed = mirror.map.columnSpans.get(cellIndex(mirror.map, x, z));
      if (packed === undefined) return [spanAt(mirror.map, x, z, 0)];
      const out: { floor: number; ceiling: number }[] = [];
      for (let k = 0; k < packed.length / 2; k++) {
        out.push({ floor: packed[k * 2]!, ceiling: packed[k * 2 + 1]! });
      }
      return out;
    };
  }
}
animate();
