// Per-chunk terrain meshes and the in-place vertex patch path.
//
// CRITICAL CODE — the client performance contract (design doc): mesh updates
// patch vertex buffers in place, never rebuild geometry per edit. A chunk's
// BufferGeometry and its Float32Array attributes are allocated once, when its
// data first arrives, and live until the world is replaced. A terrain diff
// rewrites the affected chunks' position/normal/colour arrays and flips
// `needsUpdate`; it never re-adds anything to the scene graph.
//
// BUFFER STRATEGY (2026-08-14). The old builder had a tight worst case (768
// quads/chunk); the organic builder's triangle count ranges from ~10 (flat
// chunk) to tens of thousands (full ±16 bands, wiggly contours on every one).
// Preallocating for the worst case is 24 MB/chunk (600 MB for a fully
// revealed 512² world) to serve chunks that overwhelmingly need 1% of it.
//
// CHOSEN instead: preallocate a working capacity, draw a prefix with
// setDrawRange, and grow (doubling) on overflow. Chunks start at
// INITIAL_CHUNK_TRIANGLE_CAPACITY (1024 triangles = 110 KB) and reallocate
// only on the edit that first exceeds it; capacity never shrinks, so every
// patch after convergence is pure array writes.
//
// AGAINST THE HELD-SCULPT BUDGET. A held brush emits ~8 intents/s across up
// to 4 chunks (radius-4), so ~32 patches/s — one every other frame at 60fps.
// Per patch on a typical 4-band chunk: sampling/marching ~1k evaluations,
// smoothing, ear-clip triangulation O(n²) on n≈150, ~40k buffer stores — same
// order as the old builder, landing on ~4% of frames. Growth events are the
// only spike, at most log2(capacity) of them per chunk ever.
//
// GARBAGE, named rather than hidden: the contour pipeline allocates ~100 KB
// of short-lived point objects per rebuild (~3 MB/s at 32 patches/s) —
// nursery traffic a generational GC scavenges without promoting. What must
// hold absolutely: no GPU buffer is respecified mid-stroke, since a
// driver-side respec is what shows up as a frame spike rather than a lower average.
//
// MEMORY at rest: 111 bytes/triangle (3 unshared vertices × 9 floats + a
// one-byte self-lit flag — see SELF_LIT_ATTRIBUTE). Non-indexed is
// deliberate: every triangle owning its own vertices is what gives flat
// shading a hard crease at every cap/skirt boundary.
//
// QUEUE → JOB → SPLICE (issue #47, 2026-08-20; build moved off-thread
// 2026-08-28). `update` marks chunks dirty in a queue; a frame hook submits
// what the build source has room for and splices answers under a wall-clock
// budget (CHUNK_SPLICE_FRAME_BUDGET_MS). A chunk still waiting keeps drawing
// its previous mesh — stale by a frame or two, never absent.
//
// WHERE THE WORK IS. Marching, smoothing, triangulating, the cap plan and
// band raster live in render/chunkBuildSource.ts (a worker pool on the
// client). A frame pays only for the splice: placing the run in the
// super-mesh's arena (spliceChunk), the chart publish, and `onChunkDrawn`
// (~1 ms on a developed super-mesh) — hence a splice budget, not a build
// budget. A separate budget pays for compaction on the same frame
// (ARENA_COMPACT_STROKE_BUDGET_MS).
//
// WHY IT COSTS NO LATENCY. Frame callbacks run before `renderer.render`
// (scene.ts's renderFrame), so a sculpt between two frames draws on the very
// next one, plus the worker job's own ~6 ms.
//
// WHAT IT FIXES. A radius-4 brush straddling four chunks used to rebuild all
// four inside one `update` call, costs adding: ~9 ms each (capEmission.ts's
// budget table) made a ~36 ms frame. Spreading them across frames removed the
// compounding; moving the build off-thread removed the remaining floor —
// the cost of one chunk, not resumable mid-chunk. What's left here is a splice.
//
// A CHART IS PUBLISHED BY THE SPLICE, NOT BY `update`. Everything reading
// what a chunk drew (drawnGroundStore.ts's charts, the lip overlay, the river
// rig, the sea's curtains) must be driven by `onChunkDrawn`, not the dirty
// set — the dirty set reads the pre-edit chart for any chunk not yet landed.
// See world.ts's applyDirty.
//
// NO FRAME HOOK, NO DEFERRAL. `createTerrainMeshes` takes the scheduler as an
// option and falls back to `flush` inside `update` when absent — deferring
// to a later frame is meaningless with no frame loop, so a caller with none
// (the headless suite, anything wanting the world complete before looking)
// gets synchronous behaviour. Such a caller is on the direct build source by
// definition, so `update` there both builds and publishes before returning.
//
// DRAW-CALL TRADEOFF, accepted for v1: one mesh per 16×16 chunk means a fully
// revealed 512² world is 1024 draw calls. Worlds start small and grow
// slowly, and per-chunk meshes make streaming and locked-chunk omission
// trivial — an unreceived chunk has no mesh, so it can't be drawn or picked.
// The Phase 2+ fix, if measurement demands it, is merging chunks into larger
// super-meshes while keeping the same patch path.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
import { chunksPerEdge } from '@terrace/shared';
import { SCULPT_REPEAT_DELAY_MS } from '../config.ts';
import {
  createDirectChunkBuildSource,
  type ChunkBuildSource,
} from './chunkBuildSource.ts';
import type { ChunkJobAnswer } from '../terrain/chunkJob.ts';
import { type Rgb } from '../terrain/bandColors.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/vertexGrid.ts';
import {
  createDrawnGroundStore,
  type DrawnGroundStore,
} from '../terrain/drawnGroundStore.ts';
import { spliceShader } from './shaderSplice.ts';
import { applyGroundShade } from './groundShade.ts';

/**
 * How long a frame may spend splicing finished chunk jobs, in ms.
 *
 * 1.5, about a fifth of a 140 fps frame's 7.1 ms. Replaced
 * CHUNK_BUILD_FRAME_BUDGET_MS (4 ms) when the build moved to a worker: a
 * frame now only copies a finished answer into its super-mesh (~1 ms on a
 * developed super-mesh), not marches/triangulates it.
 *
 * At ~1 ms this is roughly one splice per frame, and "always splices at
 * least one" is a floor on progress, not a ceiling on cost — a radius-4
 * brush straddling two chunks lands over two frames.
 */
export const CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5;

/**
 * What one vertex costs to get onto the GPU, in ms — the rate the
 * compaction budgets below are denominated in.
 *
 * MEASURED 2026-08-28 (RTX 3090, Chrome/ANGLE; docs/plans/vertex-arena-no-tail-move.md
 * §1): a frame uploading 19-21 MB of vertex attributes spent 3.5-12 ms in
 * `bufferSubData` plus roughly as much again stalled on the next frame —
 * ~1 ms/MB all in. A vertex is 19 bytes (see `createChunkGeometryBuffers`).
 *
 * An estimator, not a clock: compaction decides whether it can afford a move
 * BEFORE making it.
 */
export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

/**
 * How much transfer compaction may schedule on a frame that also spliced, in ms.
 *
 * 1.0. The 140 fps bar gives a frame 7.1 ms; measured, that frame already
 * owes ~1.7 ms idle render + 1.5 ms splice + ~0.5 ms plugins = 3.7 ms. Of the
 * 3.4 ms left, half is held back since a transfer bills roughly its own cost
 * again as GPU-process backpressure the frame after (§1) — leaving 1.7,
 * rounded down to 1.0. That moves up to ~52k vertices, above the owner's
 * world's p90 chunk (38.8k).
 */
export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

/**
 * Same arithmetic for a frame that spliced nothing: 7.1 - 1.7 render -
 * 0.5 plugins = 4.9, halved for backpressure, rounded down to 3.
 *
 * Moves any run on the owner's world (max 142k vertices ≈ 2.7 ms). A chunk
 * at CHUNK_TRIANGLE_BUDGET (393k vertices ≈ 7.5 ms) wouldn't fit even here —
 * named residual in plan §5: that hole waits until its run itself changes size.
 */
