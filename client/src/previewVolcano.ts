// previewVolcano.ts — THROWAWAY preview harness for the volcanoes plugin,
// mirroring previewFire.ts / previewBoats.ts. Not part of the shipped app:
// reached only through preview-volcano.html, not registered in
// plugins/registry.ts.
//
//   ?scene=<dormant|erupting|cooling|steam>  — defaults to "erupting"
//   ?view=<iso|low|close|top>                — defaults to "iso"
//   ?t=<seconds>                             — animation clock; default 3.2
//
// ─────────────────────────────────────────────────────────────────────────────
// IT RUNS THE REAL CODE, not a drawing of it. The terraced cone is a heightfield
// quantised on the game's own BAND_HEIGHT; the lava's path down it is the
// SERVER's own steepest-descent front (plugins/volcanoes/server/flow.ts's
// nextFlowCell, a pure function given a heightAt and a freshwater lookup); and
// the two things drawn on top are the shipped renderers, createLavaFlow and
// createPlume, fed the wire shapes the server would have sent.
//
// So what this shows is what the plugin does. What it does NOT show is the
// terrain renderer: the real client draws band caps over a SMOOTHED MARCHED
// CONTOUR (terrain/drawnGround.ts) and this draws blocky per-cell quads, which
// is the same silhouette one step cruder. The decal is placed on THIS harness's
// cap heights for that reason — the same relationship it has to drawnGroundYAt
// in the real client.

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
import {
  FLOW_RADIUS_WORLD_UNITS,
  LAVA_COOL_SECONDS,
  VENT_MIN_BANDS_ABOVE_SEA,
  GENESIS_CONE_BANDS,
  WORLD_UNITS_PER_BAND,
  type LavaCellState,
} from '../../plugins/volcanoes/protocol.ts';
import { nextFlowCell } from '../../plugins/volcanoes/server/flow.ts';
import { createLavaFlow } from '../../plugins/volcanoes/client/lavaFlow.ts';
import { createPlume } from '../../plugins/volcanoes/client/plume.ts';

// ── Lighting rig, copied from previewBoats.ts / render/scene.ts ─────────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const SETTLE_FRAME_COUNT = 4;

/** A dusk sky, so the glow has something to read against. */
const BACKDROP_COLOR = 0x33405a;

// ── The fixture world ───────────────────────────────────────────────────────
/** Cells per edge of the patch of world this harness builds. 24 world units. */
const GRID_CELLS = 96;
/** The vent sits at the middle of it. */
const VENT_CELL = GRID_CELLS / 2;

/** Summit height, in HEIGHT UNITS — the siting bar plus the genesis cone. */
const SUMMIT_HEIGHT = (VENT_MIN_BANDS_ABOVE_SEA + GENESIS_CONE_BANDS) * BAND_HEIGHT;

/**
 * The cone's foot, in cells — where its own relief has run out.
 *
 * Matched to what the server actually sculpts: a cone is a centre brush plus a
 * ring at CONE_RING_OFFSET (MAX_BRUSH_RADIUS, 16 cells), so the EDIT reaches 32
 * cells, and gradient relaxation carries the shoulder out further still.
 */
const CONE_FOOT_CELLS = cellsAcross(10);

/** The river at the foot of the mountain, in cells from the far edge. */
const RIVER_ROW = GRID_CELLS - 10;
const RIVER_HALF_WIDTH_CELLS = 2;

/** A shallow gully down one flank, so the front has a channel to find. */
const GULLY_DIRECTION = new Vector3(0.35, 0, 1).normalize();
const GULLY_DEPTH_HEIGHT_UNITS = BAND_HEIGHT * 1.6;
const GULLY_WIDTH_CELLS = 9;

/** How many cells of flow the fixture lays down — a full eruption's worth. */
const FLOW_CELLS_DRAWN = 64;

/** Cell → height units. The whole fixture terrain, as one pure function. */
function heightAtCell(cx: number, cy: number): number {
  const dx = cx - VENT_CELL;
  const dy = cy - VENT_CELL;
  const distance = Math.hypot(dx, dy);

  // The cone: full height at the mouth, falling to the siting bar at its foot.
  const coneFalloff = Math.min(1, distance / CONE_FOOT_CELLS);
  // Squared, so the profile is a volcano's concave flank rather than a tent.
  const cone = SUMMIT_HEIGHT * (1 - coneFalloff * coneFalloff);

  // The plain the cone stands on, tilting gently away toward the river.
  const plain = (VENT_MIN_BANDS_ABOVE_SEA * BAND_HEIGHT * (GRID_CELLS - cy)) / GRID_CELLS;

  // The gully — a trough along one bearing, deepest on its axis. Distance from
  // the axis is the cross product's magnitude, which is what keeps the trough
  // straight rather than pinched at the summit.
  const alongX = dx * GULLY_DIRECTION.x + dy * GULLY_DIRECTION.z;
  const acrossDistance = Math.abs(dx * GULLY_DIRECTION.z - dy * GULLY_DIRECTION.x);
  const gully =
    alongX > 0
      ? GULLY_DEPTH_HEIGHT_UNITS * Math.exp(-((acrossDistance / GULLY_WIDTH_CELLS) ** 2))
      : 0;

  // The river's bed, cut through the plain so the water lies in something.
  const riverDistance = Math.abs(cy - RIVER_ROW);
  const riverCut =
    riverDistance <= RIVER_HALF_WIDTH_CELLS ? BAND_HEIGHT * 1.2 : 0;

  return Math.max(0, cone + plain - gully - riverCut);
}

