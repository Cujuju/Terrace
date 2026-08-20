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
//   * ONE OWNER: everything this module creates is freed by its own
//     dispose().
//   * PHOTOSENSITIVITY: the mist bob is the only animated element here and it
//     STOPS under prefers-reduced-motion — the mist simply holds still,
//     mirroring weather's "the whole sky holds still" rule. There is nothing
//     here anywhere near that rule's actual concern (flashing light); this is
//     satisfied out of consistency with the house standard, not because a
//     pulsing mist puff was ever a flash risk.
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
  Points,
  PointsMaterial,
  type Object3D,
} from 'three';
import {
  chunkIndexOfCell,
  computeRiverNetwork,
  quantizeToBand,
  type RiverNetwork,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { WATER_COLOR } from './water.ts';

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

// ── Tile geometry ────────────────────────────────────────────────────────────

/**
 * Half-width, in cells, of a FLOWING channel tile. 0.3 → a tile 0.6 cells
 * wide, narrower than the 1-cell terrain grid so a stream reads as a channel
 * cut into the land rather than as a flooded row of whole cells.
 */
const FLOW_TILE_HALF_WIDTH_CELLS = 0.3;

/**
 * Half-width of a POOLED (lake) tile. 0.5 → a full 1×1 cell, so adjacent
 * pooled cells tile edge-to-edge into one continuous flat lake surface with
 * no gaps between them.
 */
const POOL_TILE_HALF_WIDTH_CELLS = 0.5;

/**
 * How far above the terrain a flowing tile is lifted, in world units — the
 * same role WATER_SURFACE_LIFT plays for the sea (render/water.ts): without
 * it a tile sitting exactly at the band-quantised ground height z-fights the
 * terrain mesh it is drawn over. Half of WATER_SURFACE_LIFT's own margin: a
 * river tile is small and always drawn a beat after the terrain it follows,
 * so it needs less clearance than the sea's single world-spanning plane.
 */
const RIVER_SURFACE_LIFT_WORLD_UNITS = CELL_WORLD_SIZE / 64;

/** Translucency for the flowing channel — a shade more opaque than the sea. */
const FLOW_OPACITY = 0.72;
/** Pooled water reads calmer/deeper: a touch more opaque again. */
const POOL_OPACITY = 0.8;

const RIVER_ROUGHNESS = 0.85;
const RIVER_METALNESS = 0;

/** Builds one XZ-plane quad centred at the origin, `halfWidth` cells to a side. */
function buildTileGeometry(halfWidth: number): BufferGeometry {
  const positions = new Float32Array([
    -halfWidth, 0, -halfWidth,
    halfWidth, 0, -halfWidth,
    halfWidth, 0, halfWidth,
    -halfWidth, 0, -halfWidth,
    halfWidth, 0, halfWidth,
    -halfWidth, 0, halfWidth,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Builds ONE merged, non-indexed geometry from a set of tile centres — every
 * tile is `unitGeometry`'s six vertices translated to its own (x, y, z).
 * Rebuilt wholesale on every recompute (see the module header on why that is
 * an acceptable cost here) rather than patched in place: unlike terrain,
 * river tiles are not identified by a stable index a diff can address — the
 * whole SET can change shape (a new spring, a rerouted course) on any edit.
 */
function buildMergedTiles(
  unitGeometry: BufferGeometry,
  centres: ReadonlyArray<readonly [x: number, y: number, z: number]>,
): BufferGeometry {
  const unit = unitGeometry.getAttribute('position') as BufferAttribute;
  const verticesPerTile = unit.count;
  const positions = new Float32Array(centres.length * verticesPerTile * 3);
  let write = 0;
  for (const [cx, cy, cz] of centres) {
    for (let v = 0; v < verticesPerTile; v++) {
      positions[write++] = unit.getX(v) + cx;
      positions[write++] = unit.getY(v) + cy;
      positions[write++] = unit.getZ(v) + cz;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ── Waterfall mist ───────────────────────────────────────────────────────────

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

interface MistState {
  readonly object: Points;
  readonly geometry: BufferGeometry;
  /** Each particle's rest Y and a phase offset, so puffs don't bob in lockstep. */
  readonly baseY: Float32Array;
  readonly phase: Float32Array;
}

// ── The rig ──────────────────────────────────────────────────────────────────

export interface RiverRig {
  /**
   * Recomputes the river network from the mirror's CURRENT terrain and
   * rebuilds every tile/mist puff — throttled internally to
   * RIVER_RECOMPUTE_INTERVAL_MS, so calling this from every terrainDiff (as
   * client/src/world.ts does, alongside the terrain mesh patch) costs nothing
   * extra: most calls are a no-op elapsed-time check.
   */
  refresh(mirror: TerrainMirror): void;
  /**
   * Rebuilds immediately, bypassing the throttle, and resets it so the next
   * ordinary `refresh` call is timed from now. For the ONE case a throttle is
   * wrong: a fresh join or rejoin (client/src/world.ts's onSnapshot), where
   * `mirror` is a brand-new session's and the previous session's tiles must
   * not be left on screen for up to RIVER_RECOMPUTE_INTERVAL_MS just because
   * this rig happened to recompute recently for a DIFFERENT world. Every
   * other caller wants the throttle — see `refresh`.
   */
  forceRefresh(mirror: TerrainMirror): void;
  dispose(): void;
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

export function createRiverRig(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
): RiverRig {
  const flowUnit = buildTileGeometry(FLOW_TILE_HALF_WIDTH_CELLS);
  const poolUnit = buildTileGeometry(POOL_TILE_HALF_WIDTH_CELLS);

  const flowMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: FLOW_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false, // see render/water.ts: lets submerged/underlying terrain show through
    side: DoubleSide,
  });
  const poolMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: POOL_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
  });

  const flowMesh = new Mesh(new BufferGeometry(), flowMaterial);
  const poolMesh = new Mesh(new BufferGeometry(), poolMaterial);
  parent.add(flowMesh);
  parent.add(poolMesh);

  const mistMaterial = new PointsMaterial({
    color: MIST_COLOR,
    size: MIST_SPRITE_SIZE,
    sizeAttenuation: true,
    transparent: true,
    opacity: MIST_OPACITY,
    depthWrite: false,
  });
  let mist: MistState | null = null;

  let lastRebuildMs = Number.NEGATIVE_INFINITY;

  /** Band-quantised render height, in world Y units, for one mirror cell. */
  const quantizeToBandWorldY = (mirror: TerrainMirror, x: number, y: number): number =>
    quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;

  /**
   * Rebuilds the mist puffs from scratch — one small ring of particles per
   * waterfall, spread evenly around its plunge point (`angle`) and staggered
   * in height (`p % 4`) so the puff reads as a volume rather than a flat
   * disc. `phase` is assigned by the particle's position in the WHOLE mist
   * buffer (not per-puff) purely so no two puffs bob in visible lockstep.
   */
  const rebuildMist = (mirror: TerrainMirror, network: RiverNetwork): void => {
    if (mist !== null) {
      parent.remove(mist.object);
      mist.geometry.dispose();
      mist = null;
    }

    const waterfalls = network.rivers.flatMap((river) => river.waterfalls);
    if (waterfalls.length === 0) return;

    const count = waterfalls.length * MIST_PARTICLES_PER_WATERFALL;
    const positions = new Float32Array(count * 3);
    const baseY = new Float32Array(count);
    const phase = new Float32Array(count);

    let write = 0;
    let particle = 0;
    for (const waterfall of waterfalls) {
      const plungeY =
        quantizeToBandWorldY(mirror, waterfall.x, waterfall.y) + RIVER_SURFACE_LIFT_WORLD_UNITS;
      for (let p = 0; p < MIST_PARTICLES_PER_WATERFALL; p++) {
        const angle = (p / MIST_PARTICLES_PER_WATERFALL) * TWO_PI;
        const y = plungeY + MIST_HEIGHT_WORLD_UNITS * ((p % 4) / 4);
        positions[write++] = waterfall.x * CELL_WORLD_SIZE + Math.cos(angle) * MIST_SPREAD_CELLS;
        positions[write++] = y;
        positions[write++] = waterfall.y * CELL_WORLD_SIZE + Math.sin(angle) * MIST_SPREAD_CELLS;
        baseY[particle] = y;
        phase[particle] = (particle / count) * TWO_PI;
        particle++;
      }
    }

    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3);
    attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    const object = new Points(geometry, mistMaterial);
    parent.add(object);
    mist = { object, geometry, baseY, phase };
  };

  const rebuild = (mirror: TerrainMirror): void => {
    const network = computeRiverNetwork(mirror.map, {
      isActive: (x, y) => mirror.received.has(chunkIndexOfCell(mirror.map.size, x, y)),
    });

    const flowCentres: Array<readonly [number, number, number]> = [];
    const poolCentres: Array<readonly [number, number, number]> = [];
    for (const river of network.rivers) {
      for (const point of river.points) {
        const worldX = point.x * CELL_WORLD_SIZE;
        const worldZ = point.y * CELL_WORLD_SIZE;
        if (point.pooled) {
          const surfaceY = (point.poolHeight ?? 0) * HEIGHT_WORLD_SCALE + RIVER_SURFACE_LIFT_WORLD_UNITS;
          poolCentres.push([worldX, surfaceY, worldZ]);
        } else {
          const groundY = quantizeToBandWorldY(mirror, point.x, point.y) + RIVER_SURFACE_LIFT_WORLD_UNITS;
          flowCentres.push([worldX, groundY, worldZ]);
        }
      }
    }

    const nextFlow = buildMergedTiles(flowUnit, flowCentres);
    flowMesh.geometry.dispose();
    flowMesh.geometry = nextFlow;

    const nextPool = buildMergedTiles(poolUnit, poolCentres);
    poolMesh.geometry.dispose();
    poolMesh.geometry = nextPool;

    rebuildMist(mirror, network);
  };

  // The animation clock STOPS ADVANCING under prefers-reduced-motion (the
  // same pattern plugins/weather/client/index.ts documents on its own
  // `animationSeconds`), which is what lets the bob below skip its own
  // reduced-motion branch: a frozen clock is a frozen `sin(...)`.
  const reducedMotion = watchReducedMotion();
  let elapsedSeconds = 0;
  const unregisterFrame = onFrame((dt: number) => {
    if (!reducedMotion.matches()) elapsedSeconds += dt;
    if (mist === null || reducedMotion.matches()) return;
    const attribute = mist.geometry.getAttribute('position') as BufferAttribute;
    const bobHz = 1 / MIST_BOB_PERIOD_SECONDS;
    for (let i = 0; i < mist.baseY.length; i++) {
      const bob = Math.sin(elapsedSeconds * bobHz * TWO_PI + mist.phase[i]!) * MIST_BOB_HEIGHT_WORLD_UNITS;
      attribute.setY(i, mist.baseY[i]! + bob);
    }
    attribute.needsUpdate = true;
  });

  return {
    refresh(mirror: TerrainMirror): void {
      const now = performance.now();
      if (now - lastRebuildMs < RIVER_RECOMPUTE_INTERVAL_MS) return;
      lastRebuildMs = now;
      rebuild(mirror);
    },

    forceRefresh(mirror: TerrainMirror): void {
      lastRebuildMs = performance.now();
      rebuild(mirror);
    },

    dispose(): void {
      unregisterFrame();
      reducedMotion.stop();
      parent.remove(flowMesh);
      parent.remove(poolMesh);
      flowMesh.geometry.dispose();
      poolMesh.geometry.dispose();
      flowUnit.dispose();
      poolUnit.dispose();
      flowMaterial.dispose();
      poolMaterial.dispose();
      mistMaterial.dispose();
      if (mist !== null) {
        parent.remove(mist.object);
        mist.geometry.dispose();
      }
    },
  };
}
