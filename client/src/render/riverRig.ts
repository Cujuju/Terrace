// Rivers, pools and waterfalls: CLIENT-SIDE PRESENTATION of a pure, derived
// fact of the heightmap (shared/src/rivers.ts, mechanics cards 27 & 40).
//
// Design decision Q3 extended to flowing water (docs/DESIGN.md, "Decisions
// made 2026-08-19"): a river is never synced or simulated state. It is
// recomputed HERE, on the client's own copy of the terrain, on the same
// cadence-decoupling throttle the server keeps for its own copy
// (World.riverNetwork in server/src/world/world.ts) — two clients looking at
// the same terrain draw the same rivers without either being told to.
//
// RULES THIS FILE KEEPS (the house pattern — see plugins/weather/client/
// rig.ts's own header, which states these first):
//   * Geometry and materials are built once and MUTATED IN PLACE on each
//     throttled recompute — never rebuilt inside the animation loop. A
//     recompute happens at most every RIVER_RECOMPUTE_INTERVAL_MS, which is
//     not "per frame" by a wide margin (60+ frames apart at 60 fps), so
//     replacing a BufferGeometry there is the same "rebuild is fine, not per
//     edit" allowance render/water.ts already documents for its own resize.
//   * NO PER-FRAME ALLOCATIONS in the animation path: the mist's gentle bob
//     rewrites an existing Float32Array's Y values; it never creates one.
//     — AMENDED 2026-08-20: the mist puffs are gone (see the dated block over
//     the legacy MIST_* constants below) but the rule stands unchanged for
//     their replacement: the spring rings/dome animation rewrites existing
//     Float32Arrays' values in place, never allocating in the frame handler.
//   * ONE OWNER: everything this module creates is freed by its own
//     dispose().
//   * PHOTOSENSITIVITY: the mist bob is the only animated element here and it
//     STOPS under prefers-reduced-motion — the mist simply holds still,
//     mirroring weather's "the whole sky holds still" rule. There is nothing
//     here anywhere near that rule's actual concern (flashing light); this is
//     satisfied out of consistency with the house standard, not because a
//     pulsing mist puff was ever a flash risk.
//     — AMENDED 2026-08-20: still true of the spring effect that replaced the
//     mist. Its fastest element is one ripple ring birth every
//     SPRING_RIPPLE_PERIOD_SECONDS / SPRING_RING_COUNT seconds (~0.67 Hz),
//     continuous motion rather than flashing, far under weather's 3 Hz bar;
//     the shared animation clock freezing under prefers-reduced-motion
//     freezes every part of it at once.
//   * SOUND: card 40 says "mist, sound". This project has no audio system at
//     all (confirmed against the whole client tree) and this change does not
//     add one — the card's audio half is DEFERRED, named here rather than
//     silently dropped.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import {
  BAND_HEIGHT,
  cellX,
  cellY,
  chunkIndexOfCell,
  chunksPerEdge,
  CHUNK_SIZE,
  quantizeToBand,
  SEA_LEVEL,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WATER_SURFACE_LIFT } from '../config.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { type DrawnGround } from '../terrain/drawnGround.ts';
import { WATER_COLOR } from './water.ts';
import { installWaterBandClock, makeBanded } from './water/waterBands.ts';
import {
  TILE_LATTICE_MAX_OFFSET,
  TILE_LATTICE_MIN_OFFSET,
  appendRegionSurface,
  type WaterRegion,
} from './water/waterTread.ts';
import { appendCurtains } from './water/waterCurtain.ts';
import {
  directRiverNetworkSource,
  type RiverNetworkSource,
} from './water/riverNetworkSource.ts';
import { EMPTY_RIVER_SURFACE, type RiverSurface } from './water/riverSurface.ts';

// ── Recompute throttle ───────────────────────────────────────────────────────

/**
 * Minimum real time between recomputes, in milliseconds — the client-side
 * twin of server/src/world/world.ts's RIVER_RECOMPUTE_INTERVAL_MS (see that
 * constant's doc comment for the full cost argument; the two are independent
 * numbers on purpose, since determinism only requires "same heightmap in,
 * same network out", never "computed at the same moment" — see
 * docs/DESIGN.md).
 *
 * 500 ms (2 Hz) rather than the server's 250 ms: the server's number is sized
 * against every connected player's combined edit rate hitting ONE shared
 * cost budget, while this is a single client redrawing its own screen —
 * update latency here is a feel question, not a fairness or a shared-CPU one,
 * and a river visibly settling a beat after the last click of a held stroke
 * reads as fine as terrain relaxation already does (SMOOTH_PASS_LIMIT strokes
 * are not instant either). Halving the server's rate also means this rebuild
 * is never the bottleneck the moment a terrainDiff message re-triggers it.
 */
const RIVER_RECOMPUTE_INTERVAL_MS = 500;

// ── Channel & lake geometry ──────────────────────────────────────────────────

/**
 * How far above the terrain river water is lifted, in world units — the same
 * role WATER_SURFACE_LIFT plays for the sea (render/water.ts): without it a
 * surface sitting exactly at the band-quantised ground height z-fights the
 * terrain mesh it is drawn over. Half of WATER_SURFACE_LIFT's own margin: a
 * river surface is narrow and always drawn a beat after the terrain it
 * follows, so it needs less clearance than the sea's single world-spanning
 * plane.
 *
 * IN WORLD UNITS, NOT CELLS (2026-08-21 re-sample), for exactly the reason
 * config.ts's WATER_SURFACE_LIFT gives for itself: depth-buffer resolution is a
 * fact about world space and the camera, and neither of those learned anything
 * about how finely the world is sampled. Left as a fraction of a CELL it would
 * have quietly shrunk to a quarter of the separation it was tuned for, and the
 * stated relation to WATER_SURFACE_LIFT (1/32) — half of it — would have
 * silently stopped holding.
 */
const RIVER_SURFACE_LIFT_WORLD_UNITS = 1 / 64;

/**
 * World Y of the sea's own surface — the floor no waterfall curtain may reach
 * below.
 *
 * The SAME expression render/water.ts:293 positions the sea plane with, and
 * for the same reason it is lifted: band-0 terrain renders exactly at
 * SEA_LEVEL and WATER_SURFACE_LIFT is what keeps the plane off it. A curtain
 * that ran past this would be drawing a waterfall UNDER the ocean, visible as
 * a sheet hanging in the water column. It stops here instead and the sea takes
 * over.
 */
const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

/**
 * Depth-buffer bias for the whole water mesh, pulling it TOWARD the camera in
 * the depth comparison without moving any vertex.
 *
 * WHY A MATERIAL BIAS AND NOT A GEOMETRIC ONE (2026-08-24). A waterfall sheet
 * is drawn flat against the rock face it pours down, and coincident surfaces
 * z-fight. The curtain used to buy its clearance by pushing every vertex 1/64
 * of a world unit outward along its own segment normal — which worked for the
 * depth buffer and broke the thing that matters more: the sheet no longer
 * shared vertices with the pool above it, so there was a hairline crack at
 * every pool-to-wall junction, and neighbouring quads offset along DIFFERENT
 * normals showed as bright doubled lines down each fall.
 *
 * A polygon offset resolves the depth comparison where the problem actually
 * is, leaving geometry free to be exactly coincident and exactly welded. One
 * unit each of slope-relative and constant bias: the smallest the GL spec
 * guarantees is resolvable, which is all a coplanar surface needs, and small
 * enough that water never pulls in front of geometry genuinely nearer.
 */
const WATER_DEPTH_BIAS_FACTOR = -1;
const WATER_DEPTH_BIAS_UNITS = -1;

/**
 * Translucency of ALL water in a network.
 *
 * ONE VALUE, not the old FLOW_OPACITY 0.72 / POOL_OPACITY 0.8 pair. A channel
 * and the pool it runs into are one continuous body of water; an opacity step
 * between them is itself a visible edge exactly where the owner reported
 * seeing one (2026-08-22, "it still doesn't look like continuous water").
 * Keeps the pooled value — the calmer, deeper read — and stays distinct from
 * the sea's own.
 */
const WATER_OPACITY = 0.8;

const RIVER_ROUGHNESS = 0.85;
const RIVER_METALNESS = 0;

/**
 * The radius, in CELLS, of the flat ground around a cell: the distance to the
 * nearest cell that the terrain draws in a DIFFERENT terrace band, less half a
 * cell, because the ground ends at the edge between the two rather than at the
 * far cell's centre.
 *
 * Measured in Chebyshev rings outward — the ring the effect draws is a circle,
 * so the plot has to hold in every direction at once, and the first direction
 * that runs out is the one that decides. Off the edge of the world counts as
 * running out: there is no ground there either.
 */
function plotRadiusCells(mirror: TerrainMirror, x: number, y: number): number {
  const band = quantizeToBand(sampleHeight(mirror, x, y));
  for (let reach = 1; reach <= SPRING_PLOT_PROBE_CELLS; reach++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Only the shell of this ring; the inside was cleared by earlier passes.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== reach) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mirror.map.size || ny >= mirror.map.size) {
          return reach - 0.5;
        }
        if (quantizeToBand(sampleHeight(mirror, nx, ny)) !== band) return reach - 0.5;
      }
    }
  }
  return SPRING_PLOT_PROBE_CELLS;
}


