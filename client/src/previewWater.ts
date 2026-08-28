// previewWater.ts — THROWAWAY preview harness for the SEA's depth curves,
// mirroring previewRivers.ts. Not part of the shipped app: reached only
// through preview-water.html.
//
//   ?scene=<staircase|ocean>  — fixture; defaults to "staircase"
//   ?view=<iso|side|top>      — camera angle; defaults to "iso"
//   ?zoom=<number>            — camera distance multiplier; defaults to 1
//   ?light=<noon|night>       — lighting rig; defaults to "noon" (the static
//                               rig this harness has always had)
//   ?contour=<albedo|emissive> — how the sea's band contour is drawn; defaults
//                               to "albedo", the shipped behaviour
//
// WHAT THIS EXISTS TO SHOW, and why the live client could not. The thing under
// test is a CURVE — how much terrain shows through the sea as a function of the
// water column's depth (terrain/waterDepth.ts's depthToWaterAlpha, and the
// shade and specular curves beside it). Reading a curve off the live world
// means hunting for a cell at each depth, in terrain whose shape is whatever
// the players sculpted, under lighting the daynight plugin rewrites ten times a
// second. Here every depth from the waterline down is on screen at once, in a
// known order, held still.
//
// It drives the REAL modules, not a copy: `createTerrainMeshes` for the seabed
// and `createWater` for the sea, over a real `TerrainMirror`. What it stubs is
// only what a preview has no business having — a server, a network, and a
// day/night cycle.
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
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, cellIndex, chunkIndex, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { createTerrainMirror, type TerrainMirror } from './terrain/mirror.ts';
import { createTerrainMeshes } from './render/terrainMeshes.ts';
import { createWater, type WaterBandContourMode } from './render/water.ts';
// The REAL night rig, not a copy of its numbers: ?light=night drives this
// fixture's three lights from the same function the daynight plugin drives the
// live client's with, so a night capture here is lit exactly as the game is.
import { skyStateAtPhase } from '../../plugins/daynight/client/sky.ts';
import { installWaterBandClock } from './render/water/waterBands.ts';
import { depthToWaterAlpha, waterDepthWorldUnits } from './terrain/waterDepth.ts';

// ── Lighting rig, copied from previewRivers.ts / render/scene.ts ─────────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
/**
 * How far out the directional light is placed. A DirectionalLight's position
 * sets only its DIRECTION (it has no falloff and this fixture casts no
 * shadows), so the magnitude is arbitrary; it is named here because ?light=
 * now has to re-place the same light and the two must not disagree.
 */
const SUN_DISTANCE_WORLD_UNITS = 1000;
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const BACKDROP_COLOR = 0x9fc7e8;
const SETTLE_FRAME_COUNT = 6;

/**
 * The phase the day/night cycle calls midnight. Not a guess: sky.ts models the
 * whole day as one sine, `sunHeight(phase) = sin(phase * 2pi)`, which is -1 —
 * the sun at its lowest, the NIGHT keyframe reached in full — at exactly 0.75.
 */
const MIDNIGHT_PHASE = 0.75;

/**
 * The fixture world's edge, in cells. Eight chunks, not the four previewRivers
 * uses: the staircase below needs one readable tread per depth band across the
 * whole span the alpha curve is being judged over, and four chunks (64 cells)
 * would give each tread barely two cells.
 */
const PREVIEW_WORLD_SIZE = CHUNK_SIZE * 8;

/**
 * The deepest tread of the staircase, in bands. Past the measured p99 (21
 * bands on the live world) with headroom, so the fixture shows both the
 * populated part of the curve AND the start of the flat beyond it — where the
 * curve stops changing is exactly the thing being judged.
 */
const STAIRCASE_MAX_DEPTH_BANDS = 26;

/** Bands of dry land at the shallow end, so the shot contains a shoreline. */
const STAIRCASE_DRY_BANDS = 2;