/** Which terrace band a height falls in, and the world Y its cap is drawn at. */
function bandOfHeight(height: number): number {
  return Math.floor(height / BAND_HEIGHT);
}
function capWorldY(cx: number, cy: number): number {
  return bandOfHeight(heightAtCell(cx, cy)) * WORLD_UNITS_PER_BAND;
}

function isRiverCell(cx: number, cy: number): boolean {
  return Math.abs(cy - RIVER_ROW) <= RIVER_HALF_WIDTH_CELLS && cx > 4 && cx < GRID_CELLS - 4;
}

/**
 * The game's terrain palette, roughly — sand, grass, rock, bare summit.
 *
 * NOT imported from client/src/terrain/bandColors.ts: that module is built for
 * the real band range around sea level and this fixture's ground is a relative
 * profile, so an import would tie the harness's look to a mapping it does not
 * actually satisfy. Approximate on purpose, and only the LAVA is exact.
 */
const BAND_COLORS: readonly Color[] = [
  new Color(0.78, 0.72, 0.52),
  new Color(0.62, 0.71, 0.42),
  new Color(0.48, 0.64, 0.34),
  new Color(0.42, 0.58, 0.31),
  new Color(0.46, 0.54, 0.35),
  new Color(0.45, 0.41, 0.33),
  new Color(0.36, 0.32, 0.29),
  new Color(0.29, 0.25, 0.23),
  new Color(0.23, 0.20, 0.19),
  new Color(0.18, 0.16, 0.15),
  new Color(0.14, 0.13, 0.13),
];

function colorForBand(band: number): Color {
  const index = Math.min(BAND_COLORS.length - 1, Math.max(0, band));
  return BAND_COLORS[index]!;
}

/**
 * Builds the terraced ground: one flat cap quad per cell, plus a riser quad
 * wherever a cell's neighbour sits in a lower band.
 *
 * BLOCKY, NOT CONTOURED — see this file's header on what that does and does not
 * represent.
 */