/**
 * RETIRED 2026-08-26 — kept as the record of the rule, the same convention this
 * file already keeps for the superseded MIST_* constants below. The water is no
 * longer wrapped as a fresh geometry per rebuild (see "The water buffer: one
 * packed run per region"), but its normals are still authored straight up for
 * exactly the reason set out here, and the packed buffer's `fillWaterNormals`
 * is where that now happens.
 *
 * Wraps a finished triangle-soup position list as a geometry, with every
 * normal AUTHORED STRAIGHT UP rather than computed from the faces.
 *
 * WHY NOT computeVertexNormals (2026-08-22, owner: "going from one band to the
 * next, there needs to be no edges"). This is a NON-INDEXED soup, so
 * computeVertexNormals has no vertices to average across — it produces a
 * per-FACE normal, which puts a hard shading crease everywhere the surface
 * bends. An apron bends by construction at its crest and at its foot, so a
 * geometrically watertight body would still have drawn a visible line at every
 * fall: a seam made of light rather than of gaps. Pinning every normal to +Y
 * makes the whole body shade as one flat surface, and a fall is then read from
 * its silhouette and its position — which is what "no edges" means. Nothing is
 * lost: this water is matte (RIVER_ROUGHNESS 0.85, RIVER_METALNESS 0) and the
 * world is flat-shaded throughout.
 */
function geometryFromTriangles(positions: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  const vertexCount = positions.length / 3;
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let v = 0; v < vertexCount; v++) normals[v * 3 + 1] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  return geometry;
}

// ── Waterfall mist (SUPERSEDED) ──────────────────────────────────────────────
// ---------------------------------------------------------------------------
// SUPERSEDED 2026-08-20 (owner report): the eight point sprites per waterfall
// below rendered, at orbit distance, as "white cubes" — a square un-rotated
// sprite has no silhouette that reads as water. Replaced by the plunge-pool
// treatment in the "Spring / plunge-pool effect" section that follows:
// concentric ripple rings expanding from the plunge point plus a faceted
// upwelling foam dome. The MIST_* constants remain below, unreferenced, as
// the record of the treatment this replaces — the same convention
// terrain/bandColors.ts keeps for seabedRimColor.
// ---------------------------------------------------------------------------

/**
 * Particles per waterfall's mist puff. A small, fixed column rather than
 * anything resembling weather's precipitation counts (tens to hundreds per
 * system) — this is a "small... aura" (the card's own words for the mana
 * effect it marks) and there are at most a couple of dozen waterfalls in a
 * network at all (MAX_SPRINGS_PER_NETWORK, shared/src/rivers.ts).
 */
const MIST_PARTICLES_PER_WATERFALL = 8;
/** How far the mist puff spreads horizontally from the plunge point, in cells. */
const MIST_SPREAD_CELLS = 0.4;
/** How tall the puff stands above the plunge pool, in world units. */
const MIST_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.6;
const MIST_COLOR = 0xf4fbff;
const MIST_OPACITY = 0.55;
const MIST_SPRITE_SIZE = CELL_WORLD_SIZE * 0.5;

/**
 * The bob's period, in seconds, and how far it moves — gentle enough to read
 * as drifting spray, slow enough to sit far under any photosensitivity
 * concern (weather's own bar is 3 Hz; this is 1/6 Hz).
 */
const MIST_BOB_PERIOD_SECONDS = 6;
const MIST_BOB_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.15;

const TWO_PI = Math.PI * 2;

// ── Spring / plunge-pool effect ──────────────────────────────────────────────
// The SPRING marker that replaced the mist puffs (2026-08-20, owner
// directive: springs must LOOK like springs). Two merged meshes cover every
// spring in the network — and only springs: the plunge-point half was removed
// 2026-08-24 (see "WHERE THE EFFECT BELONGS" in rebuildSprings for the
// owner's reasoning).
//
//   1. RIPPLE RINGS — SPRING_RING_COUNT flat concentric annuli per spring,
//      each cycling from SPRING_RING_MIN_RADIUS_CELLS out to
//      SPRING_RING_MAX_RADIUS_CELLS. A ring's band width follows
//      sin(π · progress): zero at birth, widest mid-life, zero again as it
//      dies at full radius — so rings appear and dissolve with no popping and
//      WITHOUT animating material opacity (one shared material serves every
//      spring; per-ring opacity would need per-vertex alpha machinery for
//      no extra legibility at orbit distance).
//   2. FOAM DOME — a faceted low-poly dome over the spring that swells and
//      settles like water welling up, in the flat-shaded style of the rest of
//      the world.
//
// Both geometries are built once per throttled recompute and their position
// buffers are MUTATED IN PLACE per frame (house rule #1/#2 in the module
// header). Per-spring cost is fixed and small — see the budget note under
// SPRING_RING_SEGMENTS.

/**
 * Concurrent ripple rings per spring. Three staggered thirds of a cycle
 * apart read as a continuous "welling" train; two leaves a visible dead gap
 * between ripples, four adds cost with no legibility gain at orbit distance.
 */
const SPRING_RING_COUNT = 3;

/**
 * Straight segments per ripple ring. 12 is the coarsest count whose polygon
 * still reads as a CIRCLE rather than a hexagon-ish blob at orbit distance,
 * and its faceting matches the world's flat-shaded style anyway.
 *
 * BUDGET, per spring: rings are SPRING_RING_COUNT × (2 ×
 * SPRING_RING_SEGMENTS) = 72 vertices / 72 triangles; the dome is
 * 2 × SPRING_DOME_SEGMENTS + 1 = 17 vertices / 24 triangles. Total 89
 * vertices / 96 triangles per spring.
 *
 * Network-wide this is now BOUNDED BY A CONSTANT, which it was not before
 * 2026-08-24: one site per river, at most MAX_SPRINGS_PER_NETWORK = 24 rivers
 * (shared/src/rivers.ts) — about 2 100 vertices, a rounding error against one
 * terrain chunk. The old per-band plunge sites made the count scale with how
 * cliffy the world was, which is why the index buffers are Uint32; they are
 * left that way rather than narrowed to Uint16 on the strength of one bound,
 * since the cost is nil and a future foot-of-fall effect would restore the
 * unbounded case.
 */
const SPRING_RING_SEGMENTS = 12;

/**
 * A ring is born at this centre-line radius, in cells — just outside the foam
 * dome's edge (SPRING_DOME_RADIUS_CELLS), so ripples visibly emanate FROM the
 * upwelling rather than materialising over it.
 */
const SPRING_RING_MIN_RADIUS_CELLS = 0.18;

/**
 * ...and dies at this radius. 0.45 keeps the ripple train inside the plunge
 * cell (half a cell is 0.5): it may lap the channel edge — read as spray
 * wetting the bank — but never marches across neighbouring cells.
 */
const SPRING_RING_MAX_RADIUS_CELLS = 0.45;

/**
 * How far out, in CELLS, the plot under a spring is measured before the
 * effect simply takes its full size.
 *
 * Three cells. Past that the ground is wider than the widest ring can ever
 * be, so measuring further only costs samples to learn nothing.
 */
const SPRING_PLOT_PROBE_CELLS = 3;

/**
 * How much of its plot's radius the widest ring may fill.
 *
 * WHY THE EFFECT IS FITTED TO ITS GROUND AT ALL (2026-08-22, owner, with a
 * photograph of a spring on a pillar: "the size of those rings should never be
 * larger than the size of ground it spawns on"). The rings were a fixed size
 * in cells, so on a broad plateau they looked right and on a one-cell pillar
 * they hung over every edge — the effect claiming ground the terrain does not
 * have.
 *
 * THREE FIFTHS, because a cell of plot is not a cell of DRAWN ground. The
 * terrain's cap is a smoothed contour whose crossings sit somewhere between an
 * eighth and seven eighths of the way to the neighbouring cell, so the visible
 * top of a lone high cell is meaningfully smaller than the cell itself, and a
 * ring sized to the cell would still overhang the tread that is actually
 * drawn. Three fifths leaves room for that inset at the tightest plot while
 * costing nothing on open ground, where SPRING_RING_MAX_RADIUS_CELLS is
 * reached first and this stops applying.
 */
const SPRING_RING_PLOT_FILL_FRACTION = 0.6;

/**
 * A ring's radial band width at mid-life (its widest), in cells. Wide enough
 * to survive at orbit distance; narrower than the ring spacing so consecutive
 * rings never merge into a solid disc.
 */
const SPRING_RING_MAX_WIDTH_CELLS = 0.1;

/**
 * One ring's full birth-to-death cycle, in seconds. With SPRING_RING_COUNT
 * rings staggered evenly, a new ripple is born every 4.5 / 3 = 1.5 s
 * (~0.67 Hz) — an unhurried welling pace, far under the 3 Hz photosensitivity
 * ceiling weather documents, and continuous motion rather than flashing
 * besides.
 */