export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

/**
 * The p90 chunk run on the owner's world, in triangles.
 *
 * MEASURED 2026-08-29 from `arenaLayout()` over 400 streamed chunks
 * (docs/plans/frame-budget-growth-and-draw-calls.md §A3): p90 is 40,959
 * vertices = 13,653 triangles.
 *
 * In triangles, not vertices, since `createChunkGeometryBuffers` and
 * `ensureSuperCapacity` are denominated in triangles and every arena offset
 * is a multiple of VERTICES_PER_TRIANGLE.
 */
const ARENA_P90_RUN_TRIANGLES = 13_653;

/**
 * How many of a super-mesh's own largest run its headroom must absorb
 * without reallocating.
 *
 * TWO. A regrow appends at most one new run of about the old run's size
 * while the old run is still live, and a brush straddles two chunks per
 * step — one run's slack isn't enough, and three buys nothing extra.
 */
export const ARENA_HEADROOM_RUN_MULTIPLE = 2;

/**
 * The floor under a super-mesh's headroom, in triangles: two p90 runs.
 *
 * `ARENA_HEADROOM_RUN_MULTIPLE × largest run` is measured against what a
 * super-mesh has already drawn; a barely-revealed one has drawn almost
 * nothing (its largest run is a flat chunk's six vertices), so the rule
 * alone gives it no real slack. The floor sizes it for the run it's likely
 * to get next instead.
 */
export const ARENA_HEADROOM_FLOOR_TRIANGLES =
  ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES;

/**
 * How long the terrain must go without an `update` before a super-mesh may
 * be grown, in ms.
 *
 * Twice SCULPT_REPEAT_DELAY_MS (400 ms): a held brush's slowest gap between
 * intents is its first repeat, after which the interval ramps down to
 * SCULPT_REPEAT_INTERVAL_MS. One delay would let a slow first repeat read as
 * a lifted brush; two is margin enough that it can't.
 */
export const TERRAIN_QUIET_MS = 2 * SCULPT_REPEAT_DELAY_MS;

/** Terrain is dielectric; a little roughness variation is not worth a map. */
const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/** Name of the per-vertex self-lit attribute, shared by the geometry (writes it) and the shader patch below (reads it) — one string so a rename can't silently unbind it. */
const SELF_LIT_ATTRIBUTE = 'selfLit';

/**
 * Makes the terrain material honour that attribute: a vertex flagged
 * SELF_LIT is shaded as its own colour and nothing else.
 *
 * WHY (owner, 2026-08-14, low-angle screenshot). Underwater terrace seams
 * are outlined by a brightened silt rim on each skirt (bandColors.ts). A
 * skirt is vertical under a single directional sun + hemisphere fill, so
 * faces away from the sun read from overhead but disappear at a low camera —
 * a lighting dependence only the shading stage can remove.
 *
 * WHAT IT DOES. `outgoingLight` is the fragment's fully accumulated radiance
 * just before `<opaque_fragment>` in three's meshphysical shader;
 * `diffuseColor.rgb` there is the palette entry in linear space. Mixing by
 * the flag replaces lit shading with the raw palette entry for flagged
 * vertices only. Injected BEFORE `<opaque_fragment>`, so tone mapping,
 * colour space and fog still apply — a rim still fogs at distance, it just
 * never darkens for facing the wrong way. Verified against three 0.185's
 * meshphysical.glsl.js include order (opaque → tonemapping → colorspace → fog).
 *
 * WHY NOT A SECOND MATERIAL. `addGroup` with an unlit MeshBasicMaterial costs
 * a second draw call on every chunk with underwater geometry — every chunk,
 * since a Terrace world starts as ocean — doubling a fully revealed world's
 * 1024 draw calls, and would force rim triangles into one contiguous range
 * the level-by-level builder doesn't naturally produce. One byte + one line
 * of GLSL costs neither.
 *
 * WHY NOT FAKE THE NORMALS. flatShading derives its normal from screen-space
 * derivatives, ignoring any attribute, so faking normals would first require
 * dropping flatShading, and would still tie rim brightness to the light rig.
 * Treats the symptom, not the cause.
 */
function makeSelfLitAware(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        `#include <common>\nattribute float ${SELF_LIT_ATTRIBUTE};\nvarying float vSelfLit;`,
        'terrain',
      ),
      '#include <begin_vertex>',
      `vSelfLit = ${SELF_LIT_ATTRIBUTE};\n#include <begin_vertex>`,
      'terrain',
    );
    // The colour attribute arrives as sRGB bytes; three assumes vertex colour
    // is already linear. Decoded here with the exact sRGB EOTF (not the
    // 2.2-gamma approximation, since the deep ramp lives where they disagree most).
    shader.vertexShader = spliceShader(
      shader.vertexShader,
      '#include <color_vertex>',
      `#include <color_vertex>
      vColor.rgb = mix(
        vColor.rgb / 12.92,
        pow( ( vColor.rgb + 0.055 ) / 1.055, vec3( 2.4 ) ),
        step( vec3( 0.04045 ), vColor.rgb )
      );`,
      'terrain',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        '#include <common>\nvarying float vSelfLit;',
        'terrain',
      ),
      '#include <opaque_fragment>',
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );\n#include <opaque_fragment>',
      'terrain',
    );
  };
}

/**
 * SUPERSEDED 2026-08-20, kept as the record of what this file used to do.
 *
 * Converting sRGB palette entries to linear once here (rather than per
 * vertex per patch) ended when vertex-format compression made the colour
 * buffer bytes: the deep ramp half didn't survive quantising in linear (28
 * of 64 blue-column stops collapsed into ties, vs zero in sRGB — measured).
 * sRGB values now go to the GPU untouched and `<color_vertex>` decodes them.
 */
function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

/**
 * Chunks per super-mesh edge — the merge factor of this module's 2026-08-21 rewrite.
 *
 * WHY MERGE AT ALL. A chunk is the sync payload, the reveal quantum, and —
 * until now — the draw quantum; the third was an accident of the first two
 * and the one that costs. Measured on a live day-one world: 400 terrain
 * meshes drawing 19,000 triangles, ~34 triangles/draw call where a modern
 * renderer carries thousands. A fully revealed 2048² world would be 16,384
 * draw calls — more submission work than a AAA frame drawing a thousand
 * times the geometry. Draw calls are CPU work that scales with world
 * revealed, not with what's on screen.
 *
 * EIGHT. A super-mesh covers 8 × CHUNK_SPAN = 32 world units; a default
 * 512-unit map is 256 super-meshes instead of 16,384 meshes (a 64x cut).
 * Trades two things:
 *   - CULLING GRANULARITY. Too large a merge stops culling from doing
 *     anything; 32 world units is well under CAMERA_INITIAL_DISTANCE (80),
 *     so the horizon still culls.
 *   - EDIT COST. A sculpt re-packs the tail of one super-mesh (spliceChunk),
 *     so the memmove grows with the square of this number.
 * Raise it if draw calls are still the bottleneck; lower it if a pan starts
 * submitting off-camera geometry. Both measurable via `drawCallCount()` and renderer.info.
 */
export const SUPER_MESH_SPAN_CHUNKS = 8;

/** Non-indexed geometry: three vertices per triangle, never shared. */
const VERTICES_PER_TRIANGLE = 3;

/**
 * Where one chunk's vertices live inside its super-mesh's packed buffers.
 *
 * The chunk is still the unit of BUILDING (what a sculpt invalidates), but
 * no longer the unit of DRAWING.
 */
