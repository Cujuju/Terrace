// previewStorm.ts — THROWAWAY preview harness for the storms plugin, mirroring
// previewVolcano.ts / previewFire.ts. Not part of the shipped app: reached only
// through preview-storm.html, not registered in plugins/registry.ts.
//
//   ?scene=<tornado|hurricane|clear>   — defaults to "tornado"
//   ?view=<iso|low|high|under>         — defaults per scene
//   ?t=<seconds>                       — animation clock; default 6
//
// ─────────────────────────────────────────────────────────────────────────────
// IT RUNS THE REAL CODE, not a drawing of it. The funnel and the spiral deck
// are the SHIPPED renderers (plugins/storms/client/funnel.ts and spiral.ts),
// fed the wire shape the server would have sent; the darkening is the shipped
// applyGloom, run over a base sky and written onto this harness's own lights,
// which is exactly what ClientPluginCtx.modulateSkyRig does to the day/night
// plugin's sky in the real client.
//
// What it does NOT show is the terrain renderer: the real client draws band
// caps over a SMOOTHED MARCHED CONTOUR (terrain/drawnGround.ts) and this draws
// blocky quads at a coarser step, which is the same silhouette one step cruder.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
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
import { BAND_HEIGHT, CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';
import type { SkyRigState } from './plugins/types.ts';
import {
  CYCLONE_DECK_HEIGHT_WORLD_UNITS,
  TORNADO_HEIGHT_WORLD_UNITS,
  WORLD_UNITS_PER_BAND,
  cycloneRadiusFor,
} from '../../plugins/storms/protocol.ts';
import { createFunnel } from '../../plugins/storms/client/funnel.ts';
import { createSpiral } from '../../plugins/storms/client/spiral.ts';
import {
  MAX_GLOOM_LIGHT_LOSS,
  applyGloom,
  overheadFraction,
} from '../../plugins/storms/client/gloom.ts';

// ── The base sky, copied from render/scene.ts's boot rig ────────────────────
// It is a SkyRigState rather than three loose numbers so that applyGloom — the
// shipped function — can be run over exactly the shape the real client hands it.
const BASE_SKY: SkyRigState = {
  sunDirection: { x: 0.7, y: 0.45, z: 0.55 },
  sunColor: 0xffffff,
  sunIntensity: 1.2,
  hemisphereSkyColor: 0x9fc7e8,
  hemisphereGroundColor: 0x9a948a,
  hemisphereIntensity: 1.5,
  ambientColor: 0xffffff,
  ambientIntensity: 0.9,
  backgroundColor: 0x9fc7e8,
};

const SUN_DISTANCE_WORLD_UNITS = 60;
/**
 * HARNESS EXPOSURE, and it is deliberately lower than the client's 1.25.
 *
 * The fixture ground is a flat-normalled Lambert surface under all three of
 * core's lights at full strength, which sums to about 3.6 and clips every band
 * to white — the terrain stops reading as terrain and the storm has nothing to
 * be seen against. The real client's ground is contoured and shaded, so it does
 * not have this problem; this is a framing knob for the harness, not a claim
 * about the shipped rig.
 */
const TONE_MAPPING_EXPOSURE = 0.7;
const CAMERA_FOV_DEGREES = 55;
const SETTLE_FRAME_COUNT = 4;

// ── The fixture world: an island with a south coast ─────────────────────────
/** Cells per edge of the patch of world this harness builds. 64 world units. */
const GRID_CELLS = cellsAcross(64);

/**
 * Cells per mesh quad. TWO — the fixture is four times the volcano harness's
 * area, and stepping the ground mesh halves its edge count in each axis. It is
 * a preview: the silhouette survives, and a 65 000-cell per-cell mesh does not
 * render in this environment's software GL in a usable time.
 */
const MESH_STEP_CELLS = 2;

/** The coastline runs across the middle, waving so it is not a ruled line. */
const COAST_ROW = GRID_CELLS * 0.55;
const COAST_WAVE_CELLS = cellsAcross(4);
const COAST_WAVE_PERIOD_CELLS = cellsAcross(18);

/** How high the land gets, in terrace bands, and how big its rolls are. */
const LAND_RELIEF_BANDS = 7;
const ROLL_PERIOD_CELLS = cellsAcross(11);

/** Where the coast is at column cx, in cell rows. */
function coastRowAt(cx: number): number {
  return COAST_ROW + Math.sin((cx / COAST_WAVE_PERIOD_CELLS) * Math.PI * 2) * COAST_WAVE_CELLS;
}

/** Cell → height units. The whole fixture terrain, as one pure function. */
function heightAtCell(cx: number, cy: number): number {
  const coast = coastRowAt(cx);
  // Distance inland, in cells: positive on land, negative at sea.
  const inland = coast - cy;
  const rolls =
    Math.sin((cx / ROLL_PERIOD_CELLS) * Math.PI * 2) *
    Math.cos((cy / (ROLL_PERIOD_CELLS * 1.3)) * Math.PI * 2);

  if (inland <= 0) {
    // The seabed, falling away from the shore so the water has depth.
    return Math.max(-4, inland / cellsAcross(6)) * BAND_HEIGHT;
  }
  // The land: a ramp up from the beach, plus rolling hills on top of it.
  const ramp = Math.min(1, inland / cellsAcross(14));
  return (ramp * LAND_RELIEF_BANDS + rolls * 1.2 * ramp) * BAND_HEIGHT;
}

function bandOfHeight(height: number): number {
  return Math.floor(height / BAND_HEIGHT);
}
function capWorldY(cx: number, cy: number): number {
  return Math.max(0, bandOfHeight(heightAtCell(cx, cy))) * WORLD_UNITS_PER_BAND;
}
function isSeaCell(cx: number, cy: number): boolean {
  return heightAtCell(cx, cy) <= 0;
}

/** The game's terrain palette, roughly — sand, grass, rock. Approximate on
 * purpose; see previewVolcano.ts's own note on why it is not imported. */
const BAND_COLORS: readonly Color[] = [
  new Color(0.52, 0.47, 0.33),
  new Color(0.42, 0.47, 0.27),
  new Color(0.33, 0.43, 0.23),
  new Color(0.28, 0.39, 0.2),
  new Color(0.27, 0.35, 0.22),
  new Color(0.3, 0.32, 0.23),
  new Color(0.31, 0.3, 0.25),
  new Color(0.33, 0.31, 0.28),
];
const SEA_COLOR = new Color(0.13, 0.3, 0.45);

function colorForBand(band: number): Color {
  return BAND_COLORS[Math.min(BAND_COLORS.length - 1, Math.max(0, band))]!;
}

/** Builds the terraced ground: one flat cap quad per MESH_STEP_CELLS square. */
function buildTerrain(): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const quad = CELL_WORLD_SIZE * MESH_STEP_CELLS;

  function pushTriangle(a: Vector3, b: Vector3, c: Vector3, color: Color): void {
    for (const v of [a, b, c]) positions.push(v.x, v.y, v.z);
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  }

  for (let cy = 0; cy < GRID_CELLS; cy += MESH_STEP_CELLS) {
    for (let cx = 0; cx < GRID_CELLS; cx += MESH_STEP_CELLS) {
      const sea = isSeaCell(cx, cy);
      // The sea is drawn as a flat sheet at the waterline, which is what the
      // real client's water does; the seabed below it is not modelled here
      // because nothing in this harness is seen through the water.
      const y = sea ? 0 : capWorldY(cx, cy);
      const color = sea ? SEA_COLOR : colorForBand(bandOfHeight(heightAtCell(cx, cy)));

      const x0 = cx * CELL_WORLD_SIZE;
      const x1 = x0 + quad;
      const z0 = cy * CELL_WORLD_SIZE;
      const z1 = z0 + quad;

      pushTriangle(new Vector3(x0, y, z0), new Vector3(x0, y, z1), new Vector3(x1, y, z1), color);
      pushTriangle(new Vector3(x0, y, z0), new Vector3(x1, y, z1), new Vector3(x1, y, z0), color);

      // Risers, on the two sides that can face a lower neighbour.
      const neighbours: ReadonlyArray<readonly [number, number, Vector3, Vector3]> = [
        [cx + MESH_STEP_CELLS, cy, new Vector3(x1, y, z0), new Vector3(x1, y, z1)],
        [cx, cy + MESH_STEP_CELLS, new Vector3(x1, y, z1), new Vector3(x0, y, z1)],
      ];
      for (const [nx, ny, edgeA, edgeB] of neighbours) {
        if (nx >= GRID_CELLS || ny >= GRID_CELLS) continue;
        const neighbourY = isSeaCell(nx, ny) ? 0 : capWorldY(nx, ny);
        if (neighbourY >= y) continue;
        const lowA = new Vector3(edgeA.x, neighbourY, edgeA.z);
        const lowB = new Vector3(edgeB.x, neighbourY, edgeB.z);
        // The tread catches the sun, the riser does not — how the real terrain
        // reads a step.
        const riser = color.clone().multiplyScalar(0.82);
        pushTriangle(edgeA, edgeB, lowB, riser);
        pushTriangle(edgeA, lowB, lowA, riser);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  return new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
}

// ── The storms this harness stages ──────────────────────────────────────────
/** The tornado touches down inland, where the hills are. */
const TORNADO_CELL = { x: GRID_CELLS * 0.5, y: GRID_CELLS * 0.26 };
/**
 * The cyclone's eye, just offshore of the coast — a landfall in progress, which
 * is the moment worth photographing: the deck covers the land, and the aim
 * point below is under it rather than out past the rim.
 */
const CYCLONE_CELL = { x: GRID_CELLS * 0.5, y: GRID_CELLS * 0.62 };

type SceneName = 'tornado' | 'hurricane' | 'clear';
type ViewName = 'iso' | 'low' | 'high' | 'under';

const CAMERA_VIEWS: Record<ViewName, { direction: Vector3; distance: number; targetY: number }> = {
  // A three-quarter view of the funnel against the hills.
  iso: { direction: new Vector3(0.5, 0.4, 0.9), distance: 14, targetY: 3 },
  // Ground level — what a player standing a field away sees.
  low: { direction: new Vector3(0.25, 0.1, 1), distance: 12, targetY: 2 },
  // Up and out, far enough to see a whole cyclone and the coast it is hitting.
  high: { direction: new Vector3(0.35, 0.62, 0.85), distance: 78, targetY: 0 },
  // Under the deck, looking up at the arms from the shore.
  under: { direction: new Vector3(0.15, 0.22, 0.95), distance: 26, targetY: 8 },
};

const DEFAULT_VIEW: Record<SceneName, ViewName> = {
  tornado: 'iso',
  hurricane: 'high',
  clear: 'high',
};

function main(): void {
  const query = new URLSearchParams(window.location.search);
  const sceneName = (query.get('scene') ?? 'tornado') as SceneName;
  const viewName = (query.get('view') ?? DEFAULT_VIEW[sceneName] ?? 'iso') as ViewName;
  const clock = Number(query.get('t') ?? '6');

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();

  const hemisphere = new HemisphereLight();
  const ambient = new AmbientLight();
  const sun = new DirectionalLight();
  scene.add(hemisphere, ambient, sun);
  scene.background = new Color();

  scene.add(buildTerrain());

  const layer = new Group();
  scene.add(layer);

  const cycloneRadiusCells = cycloneRadiusFor(GRID_CELLS);

  // ── The funnel ─────────────────────────────────────────────────────────────
  const funnel = createFunnel();
  layer.add(funnel.root);
  if (sceneName === 'tornado') {
    funnel.apply([
      {
        id: 1,
        x: TORNADO_CELL.x * CELL_WORLD_SIZE,
        groundY: capWorldY(Math.round(TORNADO_CELL.x), Math.round(TORNADO_CELL.y)),
        z: TORNADO_CELL.y * CELL_WORLD_SIZE,
        intensity: 0.9,
      },
    ]);
  }
  // One big step to full presence, then the animation clock — the renderers are
  // pure functions of (dt, elapsed, daylight), so this IS the frame at `t`. The
  // daylight factor is computed below with the sky, then handed to both.

  // ── The deck ───────────────────────────────────────────────────────────────
  const spiral = createSpiral();
  layer.add(spiral.root);
  if (sceneName === 'hurricane') {
    spiral.apply([
      {
        id: 2,
        x: CYCLONE_CELL.x * CELL_WORLD_SIZE,
        z: CYCLONE_CELL.y * CELL_WORLD_SIZE,
        radiusCells: cycloneRadiusCells,
        intensity: 0.95,
      },
    ]);
  }

  // ── The sky, through the SHIPPED gloom ─────────────────────────────────────
  // In the real client this is what ClientPluginCtx.modulateSkyRig does to the
  // day/night plugin's sky; here the base sky is core's boot rig and the depth
  // is measured at the point the camera is looking at, exactly as the plugin's
  // own frame loop measures it.
  const aim = sceneName === 'hurricane' ? { x: GRID_CELLS * 0.5, y: COAST_ROW } : null;
  const depth =
    aim === null
      ? 0
      : 0.95 *
        overheadFraction(
          Math.hypot(aim.x - CYCLONE_CELL.x, aim.y - CYCLONE_CELL.y),
          cycloneRadiusCells,
        );
  const sky = applyGloom(BASE_SKY, depth);
  // The same number the real plugin's frame loop derives, for the same reason:
  // both renderers are unlit, so the gloom has to reach them as a uniform.
  const daylight = 1 - depth * MAX_GLOOM_LIGHT_LOSS;
  funnel.update(10, clock, daylight);
  spiral.update(60, clock, daylight);

  sun.position
    .set(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z)
    .normalize()
    .multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  sun.color.setHex(sky.sunColor);
  sun.intensity = sky.sunIntensity;
  hemisphere.color.setHex(sky.hemisphereSkyColor);
  hemisphere.groundColor.setHex(sky.hemisphereGroundColor);
  hemisphere.intensity = sky.hemisphereIntensity;
  ambient.color.setHex(sky.ambientColor);
  ambient.intensity = sky.ambientIntensity;
  (scene.background as Color).setHex(sky.backgroundColor);

  // ── Framing ────────────────────────────────────────────────────────────────
  const view = CAMERA_VIEWS[viewName] ?? CAMERA_VIEWS.iso;
  const focus = sceneName === 'hurricane' ? CYCLONE_CELL : TORNADO_CELL;
  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    window.innerWidth / window.innerHeight,
    0.05,
    600,
  );
  const centre = new Vector3(focus.x * CELL_WORLD_SIZE, view.targetY, focus.y * CELL_WORLD_SIZE);
  camera.position.copy(centre).addScaledVector(view.direction.clone().normalize(), view.distance);
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
}

main();

// Referenced so the fixture's vertical framing is visibly tied to the shipped
// constants rather than to numbers typed here: the funnel reaches
// TORNADO_HEIGHT_WORLD_UNITS and the deck sits at CYCLONE_DECK_HEIGHT_WORLD_UNITS,
// which is what the camera distances above are chosen against.
void TORNADO_HEIGHT_WORLD_UNITS;
void CYCLONE_DECK_HEIGHT_WORLD_UNITS;