const SPRING_RIPPLE_PERIOD_SECONDS = 4.5;

/**
 * Foam near-white — the same value the superseded mist used (MIST_COLOR): it
 * was the right COLOUR for aerated water; the failure was sprite shape, not
 * palette.
 */
const SPRING_FOAM_COLOR = 0xf4fbff;

/**
 * Rings are see-through foam wash: translucent enough that the river's own
 * blue reads through them, opaque enough to register against it.
 */
const SPRING_RING_OPACITY = 0.5;

/** Radius of the upwelling foam dome, in cells — comfortably inside the
 * 0.6-cell-wide flowing channel ribbon so the dome sits ON the water. */
const SPRING_DOME_RADIUS_CELLS = 0.16;

/**
 * The dome's rest height above the plunge-pool surface, in world units. A low
 * mound — water welling up — not a hemisphere boulder; kept well under one
 * band (BAND_WORLD_HEIGHT = CELL_WORLD_SIZE) so it never reads as terrain.
 */
const SPRING_DOME_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.12;

/**
 * Radial segments of the dome. 8 gives the faceted low-poly silhouette the
 * rest of the world uses (trees, boulders); the budget arithmetic under
 * SPRING_RING_SEGMENTS assumes this value.
 */
const SPRING_DOME_SEGMENTS = 8;

/**
 * The dome's mid ring sits at 45° up the profile: cos 45° of the radius,
 * sin 45° of the height (≈ 0.7071 each) — one named constant since the two
 * are the same number by construction.
 */
const SPRING_DOME_MID_PROFILE = Math.SQRT1_2;

/** The dome is denser foam than the rings — nearly solid. */
const SPRING_DOME_OPACITY = 0.85;

/**
 * How far the dome swells above/below its rest height, as a fraction of that
 * height, and how long one swell takes. 1/6 Hz — the exact period the
 * superseded mist bob used, kept because it already read as "gently alive"
 * and sits far under the photosensitivity bar.
 */
const SPRING_DOME_SWELL_FRACTION = 0.15;
const SPRING_DOME_SWELL_PERIOD_SECONDS = 6;

/**
 * Rings float this far above the river surface under them (which itself sits
 * RIVER_SURFACE_LIFT_WORLD_UNITS above terrain). Double that lift: the same
 * z-fighting argument, applied one layer up — the rings must clear the water
 * by at least as much as the water clears the ground.
 */
const SPRING_EFFECT_LIFT_WORLD_UNITS = RIVER_SURFACE_LIFT_WORLD_UNITS * 2;

/**
 * Everything the frame handler needs to animate the spring meshes without
 * allocating: flat per-vertex arrays captured at rebuild time. All arrays are
 * indexed by vertex (rings) or by vertex/dome as commented.
 */
interface SpringState {
  readonly ringMesh: Mesh;
  readonly ringGeometry: BufferGeometry;
  /** Per ring-vertex plunge-point centre, world X/Z. */
  readonly ringCentreX: Float32Array;
  readonly ringCentreZ: Float32Array;
  /** Per ring-vertex unit direction out from the centre. */
  readonly ringDirX: Float32Array;
  readonly ringDirZ: Float32Array;
  /** Per ring-vertex: 0 = inner edge of the band, 1 = outer edge. */
  readonly ringEdge: Float32Array;
  /** Per ring-vertex cycle offset in [0, 1), staggering the rings. */
  readonly ringCycleOffset: Float32Array;
  /**
   * Per ring-vertex multiplier on the ring's radius, fitting the effect to the
   * ground it stands on (see SPRING_RING_PLOT_FILL_FRACTION). 1 on open
   * ground; smaller on a narrow pillar, where a full-size ring would hang over
   * the edge of a tread the terrain never drew.
   */
  readonly ringPlotScale: Float32Array;

  readonly domeMesh: Mesh;
  readonly domeGeometry: BufferGeometry;
  /** Per dome-vertex rest height above the plunge surface (0 for the base ring). */
  readonly domeRestOffsetY: Float32Array;
  /** Per dome-vertex plunge surface world Y (constant within one dome). */
  readonly domeSurfaceY: Float32Array;
  /** Per dome-vertex swell phase (constant within one dome, staggered across domes). */
  readonly domePhase: Float32Array;
}

// ── The rig ──────────────────────────────────────────────────────────────────

export interface RiverRig {
  /**
   * Recomputes the river network from the mirror's CURRENT terrain and
   * re-emits the water the given chunks can have changed — throttled
   * internally to RIVER_RECOMPUTE_INTERVAL_MS, so calling this from every
   * terrainDiff (as client/src/world.ts does, alongside the terrain mesh patch)
   * costs nothing extra: most calls are a no-op elapsed-time check.
   *
   * `dirty` IS THE SAME SET THE MESHES GET — the chunks whose heights changed.
   * Dirty sets accumulate across throttled calls, so a stroke that emits eight
   * intents a second and gets two rebuilds still re-emits every chunk it
   * touched. Water whose region neither moved nor stands over changed ground
   * keeps the vertices it already had.
   *
   * `ground` is what the terrain has DRAWN (terrain/drawnGround.ts). It is
   * passed in rather than built here because it is a reader over the mesh
   * builder's own store: the water must weld to the rock that is on screen.
   */
  refresh(mirror: TerrainMirror, dirty: ReadonlySet<number>, ground: DrawnGround): void;
  /**
   * Rebuilds EVERYTHING immediately, bypassing the throttle, and resets it so
   * the next ordinary `refresh` call is timed from now. For the ONE case a
   * throttle is wrong: a fresh join or rejoin (client/src/world.ts's
   * onSnapshot), where `mirror` is a brand-new session's and the previous
   * session's tiles must not be left on screen for up to
   * RIVER_RECOMPUTE_INTERVAL_MS just because this rig happened to recompute
   * recently for a DIFFERENT world. Every other caller wants the throttle —
   * see `refresh`.
   *
   * Immediately means the REQUEST is immediate. With the worker source the
   * network still arrives a beat later; with the direct source the rebuild has
   * finished by the time this returns.
   */
  forceRefresh(mirror: TerrainMirror, ground: DrawnGround): void;
  dispose(): void;
}

/** Optional collaborators — everything here has a working default. */
export interface RiverRigOptions {
  /**
   * Where the river network is computed. Defaults to
   * `directRiverNetworkSource` (this thread, synchronous), which is what tests
   * and previews want; the client passes the worker-backed one.
   */
  readonly networkSource?: RiverNetworkSource;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference live. A near-duplicate of the same
 * small watcher plugins/weather/client/index.ts, the mana gauge and the
 * monsters plugin's dread already each keep their own copy of — this module
 * lives in core (rivers are not a plugin — see docs/DESIGN.md), which has no
 * shared client utility module to hang one shared copy on, so a fourth small
 * copy here follows the same house pattern rather than inventing a new one.
 */
function watchReducedMotion(): { matches(): boolean; stop(): void } {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  if (query === null) return { matches: () => false, stop: () => {} };

  let reduced = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
  };
  query.addEventListener('change', onChange);
  return {
    matches: () => reduced,
    stop: () => query.removeEventListener('change', onChange),
  };
}

/**
 * The river rig's share of the frame's draw budget: THREE meshes, whatever the
 * network holds. One packed water mesh for every region, plus the two MERGED
 * spring meshes — the rings and the domes — which cover every spring in the
 * network at once (see the spring section below) rather than one pair per
 * spring. The count is fixed, so a world with more rivers costs more triangles
 * and no more draw calls.
 */
export const RIVER_RIG_DRAW_OBJECTS = 3;