interface ChunkSlot {
  /** First vertex of this chunk's run, as an index into the packed buffers. */
  offset: number;
  /** Live vertices in the run. Moves on every rebuild that changes a contour. */
  count: number;
  /**
   * The run's own axis-aligned bounds, world units — measured once over the
   * vertices the chunk was just emitted with.
   *
   * Kept per slot rather than recomputed from all vertices on every splice:
   * scanning the whole super-mesh (1.25M vertices on the busiest one, ~14ms)
   * for a 4.5k-vertex edit would be wasteful. The super-mesh's bound is the
   * union of at most SUPER_MESH_SPAN_CHUNKS² = 64 boxes.
   *
   * Meaningless while `count` is 0 (min > max); the union skips those slots.
   */
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * A run of dead vertices inside a super-mesh's arena, in vertices.
 *
 * Zeroed in all four attributes: three zero positions are a zero-area
 * triangle at the origin (no fragments, and `Ray.intersectTriangle` rejects
 * it via `DdN === 0`). Costs 7 of 19 bytes per hole vertex for one
 * recognisable "dead" byte pattern — a deliberate trade.
 */
interface Hole {
  offset: number;
  length: number;
}

/** Per-super-mesh arena occupancy — see `TerrainMeshes.arenaStats`. */
export interface ArenaStats {
  /** The arena's EXTENT: the draw range, and where an append lands. */
  liveEnd: number;
  /** The sum of the slot counts — what is actually drawn geometry. */
  liveCount: number;
  /** `liveEnd - liveCount`; equal to the total length of the free list. */
  deadVertices: number;
  holeCount: number;
  /** How many times these buffers have been reallocated (a full `bufferData`). */
  growths: number;
  /**
   * The subset of `growths` taken DURING A SPLICE — every one `settle` did not schedule.
   *
   * A DELTA, not a total: streaming a world climbs the doubling ladder over
   * a reveal (accepted, off-stroke), while a stroke outrunning its headroom
   * reallocates on a frame the player is watching (issue #229). Nothing else
   * distinguishes them — only WHEN it happened does — so this number is
   * expected to hold steady across a stroke; the bench/probe report it before and after one.
   */
  strokeGrowths: number;
}

/** Per-super-mesh arena layout — see `TerrainMeshes.arenaLayout`. */
export interface ArenaLayout {
  slots: { chunkIdx: number; offset: number; count: number }[];
  holes: { offset: number; length: number }[];
}

/**
 * One drawn object: the merged geometry of a SUPER_MESH_SPAN_CHUNKS square of
 * chunks — an ARENA of runs, one per chunk, in no particular order.
 */
interface SuperMesh {
  mesh: Mesh;
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  selfLitAttribute: BufferAttribute;
  slots: Map<number, ChunkSlot>;
  /**
   * The dead runs between the live ones, sorted by offset and coalesced,
   * every offset/length a multiple of VERTICES_PER_TRIANGLE. Bounded by one
   * hole per run plus one.
   *
   * Maintained by exactly one insert/take pair (`insertHole`/`takeHole`) so
   * "sorted", "coalesced", "aligned" and the retreat rule are properties of
   * the LIST, not things every caller must remember.
   */
  holes: Hole[];
  /** The arena's extent: one past the highest live vertex, and the geometry's draw range. At least the sum of the slot counts. */
  liveEnd: number;
  /**
   * True once these buffers have been reallocated during the current drain
   * pass, reset by the frame hook (or `flush`).
   *
   * A FLAG, not a return value: `bindGeometry` installs brand-new
   * BufferAttributes, and three's create path takes a full `bufferData`
   * WITHOUT clearing `updateRanges` (only `updateBuffer` does), so any range
   * added later in the same pass would double-upload next frame. The packed
   * layout had one range producer per pass and could carry this locally; the
   * arena has two (splices and compaction), so it lives on the super-mesh.
   *
   * Written only by `bindGeometry` — a caller that binds without setting it
   * reintroduces the double upload. Starts `false` because `createSuperMesh`
   * binds immediately after, which sets it.
   */
  reallocatedThisPass: boolean;
  /** How many times the buffers have been reallocated — reported by arenaStats. */
  growths: number;
  /** Of those, the ones taken during a splice — see `ArenaStats.strokeGrowths`. */
  strokeGrowths: number;
}

/**
 * Which seam a capacity growth was taken from — see
 * docs/plans/frame-budget-growth-and-draw-calls.md part A.
 *
 * Required at every callsite rather than defaulted, so a future call can't
 * be miscounted as planned growth by omission.
 */
type GrowthSite =
  /** Inside `spliceChunk`, i.e. inside a stroke. Counted in `strokeGrowths`. */
  | 'splice'
  /** From `settle`, on a quiet frame. The growth the headroom rule schedules. */
  | 'settle';

/** How the builder gets its frames. Absent means "there are none" — see the module header's NO FRAME HOOK note for why that is a real mode, not test-only. */
export interface MeshScheduling {
  /** Registers a per-frame handler and returns its unsubscribe. */
  onFrame: (handler: (dt: number) => void) => () => void;
  /** Monotonic ms clock the drain budget is measured against. Injectable for tests; defaults to `performance.now`. */
  now?: () => number;
}

/** See `TerrainMeshes.settle`. */
export interface SettleOptions {
  /**
   * Skips the "no `update` for TERRAIN_QUIET_MS" half of the quiet test,
   * because the CALLER knows the terrain is done.
   *
   * WHY. A caller with no frame hook runs
   * `update(everything); flush(); settle();` in one synchronous turn, so the
   * timestamp gate would decide based on how long the build happened to
   * take — a wall-clock race in exactly the harnesses meant to be a finished
   * world.
   *
   * SKIPS THE TIMESTAMP GATE ONLY. The queue test (no chunk of this
   * super-mesh pending/inFlight/ready/retry) still applies — growing a
   * super-mesh about to be spliced into would pay a second full
   * `bufferData`. The caller may assert no more work is coming, never that
   * queued work is done.
   *
   * A named option, not a positional boolean: `settle(true)` says nothing
   * about what's being asserted.
   */
  readonly assumeQuiet?: boolean;
}

export interface TerrainMeshes {
  /**
   * Marks the given chunks for rebuild. Indices for chunks the mirror has
   * not received are ignored — the mechanism by which locked terrain stays invisible.
   *
   * Builds nothing itself with a frame hook supplied; the queue drains on
   * frames under a budget. Without one, this drains inline.
   *
   * A chunk marked twice before it's built is built ONCE, from the mirror's
   * state at drain time — a held stroke re-dirtying the same chunk eight
   * times a second costs one rebuild per frame, always the newest heights.
   */
  update(dirty: Iterable<number>): void;
  /** Builds every queued chunk now, whatever the budget says. */
  flush(): void;
  /**
   * Gives one quiet super-mesh the free capacity it's short of, so a later
   * stroke doesn't have to reallocate (issue #229).
   *
   * Run from the frame hook after splices and compaction. Public because
   * paths with no frame hook (preview harnesses, bench, tests) build their
   * world and stop, and only they can name "the terrain has gone quiet".
   * Safe and a no-op while the terrain is busy.
   *
   * Deliberately NOT called by `flush` — see the implementation.
   */
  settle(options?: SettleOptions): void;
  /** Chunks marked dirty and not yet drawn: queued, out at the build source, answered awaiting splice, or waiting retry after a lost build. */
  pendingCount(): number;
  /** Drops every mesh — used when a fresh join replaces the world. */
  clear(): void;
  /**
   * The drawn meshes — one per super-mesh, not one per chunk.
   *
   * Named for the raycasting it used to serve; nothing raycasts terrain any
   * more (picking marches the height field — terrain/picking.ts). Survives
   * for the differential test pinning that march against the old mesh, and
   * for tests inspecting the geometry actually submitted.
   */
  pickables(): Mesh[];
  /**
   * What the terrain has drawn, chunk by chunk — published by
   * `writeChunkVertexData` as each chunk builds (drawnGroundStore.ts).
   *
   * Owned here because the emitter is here: the same call writes an entry
   * and its vertices, and replaces both together — letting a reader
   * (terrain/drawnGround.ts) hold one for the mirror's whole lifetime rather
   * than invalidating by hand. Cleared by `clear()` with the meshes it describes.
   */
  drawnGround(): DrawnGroundStore;
  /**
   * Registers a handler run immediately after one chunk has been built and
   * its chart published; returns its unsubscribe.
   *
   * WHY A BUILD EVENT, NOT THE DIRTY SET. `update` queues, and the queue
   * drains under budget; anything derived from what a chunk DREW (the
   * terrace lip overlay above all) that refreshed from the dirty set would
   * read a stale chart for any deferred chunk. This event fires the moment
   * a chunk's published geometry actually changes.
   */
  onChunkDrawn(handler: (chunkIdx: number) => void): () => void;
  /** Terrain draw calls the renderer would submit with nothing culled — exposed so a test can hold a budget against it. */
  drawCallCount(): number;
  /**
   * Median wall-clock cost of a SPLICE over the last SPLICE_SAMPLE_WINDOW,
   * or null before any have run.
   *
   * The number CHUNK_SPLICE_FRAME_BUDGET_MS is sized against — a headless
   * bench can't report it, since the direct source builds inline in node and
   * measures the whole build, never the splice alone. Exposed for an
   * in-browser probe to report beside the frame rate.
   */
  medianSpliceMs(): number | null;
  /**
   * Arena occupancy per super-mesh, in `pickables()` order.
   *
   * Dead space isn't asserted as a bound anywhere (plan §3d argues
   * convergence, not a bound), so tests/bench/probe OBSERVE it instead.
   * Vertex-shader cost of holes is proportional to `deadVertices`; `growths`
   * counts the one upload the arena doesn't bound (plan §5).
   */
  arenaStats(): ArenaStats[];
  /**
   * Where every run and hole sits, per super-mesh, in `pickables()` order.
   *
   * For tests: the free list's invariants (sorted, coalesced, aligned,
   * never reaching `liveEnd`) are what make a hole safe inside the draw
   * range, and are checkable only against the layout itself.
   */
  arenaLayout(): ArenaLayout[];
  /**
   * Chunks whose geometry is in the scene.
   *
   * The mesh count stopped answering this at the 2026-08-21 merge; several
   * tests used it as a proxy for "how many chunks got built" (drain budget,
   * locked-terrain invisibility) — both contracts about CHUNKS, so this
   * reports chunks rather than whatever the renderer groups them into.
   */
  builtChunkCount(): number;
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
  scheduling?: MeshScheduling,
  /** Where chunk geometry is built. Defaults to the direct (this-thread) source for tests/harnesses; the client passes the worker-backed one. */
  buildSource: ChunkBuildSource = createDirectChunkBuildSource(),
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: TERRAIN_ROUGHNESS,
    metalness: TERRAIN_METALNESS,
    // The camera can dip toward the horizon and see under a far terrace;
    // DoubleSide costs nothing here (no shadows, no transparency) and avoids
    // holes that would show.
    side: DoubleSide,
  });
  makeSelfLitAware(material);
  // The ground darkens under whatever plugins put in the sky (#284). AFTER
  // makeSelfLitAware and chains rather than replaces: the shade multiplies
  // `outgoingLight` at the same anchor, right after the self-lit mix, so a
  // rim just mixed to its unlit colour is still shaded like everything else.
  applyGroundShade(material, 'terrain');

  const superMeshes = new Map<number, SuperMesh>();

  /** What each built chunk drew — see the `drawnGround` accessor. */
  const drawnGroundStore = createDrawnGroundStore(worldSize);

  /** Build-completion subscribers — see `onChunkDrawn`. */
  const chunkDrawnHandlers = new Set<(chunkIdx: number) => void>();

  const superIndexOf = (chunkIdx: number): number => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;
    const sx = Math.floor(cx / SUPER_MESH_SPAN_CHUNKS);
    const sy = Math.floor(cy / SUPER_MESH_SPAN_CHUNKS);
    return sy * superCols + sx;
  };

  /**
   * Points the geometry at the super-mesh's current buffers. Run on creation
   * and whenever buffers grow — a typed array can't resize, so growth means
   * new attributes, and the old geometry is disposed.
   *
   * ALSO SETS `reallocatedThisPass`: brand-new BufferAttributes take three's
   * create path, which uploads everything and leaves `updateRanges`
   * uncleared, so any range added later this pass double-uploads next
   * frame. Used to be set by callers; `createSuperMesh` didn't, leaking a
   * newly-streamed chunk's ranges into the next frame's upload. Set here so
   * no caller can forget it.
   */
  const bindGeometry = (sm: SuperMesh): void => {
    sm.reallocatedThisPass = true;
    const positionAttribute = new BufferAttribute(sm.buffers.positions, 3);
    // `true` = NORMALIZED: the GPU reads these byte attributes back as
    // value/127 (signed) and value/255 (unsigned); omitting it feeds the
    // shader raw integers up to 255.
    const normalAttribute = new BufferAttribute(sm.buffers.normals, 3, true);
    const colorAttribute = new BufferAttribute(sm.buffers.colors, 3, true);
    // Normalised, so the shader reads the flag's 0/255 bytes as 0.0/1.0.
    const selfLitAttribute = new BufferAttribute(sm.buffers.selfLit, 1, true);
    positionAttribute.setUsage(DynamicDrawUsage);
    normalAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    selfLitAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', normalAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setAttribute(SELF_LIT_ATTRIBUTE, selfLitAttribute);
    geometry.setDrawRange(0, sm.liveEnd);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.normalAttribute = normalAttribute;
    sm.colorAttribute = colorAttribute;
    sm.selfLitAttribute = selfLitAttribute;

    // LAST: the new geometry's `boundingSphere` is null, and three would
    // compute one over the whole position attribute — including the dead
    // tail, which holds a previous occupant's leftovers and would stretch
    // the sphere to the origin. Do not move this into the callers.
    updateBounds(sm);
  };

  /**
   * Grows a super-mesh's buffers to hold at least `vertices`, preserving
   * existing content, and rebinds. Returns true if it had to.
   *
   * GEOMETRIC (doubling), not exact: a world fills chunk by chunk, and
   * growing by one chunk's worth each time would reallocate and copy the
   * whole super-buffer per chunk — quadratic, paid during the reveal.
   */
  const capacityVertices = (sm: SuperMesh): number =>
    sm.buffers.triangleCapacity * VERTICES_PER_TRIANGLE;

  const ensureSuperCapacity = (
    sm: SuperMesh,
    vertices: number,
    site: GrowthSite,
  ): boolean => {
    if (vertices <= capacityVertices(sm)) return false;
    let triangles = Math.max(sm.buffers.triangleCapacity, 1);
    while (triangles * VERTICES_PER_TRIANGLE < vertices) triangles *= 2;

    const grown = createChunkGeometryBuffers(triangles);
    grown.positions.set(sm.buffers.positions.subarray(0, sm.liveEnd * 3));
    grown.normals.set(sm.buffers.normals.subarray(0, sm.liveEnd * 3));
    grown.colors.set(sm.buffers.colors.subarray(0, sm.liveEnd * 3));
    grown.selfLit.set(sm.buffers.selfLit.subarray(0, sm.liveEnd));
    sm.buffers = grown;
    // The fresh attributes three will fully re-upload are installed by
    // `bindGeometry` below, along with `reallocatedThisPass` — see its own note.
    sm.growths++;
    if (site === 'splice') sm.strokeGrowths++;
    bindGeometry(sm);
    return true;
  };

  /**
   * The bound the renderer culls against: the union of the super-mesh's slot
   * boxes, O(64) rather than O(live vertices).
   *
   * EXACT, not conservative: the union of the chunks' measured boxes IS the
   * AABB of the live vertices — a static box from world size and height
   * range would be wrong for any partially revealed super-mesh, which is
   * most of them mid-exploration.
   *
   * The SPHERE is the AABB's centre plus half-diagonal — marginally looser
   * than a max-distance-over-vertices radius, but avoids a second pass over
   * every vertex; it culls a hair later, never wrongly.
   *
   * Hand-rolled rather than `computeBoundingSphere()`, which reads the whole
   * position attribute including the dead tail.
   *
   * The BOX is set too (free — it's the sphere's own extents), since
   * `Mesh.raycast` rejects on the box, after the sphere, before walking
   * triangles; a null box would make every ray clipping the sphere (which
   * over-covers the box) pay the full triangle walk. Nothing in the shipped
   * client raycasts terrain today, but preview harnesses, the differential
   * pick test, and any plugin registering terrain as pickable would.
   */
  const updateBounds = (sm: SuperMesh): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const slot of sm.slots.values()) {
      if (slot.count === 0) continue; // a chunk that emitted nothing has no box
      if (slot.minX < minX) minX = slot.minX;
      if (slot.minY < minY) minY = slot.minY;
      if (slot.minZ < minZ) minZ = slot.minZ;
      if (slot.maxX > maxX) maxX = slot.maxX;
      if (slot.maxY > maxY) maxY = slot.maxY;
      if (slot.maxZ > maxZ) maxZ = slot.maxZ;
    }
    const geometry = sm.mesh.geometry;
    if (minX > maxX) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      geometry.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(0, 0, 0));
      return;
    }
    geometry.boundingBox = new Box3(
      new Vector3(minX, minY, minZ),
      new Vector3(maxX, maxY, maxZ),
    );
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.hypot(maxX - centreX, maxY - centreY, maxZ - centreZ),
    );
  };

  /**
   * Marks one attribute's vertex range as the only part needing re-upload.
   *
   * Without this, `needsUpdate` alone re-uploads the WHOLE attribute — tens
   * of megabytes on a developed super-mesh — for a splice rewriting one
   * chunk. Ranges are in array elements, not vertices, so scaled by
   * itemSize (WebGLAttributes.js:141). three clears ranges itself after
   * upload (WebGLAttributes.js:147).
   */
  const addVertexRange = (
    attribute: BufferAttribute,
    startVertex: number,
    vertexCount: number,
  ): void => {
    if (vertexCount <= 0) return;
    const stride = attribute.itemSize;
    attribute.addUpdateRange(startVertex * stride, vertexCount * stride);
  };

  /** Every attribute of one super-mesh needs re-uploading. */
  const markDirty = (sm: SuperMesh): void => {
    sm.positionAttribute.needsUpdate = true;
    sm.normalAttribute.needsUpdate = true;
    sm.colorAttribute.needsUpdate = true;
    sm.selfLitAttribute.needsUpdate = true;
  };

  /**
   * Declares one vertex range of one super-mesh as needing re-upload, on all
   * four attributes.
   *
   * Clamped to the arena, and skipped entirely on a super-mesh reallocated
   * this pass (§3e). Not defensive: the retreat rule can pull `liveEnd`
   * below a range that was correct when computed (a shrink whose hole
   * reached the end) — those vertices leave the draw range instead of
   * uploading as zeroes.
   */
  const addRange = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (sm.reallocatedThisPass) return;
    const start = Math.max(0, startVertex);
    const end = Math.min(sm.liveEnd, startVertex + vertexCount);
    if (end <= start) return;
    addVertexRange(sm.positionAttribute, start, end - start);
    addVertexRange(sm.normalAttribute, start, end - start);
    addVertexRange(sm.colorAttribute, start, end - start);
    addVertexRange(sm.selfLitAttribute, start, end - start);
  };

  /** Writes zeroes over a vertex range in all four attributes — see `Hole`. */
  const zeroVertices = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (vertexCount <= 0) return;
    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    normals.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    colors.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    selfLit.fill(0, startVertex, startVertex + vertexCount);
  };

  /**
   * THE RETREAT RULE, an invariant of the LIST rather than of any one
   * insertion: a hole ending at the arena's extent isn't dead space, it's
   * space that stopped being live. Dropping it and pulling `liveEnd` back
   * costs no upload — those vertices simply leave the draw range.
   *
   * A loop, not an `if`, so the rule reads as "while the list still ends at
   * `liveEnd`"; a coalesced list can never satisfy it twice.
   */
  const retreatFromLiveEnd = (sm: SuperMesh): void => {
    for (;;) {
      const last = sm.holes[sm.holes.length - 1];
      if (last === undefined || last.offset + last.length !== sm.liveEnd) break;
      sm.holes.pop();
      sm.liveEnd = last.offset;
    }
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
  };

  /** Adds one dead run to the free list, keeping it sorted, coalesced and retreated. THE ONLY WAY A HOLE IS EVER CREATED. */
  const insertHole = (sm: SuperMesh, offset: number, length: number): void => {
    if (length <= 0) return;
    let at = 0;
    while (at < sm.holes.length && sm.holes[at]!.offset < offset) at++;
    sm.holes.splice(at, 0, { offset, length });
    // FORWARD FIRST, then backward: merging with the next entry can make
    // this one adjacent to the previous, so the order matters.
    const next = sm.holes[at + 1];
    const here = sm.holes[at]!;
    if (next !== undefined && here.offset + here.length === next.offset) {
      here.length += next.length;
      sm.holes.splice(at + 1, 1);
    }
    const previous = sm.holes[at - 1];
    if (previous !== undefined && previous.offset + previous.length === here.offset) {
      previous.length += here.length;
      sm.holes.splice(at, 1);
    }
    retreatFromLiveEnd(sm);
  };

  /**
   * FIRST FIT: the lowest hole that can hold `count` vertices, split so the
   * surplus stays on the list. Returns where the run may be written and
   * surplus vertices following, or null.
   *
   * Lowest-first, not best-fit: keeps live geometry bunched toward offset 0,
   * shortening the compactor's job, while a best-fit scan would still be
   * O(64) and leave the arena more scattered.
   */
  const takeHole = (
    sm: SuperMesh,
    count: number,
  ): { offset: number; surplus: number } | null => {
    for (let i = 0; i < sm.holes.length; i++) {
      const hole = sm.holes[i]!;
      if (hole.length < count) continue;
      const offset = hole.offset;
      const surplus = hole.length - count;
      if (surplus === 0) sm.holes.splice(i, 1);
      else {
        hole.offset = offset + count;
        hole.length = surplus;
      }
      // No retreat check: the split hole ENDS where the original did, so if
      // it had reached `liveEnd` the rule would already have removed it.
      return { offset, surplus };
    }
    return null;
  };

  /** The slot whose run starts exactly at `offset`, or undefined. O(64). */
  const runStartingAt = (sm: SuperMesh, offset: number): ChunkSlot | undefined => {
    for (const slot of sm.slots.values()) {
      if (slot.count > 0 && slot.offset === offset) return slot;
    }
    return undefined;
  };

  /**
   * Moves the run immediately above `hole` down into it, in one piece.
   *
   * NEVER SPLIT ACROSS FRAMES: a partially moved live run draws garbage
   * between its halves. A run too dear for this frame's budget is skipped
   * and waits for a cheaper one — the caller's decision, made before this runs.
   *
   * Upload is one run plus one hole (contiguous); the slot's BOUNDS are
   * untouched since a move changes where a run lives, not what it contains.
   */
  const moveRunDown = (sm: SuperMesh, hole: Hole, run: ChunkSlot): void => {
    const from = run.offset;
    const runEnd = from + run.count;
    const to = hole.offset;
    const { positions, normals, colors, selfLit } = sm.buffers;
    // copyWithin, not set(subarray): source and destination overlap whenever
    // the hole is shorter than the run.
    positions.copyWithin(to * 3, from * 3, runEnd * 3);
    normals.copyWithin(to * 3, from * 3, runEnd * 3);
    colors.copyWithin(to * 3, from * 3, runEnd * 3);
    selfLit.copyWithin(to, from, runEnd);
    run.offset = to;

    const vacated = to + run.count;
    zeroVertices(sm, vacated, runEnd - vacated);
    sm.holes.splice(sm.holes.indexOf(hole), 1);
    insertHole(sm, vacated, runEnd - vacated);
    markDirty(sm);
    addRange(sm, to, runEnd - to);
  };

  /**
   * Closes holes, cheapest-first in free-list order, while `budgetMs` of
   * ESTIMATED transfer remains. Returns what it spent.
   *
   * A skipped run isn't a failure — the next hole is tried, and the run
   * waits for a frame with more budget. Convergence isn't asserted as a
   * bound here: one full sweep is at most one move per run, since the
   * lowest hole is carried past exactly one run per move.
   */
  const compactSuperMesh = (sm: SuperMesh, budgetMs: number): number => {
    let spentMs = 0;
    for (;;) {
      let moved = false;
      for (const hole of sm.holes) {
        const run = runStartingAt(sm, hole.offset + hole.length);
        // Only the highest hole can have no run above it, and the retreat
        // rule has already taken that one off the list.
        if (run === undefined) continue;
        const costMs = run.count * ARENA_TRANSFER_MS_PER_VERTEX;
        if (spentMs + costMs > budgetMs) continue;
        moveRunDown(sm, hole, run);
        spentMs += costMs;
        moved = true;
        break; // the list was mutated; re-read it
      }
      if (!moved) return spentMs;
    }
  };

  /** One frame's compaction across every super-mesh, sharing one budget — not per-super-mesh, since four each spending it would spend four times what the frame has. */
  const compact = (budgetMs: number): void => {
    let spentMs = 0;
    for (const sm of superMeshes.values()) {
      if (sm.holes.length === 0) continue;
      spentMs += compactSuperMesh(sm, budgetMs - spentMs);
      if (spentMs >= budgetMs) return;
    }
  };

  /** Sum of every slot's count — the live geometry, as against the extent. */
  const liveCount = (sm: SuperMesh): number => {
    let total = 0;
    for (const slot of sm.slots.values()) total += slot.count;
    return total;
  };

  const createSuperMesh = (superIdx: number): SuperMesh => {
    const placeholder = new BufferAttribute(new Float32Array(0), 3);
    const sm: SuperMesh = {
      mesh: new Mesh(new BufferGeometry(), material),
      buffers: createChunkGeometryBuffers(),
      positionAttribute: placeholder,
      normalAttribute: placeholder,
      colorAttribute: placeholder,
      selfLitAttribute: placeholder,
      slots: new Map(),
      holes: [],
      liveEnd: 0,
      reallocatedThisPass: false,
      growths: 0,
      strokeGrowths: 0,
    };
    bindGeometry(sm);
    group.add(sm.mesh);
    superMeshes.set(superIdx, sm);
    return sm;
  };

  /**
   * Copies a finished job's vertices into `chunkIdx`'s run, PLACING that run
   * wherever it now fits — never moving anybody else's.
   *
   * THE CONTRACT (docs/plans/vertex-arena-no-tail-move.md §2): a splice's
   * upload is bounded by the chunk it splices, never by the super-mesh.
   * Under the old chunk-index-ordered packing, a chunk whose vertex count
   * changed moved every run after it (measured 19-21 MB per stroke step on
   * the busiest super-mesh). Under the arena, upload is this chunk's own run
   * plus the run it vacated.
   *
   * WHY NOT A FIXED SLOT PER CHUNK. Sized for the worst chunk
   * (CHUNK_TRIANGLE_BUDGET, 393,216 vertices = 7.5 MB), a 64-slot super-mesh
   * is ~480 MB and submits ~8.4M triangles to draw the ~50k it holds. Sized
   * for INITIAL_CHUNK_TRIANGLE_CAPACITY instead, it can't hold the owner's
   * world's median chunk (5,388 vertices). No slot size is both affordable
   * and sufficient; the arena gives every chunk exactly its own size.
   *
   * PLACEMENT, decided first, capacity second (§3b). For a run of `count`
   * vertices replacing one of `old` at `[offset, offset+old)`:
   *
   *   1. count === old — overwrite in place. Upload: the run.
   *   2. count < old — overwrite in place; remainder becomes a hole.
   *      Upload: the run and hole (contiguous).
   *   3. count > old and the run ends at `liveEnd` — extend in place (the
   *      common case for a one-chunk super-mesh; keeps those hole-free).
   *      Upload: the run.
   *   4. count > old — the lowest hole that fits, split. Upload: new run,
   *      surplus, and old run zeroed — three disjoint ranges (three's own
   *      merge only joins adjacent ones).
   *   5. count > old, nothing fits — append at `liveEnd`. Upload: new run
   *      and old one.
   *
   * A chunk arriving for the first time is case 3, 4 or 5 with `old = 0`.
   */
  const spliceChunk = (sm: SuperMesh, chunkIdx: number, answer: ChunkJobAnswer): void => {
    const count = answer.vertexCount;
    let slot = sm.slots.get(chunkIdx);
    if (slot === undefined) {
      slot = {
        // Placed below, by the same rules as any other run: an empty run at
        // 0 is case 3 on an empty super-mesh, case 4/5 on a populated one.
        offset: 0,
        count: 0,
        // An empty box (min > max), which `updateBounds` skips; filled by
        // the bounds copy below, in this same call.
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      sm.slots.set(chunkIdx, slot);
    }

    const old = slot.count;
    /** Vertex ranges this splice dirtied, as [startVertex, vertexCount] pairs. */
    const dirtied: [number, number][] = [];

    if (count <= old) {
      // Cases 1 and 2. The hole (empty when counts match) is contiguous with
      // the run, so one range covers both.
      zeroVertices(sm, slot.offset + count, old - count);
      dirtied.push([slot.offset, old]);
      slot.count = count;
      insertHole(sm, slot.offset + count, old - count);
    } else if (slot.offset + old === sm.liveEnd) {
      // Case 3. Capacity is an extent, not a delta: what has to fit is where
      // the run now ends.
      ensureSuperCapacity(sm, slot.offset + count, 'splice');
      sm.liveEnd = slot.offset + count;
      slot.count = count;
      dirtied.push([slot.offset, count]);
    } else {
      const reused = takeHole(sm, count);
      /** Where this chunk's previous run sat, once nothing can move it again. */
      let freedOffset: number;
      if (reused !== null) {
        // Case 4.
        freedOffset = slot.offset;
        slot.offset = reused.offset;
        dirtied.push([reused.offset, count]);
        if (reused.surplus > 0) dirtied.push([reused.offset + count, reused.surplus]);
      } else {
        // Case 5. Compact before doubling: a capacity growth is one full
        // `bufferData` of the whole super-mesh (plan §5), cheaper to avoid
        // via a full compactor sweep whenever there's enough dead space —
        // the one place a sweep runs unbudgeted.
        if (sm.liveEnd + count > capacityVertices(sm) && sm.holes.length > 0) {
          compactSuperMesh(sm, Infinity);
        }
        // Capacity from `count`, never from `delta`: an append writes the
        // whole run past the live end, so a `delta`-phrased request
        // under-requests by `old` and `set()` runs off the buffer.
        ensureSuperCapacity(sm, sm.liveEnd + count, 'splice');
        // Read AFTER the compaction, not before: a sweep moves live runs,
        // including this chunk's own.
        freedOffset = slot.offset;
        slot.offset = sm.liveEnd;
        sm.liveEnd += count;
        dirtied.push([slot.offset, count]);
      }
      slot.count = count;
      // The run it left behind, zeroed and offered back to the free list.
      zeroVertices(sm, freedOffset, old);
      dirtied.push([freedOffset, old]);
      insertHole(sm, freedOffset, old);
    }

    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.set(answer.positions, slot.offset * 3);
    normals.set(answer.normals, slot.offset * 3);
    colors.set(answer.colors, slot.offset * 3);
    selfLit.set(answer.selfLit, slot.offset);

    // Measured where the vertices were made, not here: the job walked them
    // once on its way out and sent six floats.
    slot.minX = answer.bounds[0]!;
    slot.minY = answer.bounds[1]!;
    slot.minZ = answer.bounds[2]!;
    slot.maxX = answer.bounds[3]!;
    slot.maxY = answer.bounds[4]!;
    slot.maxZ = answer.bounds[5]!;

    markDirty(sm);
    for (const [startVertex, vertexCount] of dirtied) addRange(sm, startVertex, vertexCount);

    // Non-indexed geometry's draw range counts VERTICES and covers the
    // arena's whole extent, holes included — why they must be zeroed rather
    // than merely forgotten.
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
    updateBounds(sm);
  };

  /**
   * Chunks marked dirty and not yet rebuilt, in the order they were marked.
   *
   * A SET, so a re-dirtied chunk is still built once, from the mirror's
   * state at drain time. Insertion order is the drain order — deterministic
   * whatever the frame budget allows on the day.
   */
  const pending = new Set<number>();

  /**
   * Chunks whose job is out and whose answer has not landed.
   *
   * AT MOST ONE JOB PER CHUNK, enforced rather than implied: two answers for
   * one chunk could return in either order, and the older splicing last
   * would leave the chunk drawing pre-edit geometry. A chunk re-dirtied
   * while its job is out just stays in `pending` and resubmits when the
   * answer lands.
   */
  const inFlight = new Set<number>();

  /** Finished jobs waiting for a frame's splice budget. */
  const ready: ChunkJobAnswer[] = [];

  /**
   * Chunks whose build was LOST (`ChunkBuildSource.build` answered null) and
   * must be built again.
   *
   * A HOLDING PEN rather than `pending` directly: a source can fail
   * synchronously inside `submit`, and a chunk put straight back into
   * `pending` there would be the very chunk `nextSubmittable` hands the same
   * loop next turn — an infinite spin. This set merges into `pending` only
   * at the top of a drain/flush pass, so a lost job retries next pass, never
   * the one that lost it.
   */
  const retry = new Set<number>();

  /** A ring of recent splice costs — long enough to survive a held stroke (~8 intents/s, a few seconds), short enough that the median tracks the world as it is now. */
  const SPLICE_SAMPLE_WINDOW = 64;
  const spliceMs: number[] = [];
  let spliceMsNext = 0;

  /** Bumped whenever the world this builder draws is replaced. An answer stamped with an older generation is a picture of a world that no longer exists, and is dropped rather than spliced. */
  let generation = 0;

  /** Takes one build's outcome off the pool. `answer` is null on a lost build; the chunk index is passed separately since a lost job has no answer to read it from. */
  const receive = (chunkIdx: number, answer: ChunkJobAnswer | null): void => {
    inFlight.delete(chunkIdx);
    if (answer === null) {
      // Tried again, not dropped: still dirty and still drawing its pre-edit
      // geometry, so a later pass must build it.
      if (mirror.received.has(chunkIdx)) retry.add(chunkIdx);
      return;
    }
    if (answer.generation !== generation) return;
    // Re-checked on ARRIVAL as well as submission: a chunk can leave
    // `received` while its job is out (a rejoin), and splicing geometry the
    // mirror no longer holds would draw terrain that isn't there.
    if (!mirror.received.has(answer.chunkIdx)) return;
    ready.push(answer);
  };

  /** Sends one queued chunk to the build source. */
  const submit = (chunkIdx: number): void => {
    // Re-checked at SUBMIT time, not queue time: a chunk can drop from
    // `received` between the two.
    if (!mirror.received.has(chunkIdx)) return;
    inFlight.add(chunkIdx);
    const answer = buildSource.build(mirror, chunkIdx, generation);
    if (answer instanceof Promise) void answer.then((settled) => receive(chunkIdx, settled));
    else receive(chunkIdx, answer);
  };

  /** Splices one finished job into its super-mesh, creating that if needed. */
  const spliceAnswer = (answer: ChunkJobAnswer): void => {
    const startedMs = now();
    // Handed over, not re-derived: the plan this chunk was emitted from is
    // published here rather than re-planned by drawnGroundStore.ts. Arrives
    // already flat and rasterised from wherever the chunk was built.
    drawnGroundStore.publishRastered(
      answer.chunkIdx,
      answer.plan,
      answer.topLevel,
      answer.lips,
    );
    const superIdx = superIndexOf(answer.chunkIdx);
    const sm = superMeshes.get(superIdx) ?? createSuperMesh(superIdx);
    spliceChunk(sm, answer.chunkIdx, answer);
    // AFTER the splice and publish, so a handler sees both.
    for (const handler of chunkDrawnHandlers) handler(answer.chunkIdx);
    // Timed around all three: run placement, chart publish, lip refresh —
    // what a frame actually pays per answer.
    const elapsedMs = now() - startedMs;
    if (spliceMs.length < SPLICE_SAMPLE_WINDOW) spliceMs.push(elapsedMs);
    else {
      spliceMs[spliceMsNext] = elapsedMs;
      spliceMsNext = (spliceMsNext + 1) % SPLICE_SAMPLE_WINDOW;
    }
  };

  const now = scheduling?.now ?? (() => performance.now());

  /** The first queued chunk with no job out, or undefined. */
  const nextSubmittable = (): number | undefined => {
    for (const chunkIdx of pending) {
      if (!inFlight.has(chunkIdx)) return chunkIdx;
    }
    return undefined;
  };

  /** Folds lost builds back into the queue. Called at the top of a pass only. */
  const takeRetries = (): void => {
    if (retry.size === 0) return;
    for (const chunkIdx of retry) pending.add(chunkIdx);
    retry.clear();
  };

  /**
   * Submits what the pool has room for, then splices finished answers until
   * `budgetMs` of wall clock is gone. Returns how many answers it spliced —
   * what decides the compaction budget.
   *
   * ALWAYS SPLICES AT LEAST ONE: a splice costing more than the whole budget
   * would otherwise never happen and the queue would stall permanently. The
   * clock is checked AFTER a splice, not before, expressing that the first
   * splice of a frame is unconditional and every one after must fit — a
   * floor on progress, not a ceiling on cost.
   */
  const drain = (budgetMs: number): number => {
    takeRetries();
    let spliced = 0;
    if (pending.size === 0 && ready.length === 0) return spliced;
    const startedMs = now();
    for (;;) {
      // Top the pool up FIRST, so a worker is never idle while this thread splices.
      //
      // FINISHED ANSWERS COUNT AGAINST THE POOL — what bounds the DIRECT
      // source. Its `build` returns an already-finished answer, so `receive`
      // runs inline and releases the `inFlight` slot before `submit`
      // returns; counting `inFlight` alone would re-test 0 < 1 forever and
      // build every pending chunk in one call, ignoring the budget. Counting
      // `ready` too means one unspliced answer occupies one slot, so the
      // direct path builds exactly one chunk per pass — the worker path gets
      // this for free, its answers being genuinely in flight. `flush` is the
      // path that deliberately builds everything.
      while (inFlight.size + ready.length < buildSource.concurrency) {
        const chunkIdx = nextSubmittable();
        if (chunkIdx === undefined) break;
        pending.delete(chunkIdx);
        submit(chunkIdx);
      }
      if (ready.length === 0) return spliced;
      spliceAnswer(ready.shift()!);
      spliced++;
      if (now() - startedMs >= budgetMs) return spliced;
    }
  };

  /**
   * Builds every queued chunk now, whatever the budget says.
   *
   * SYNCHRONOUS ONLY ON THE DIRECT SOURCE, which answers inside `build`. The
   * worker source can't finish on this thread by definition, so a client
   * using it gets "everything submitted, everything already answered
   * spliced" — all a flush can honestly mean there. Callers depending on the
   * world being complete on return (tests, preview harnesses) are on the
   * direct source.
   */
  const flush = (): void => {
    takeRetries();
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    for (;;) {
      const chunkIdx = nextSubmittable();
      if (chunkIdx !== undefined) {
        pending.delete(chunkIdx);
        submit(chunkIdx);
      }
      if (ready.length > 0) spliceAnswer(ready.shift()!);
      else if (chunkIdx === undefined) break;
    }
    // "Build everything now" also means "and leave no holes" — every caller
    // of this path wants the world finished on return, and there's no later
    // frame to compact on.
    compact(Infinity);
  };

  const clear = (): void => {
    for (const sm of superMeshes.values()) {
      group.remove(sm.mesh);
      sm.mesh.geometry.dispose();
    }
    superMeshes.clear();
    // The charts describe geometry that no longer exists; a stale one would
    // answer a water query with contours from the world being replaced.
    drawnGroundStore.clear();
    // The queue holds indices into the world being dropped; draining them
    // against the replacement would build chunks nobody asked for.
    pending.clear();
    retry.clear();
    // Jobs already out are pictures of the world being dropped; the
    // generation bump makes their answers arrive and be discarded.
    inFlight.clear();
    ready.length = 0;
    generation++;
  };

  /**
   * COMPACTION IS ITS OWN SEAM ON THE FRAME, not a step inside `drain`.
   *
   * `drain` returns the moment there's nothing to build or splice, so a
   * settled frame (the only kind with budget to spare) would never reach
   * anything placed after its splices. A stroke frame's first splice already
   * spends the splice budget (medianSpliceMs 1.4-1.7 against the 1.5 ms
   * budget), so compaction sharing it would never run either. Two budgets,
   * two seams.
   */
  /** When `update` was last called, on the clock the budgets are measured against. Half of the quiet test — see `settle`. Negative infinity until the first update, the quietest state. */
  let lastUpdateMs = Number.NEGATIVE_INFINITY;

  /** The largest run this super-mesh currently holds, in vertices. */
  const largestRunVertices = (sm: SuperMesh): number => {
    let largest = 0;
    for (const slot of sm.slots.values()) {
      if (slot.count > largest) largest = slot.count;
    }
    return largest;
  };

  /** Free capacity this super-mesh must hold when the terrain is quiet, in vertices: ARENA_HEADROOM_RUN_MULTIPLE times its own largest run, never below ARENA_HEADROOM_FLOOR_TRIANGLES. */
  const headroom = (sm: SuperMesh): number =>
    Math.max(
      ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices(sm),
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );

  /**
   * Whether any chunk of this super-mesh is still on its way to being drawn —
   * queued, out at the build source, awaiting a splice, or awaiting retry.
   *
   * ALL FOUR QUEUES, since `drain` returning 0 is not a substitute: on the
   * worker source most reveal frames splice nothing while jobs are out, and
   * during a held stroke ~16 of 17 frames splice nothing between intents —
   * either would read as quiet. O(queue) per call.
   */
  const superMeshHasChunkQueued = (superIdx: number): boolean => {
    for (const chunkIdx of pending) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const chunkIdx of inFlight) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const chunkIdx of retry) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const answer of ready) {
      if (superIndexOf(answer.chunkIdx) === superIdx) return true;
    }
    return false;
  };

  /**
   * Gives one quiet super-mesh its headroom (issue #229; part A of
   * docs/plans/frame-budget-growth-and-draw-calls.md).
   *
   * THE CONTRACT: when quiet, every super-mesh holds at least `headroom(sm)`
   * free capacity, and capacity only grows while quiet. Before this existed,
   * post-streaming slack was an accident of the doubling ladder, so whether
   * a stroke reallocated (one full `bufferData`, measured ~3 MB and up to
   * 505 ms, on a frame the player watches) came down to streaming order.
   *
   * ONE SUPER-MESH PER CALL: each growth is one `bufferData` (≤30 MB ≈ 30 ms
   * on the owner's world); several per frame would trade a stroke hitch for
   * a bigger idle one.
   *
   * NOT CALLED BY `flush`: on the no-scheduler path `update` calls `flush`
   * every sculpt step, so a headroom pass there would be growth inside the
   * stroke — exactly what this prevents.
   */
  const settle = (options?: SettleOptions): void => {
    // The global half of the quiet test, checked once: no `update` at all
    // in the window means no super-mesh can be quiet. assumeQuiet skips only
    // this gate, not the queue test below.
    if (options?.assumeQuiet !== true && now() - lastUpdateMs < TERRAIN_QUIET_MS) return;
    for (const [superIdx, sm] of superMeshes) {
      if (capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      if (superMeshHasChunkQueued(superIdx)) continue;
      // Deliberately not a second rounding ladder: `ensureSuperCapacity`
      // keeps its doubling-from-current rule.
      ensureSuperCapacity(sm, sm.liveEnd + headroom(sm), 'settle');
      return;
    }
  };

  const stopDraining = scheduling?.onFrame(() => {
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    const spliced = drain(CHUNK_SPLICE_FRAME_BUDGET_MS);
    compact(spliced > 0 ? ARENA_COMPACT_STROKE_BUDGET_MS : ARENA_COMPACT_IDLE_BUDGET_MS);
    // LAST, AND ONLY HERE: `settle` must see this frame's splices and
    // compaction before deciding whether the terrain still lacks headroom.
    settle();
  });

  return {
    update(dirty: Iterable<number>): void {
      // BEFORE the loop, unconditionally: the quiet test asks when the
      // terrain was last ASKED to change, not when it last managed to.
      lastUpdateMs = now();
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        pending.add(chunkIdx);
      }
      // No frames to defer to — see the module header. The queue still
      // exists (so both paths dedupe identically); it's simply emptied
      // before the call returns.
      if (stopDraining === undefined) flush();
    },
    flush,
    settle,
    pendingCount(): number {
      return pending.size + inFlight.size + ready.length + retry.size;
    },
    clear,
    pickables(): Mesh[] {
      return Array.from(superMeshes.values(), (sm) => sm.mesh);
    },
    drawnGround(): DrawnGroundStore {
      return drawnGroundStore;
    },
    onChunkDrawn(handler: (chunkIdx: number) => void): () => void {
      chunkDrawnHandlers.add(handler);
      return () => chunkDrawnHandlers.delete(handler);
    },

    medianSpliceMs(): number | null {
      if (spliceMs.length === 0) return null;
      const sorted = [...spliceMs].sort((a, b) => a - b);
      return sorted[sorted.length >> 1]!;
    },

    arenaStats(): ArenaStats[] {
      return Array.from(superMeshes.values(), (sm) => {
        const live = liveCount(sm);
        return {
          liveEnd: sm.liveEnd,
          liveCount: live,
          deadVertices: sm.liveEnd - live,
          holeCount: sm.holes.length,
          growths: sm.growths,
          strokeGrowths: sm.strokeGrowths,
        };
      });
    },
    arenaLayout(): ArenaLayout[] {
      return Array.from(superMeshes.values(), (sm) => ({
        slots: Array.from(sm.slots, ([chunkIdx, slot]) => ({
          chunkIdx,
          offset: slot.offset,
          count: slot.count,
        })),
        holes: sm.holes.map((hole) => ({ offset: hole.offset, length: hole.length })),
      }));
    },

    drawCallCount(): number {
      return superMeshes.size;
    },
    builtChunkCount(): number {
      let built = 0;
      for (const sm of superMeshes.values()) built += sm.slots.size;
      return built;
    },
    dispose(): void {
      stopDraining?.();
      clear();
      material.dispose();
      // The build source is NOT disposed here — it's the caller's, and the
      // client's worker pool outlives the mesh set (a rejoin replaces the
      // meshes without terminating threads for nothing). `clear()` above has
      // already bumped the generation, so in-flight answers are discarded.
    },
  };
}