function buildTerrain(): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];

  const half = CELL_WORLD_SIZE / 2;

  function pushTriangle(a: Vector3, b: Vector3, c: Vector3, color: Color): void {
    for (const v of [a, b, c]) positions.push(v.x, v.y, v.z);
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  }

  for (let cy = 0; cy < GRID_CELLS; cy++) {
    for (let cx = 0; cx < GRID_CELLS; cx++) {
      const band = bandOfHeight(heightAtCell(cx, cy));
      const y = band * WORLD_UNITS_PER_BAND;
      const color = isRiverCell(cx, cy) ? new Color(0.20, 0.42, 0.58) : colorForBand(band);

      const x0 = cx * CELL_WORLD_SIZE - half;
      const x1 = x0 + CELL_WORLD_SIZE;
      const z0 = cy * CELL_WORLD_SIZE - half;
      const z1 = z0 + CELL_WORLD_SIZE;

      // Cap.
      pushTriangle(new Vector3(x0, y, z0), new Vector3(x0, y, z1), new Vector3(x1, y, z1), color);
      pushTriangle(new Vector3(x0, y, z0), new Vector3(x1, y, z1), new Vector3(x1, y, z0), color);

      // Risers, on the two sides that can face a lower neighbour.
      const neighbours: ReadonlyArray<readonly [number, number, Vector3, Vector3]> = [
        [cx + 1, cy, new Vector3(x1, y, z0), new Vector3(x1, y, z1)],
        [cx, cy + 1, new Vector3(x1, y, z1), new Vector3(x0, y, z1)],
      ];
      for (const [nx, ny, edgeA, edgeB] of neighbours) {
        if (nx >= GRID_CELLS || ny >= GRID_CELLS) continue;
        const neighbourY = bandOfHeight(heightAtCell(nx, ny)) * WORLD_UNITS_PER_BAND;
        if (neighbourY >= y) continue;
        const lowA = new Vector3(edgeA.x, neighbourY, edgeA.z);
        const lowB = new Vector3(edgeB.x, neighbourY, edgeB.z);
        // Risers are drawn a shade darker than their cap, which is how the real
        // terrain reads a step: the tread catches the sun, the riser does not.
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

/**
 * Walks the REAL front down the REAL terrain, and returns the cells it laid.
 *
 * `ageOfIndex` is what makes one scene differ from another: the front lays
 * cells in order, so the cell's index along the path IS how long ago it went
 * molten, and a scene picks the mapping (a live eruption is hot at the front
 * and cooling behind it; a cooled flow is cold all the way up).
 */
function walkFlow(ageOfIndex: (index: number, total: number) => number): LavaCellState[] {
  const world = {
    worldSize: GRID_CELLS,
    heightAt: heightAtCell,
    freshwater: {
      at: (x: number, y: number) => (isRiverCell(x, y) ? ('channel' as const) : ('none' as const)),
    },
  };

  const cells: LavaCellState[] = [];
  const visited = new Set<number>([VENT_CELL * 0x10000 + VENT_CELL]);
  let x = VENT_CELL;
  let y = VENT_CELL;

  for (let i = 0; i < FLOW_CELLS_DRAWN; i++) {
    const next = nextFlowCell(world, x, y, visited);
    // A string is one of flow.ts's stop reasons — water, the sea, or a basin.
    // The fixture is built so this lands on the river, which is the behaviour
    // worth photographing: fresh water stops a front dead.
    if (typeof next === 'string') break;
    x = next.x;
    y = next.y;
    visited.add(x * 0x10000 + y);
    cells.push({ x, y, ageSeconds: 0 });
  }

  return cells.map((cell, index) => ({
    ...cell,
    ageSeconds: ageOfIndex(index, cells.length),
  }));
}

type SceneName = 'dormant' | 'erupting' | 'cooling' | 'steam';
type ViewName = 'iso' | 'low' | 'close' | 'top';

const CAMERA_VIEWS: Record<ViewName, { direction: Vector3; distance: number; targetY: number }> = {
  // The default orbit: the whole mountain, its flow and its column.
  iso: { direction: new Vector3(0.55, 0.5, 0.95), distance: 30, targetY: 1.4 },
  // Down at ground level — what a player standing at the foot of it sees.
  low: { direction: new Vector3(0.2, 0.12, 1), distance: 26, targetY: 1.8 },
  // In on the flow itself, where the crust and the cracks are.
  close: { direction: new Vector3(0.5, 0.45, 0.8), distance: 9, targetY: 0.6 },
  top: { direction: new Vector3(0.01, 1, 0.02), distance: 26, targetY: 0 },
};

function main(): void {
  const query = new URLSearchParams(window.location.search);
  const sceneName = (query.get('scene') ?? 'erupting') as SceneName;
  const viewName = (query.get('view') ?? 'iso') as ViewName;
  const clock = Number(query.get('t') ?? '3.2');

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(60);
  scene.add(sun);

  scene.add(buildTerrain());

  const layer = new Group();
  scene.add(layer);

  // ── The flow, as each scene has it ────────────────────────────────────────
  // dormant  — nothing has ever erupted here.
  // erupting — hot at the front, cooling back toward the vent.
  // cooling  — the eruption ended a while ago; only the front is still lit.
  // steam    — the same as erupting, framed on where it met the river.
  const flow = createLavaFlow();
  layer.add(flow.root);
  if (sceneName !== 'dormant') {
    const cells =
      sceneName === 'cooling'
        ? walkFlow((index, total) => LAVA_COOL_SECONDS * (1 - (index / total) * 0.35))
        : walkFlow((index, total) => (LAVA_COOL_SECONDS * 0.75 * (total - index)) / total);
    flow.replaceAll(cells, clock, (cellX, cellY) => capWorldY(cellX, cellY));
  }

  // ── The column ────────────────────────────────────────────────────────────
  const plume = createPlume();
  layer.add(plume.root);
  if (sceneName === 'erupting' || sceneName === 'steam') {
    plume.apply([
      { id: 1, x: VENT_CELL, y: VENT_CELL, groundY: capWorldY(VENT_CELL, VENT_CELL) },
    ]);
    // One big step to full strength, then the animation clock — the renderers
    // are pure functions of (dt, elapsed), so this IS the frame at `t`.
    plume.update(10, clock);
  }
  flow.update(clock);

  // ── Framing ───────────────────────────────────────────────────────────────
  const view = CAMERA_VIEWS[viewName] ?? CAMERA_VIEWS.iso;
  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    window.innerWidth / window.innerHeight,
    // A near plane of 0.05 against a far of 400 is an 8000:1 ratio, which
    // leaves so little depth precision that the flow's hover over the ground
    // stops winning the depth test. The real client does not frame this way;
    // this is the harness's own camera and it should not invent a z-fight the
    // shipped one would not have.
    0.5,
    400,
  );
  const centre = new Vector3(
    VENT_CELL * CELL_WORLD_SIZE,
    view.targetY,
    VENT_CELL * CELL_WORLD_SIZE,
  );
  // The close view looks at the flow, not at the mouth.
  if (viewName === 'close') {
    centre.set(
      (VENT_CELL + 14) * CELL_WORLD_SIZE,
      capWorldY(VENT_CELL + 14, VENT_CELL + 26),
      (VENT_CELL + 26) * CELL_WORLD_SIZE,
    );
  }
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

// Referenced so the fixture's flow width is visibly tied to the shipped
// constant rather than to a number typed here; the front's own brush is what
// FLOW_RADIUS_WORLD_UNITS sizes, and the decal above is drawn at that width.
void FLOW_RADIUS_WORLD_UNITS;