export function createRiverRig(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
  options?: RiverRigOptions,
): RiverRig {
  const networkSource = options?.networkSource ?? directRiverNetworkSource;
  // ONE material and ONE mesh for every drop of river water in the network —
  // channels, pools and the aprons that pour between them. Two materials meant
  // two opacities and therefore a visible boundary wherever a channel met its
  // pool; two meshes meant two independent transparent surfaces sorting against
  // each other at exactly the place the water is supposed to read as one body.
  const waterMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: WATER_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false, // see render/water.ts: lets submerged/underlying terrain show through
    side: DoubleSide,
    // Waterfall sheets are coincident with the rock face by design — see
    // WATER_DEPTH_BIAS_FACTOR for why the clearance lives here rather than in
    // the vertices.
    polygonOffset: true,
    polygonOffsetFactor: WATER_DEPTH_BIAS_FACTOR,
    polygonOffsetUnits: WATER_DEPTH_BIAS_UNITS,
  });

  // The painted bands, and the clock that drives them. The rig is built by both
  // the real client and the river previews, so installing the clock here is what
  // makes the water move in a preview harness too; the installer is idempotent,
  // so the sea sharing the same uniform cannot double-tick it.
  makeBanded(waterMaterial);
  installWaterBandClock(onFrame);

  const waterMesh = new Mesh(new BufferGeometry(), waterMaterial);
  parent.add(waterMesh);

  // ── The water buffer: one packed run per region ────────────────────────────
  //
  // WHY THE GEOMETRY IS NO LONGER THROWN AWAY EACH REBUILD. Until 2026-08-26
  // every rebuild re-emitted every region into one fresh triangle list and
  // replaced the BufferGeometry — measured at ~235 ms per rebuild on a 512²
  // world with 400 chunks revealed, twice a second while a stroke is held,
  // against a 7.1 ms frame budget. Almost all of it was work with no new
  // answer in it: a stroke changes one or two chunks, and the water standing
  // three hundred cells away is exactly the water that was already there.
  //
  // So the buffer is now packed the way terrainMeshes.ts packs chunks into a
  // super-mesh, for the same reasons and with the same shape: each region owns
  // a contiguous RUN of vertices, a re-emit that changes a run's length shifts
  // the tail with `copyWithin` (bounded memmove, not a rebuild), and the whole
  // buffer is submitted as ONE draw range with no holes. What differs is only
  // the key: chunks there, water regions here.
  //
  // NORMALS ARE NOT PART OF THE SPLICE. Every water vertex's normal is +Y (see
  // the note on the retired `geometryFromTriangles` for why the water is
  // authored flat rather than face-shaded), so the normal buffer is a constant
  // the length of the capacity — filled on growth and never moved.

  /** Where one region's vertices live inside the packed water buffer. */
  interface RegionRun {
    /** First vertex of the run, as an index into the packed buffers. */
    offset: number;
    /** Live vertices in the run. */
    count: number;
  }

  /**
   * Vertices the water buffer starts with. A first rebuild grows it to whatever
   * the world really needs and it never shrinks — the same bargain
   * `ensureCapacity` makes for a chunk that once held a big cliff.
   */
  const INITIAL_WATER_VERTEX_CAPACITY = 3072;

  let waterPositions = new Float32Array(INITIAL_WATER_VERTEX_CAPACITY * 3);
  let waterNormals = new Float32Array(INITIAL_WATER_VERTEX_CAPACITY * 3);
  let waterPositionAttribute = new BufferAttribute(waterPositions, 3);
  let waterNormalAttribute = new BufferAttribute(waterNormals, 3);
  /** Sum of every run's count — the geometry's draw range, and its only one. */
  let liveWaterVertices = 0;
  /**
   * The regions in the buffer, by surface band, in ASCENDING BAND ORDER — which
   * is the order their runs sit in the buffer, so a run's offset is the sum of
   * the counts before it. Sorted rather than insertion-ordered because the
   * packing depends on it: a splice shifts exactly the runs that follow, and
   * "the runs that follow" has to be well-defined however the regions happened
   * to appear.
   */
  const waterRunOrder: number[] = [];
  const waterRuns = new Map<number, RegionRun>();

  /** Every normal from `from` to `to` (vertex indices) authored straight up. */
  const fillWaterNormals = (from: number, to: number): void => {
    for (let v = from; v < to; v++) waterNormals[v * 3 + 1] = 1;
  };
  fillWaterNormals(0, INITIAL_WATER_VERTEX_CAPACITY);

  /**
   * Points the mesh at the current buffers. Run at startup and again whenever
   * they had to grow — a typed array cannot be resized, so growth means new
   * arrays and therefore new attributes, and the old geometry is disposed
   * rather than left holding its GPU buffers.
   */
  const bindWaterGeometry = (): void => {
    waterPositionAttribute = new BufferAttribute(waterPositions, 3);
    waterNormalAttribute = new BufferAttribute(waterNormals, 3);
    waterPositionAttribute.setUsage(DynamicDrawUsage);
    waterNormalAttribute.setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', waterPositionAttribute);
    geometry.setAttribute('normal', waterNormalAttribute);
    geometry.setDrawRange(0, liveWaterVertices);
    const previous = waterMesh.geometry;
    waterMesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();
  };
  bindWaterGeometry();

  /**
   * Grows the water buffers to hold at least `vertices`, preserving what is in
   * them. Geometric (doubling) rather than exact, so a river growing a cell at
   * a time cannot reallocate on every rebuild.
   */
  const ensureWaterCapacity = (vertices: number): void => {
    const capacity = waterPositions.length / 3;
    if (vertices <= capacity) return;
    let grown = Math.max(capacity, 1);
    while (grown < vertices) grown *= 2;
    const positions = new Float32Array(grown * 3);
    positions.set(waterPositions.subarray(0, liveWaterVertices * 3));
    waterPositions = positions;
    waterNormals = new Float32Array(grown * 3);
    fillWaterNormals(0, grown);
    bindWaterGeometry();
  };

  /**
   * Copies `count` vertices of `source` into the region's run, moving
   * everything after it if the run changed length. A `count` of 0 removes the
   * region from the buffer.
   *
   * Line for line the same manoeuvre as terrainMeshes.ts's `spliceChunk`, and
   * deliberately so: the packing invariant (runs back-to-back, offsets exact,
   * one draw range) is the thing that must hold, and two spellings of it would
   * be two chances to get it wrong.
   */
  const spliceRegion = (band: number, source: readonly number[], count: number): void => {
    let run = waterRuns.get(band);
    if (run === undefined) {
      if (count === 0) return;
      // A new region goes where its band sorts to, so one that appears later
      // still lands between its neighbours rather than at the end.
      let at = waterRunOrder.length;
      for (let i = 0; i < waterRunOrder.length; i++) {
        if (waterRunOrder[i]! > band) {
          at = i;
          break;
        }
      }
      const previous = at === 0 ? null : waterRuns.get(waterRunOrder[at - 1]!)!;
      run = { offset: previous === null ? 0 : previous.offset + previous.count, count: 0 };
      waterRunOrder.splice(at, 0, band);
      waterRuns.set(band, run);
    }

    const delta = count - run.count;
    if (delta > 0) ensureWaterCapacity(liveWaterVertices + delta);

    const tailStart = run.offset + run.count;
    const tailLength = liveWaterVertices - tailStart;
    if (delta !== 0 && tailLength > 0) {
      // copyWithin, not set(subarray): the source and destination overlap, and
      // copyWithin is specified to behave as if the range were copied first.
      waterPositions.copyWithin(
        (tailStart + delta) * 3,
        tailStart * 3,
        (tailStart + tailLength) * 3,
      );
    }
    if (delta !== 0) {
      const from = waterRunOrder.indexOf(band) + 1;
      for (let i = from; i < waterRunOrder.length; i++) {
        waterRuns.get(waterRunOrder[i]!)!.offset += delta;
      }
      liveWaterVertices += delta;
      run.count = count;
    }

    const base = run.offset * 3;
    for (let i = 0; i < count * 3; i++) waterPositions[base + i] = source[i]!;

    if (count === 0) {
      waterRuns.delete(band);
      waterRunOrder.splice(waterRunOrder.indexOf(band), 1);
    }
  };

  /**
   * The bound the renderer culls against, over the LIVE range only.
   *
   * Hand-rolled for the same reason terrainMeshes.ts hand-rolls its own:
   * `computeBoundingSphere` reads the whole position attribute, and the tail
   * past `liveWaterVertices` is whatever a previous, longer occupant left there.
   * Centre-of-AABB, which is what Three's own implementation uses.
   */
  const recomputeWaterBounds = (): void => {
    const geometry = waterMesh.geometry;
    if (liveWaterVertices === 0) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < liveWaterVertices; v++) {
      const x = waterPositions[v * 3]!;
      const y = waterPositions[v * 3 + 1]!;
      const z = waterPositions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    let maxSquared = 0;
    for (let v = 0; v < liveWaterVertices; v++) {
      const dx = waterPositions[v * 3]! - centreX;
      const dy = waterPositions[v * 3 + 1]! - centreY;
      const dz = waterPositions[v * 3 + 2]! - centreZ;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxSquared) maxSquared = squared;
    }
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.sqrt(maxSquared),
    );
  };

  // ── What the last rebuild emitted ─────────────────────────────────────────

  // ── The wet-cell scratch ──────────────────────────────────────────────────
  //
  // WHY TYPED ARRAYS AND NOT A `Map<cell, band>`. Every rebuild flattens the
  // whole network into "which band of water stands on this cell", and that walk
  // is O(WET CELLS) however cheap the geometry around it becomes — its size is
  // capped by shared/src/rivers.ts's own two constants (MAX_SPRINGS_PER_NETWORK
  // traces, each bounded by RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER x
  // worldSize cells), which on a 512-edge world is ~24.5k cells. Done with a
  // Map — one `get` and one `set` to record each cell, then two more passes of
  // `get`/`has` to diff against the last rebuild — that walk alone was ~6 ms of
  // an 11 ms refresh, most of the main-thread cost that survived moving the
  // network off it.
  //
  // A cell index is a dense integer, so the table is an array. The generation
  // STAMP is what makes it free to reuse: "wet" is `stamp[cell] === thisRebuild`
  // rather than a value that has to be cleared, so nothing is zeroed between
  // rebuilds and the previous rebuild's answer stays readable in the other half
  // of the pair.

  /** One rebuild's wet-cell table: band per cell, valid where the stamp matches. */
  interface WetCells {
    band: Int16Array;
    stamp: Int32Array;
    /**
     * The cells stamped this rebuild, in the order the network walk found them.
     * This IS the array the surface arrived in — adopted rather than copied.
     */
    list: Int32Array;
    /** The stamp value that means "wet in the rebuild this table describes". */
    generation: number;
  }

  const makeWetCells = (cellCount: number): WetCells => ({
    band: new Int16Array(cellCount),
    stamp: new Int32Array(cellCount),
    list: new Int32Array(0),
    generation: 0,
  });

  /** This rebuild's table and the previous one's; swapped, never rebuilt. */
  let wetCells = makeWetCells(0);
  let previousWetCells = makeWetCells(0);
  let wetGeneration = 0;

  /**
   * Re-allocates the tables when the world size changes, and rotates them for a
   * new rebuild. A rejoin can hand over a different world; a table sized for the
   * old one would index out of range.
   */
  const beginWetCells = (cellCount: number): void => {
    if (wetCells.band.length !== cellCount) {
      wetCells = makeWetCells(cellCount);
      previousWetCells = makeWetCells(cellCount);
      wetGeneration = 0;
    }
    const rotated = previousWetCells;
    previousWetCells = wetCells;
    wetCells = rotated;
    wetGeneration++;
    wetCells.generation = wetGeneration;
  };

  /** One region's triangles, reused across regions and rebuilds. */
  const regionTriangles: number[] = [];

  /** The empty run handed to `spliceRegion` when a region is removed. */
  const EMPTY_TRIANGLES: readonly number[] = [];

  /**
   * The marching tiles each band-region was EMITTED with, by band.
   *
   * A region's IDENTITY IS ITS BAND, which is not a convention imposed here —
   * the rebuild groups every wet cell by the band its surface is drawn at, so
   * one band is one region by construction (see the rebuild's step 2). That
   * makes identity deterministic without an anchor-cell rule: the same terrain
   * always produces the same bands with the same contents.
   *
   * The tiles are kept, rather than the cells, because of the one case the new
   * tiles cannot speak for: a region that LOST every cell it had in some chunk
   * no longer lists that chunk, so only the tiles it was drawn with can say
   * that its old geometry there is stale.
   */
  const emittedRegionTiles = new Map<number, ReadonlySet<number>>();

  /**
   * Whether a region has to be emitted again, or may keep the vertices it has.
   *
   * A region's geometry is a function of three things: its own cells, the
   * terrain in and beside its tiles, and the water standing just outside it (a
   * curtain's foot lands on the pool below, not on the first rock ledge). The
   * `affectedChunks` set is built to cover all three — every chunk whose terrain
   * changed and every chunk holding a cell whose water changed, each grown by
   * one ring — so intersecting it with the region's tiles is the whole test.
   *
   * BOTH TILE SETS ARE TESTED, and the second is not redundant. A region that
   * lost every cell it had in a chunk does not list that chunk any more, so its
   * NEW tiles cannot report the change that emptied it; the tiles it was drawn
   * with can.
   */
  const regionNeedsReemit = (
    region: WaterRegion,
    affectedChunks: ReadonlySet<number>,
  ): boolean => {
    const emittedTiles = emittedRegionTiles.get(region.surfaceBand);
    if (emittedTiles === undefined || !waterRuns.has(region.surfaceBand)) return true;
    for (const tile of region.tiles) if (affectedChunks.has(tile)) return true;
    for (const tile of emittedTiles) if (affectedChunks.has(tile)) return true;
    return false;
  };

  // Spring materials — one shared instance each across every spring in
  // the network (the rings/dome geometries are merged, so one draw call per
  // mesh). depthWrite stays false like the water tiles': the effect layers
  // over translucent water and must not punch holes in what renders behind.
  const springRingMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_RING_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide, // rings are flat annuli; visible from below a terrace lip too
  });
  const springDomeMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_DOME_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    flatShading: true, // faceted low-poly dome, in the world's house style
  });
  let spring: SpringState | null = null;

  let lastRebuildMs = Number.NEGATIVE_INFINITY;

  /**
   * Rebuilds the spring effect from scratch, one ripple-ring set and one foam
   * dome per spring, merged into two indexed geometries (one draw call
   * each). Vertex POSITIONS here are only placeholders for the animated
   * components — the frame handler below overwrites ring X/Z and dome Y every
   * frame from the flat per-vertex arrays captured in SpringState — but the
   * static components (ring Y, dome X/Z) and both index buffers are final.
   *
   * Cycle offsets are staggered per ring AND per spring (`w /
   * springs.length`) for the same reason the superseded mist staggered its
   * bob phases across the whole buffer: no two springs pulsing in visible
   * lockstep.
   */
  const rebuildSprings = (
    mirror: TerrainMirror,
    sourceCells: Int32Array,
    waterSurfaceYAt: (x: number, y: number) => number | null,
  ): void => {
    if (spring !== null) {
      parent.remove(spring.ringMesh);
      parent.remove(spring.domeMesh);
      spring.ringGeometry.dispose();
      spring.domeGeometry.dispose();
      spring = null;
    }

    // WHERE THE EFFECT BELONGS.
    //
    // 2026-08-22, owner: the rings "should only be shown at sources of water
    // or at the bottom of drawn waterfalls". Before that it sat on every
    // Waterfall in the network, and a Waterfall is recorded at the cell the
    // water LEAVES — the lip. So the rings rode the top of each drop, where
    // the water is smooth and leaving, and there was nothing where it lands
    // or where it comes out of the ground.
    //
    // 2026-08-24, owner, NARROWING THAT to sources alone: "I would prefer if
    // that spring slash plunge foam effect was only applied to springs. If
    // it's going to draw a plunge effect where water pours into more water
    // like the bottom of a waterfall, that animation needs to be changed
    // because that's not what it would look like."
    //
    // So plunge points are dropped rather than left drawing the wrong thing.
    // Expanding rings ARE what a spring looks like — water welling up and
    // spreading out from a point — and are NOT what a fall's foot looks like,
    // which is churn and spray driven downward, not a tidy concentric
    // ripple. Marking the foot of a fall is deferred until it has an
    // animation of its own; it is not approximated with this one.
    //
    // A SOURCE is the first point of a river's trunk course: the one place in
    // a network where water arrives from nowhere and should look like it.
    // Deduplicated by cell, so two rivers sharing a head spring get one
    // effect.
    const siteCells = new Map<number, { readonly x: number; readonly y: number }>();
    for (const cell of sourceCells) {
      siteCells.set(cell, {
        x: cellX(mirror.map.size, cell),
        y: cellY(mirror.map.size, cell),
      });
    }
    const springs = [...siteCells.values()];
    if (springs.length === 0) return;

    // ── Ripple rings ──
    const ringVertsPerRing = SPRING_RING_SEGMENTS * 2; // inner edge + outer edge
    const ringVertsPerSpring = SPRING_RING_COUNT * ringVertsPerRing;
    const ringVertexCount = springs.length * ringVertsPerSpring;
    const ringPositions = new Float32Array(ringVertexCount * 3);
    const ringNormals = new Float32Array(ringVertexCount * 3);
    const ringCentreX = new Float32Array(ringVertexCount);
    const ringCentreZ = new Float32Array(ringVertexCount);
    const ringDirX = new Float32Array(ringVertexCount);
    const ringDirZ = new Float32Array(ringVertexCount);
    const ringEdge = new Float32Array(ringVertexCount);
    const ringCycleOffset = new Float32Array(ringVertexCount);
    const ringPlotScale = new Float32Array(ringVertexCount);
    // Two triangles per segment per ring. Uint32: see the budget note under
    // SPRING_RING_SEGMENTS for why Uint16 cannot be assumed safe here.
    const ringIndices = new Uint32Array(
      springs.length * SPRING_RING_COUNT * SPRING_RING_SEGMENTS * 2 * 3,
    );

    // ── Foam domes ──
    // Base octagon + mid octagon + apex point.
    const domeVertsPerDome = SPRING_DOME_SEGMENTS * 2 + 1;
    const domeVertexCount = springs.length * domeVertsPerDome;
    const domePositions = new Float32Array(domeVertexCount * 3);
    const domeRestOffsetY = new Float32Array(domeVertexCount);
    const domeSurfaceY = new Float32Array(domeVertexCount);
    const domePhase = new Float32Array(domeVertexCount);
    // Base→mid band is 2 triangles per segment; mid→apex fan is 1. Uint32 for
    // the same reason as the ring indices.
    const domeIndices = new Uint32Array(springs.length * SPRING_DOME_SEGMENTS * 3 * 3);

    let ringIndexWrite = 0;
    let domeIndexWrite = 0;
    for (let w = 0; w < springs.length; w++) {
      const site = springs[w]!;
      const centreX = site.x * CELL_WORLD_SIZE;
      const centreZ = site.y * CELL_WORLD_SIZE;
      // The effect's resting surface: the river's height at the plunge cell,
      // plus its own anti-z-fight lift over that water.
      // FOAM SITS ON THE WATER, NOT ON THE BED (fixed 2026-08-24, owner's
      // screenshot: faint white rings visible INSIDE the water rather than on
      // it). This used to read `quantizeToBandWorldY(mirror, x, y)` — the
      // band-quantised height of the GROUND at the cell, straight off the cell
      // lattice — which is the bed, not the surface. Wherever a spring is
      // submerged under a lake or the sea, that put the rings on the lakebed
      // and you saw them dimly through the water above.
      //
      // Two rules, both of them "the surface a viewer would actually see":
      //   * the river's own water surface at that cell, which is the tread the
      //     rings are foam on — the SAME bandWorldY the tread was built with,
      //     not a second derivation of it;
      //   * never below the sea, because where the terrain is drowned the
      //     visible surface is the sea plane and nothing else.
      // A spring whose cell carries no water at all has no surface to sit on;
      // it is skipped when the sites are gathered.
      const surfaceY =
        Math.max(waterSurfaceYAt(site.x, site.y) ?? SEA_SURFACE_WORLD_Y, SEA_SURFACE_WORLD_Y) +
        SPRING_EFFECT_LIFT_WORLD_UNITS;
      const springStagger = w / springs.length;
      // The effect is never wider than the ground under it: the widest ring
      // this site may draw, as a fraction of the widest ring there is.
      const fittedRadiusCells = Math.min(
        SPRING_RING_MAX_RADIUS_CELLS,
        plotRadiusCells(mirror, site.x, site.y) * SPRING_RING_PLOT_FILL_FRACTION,
      );
      const plotScale = fittedRadiusCells / SPRING_RING_MAX_RADIUS_CELLS;

      // Rings: static per-vertex data. X/Z are animated, so positions get a
      // throwaway 0 there; Y is FINAL here and never rewritten.
      for (let r = 0; r < SPRING_RING_COUNT; r++) {
        const ringBase = w * ringVertsPerSpring + r * ringVertsPerRing;
        const cycleOffset = (r / SPRING_RING_COUNT + springStagger) % 1;
        for (let s = 0; s < SPRING_RING_SEGMENTS; s++) {
          const angle = (s / SPRING_RING_SEGMENTS) * TWO_PI;
          const dirX = Math.cos(angle);
          const dirZ = Math.sin(angle);
          for (let edge = 0; edge < 2; edge++) {
            const v = ringBase + s + edge * SPRING_RING_SEGMENTS;
            ringCentreX[v] = centreX;
            ringCentreZ[v] = centreZ;
            ringDirX[v] = dirX;
            ringDirZ[v] = dirZ;
            ringEdge[v] = edge;
            ringCycleOffset[v] = cycleOffset;
            ringPlotScale[v] = plotScale;
            ringPositions[v * 3 + 1] = surfaceY;
            ringNormals[v * 3 + 1] = 1; // flat annulus: straight up, forever
          }
          // Segment s spans to its wrapped neighbour sn.
          const sn = (s + 1) % SPRING_RING_SEGMENTS;
          const innerS = ringBase + s;
          const innerSn = ringBase + sn;
          const outerS = ringBase + SPRING_RING_SEGMENTS + s;
          const outerSn = ringBase + SPRING_RING_SEGMENTS + sn;
          ringIndices[ringIndexWrite++] = innerS;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = outerSn;
        }
      }

      // Dome: X/Z are FINAL here; Y is animated (the swell), so the frame
      // handler recomputes it from surfaceY + restOffsetY.
      const domeBase = w * domeVertsPerDome;
      const apex = domeBase + SPRING_DOME_SEGMENTS * 2;
      const domeSwellPhase = springStagger * TWO_PI;
      for (let s = 0; s < SPRING_DOME_SEGMENTS; s++) {
        const angle = (s / SPRING_DOME_SEGMENTS) * TWO_PI;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const baseV = domeBase + s;
        const midV = domeBase + SPRING_DOME_SEGMENTS + s;
        // Base ring: on the surface, full radius.
        domePositions[baseV * 3] =
          centreX + dirX * SPRING_DOME_RADIUS_CELLS * plotScale * CELL_WORLD_SIZE;
        domePositions[baseV * 3 + 2] =
          centreZ + dirZ * SPRING_DOME_RADIUS_CELLS * plotScale * CELL_WORLD_SIZE;
        domeRestOffsetY[baseV] = 0;
        // Mid ring: 45° up the dome profile.
        domePositions[midV * 3] =
          centreX +
          dirX * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * plotScale * CELL_WORLD_SIZE;
        domePositions[midV * 3 + 2] =
          centreZ +
          dirZ * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * plotScale * CELL_WORLD_SIZE;
        domeRestOffsetY[midV] = SPRING_DOME_HEIGHT_WORLD_UNITS * SPRING_DOME_MID_PROFILE;

        const sn = (s + 1) % SPRING_DOME_SEGMENTS;
        const baseVn = domeBase + sn;
        const midVn = domeBase + SPRING_DOME_SEGMENTS + sn;
        // Base→mid band.
        domeIndices[domeIndexWrite++] = baseV;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = midVn;
        // Mid→apex fan.
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = apex;
        domeIndices[domeIndexWrite++] = midVn;
      }
      domePositions[apex * 3] = centreX;
      domePositions[apex * 3 + 2] = centreZ;
      domeRestOffsetY[apex] = SPRING_DOME_HEIGHT_WORLD_UNITS;
      for (let v = domeBase; v < domeBase + domeVertsPerDome; v++) {
        domeSurfaceY[v] = surfaceY;
        domePhase[v] = domeSwellPhase;
        domePositions[v * 3 + 1] = surfaceY + domeRestOffsetY[v]!;
      }
    }

    const ringGeometry = new BufferGeometry();
    const ringPositionAttribute = new BufferAttribute(ringPositions, 3);
    ringPositionAttribute.setUsage(DynamicDrawUsage);
    ringGeometry.setAttribute('position', ringPositionAttribute);
    ringGeometry.setAttribute('normal', new BufferAttribute(ringNormals, 3));
    ringGeometry.setIndex(new BufferAttribute(ringIndices, 1));
    const ringMesh = new Mesh(ringGeometry, springRingMaterial);
    // The rings' animated radius means their static bounding sphere (computed
    // from birth-radius placeholder positions) would be wrong; the whole
    // effect is small and cheap enough that skipping culling is the honest
    // fix, and the dome mesh matches for consistency.
    ringMesh.frustumCulled = false;
    parent.add(ringMesh);

    const domeGeometry = new BufferGeometry();
    const domePositionAttribute = new BufferAttribute(domePositions, 3);
    domePositionAttribute.setUsage(DynamicDrawUsage);
    domeGeometry.setAttribute('position', domePositionAttribute);
    domeGeometry.setIndex(new BufferAttribute(domeIndices, 1));
    domeGeometry.computeVertexNormals();
    const domeMesh = new Mesh(domeGeometry, springDomeMaterial);
    domeMesh.frustumCulled = false;
    parent.add(domeMesh);

    spring = {
      ringMesh,
      ringGeometry,
      ringCentreX,
      ringCentreZ,
      ringDirX,
      ringDirZ,
      ringEdge,
      ringCycleOffset,
      ringPlotScale,
      domeMesh,
      domeGeometry,
      domeRestOffsetY,
      domeSurfaceY,
      domePhase,
    };
  };

  /**
   * Rebuilds every drop of river water in the network into ONE triangle soup.
   *
   * WATER IS ONE BODY, MARCHED PER BAND (2026-08-22, owner: "it still doesn't
   * look like continuous water. When going from one band to the next, there
   * needs to be no edges"). The rig used to build flowing water and pooled
   * water out of two different primitives — a fixed-width strip extruded along
   * a smoothed centre-line for channels, and a marched-and-smoothed region for
   * lakes. Two shape languages meeting along a curve that neither of them
   * owned is why no amount of lip-locating, cresting or tapering ever closed
   * the seam: it was structural, not a tuning error.
   *
   * So there is now ONE shape rule for all of it, and it is the terrain's own:
   *
   *   1. Collect every WET CELL in the network with the BAND its surface is
   *      drawn at — a flowing cell takes the band the terrain renders that
   *      tread at, a pooled cell takes its basin's spill band. A river is then
   *      simply a narrow flooded region.
   *   2. Group those cells BY BAND. Everything at one band is one region, so
   *      two pools that brim to the same level, and a channel that runs
   *      between them, are one outline with nothing to join. This is what
   *      deletes the whole class of pool-to-pool and channel-to-pool seams:
   *      they are no longer separate surfaces that have to meet.
   *   3. March, smooth and triangulate each region through the terrain's own
   *      pipeline (water/waterTread.ts) — the treatment lakes already had, and
   *      the one the owner stopped complaining about.
   *   4. Pour each region over its downstream lips with CURTAINS
   *      (water/waterCurtain.ts) cut from that region's OWN boundary loops —
   *      the arcs the tread already returned — as flat VERTICAL sheets, each
   *      running from the pool it hangs off straight down to the pool or
   *      ground it lands on. Nothing here models a surface beside the terrain:
   *      every water vertex, tread and curtain alike, is a number the
   *      terrain's own contour pipeline produced. That is the whole point of
   *      the change (docs/plans/water-painted-on-bands.md) — the apron this
   *      replaced derived its own heights from the cell lattice and 11,340 of
   *      84,073 vertices floated a full band.
   *
   *      CORRECTED 2026-08-24: this paragraph used to describe the curtain as
   *      "extruded down one band at a time and re-seated onto each level's own
   *      contour, exactly as capEmission.ts stacks one skirt per level". That
   *      was true of the staircase design, which the owner paused in favour of
   *      vertical sheets the same day — so the comment was asserting deleted
   *      code as present-tense fact. See waterCurtain.ts's header for the
   *      reasoning behind the pause.
   */
  const rebuild = (
    mirror: TerrainMirror,
    ground: DrawnGround,
    surface: RiverSurface,
    dirtyChunks: ReadonlySet<number> | null,
  ): void => {
    // PASS ONE: the surface band of every wet cell in the whole network,
    // before a single triangle is built. An outline can only be marched once
    // every cell under that water is known, and a cell's water can arrive from
    // more than one course (a fork rejoining the same pool contributes cells
    // from each arm).
    const worldSize = mirror.map.size;
    beginWetCells(worldSize * worldSize);
    const wetBand = wetCells.band;
    const wetStamp = wetCells.stamp;
    const wetList = surface.cells;
    const generation = wetCells.generation;
    // THE CHANGE LEDGER, opened before the table is stamped so the stamping walk
    // can fill it in passing.
    //
    // It answers "which chunks can the water have moved in", and it has TWO
    // sources. The TERRAIN moved wherever `dirtyChunks` says, which moves the
    // contours a region is marched and welded against. The WATER moved wherever
    // a cell entered, left or changed band, which moves the outline itself and —
    // because a curtain's foot lands on the water below it, not on the first
    // rock ledge — the falls of neighbouring regions too. Each is grown by one
    // ring of chunks, because a marching tile reads the border row it shares
    // with the tile next door and a curtain probes up to a cell outside its own
    // region.
    const affectedChunks = new Set<number>();
    const tileCols = chunksPerEdge(worldSize);
    const noteChunkAndNeighbours = (chunkIdx: number): void => {
      const chunkX = chunkIdx % tileCols;
      const chunkZ = (chunkIdx - chunkX) / tileCols;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = chunkX + dx;
          const nz = chunkZ + dz;
          if (nx < 0 || nz < 0 || nx >= tileCols || nz >= tileCols) continue;
          affectedChunks.add(nz * tileCols + nx);
        }
      }
    };
    const noteCell = (cell: number): void => {
      const x = cell % worldSize;
      noteChunkAndNeighbours(chunkIndexOfCell(worldSize, x, (cell - x) / worldSize));
    };
    if (dirtyChunks !== null) for (const chunkIdx of dirtyChunks) noteChunkAndNeighbours(chunkIdx);

    // The surface arrives already flattened and already deduplicated (the
    // network walk and the higher-water-wins rule both live in
    // water/riverSurface.ts, which is what the worker runs). All that is left
    // here is to stamp it into the table the rest of the rebuild reads — and,
    // in the same pass, to note every cell whose water is new or has moved.
    const previousBand = previousWetCells.band;
    const previousStamp = previousWetCells.stamp;
    const previousGeneration = previousWetCells.generation;
    for (let i = 0; i < wetList.length; i++) {
      const cell = wetList[i]!;
      const band = surface.bands[i]!;
      wetStamp[cell] = generation;
      wetBand[cell] = band;
      if (previousStamp[cell] !== previousGeneration || previousBand[cell] !== band) {
        noteCell(cell);
      }
    }
    // ...and every cell the water has LEFT, which the walk above cannot see.
    for (const cell of previousWetCells.list) {
      if (wetStamp[cell] !== generation) noteCell(cell);
    }
    wetCells.list = wetList;

    // PASS TWO: one region per band, plus the marching tiles it reaches.
    const regions = new Map<number, WaterRegion>();
    const lastCell = worldSize - 1;
    /** The band, region and tile range the previous cell used — see the run skips below. */
    let lastTileRange = -1;
    let lastTileBand = Number.NaN;
    let lastRegion: WaterRegion | undefined;
    for (const cell of wetList) {
      const band = wetBand[cell]!;
      // A course runs along one band for a stretch at a time, so the region of
      // the previous cell is almost always this cell's too — one comparison in
      // place of a Map lookup, ~24.5k times per rebuild at the trace ceiling.
      let region = band === lastTileBand ? lastRegion : regions.get(band);
      if (region === undefined) {
        region = {
          // Reads the table this pass just filled: a cell is under THIS
          // region's water when it is wet at all and its band is this one.
          isWet: (candidate) =>
            wetStamp[candidate] === generation && wetBand[candidate] === band,
          anchorCell: cell,
          surfaceBand: band,
          tiles: new Set<number>(),
        };
        regions.set(band, region);
      }
      lastRegion = region;
      const x = cell % worldSize;
      const y = (cell - x) / worldSize;
      // Every marching tile whose 17x17 lattice HOLDS this cell — its own and,
      // when it sits on a tile's first row or column, the neighbours whose
      // lattice ends on it. Those are exactly the tiles that can carry a
      // crossing on an edge of this cell, and a tile missed here would leave a
      // notch of unbuilt water at a tile border.
      //
      // WALKED AS A TILE RANGE, not as TILE_LATTICE_OFFSETS' sixteen cells: the
      // offsets span [-2, +1] on both axes, which is at most two tiles per axis
      // and one for almost every cell, so the cell walk asked `chunkIndexOfCell`
      // sixteen times to learn at most four answers. On a network at the trace
      // budget's own ceiling (MAX_SPRINGS_PER_NETWORK x
      // RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER x worldSize wet cells) that was
      // 400k calls per rebuild. Same tiles, named by their range instead.
      const tileXLo = Math.floor(Math.max(0, x + TILE_LATTICE_MIN_OFFSET) / CHUNK_SIZE);
      const tileXHi = Math.floor(Math.min(lastCell, x + TILE_LATTICE_MAX_OFFSET) / CHUNK_SIZE);
      const tileYLo = Math.floor(Math.max(0, y + TILE_LATTICE_MIN_OFFSET) / CHUNK_SIZE);
      const tileYHi = Math.floor(Math.min(lastCell, y + TILE_LATTICE_MAX_OFFSET) / CHUNK_SIZE);
      // A course walks cell by cell, so consecutive cells almost always name the
      // SAME tile range; naming it as one number lets the run be skipped.
      const tileRange =
        ((tileYLo * tileCols + tileXLo) * 2 + (tileXHi - tileXLo)) * 2 + (tileYHi - tileYLo);
      if (tileRange !== lastTileRange || band !== lastTileBand) {
        lastTileRange = tileRange;
        lastTileBand = band;
        for (let tileY = tileYLo; tileY <= tileYHi; tileY++) {
          for (let tileX = tileXLo; tileX <= tileXHi; tileX++) {
            region.tiles.add(tileY * tileCols + tileX);
          }
        }
      }
    }

    /** The band of the water standing at a cell, or null where it is dry. */
    const waterBandAt = (cellXCoord: number, cellYCoord: number): number | null => {
      if (cellXCoord < 0 || cellYCoord < 0 || cellXCoord >= worldSize || cellYCoord >= worldSize) {
        return null;
      }
      const cell = cellYCoord * worldSize + cellXCoord;
      return wetStamp[cell] === generation ? wetBand[cell]! : null;
    };

    /**
     * World Y of a water surface standing on a rendered terrace band, water
     * lift included.
     *
     * READ FROM THE ORACLE, not restated here. Until 2026-08-24 this called a
     * `drawnBandWorldY(band, seabed)` that re-derived capEmission's rule — and
     * passed `seabed: false` unconditionally, which is a guess the caller had
     * no business making. `capYOfBand` answers from the cap stack the chunk
     * really drew, so band 0's two levels resolve themselves and a blocky chunk
     * answers with the blocky height. The anchor cell is what makes that
     * possible, which is why every caller now has to supply one.
     */
    const bandWorldY = (band: number, cellXCoord: number, cellZCoord: number): number =>
      ground.capYOfBand(band, cellXCoord, cellZCoord) + RIVER_SURFACE_LIFT_WORLD_UNITS;

    // PASS THREE: re-emit only the regions that can have moved.
    for (const region of regions.values()) {
      if (dirtyChunks !== null && !regionNeedsReemit(region, affectedChunks)) continue;
      // Anchored at a cell the region actually covers, so band 0 resolves in
      // the chunk the water is really in. Regions are non-empty by
      // construction (they are created when their first cell is added).
      const anchorX = region.anchorCell % worldSize;
      const anchorZ = (region.anchorCell - anchorX) / worldSize;
      const surfaceY = bandWorldY(region.surfaceBand, anchorX, anchorZ);
      regionTriangles.length = 0;
      const loops = appendRegionSurface(mirror, region, surfaceY, regionTriangles);
      // The curtain asks the terrain where the ground is; it is not told, and
      // it is given no probe of ours to guess with. The apron needed two
      // callbacks here — a lower-water probe and a ground-height probe, both
      // re-deriving from the cell lattice — and those two derivations are the
      // defect this change deletes.
      // bandWorldY is handed over rather than re-derived, so the sheet's top
      // edge is the SAME NUMBER as the pool surface it hangs from and its foot
      // is the same number as the pool it lands in — which is what makes the
      // junctions welded rather than merely close.
      appendCurtains(
        ground,
        loops,
        region.surfaceBand,
        surfaceY,
        bandWorldY,
        waterBandAt,
        SEA_SURFACE_WORLD_Y,
        regionTriangles,
      );
      spliceRegion(region.surfaceBand, regionTriangles, regionTriangles.length / 3);
      emittedRegionTiles.set(region.surfaceBand, region.tiles);
    }

    // Regions that vanished — a band the water has left entirely — give their
    // run back. Collected first: `spliceRegion` mutates the order it walks.
    for (const band of Array.from(waterRunOrder)) {
      if (regions.has(band)) continue;
      spliceRegion(band, EMPTY_TRIANGLES, 0);
      emittedRegionTiles.delete(band);
    }

    waterMesh.geometry.setDrawRange(0, liveWaterVertices);
    waterPositionAttribute.needsUpdate = true;
    recomputeWaterBounds();

    // The foam belongs on the WATER, so the springs are told where the water
    // surface is rather than left to ask the ground — see the site loop.
    rebuildSprings(mirror, surface.sources, (x, y) => {
      const band = waterBandAt(x, y);
      return band === null ? null : bandWorldY(band, x, y);
    });
    // A rebuild leaves the rings' animated X/Z as placeholders — pose them
    // immediately so the effect is correct even if the frame handler never
    // runs again (prefers-reduced-motion: the spring holds THIS still frame,
    // exactly as the superseded mist held its rest pose).
    applySpringPose(elapsedSeconds);
  };

  /**
   * Writes one animation instant into the spring meshes' position buffers, in
   * place (house rule: no allocation here — every value comes from
   * SpringState's flat arrays).
   *
   * Rings: progress ∈ [0, 1) sweeps a ring's centre-line from birth to death
   * radius; the band's half-width follows sin(π·progress) so it is zero at
   * both ends (see the section comment). Only X/Z move — Y was final at
   * rebuild. Domes: only Y moves, scaled by the swell factor.
   */
  const applySpringPose = (seconds: number): void => {
    if (spring === null) return;

    const ringAttribute = spring.ringGeometry.getAttribute('position') as BufferAttribute;
    const ringArray = ringAttribute.array as Float32Array;
    const ringCycle = seconds / SPRING_RIPPLE_PERIOD_SECONDS;
    const radiusSpanCells = SPRING_RING_MAX_RADIUS_CELLS - SPRING_RING_MIN_RADIUS_CELLS;
    for (let i = 0; i < spring.ringEdge.length; i++) {
      const progress = (ringCycle + spring.ringCycleOffset[i]!) % 1;
      const centreLineRadiusCells = SPRING_RING_MIN_RADIUS_CELLS + radiusSpanCells * progress;
      const halfWidthCells = (SPRING_RING_MAX_WIDTH_CELLS * Math.sin(Math.PI * progress)) / 2;
      // edge 0 → inner (−halfWidth), edge 1 → outer (+halfWidth).
      const radiusWorld =
        (centreLineRadiusCells + (spring.ringEdge[i]! * 2 - 1) * halfWidthCells) *
        spring.ringPlotScale[i]! *
        CELL_WORLD_SIZE;
      ringArray[i * 3] = spring.ringCentreX[i]! + spring.ringDirX[i]! * radiusWorld;
      ringArray[i * 3 + 2] = spring.ringCentreZ[i]! + spring.ringDirZ[i]! * radiusWorld;
    }
    ringAttribute.needsUpdate = true;

    const domeAttribute = spring.domeGeometry.getAttribute('position') as BufferAttribute;
    const domeArray = domeAttribute.array as Float32Array;
    const swellAngle = (seconds / SPRING_DOME_SWELL_PERIOD_SECONDS) * TWO_PI;
    for (let i = 0; i < spring.domeRestOffsetY.length; i++) {
      const swell = 1 + SPRING_DOME_SWELL_FRACTION * Math.sin(swellAngle + spring.domePhase[i]!);
      domeArray[i * 3 + 1] = spring.domeSurfaceY[i]! + spring.domeRestOffsetY[i]! * swell;
    }
    domeAttribute.needsUpdate = true;
  };

  // The animation clock STOPS ADVANCING under prefers-reduced-motion (the
  // same pattern plugins/weather/client/index.ts documents on its own
  // `animationSeconds`), which is what lets the pose update below skip its
  // own reduced-motion branch: a frozen clock is a frozen `sin(...)`.
  const reducedMotion = watchReducedMotion();
  let elapsedSeconds = 0;
  const unregisterFrame = onFrame((dt: number) => {
    if (!reducedMotion.matches()) elapsedSeconds += dt;
    if (spring === null || reducedMotion.matches()) return;
    applySpringPose(elapsedSeconds);
  });

  // ── Requests, and how they coalesce ───────────────────────────────────────
  //
  // The network is computed somewhere else now (this thread with the direct
  // source, a worker with the real one), so a request and its rebuild are two
  // moments rather than one. Three rules keep that honest:
  //
  //   * ONE COMPUTE IN FLIGHT. A request made while one is running does not
  //     start a second — it marks "again when this finishes". A held stroke
  //     therefore costs one compute per answer, never a queue of them.
  //   * DIRTY ACCUMULATES. Every chunk named by every request since the last
  //     rebuild is remembered, so a request swallowed by the throttle or folded
  //     into an in-flight one still gets its chunks re-emitted.
  //   * AN ANSWER FOR A WORLD THAT NO LONGER EXISTS IS DROPPED. A rejoin
  //     replaces the mirror; a network traced through the previous session's
  //     heightmap describes rivers that are not there any more.

  /** Chunks named by requests since the last rebuild. */
  const pendingDirty = new Set<number>();
  /** True when a request asked for EVERYTHING, not just the dirty chunks. */
  let pendingEverything = false;
  /** The mirror and oracle the next rebuild should read. */
  let pendingMirror: TerrainMirror | null = null;
  let pendingGround: DrawnGround | null = null;
  /** The mirror the in-flight compute was requested against, or null when idle. */
  let computingFor: TerrainMirror | null = null;
  /** Set while a compute is in flight to mean "request again the moment it lands". */
  let recomputeWhenDone = false;
  /** Cleared by dispose(), so a promise that resolves afterwards touches nothing. */
  let disposed = false;

  const startCompute = (): void => {
    const mirror = pendingMirror;
    const ground = pendingGround;
    if (mirror === null || ground === null) return;
    if (computingFor !== null) {
      recomputeWhenDone = true;
      return;
    }
    computingFor = mirror;
    const dirty = pendingEverything ? null : new Set(pendingDirty);
    pendingDirty.clear();
    pendingEverything = false;

    const finish = (surface: RiverSurface): void => {
      computingFor = null;
      if (disposed) return;
      // The world was replaced while this was in flight. The answer describes
      // terrain that is gone; drop it and let the pending request (which the
      // replacement's own forceRefresh made) run against the new mirror.
      if (pendingMirror !== mirror) return;
      rebuild(mirror, ground, surface, dirty);
      if (recomputeWhenDone) {
        recomputeWhenDone = false;
        startCompute();
      }
    };

    const answer = networkSource.compute(mirror);
    if (answer instanceof Promise) void answer.then(finish);
    else finish(answer);
  };

  return {
    refresh(mirror: TerrainMirror, dirty: ReadonlySet<number>, ground: DrawnGround): void {
      pendingMirror = mirror;
      pendingGround = ground;
      for (const chunkIdx of dirty) pendingDirty.add(chunkIdx);
      const now = performance.now();
      if (now - lastRebuildMs < RIVER_RECOMPUTE_INTERVAL_MS) return;
      lastRebuildMs = now;
      startCompute();
    },

    forceRefresh(mirror: TerrainMirror, ground: DrawnGround): void {
      pendingMirror = mirror;
      pendingGround = ground;
      // EVERYTHING, not the accumulated dirty set: the one caller is a join or
      // rejoin, where the buffer may still hold the previous world's runs and
      // no dirty set describes the difference between two worlds.
      pendingEverything = true;
      lastRebuildMs = performance.now();
      startCompute();
    },

    dispose(): void {
      disposed = true;
      networkSource.dispose();
      unregisterFrame();
      reducedMotion.stop();
      parent.remove(waterMesh);
      waterMesh.geometry.dispose();
      waterMaterial.dispose();
      springRingMaterial.dispose();
      springDomeMaterial.dispose();
      if (spring !== null) {
        parent.remove(spring.ringMesh);
        parent.remove(spring.domeMesh);
        spring.ringGeometry.dispose();
        spring.domeGeometry.dispose();
      }
    },
  };
}