/**
 * The ordinary-ocean fixture's depths, in bands — the MEASURED live-world
 * distribution (frostwick-hollows, 2026-08-25: p25 11, p50 12, p75 12, p95 14),
 * not a guess. This is the shot that answers "what does 94% of the map look
 * like", which a staircase spanning 26 bands deliberately does not.
 */
const OCEAN_MEDIAN_DEPTH_BANDS = 12;
const OCEAN_RELIEF_BANDS = 2;

/** Cells per tread. The span divided by the number of treads the scene needs. */
const STAIRCASE_TREAD_CELLS = Math.floor(
  PREVIEW_WORLD_SIZE / (STAIRCASE_MAX_DEPTH_BANDS + STAIRCASE_DRY_BANDS + 1),
);

function setCell(mirror: TerrainMirror, x: number, y: number, height: number): void {
  mirror.map.cells[cellIndex(mirror.map, x, y)] = height;
}

/**
 * A staircase descending east, exactly one band per tread, from dry land down
 * past the deepest depth any real cell reaches. Every depth the alpha curve is
 * defined over appears once, in order, at a known X — so "the curve goes flat
 * here" is read off the picture rather than inferred.
 */
function buildStaircase(mirror: TerrainMirror): void {
  for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
    const tread = Math.floor(x / STAIRCASE_TREAD_CELLS);
    const bandsBelowSea = tread - STAIRCASE_DRY_BANDS;
    const height = SEA_LEVEL - bandsBelowSea * BAND_HEIGHT;
    for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) setCell(mirror, x, y, height);
  }
}

/**
 * Ordinary open ocean: a broad flat at the measured median depth with gentle
 * relief either side of it, and a dry island for a shoreline to read against.
 * The relief is a smooth bowl rather than noise so the depth gradient is
 * legible as a gradient.
 */
function buildOcean(mirror: TerrainMirror): void {
  const centre = PREVIEW_WORLD_SIZE / 2;
  for (let y = 0; y < PREVIEW_WORLD_SIZE; y++) {
    for (let x = 0; x < PREVIEW_WORLD_SIZE; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.sqrt(dx * dx + dy * dy);
      // A cosine bowl: deepest at the rim, shoaling to the island at centre.
      const depthBands = OCEAN_MEDIAN_DEPTH_BANDS + OCEAN_RELIEF_BANDS * Math.cos(Math.PI * r);
      // The island: the innermost fifth of the radius rises out of the water,
      // so the frame has a shoreline and dry land to judge the sea against.
      const height =
        r < 0.2
          ? SEA_LEVEL + Math.round((0.2 - r) * 20) * BAND_HEIGHT
          : SEA_LEVEL - Math.round(depthBands) * BAND_HEIGHT;
      setCell(mirror, x, y, height);
    }
  }
}

const SCENE_BUILDERS: Record<string, (mirror: TerrainMirror) => void> = {
  staircase: buildStaircase,
  ocean: buildOcean,
};

const CAMERA_VIEWS: Record<string, Vector3> = {
  iso: new Vector3(0.8, 0.75, 0.8),
  side: new Vector3(0, 0.18, 1),
  top: new Vector3(0, 1, 0.001),
};

const params = new URLSearchParams(window.location.search);
const sceneName = params.get('scene') ?? 'staircase';
const view = params.get('view') ?? 'iso';
const zoomRaw = Number(params.get('zoom'));
const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
const builder = SCENE_BUILDERS[sceneName] ?? buildStaircase;
const isNight = params.get('light') === 'night';
const bandContourMode: WaterBandContourMode =
  params.get('contour') === 'emissive' ? 'emissive' : 'albedo';

const scene = new Scene();
scene.background = new Color(BACKDROP_COLOR);
const hemisphere = new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY);
scene.add(hemisphere);
const ambient = new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY);
scene.add(ambient);
const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
sun.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
scene.add(sun);

// ?light=night — overwrite the static noon rig above with the day/night
// plugin's own midnight state. Written out here rather than through
// render/skyRig.ts's applySkyRig because that takes a Viewport, which this
// fixture (no scene.ts, no renderer rig) does not have; the STATE still comes
// from the plugin, so none of its numbers are duplicated.
if (isNight) {
  const night = skyStateAtPhase(MIDNIGHT_PHASE);
  sun.position
    .set(night.sunDirection.x, night.sunDirection.y, night.sunDirection.z)
    .normalize()
    .multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  sun.color.setHex(night.sunColor);
  sun.intensity = night.sunIntensity;
  hemisphere.color.setHex(night.hemisphereSkyColor);
  hemisphere.groundColor.setHex(night.hemisphereGroundColor);
  hemisphere.intensity = night.hemisphereIntensity;
  ambient.color.setHex(night.ambientColor);
  ambient.intensity = night.ambientIntensity;
  (scene.background as Color).setHex(night.backgroundColor);
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

// Every chunk marked received: this fixture has no reveal gate, and both the
// terrain meshes and the sea draw only over received chunks.
const mirror = createTerrainMirror(PREVIEW_WORLD_SIZE);
builder(mirror);
const chunkCols = chunksPerEdge(PREVIEW_WORLD_SIZE);
const allChunks: number[] = [];
for (let cy = 0; cy < chunkCols; cy++) {
  for (let cx = 0; cx < chunkCols; cx++) {
    const index = chunkIndex(PREVIEW_WORLD_SIZE, cx, cy);
    mirror.received.add(index);
    allChunks.push(index);
  }
}

const terrainGroup = new Group();
scene.add(terrainGroup);
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(allChunks);
meshes.flush();

const frameHandlers: ((dt: number) => void)[] = [];
const waterGroup = new Group();
scene.add(waterGroup);
const water = createWater(waterGroup, PREVIEW_WORLD_SIZE, { bandContourMode });
water.setWorldSize(PREVIEW_WORLD_SIZE);
water.sync(mirror);
water.refresh(mirror, allChunks);
// The painted bands drift on a shared clock the live client installs from the
// river rig; this harness builds only the sea, so it installs the clock itself
// (installWaterBandClock is idempotent by design for exactly this case).
installWaterBandClock((handler) => {
  frameHandlers.push(handler);
  return () => {};
});

const centre = new Vector3(
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
  SEA_LEVEL * HEIGHT_WORLD_SCALE,
  (PREVIEW_WORLD_SIZE / 2) * CELL_WORLD_SIZE,
);
const span = PREVIEW_WORLD_SIZE * CELL_WORLD_SIZE;
const camera = new PerspectiveCamera(
  CAMERA_FOV_DEGREES,
  window.innerWidth / window.innerHeight,
  0.1,
  8000,
);
camera.position.copy(centre).addScaledVector(CAMERA_VIEWS[view] ?? CAMERA_VIEWS.iso, span * 0.85 * zoom);
camera.lookAt(centre);

let frames = 0;
function animate(): void {
  requestAnimationFrame(animate);
  for (const handler of frameHandlers) handler(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === SETTLE_FRAME_COUNT) {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
    // Debug probe for MEASURING rather than eyeballing: the alpha the curve
    // actually yields at a given depth in bands, read from the shipped
    // function — so a screenshot and the numbers behind it cannot disagree.
    (window as unknown as { __previewAlphaAtBands?: unknown }).__previewAlphaAtBands = (
      bands: number,
    ): number => depthToWaterAlpha(waterDepthWorldUnits(SEA_LEVEL - bands * BAND_HEIGHT));
    // Hiding the sea is how "the seabed is dark" is told apart from "the water
    // is hiding it" — the A/B that isolated the milky-water bug in 2026-08-20.
    (window as unknown as { __previewWater?: unknown }).__previewWater = waterGroup;
  }
}
animate();
