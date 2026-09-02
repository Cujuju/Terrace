// Per-chunk terrain meshes and the in-place vertex patch path.
//
// CRITICAL CODE — this is the client performance contract (design doc):
// "mesh updates must patch vertex buffers in place — never rebuild geometry
// per edit". A chunk's BufferGeometry, its attributes and their backing
// Float32Arrays are allocated once, when the chunk's data first arrives, and
// live until the world is replaced. Applying a terrain diff rewrites the
// affected chunks' position/normal/colour arrays and flips `needsUpdate`; it
// never allocates and never re-adds anything to the scene graph.
//
// BUFFER STRATEGY, re-derived for the organic renderer (2026-08-14).
//
// The old builder had a TIGHT worst case: 256 top quads plus at most two wall
// quads per cell, i.e. exactly 768 quads, so buffers were sized for the
// pathological chunk once and a `setDrawRange` prefix cut the tail. The organic
// builder has no such bound worth allocating for. Its triangle count is
//
//     Σ over the bands present in the chunk of (cap triangles + 2 × contour
//     segments),
//
// which is ~10 triangles for a flat chunk, ~1.5k for a chunk crossed by four
// smoothed band contours, and — for a chunk that spans the full ±16 bands with
// a wiggly contour on every one of them — tens of thousands. Sizing every chunk
// for that last figure would cost megabytes per chunk for terrain nobody makes.
// So the two candidates change shape, and the choice with them:
//
//   REJECTED — preallocate the worst case, as before. The honest worst case is
//   33 levels × (≈2.3k cap + ≈4.6k skirt) ≈ 230k triangles = 24 MB per chunk.
//   Even a realistic-but-lively bound (8 levels, 700 triangles each) is 600 KB
//   per chunk, i.e. 600 MB for a fully revealed 512² world, to serve chunks
//   that overwhelmingly need 1% of it. Preallocation only wins when the bound
//   is tight, and it no longer is.
//
//   CHOSEN — preallocate a working capacity per chunk, DRAW A PREFIX with
//   setDrawRange, and GROW (doubling) on the rare patch that overflows. Chunks
//   start at INITIAL_CHUNK_TRIANGLE_CAPACITY (1024 triangles = 110 KB, the same
//   order as the old renderer's fixed 108 KB) and only reallocate on the edit
//   that first pushes them past it. Capacity never shrinks, so it converges to
//   each chunk's own high-water mark within the first few sculpts and every
//   patch after that is pure array writes: no allocation, no attribute or
//   geometry object created, no GPU buffer deleted and recreated.
//
// AGAINST THE HELD-SCULPT BUDGET. A held brush emits one intent every
// SCULPT_REPEAT_INTERVAL_MS (≈8/s) and a radius-4 brush can straddle at most
// four chunks, so the steady state is ≈32 chunk patches per second, i.e. one
// patch every other frame at 60 fps. Per patch, on a typical four-band chunk
// (measured shapes, estimated times):
//   - sampling and marching: 4 levels × 256 squares ≈ 1k square evaluations;
//   - smoothing: 2 Chaikin passes over a few hundred vertices;
//   - triangulation: ear clipping, O(n²) on n ≈ 150 per loop ≈ 20k operations;
//   - buffer writes: ≈1.5k triangles × 27 floats ≈ 40k stores.
// That is tens of microseconds of work, the same order as the old builder's
// ~37k stores, and it lands on ~4% of the frames. Growth events are the only
// spike, and there are at most log2(capacity) of them per chunk EVER.
//
// GARBAGE, named rather than hidden: unlike the old builder, the contour
// pipeline allocates — a few thousand small point objects per chunk rebuild,
// on the order of 100 KB. At 32 patches/s that is ~3 MB/s of strictly
// short-lived objects, which is nursery traffic a generational collector
// scavenges in a fraction of a millisecond and never promotes. The rule that
// matters for stutter is the one still kept absolutely: no GPU buffer is
// respecified mid-stroke, because a driver-side buffer respec is what shows up
// as a frame spike rather than as a lower average frame rate.
//
// MEMORY at rest: 111 bytes per triangle (3 unshared vertices × 9 floats, plus
// the one-byte self-lit flag each vertex carries — see SELF_LIT_ATTRIBUTE).
// Non-indexed is deliberate — every triangle owning its own three vertices is
// what gives flat shading a hard crease at every cap/skirt boundary, and an
// index buffer that never shares a vertex is pure overhead.
//
// QUEUE → JOB → SPLICE (issue #47, 2026-08-20; the build moved off-thread
// 2026-08-28). `update` does not build anything. It marks chunks dirty in a
// queue; a frame hook submits what the build source has room for and SPLICES
// the answers that have come back, under a wall-clock budget
// (CHUNK_SPLICE_FRAME_BUDGET_MS). A chunk still waiting its turn keeps DRAWING
// ITS PREVIOUS MESH — stale by a frame or two, never absent — which is what
// makes deferral invisible rather than a flicker.
//
// WHERE THE WORK IS. The job itself — marching, smoothing, triangulating, the
// cap plan and the band raster — is render/chunkBuildSource.ts's, and in the
// client that is a worker pool. What a frame pays here is the splice: placing
// the finished run in the super-mesh's ARENA (see spliceChunk), the chart
// publish, and the `onChunkDrawn` handlers (~1 ms on a developed super-mesh).
// That is why the budget is a splice budget and not a build budget; the
// constant's own doc comment derives the number. A second, separate budget pays
// for COMPACTION on the same frame — see ARENA_COMPACT_STROKE_BUDGET_MS.
//
// WHY IT COSTS NO LATENCY. Frame callbacks run before `renderer.render`
// (render/scene.ts's renderFrame), so a sculpt that lands between two frames is
// queued, drained and drawn on the very next frame — plus, on the worker path,
// the job's own ~6 ms. What changes is only what happens when the queue holds
// MORE work than a frame can afford.
//
// WHAT IT FIXES. A radius-4 brush straddles up to four chunks and every one of
// them was rebuilt inside a single `update` call, so their costs ADDED: four
// floor-depth chunks at the measured worst case (~9 ms each — see
// terrain/capEmission.ts's budget table) was a ~36 ms frame, two and a half
// vsync intervals. Spreading them across frames removed the compounding, and
// moving the build itself off-thread removed the remaining floor: the cost of
// ONE chunk, which no frame budget could ever divide because the contour
// pipeline is not resumable mid-chunk. What is left on this thread is a splice.
//
// A CHART IS PUBLISHED BY THE SPLICE, NOT BY `update`. Everything that reads
// what a chunk DREW — terrain/drawnGroundStore.ts's charts, and through them
// the lip overlay, the river rig and the sea's curtains — must therefore be
// driven by `onChunkDrawn` rather than by the dirty set the caller passed in.
// Driven by the dirty set it reads the pre-edit chart, or the blocky
// MISSING-CHUNKS fallback, for every chunk whose job has not landed. See
// world.ts's applyDirty.
//
// NO FRAME HOOK, NO DEFERRAL. `createTerrainMeshes` takes the scheduler as an
// option and falls back to `flush` inside `update` when it is absent. That is
// not a test affordance: deferring work to a later frame is meaningless without
// a frame loop to defer to, and a caller that has none (the headless suite, and
// anything that wants the world complete before it looks at it) should get the
// synchronous behaviour rather than a queue nobody pumps. Such a caller is on
// the direct build source by definition — the worker cannot finish on this
// thread — so `update` there both builds and publishes before it returns.
//
// DRAW-CALL TRADEOFF, known and accepted for v1: one mesh per 16×16 chunk
// means a fully revealed 512² world would be 1024 draw calls. That is a lot,
// but (a) worlds start with a handful of unlocked chunks and grow slowly by
// design, and (b) per-chunk meshes are what make streaming and
// locked-chunk omission trivial — a chunk we have never received simply has no
// mesh, so it cannot be drawn, picked, or peeked at. The Phase 2+ fix, if
// measurement demands one, is to merge chunks into larger super-meshes (or one
// buffer with per-chunk sub-ranges) while keeping the same patch path; nothing
// outside this file depends on the one-mesh-per-chunk choice.

import {
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
 * How long a frame may spend SPLICING finished chunk jobs, in milliseconds.
 *
 * ONE AND A HALF, about a fifth of the 7.1 ms a 140 fps frame has for
 * everything. It replaced CHUNK_BUILD_FRAME_BUDGET_MS (4 ms) when the chunk
 * BUILD moved to a worker (render/chunkBuildSource.ts): what a frame does here
 * is no longer marching and triangulating a chunk but copying a finished
 * answer into its super-mesh — the packed tail move, the chart publish and the
 * lip refresh, ~1 ms on a developed super-mesh. A budget sized for the old work
 * would have been no budget at all.
 *
 * AT ~1 ms A SPLICE THIS IS ROUGHLY ONE SPLICE PER FRAME, and "always splices
 * at least one" keeps the no-starvation property — so the constant is a floor
 * on progress, not a ceiling on cost, exactly as its predecessor was. A
 * radius-4 brush straddling two chunks therefore lands over two frames.
 * Accepted: the alternative is a heavier frame.
 */
export const CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5;

/**
 * What one vertex costs to get onto the GPU, in milliseconds — the exchange
 * rate the compaction budgets below are denominated in.
 *
 * MEASURED, 2026-08-28, on the owner's machine (RTX 3090, Chrome/ANGLE), from
 * the real-GPU attribution in docs/plans/vertex-arena-no-tail-move.md §1: a
 * frame that uploaded 19–21 MB of vertex attributes spent 3.5–12 ms inside
 * `bufferSubData` and roughly as much again on the NEXT frame, stalled while
 * the GPU process copied it — about 1 ms per megabyte all in. A vertex is 19
 * bytes in this renderer's compressed format (three Float32 positions, three
 * Int8 normals, three Uint8 colours, one Uint8 self-lit flag; see
 * `createChunkGeometryBuffers`), so a megabyte is 1e6/19 vertices and one
 * vertex is 19/1e6 ms.
 *
 * It is an ESTIMATOR, not a clock: compaction decides whether it can afford a
 * move BEFORE making it, and the cost it is deciding about is a transfer that
 * has not happened yet and would not be visible to `performance.now()` on this
 * frame if it had.
 */
export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

/**
 * How much transfer compaction may schedule on a frame that also SPLICED, in
 * milliseconds.
 *
 * ONE. The 140 fps bar (owner, 2026-08-26) gives a frame 7.1 ms. Measured on
 * the owner's world, that frame already owes: ~1.7 ms of idle render, 1.5 ms
 * of splice budget (CHUNK_SPLICE_FRAME_BUDGET_MS) and ~0.5 ms of plugins —
 * 3.7 ms. Of the 3.4 ms left, half is held back for the NEXT frame, because a
 * transfer bills roughly its own cost again in GPU-process backpressure on the
 * frame after it (§1). That leaves 1.7 ms, and 1.0 is the round number under
 * it. At ARENA_TRANSFER_MS_PER_VERTEX that moves runs up to ~52 k vertices —
 * above the owner's world's p90 chunk (38.8 k).
 */
export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

/**
 * The same arithmetic for a frame that spliced NOTHING: 7.1 − 1.7 render −
 * 0.5 plugins = 4.9 ms, halved for backpressure, rounded down to 3.
 *
 * That moves any run on the owner's world (max 142 k vertices ≈ 2.7 ms). A
 * chunk at the CHUNK_TRIANGLE_BUDGET ceiling — 393 k vertices ≈ 7.5 ms — would
 * not fit even here and is the named residual in the plan's §5: the hole in
 * front of such a run waits until that run itself regrows or shrinks.
 */
export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

/**
 * The p90 chunk RUN on the owner's world, in TRIANGLES.
 *
 * MEASURED 2026-08-29 from `arenaLayout()` over that world's 400 streamed
 * chunks (docs/plans/frame-budget-growth-and-draw-calls.md §A3): the p90 run is
 * 40 959 vertices, which is 13 653 whole triangles.
 *
 * IN TRIANGLES, NOT VERTICES, because that is the unit
 * `createChunkGeometryBuffers` and `ensureSuperCapacity` are denominated in and
 * every arena offset and length is a multiple of VERTICES_PER_TRIANGLE. A
 * headroom expressed in vertices could name a capacity that is not a whole
 * number of triangles.
 */
const ARENA_P90_RUN_TRIANGLES = 13_653;

/**
 * How many of a super-mesh's OWN largest run it must be able to absorb without
 * reallocating — and therefore also the multiplier on the floor below.
 *
 * TWO. A regrow appends at most one new run of about the old run's size WHILE
 * THE OLD RUN IS STILL LIVE (the splice frees it only on its way out), and a
 * brush straddles two chunks per step. One run's worth of slack is therefore
 * demonstrably not enough and three buys nothing the next quiet frame will not
 * provide.
 */
export const ARENA_HEADROOM_RUN_MULTIPLE = 2;

/**
 * The floor under a super-mesh's headroom, in TRIANGLES: two p90 runs.
 *
 * WHY A FLOOR AT ALL. `ARENA_HEADROOM_RUN_MULTIPLE × largest run` is measured
 * against what a super-mesh HAS ALREADY DRAWN, and a barely-revealed super-mesh
 * has drawn almost nothing — its largest run is a flat chunk's six vertices, so
 * the rule alone would leave it with the same accidental slack the whole
 * mechanism exists to remove. The floor sizes it for the run the world is
 * likely to hand it next instead.
 */
export const ARENA_HEADROOM_FLOOR_TRIANGLES =
  ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES;

/**
 * How long the terrain must go without an `update` before a super-mesh may be
 * grown, in milliseconds.
 *
 * TWICE SCULPT_REPEAT_DELAY_MS. A held brush's SLOWEST gap between intents is
 * its first repeat — SCULPT_REPEAT_DELAY_MS, 400 ms (input/sculptInput.ts) —
 * after which the interval ramps down to SCULPT_REPEAT_INTERVAL_MS. Waiting one
 * delay would let a slow first repeat read as a lifted brush and put the growth
 * back inside the stroke, which is the whole defect; two is the margin that
 * cannot.
 */
export const TERRAIN_QUIET_MS = 2 * SCULPT_REPEAT_DELAY_MS;

/** Terrain is dielectric; a little roughness variation is not worth a map. */
const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/**
 * Name of the per-vertex self-lit attribute, shared by the geometry (which
 * writes it) and the shader patch below (which reads it). One string, so a
 * rename cannot silently unbind the attribute and leave every rim dark again.
 */
const SELF_LIT_ATTRIBUTE = 'selfLit';

/**
 * Makes the terrain material honour that attribute: a vertex flagged SELF_LIT
 * is shaded as its own colour and nothing else.
 *
 * WHY THE MATERIAL HAS TO KNOW (owner, 2026-08-14, low-angle screenshot).
 * Underwater terrace seams are outlined by the brightened silt rim on each
 * one-band skirt (terrain/bandColors.ts). A skirt is vertical and the rig is a
 * single directional sun plus a hemisphere fill (render/scene.ts), so the two
 * orientations facing away from the sun receive almost no direct light: the
 * rims read from overhead and disappear from a low camera. That is a lighting
 * dependence and only the shading stage can remove it — the palette cannot,
 * because whatever value it produces is about to be multiplied by a factor that
 * varies ~5× with which way the terrace happens to turn.
 *
 * WHAT IT DOES. `outgoingLight` is the fully accumulated radiance for the
 * fragment, assembled just before `<opaque_fragment>` in three's meshphysical
 * shader; `diffuseColor.rgb` at that point is exactly the material colour times
 * the vertex colour, i.e. the palette entry in linear space. Mixing between
 * them by the flag replaces lit shading with the raw palette entry for flagged
 * vertices and leaves every other vertex byte-identical. The injection sits
 * BEFORE `<opaque_fragment>`, so tone mapping, output colour space and scene
 * fog all still apply to a rim exactly as they do to everything else — a rim in
 * the distance still fogs away; it just never goes dark for facing the wrong
 * way. Verified against three 0.185's src/renderers/shaders/ShaderLib/
 * meshphysical.glsl.js, where the include order is opaque → tonemapping →
 * colorspace → fog.
 *
 * WHY NOT A SECOND MATERIAL. BufferGeometry.addGroup with an unlit
 * MeshBasicMaterial is the native way to say "these triangles are not lit", and
 * it was the first candidate. It costs a second draw call on every chunk that
 * has any underwater geometry — and a Terrace world starts as an ocean, so that
 * is every chunk, doubling a fully revealed world's 1024 draw calls. It would
 * also force the emission order to put all rim triangles in one contiguous
 * range, which the builder's level-by-level walk does not naturally produce.
 * One byte per vertex and one line of GLSL costs neither.
 *
 * WHY NOT FAKE THE NORMALS. Pointing rim normals at the sky would light them
 * like treads with no new attribute at all, but flatShading derives its normal
 * from screen-space derivatives and ignores the attribute entirely, so it would
 * first require dropping flatShading; and it would leave the rims' brightness
 * still tied to the rig — a sun moved lower would darken every outline again.
 * It treats the symptom (these faces are dark) rather than the cause (these
 * faces are lit at all).
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
    // The colour attribute arrives as sRGB bytes (see ChunkGeometryBuffers'
    // colors), and three assumes a vertex colour is already in its linear
    // working space. Decode it here, once per vertex, immediately after
    // <color_vertex> has loaded vColor from the attribute — the exact sRGB
    // EOTF, not the 2.2-gamma approximation, because the deep end of the ramp
    // lives in the toe where the two disagree most.
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
 * Three's working colour space is linear and the palettes in bandColors.ts are
 * sRGB, so converting the palette entries ONCE here — rather than per vertex
 * per patch — was the whole reason bandColors separates "which entry" from
 * "the entry". Vertex-format compression ended that: the colour buffer is
 * bytes now, and the deep half of the ramp does not survive being quantised in
 * LINEAR (28 of the blue column's 64 adjacent stops collapse into ties, against
 * zero in sRGB — measured). So the sRGB values go to the GPU untouched and
 * <color_vertex> decodes them there, which costs one transfer per vertex on
 * hardware built to do exactly that and buys back the ramp.
 */
function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

/**
 * Chunks per super-mesh edge — the merge factor, and the whole point of this
 * module's 2026-08-21 rewrite.
 *
 * WHY MERGE AT ALL. A chunk is three things at once: the sync payload, the
 * reveal quantum, and — until now — the DRAW quantum. The first two are facts
 * about the protocol; the third was an accident of the first two, and it is
 * the one that costs. Measured on a live day-one world after the quarter-cell
 * re-sample: 400 terrain meshes drawing 19 000 triangles — about 34 triangles
 * per draw call, where a modern renderer carries thousands. A fully revealed
 * 2048² world is 16 384 chunks and therefore 16 384 draw calls, which is more
 * submission work than a AAA frame does to draw a thousand times the geometry.
 * Draw calls are CPU work per object and WebGL's are dearer than native's
 * (every one crosses into C++ and revalidates state), so the count IS the
 * bottleneck, and it scales with how much world has been revealed rather than
 * with what is on screen.
 *
 * EIGHT. A super-mesh then covers 8 × CHUNK_SPAN = 32 world units, and a
 * default 512-world-unit map is 16 × 16 = 256 of them instead of 16 384
 * meshes: a 64× cut. The value trades two things against each other and 8 is
 * the middle of them:
 *
 *   - CULLING GRANULARITY. A super-mesh is culled whole, so a merge factor
 *     large enough to span the view frustum stops culling from doing anything
 *     and the world's whole revealed geometry is submitted every frame. 32
 *     world units is well under the camera's own framing (CAMERA_INITIAL_
 *     DISTANCE is 80), so the horizon still culls.
 *   - EDIT COST. A sculpt re-packs the tail of ONE super-mesh (see
 *     spliceChunk), so the memmove grows with the square of this number.
 *
 * Raising it is the knob if draw calls are still the bottleneck; lowering it
 * is the knob if a pan starts submitting geometry that is behind the camera.
 * Both are measurable with `drawCallCount()` and renderer.info.
 */
export const SUPER_MESH_SPAN_CHUNKS = 8;

/** Non-indexed geometry: three vertices per triangle, never shared. */
const VERTICES_PER_TRIANGLE = 3;

/**
 * Where one chunk's vertices live inside its super-mesh's packed buffers.
 *
 * The chunk is still the unit of BUILDING — one chunk is what a sculpt
 * invalidates and what `writeChunkVertexData` knows how to emit — but it has
 * stopped being the unit of DRAWING.
 */
interface ChunkSlot {
  /** First vertex of this chunk's run, as an index into the packed buffers. */
  offset: number;
  /** Live vertices in the run. Moves on every rebuild that changes a contour. */
  count: number;
  /**
   * The run's own axis-aligned bounds, in world units — measured once, over the
   * ~4.5 k vertices the chunk was just emitted with, at the moment they are
   * copied in.
   *
   * WHY PER CHUNK. The super-mesh's bound has to be recomputed on every splice,
   * and computing it from the vertices means scanning every live vertex of the
   * super-mesh — 1.25 M on this world's busiest one, ~14 ms, for an edit that
   * touched 4.5 k of them. Kept per slot, the super-mesh's bound is the union
   * of at most SUPER_MESH_SPAN_CHUNKS² = 64 boxes.
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
 * ZEROED IN ALL FOUR ATTRIBUTES, which is what makes a hole safe to leave
 * inside the draw range: three zero positions are a triangle of zero area at
 * the world origin, so it produces no fragments, and `Ray.intersectTriangle`
 * rejects it outright (`DdN === 0`) so a raycast cannot hit one either.
 * Zeroing the other three attributes costs 7 of the 19 bytes a hole vertex
 * would otherwise keep, and buys one recognisable byte pattern for "dead" —
 * a deliberate trade.
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
   * The subset of `growths` taken DURING A SPLICE — every one `settle` did not
   * schedule.
   *
   * READ IT AS A DELTA, NOT AS A TOTAL. A splice grows for two different
   * reasons: streaming a world in climbs the doubling ladder chunk by chunk
   * (accepted — it happens over a reveal, off the stroke), and a stroke that
   * outruns its headroom reallocates on a frame the player is watching (the
   * defect issue #229 is about). The counter cannot tell them apart, and no
   * state on the super-mesh can; what says which is which is WHEN it moved. So
   * the contract is that this number does not change across a stroke, and the
   * bench and the probe report it before and after one.
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
   * The dead runs between the live ones, SORTED BY OFFSET AND COALESCED, every
   * offset and length a multiple of VERTICES_PER_TRIANGLE. Bounded by one hole
   * per run plus one, so at most SUPER_MESH_SPAN_CHUNKS² + 1 entries.
   *
   * Maintained by exactly one insert/take pair (`insertHole`/`takeHole`) so
   * that "sorted", "coalesced", "aligned" and the retreat rule are properties
   * of the LIST rather than things every caller has to remember.
   */
  holes: Hole[];
  /**
   * The arena's extent: one past the highest live vertex, and the geometry's
   * draw range. AT LEAST the sum of the slot counts, and more than it exactly
   * when the free list is non-empty.
   */
  liveEnd: number;
  /**
   * True once these buffers have been reallocated during the current drain
   * pass, and reset by the frame hook (or by `flush`).
   *
   * WHY IT IS A FLAG AND NOT A RETURN VALUE. `bindGeometry` installs brand-new
   * BufferAttributes, and three's create path (`WebGLAttributes.update` with
   * `data === undefined`) takes a full `bufferData` WITHOUT clearing
   * `updateRanges` — only `updateBuffer` clears them. Any range added to that
   * super-mesh later in the same pass is therefore uploaded a second time on
   * the next frame. The packed layout had one range producer per pass (the
   * splice) and could carry this as a local `grew`; the arena has two (splices
   * and compaction), so the fact has to live on the super-mesh.
   *
   * WRITTEN ONLY BY `bindGeometry`, never by its callers: the flag is true of
   * exactly the super-meshes whose attributes were replaced this pass, and a
   * caller that binds without saying so puts the double upload back. The
   * initial value here is `false` because `createSuperMesh` binds immediately
   * afterwards, which is what sets it.
   */
  reallocatedThisPass: boolean;
  /** How many times the buffers have been reallocated — reported by arenaStats. */
  growths: number;
  /** Of those, the ones taken during a splice — see `ArenaStats.strokeGrowths`. */
  strokeGrowths: number;
}

/**
 * Which seam a capacity growth was taken from — the whole distinction part A of
 * docs/plans/frame-budget-growth-and-draw-calls.md is about.
 *
 * REQUIRED AT EVERY CALLSITE rather than defaulted, so a future call cannot be
 * counted as planned growth by forgetting to say what it is.
 */
type GrowthSite =
  /** Inside `spliceChunk`, i.e. inside a stroke. Counted in `strokeGrowths`. */
  | 'splice'
  /** From `settle`, on a quiet frame. The growth the headroom rule schedules. */
  | 'settle';

/**
 * How the builder gets its frames. Absent means "there are none" — see the
 * module header's NO FRAME HOOK note for why that is a real mode and not a
 * test-only one.
 */
export interface MeshScheduling {
  /** Registers a per-frame handler and returns its unsubscribe. */
  onFrame: (handler: (dt: number) => void) => () => void;
  /**
   * Monotonic millisecond clock the drain budget is measured against.
   * Injectable so a test can advance time by a known amount instead of racing
   * a real one; defaults to `performance.now`.
   */
  now?: () => number;
}

/** See `TerrainMeshes.settle`. */
export interface SettleOptions {
  /**
   * Skips the "no `update` for TERRAIN_QUIET_MS" half of the quiet test,
   * because the CALLER knows the terrain is done.
   *
   * WHY IT HAS TO EXIST. The timestamp gate asks how long it has been since
   * `update` was called, and a caller with no frame hook runs
   * `update(everything); flush(); settle();` in ONE synchronous turn — so
   * whether the headroom pass did anything was decided by how long the build
   * in between happened to take, silently, with the call reporting nothing
   * either way. That is a wall-clock race in exactly the harnesses whose whole
   * purpose is to be a finished world, and it makes the bench's
   * "after settle()" row able to print success-shaped output from a pass that
   * never ran.
   *
   * IT SKIPS THE TIMESTAMP GATE ONLY. The queue test — no chunk of this
   * super-mesh in `pending`, `inFlight`, `ready` or `retry` — still applies,
   * and it is the half that protects correctness: growing a super-mesh whose
   * run is about to be spliced in would pay a second full `bufferData`. What
   * the caller is allowed to assert is that no MORE work is coming, never that
   * the work already queued is done.
   *
   * A NAMED OPTION rather than a positional boolean: `settle(true)` at a
   * callsite says nothing about what is being asserted.
   */
  readonly assumeQuiet?: boolean;
}

export interface TerrainMeshes {
  /**
   * Marks the given chunks for rebuild. Indices for chunks the mirror has not
   * received are ignored — that is the mechanism by which locked terrain stays
   * invisible.
   *
   * Builds nothing itself when a frame hook was supplied; the queue is drained
   * on frames, under a budget (see the module header). Without a frame hook
   * this drains inline and the call is exactly what it always was.
   *
   * A chunk marked twice before it is built is built ONCE, from the mirror's
   * state at drain time — so a held stroke that re-dirties the same chunk eight
   * times a second costs one rebuild per frame, not eight, and always draws the
   * newest heights rather than a backlog of stale ones.
   */
  update(dirty: Iterable<number>): void;
  /** Builds every queued chunk now, whatever the budget says. */
  flush(): void;
  /**
   * Gives one QUIET super-mesh the free capacity it is short of, so that a
   * later stroke does not have to reallocate to make room (issue #229).
   *
   * Run from the frame hook after the frame's splices and compaction, which is
   * where a client gets it for nothing. It is public because the paths with no
   * frame hook — the preview harnesses, the bench, the tests — build their
   * world and then stop, and "the terrain has gone quiet" is a moment only they
   * can name. Calling it while the terrain is busy is safe and does nothing:
   * the quiet test is inside.
   *
   * Deliberately NOT called by `flush` — see the implementation.
   */
  settle(options?: SettleOptions): void;
  /**
   * Chunks that have been marked dirty and are not yet drawn — queued, out at
   * the build source, answered and waiting for a frame's splice budget, or
   * waiting to be retried after a lost build. All four are "still waiting",
   * which is the question every caller asks.
   */
  pendingCount(): number;
  /** Drops every mesh — used when a fresh join replaces the world. */
  clear(): void;
  /**
   * The drawn meshes — ONE PER SUPER-MESH, not one per chunk.
   *
   * Named for the raycasting it used to serve. Nothing in the client raycasts
   * terrain any more (input picking marches the height field instead — see
   * terrain/picking.ts), so this survives for the differential test that pins
   * that march against the mesh it replaced, and for tests that inspect the
   * geometry the renderer actually submits.
   */
  pickables(): Mesh[];
  /**
   * What the terrain HAS DRAWN, chunk by chunk — the store `writeChunkVertexData`
   * publishes into as each chunk is built (terrain/drawnGroundStore.ts).
   *
   * OWNED HERE because the emitter is here: an entry is written by the same call
   * that writes the chunk's vertices and replaced by the same call that redraws
   * them, which is what lets a reader (`terrain/drawnGround.ts`) hold one for the
   * mirror's whole lifetime instead of being invalidated by hand at every site
   * that touches terrain. Cleared by `clear()` along with the meshes it
   * describes.
   */
  drawnGround(): DrawnGroundStore;
  /**
   * Registers a handler run immediately after one chunk has been BUILT and its
   * chart published; returns its unsubscribe.
   *
   * WHY A BUILD EVENT AND NOT THE DIRTY SET. `update` queues; the queue drains
   * under a frame budget. Anything derived from what a chunk DREW — the terrace
   * lip overlay, above all — that refreshed itself from the dirty set would
   * read an absent or pre-edit chart for every chunk whose build was deferred.
   * This is the seam that says "this chunk's published geometry has just been
   * replaced", which is the only moment such a reader is right.
   */
  onChunkDrawn(handler: (chunkIdx: number) => void): () => void;
  /**
   * Terrain draw calls the renderer would submit with nothing culled — the
   * number this module exists to keep down, exposed so a test can hold a
   * budget against it rather than trusting the comment above.
   */
  drawCallCount(): number;
  /**
   * Median wall-clock cost of a SPLICE — copying one finished job into its
   * super-mesh, publishing its chart and refreshing its lips — over the last
   * SPLICE_SAMPLE_WINDOW of them, or null before any have run.
   *
   * The number CHUNK_SPLICE_FRAME_BUDGET_MS is sized against, and the one
   * figure this module's move to a worker has to be judged on that a headless
   * bench cannot report: in node the direct source builds inline, so the bench
   * measures the whole build and never the splice alone. Exposed so an
   * in-browser probe can report it beside the frame rate.
   */
  medianSpliceMs(): number | null;
  /**
   * Arena occupancy per super-mesh, in `pickables()` order.
   *
   * THE SEAM THE ARENA IS JUDGED ON. Dead space is not asserted as a constant
   * anywhere — the plan's §3d argues convergence, not a bound — so what the
   * tests, the bench and the in-page perf probe do instead is OBSERVE it. The
   * vertex-shader cost of holes is proportional to `deadVertices`, and
   * `growths` is the count of the one upload the arena does not bound (a
   * capacity doubling is still a full `bufferData`; plan §5).
   */
  arenaStats(): ArenaStats[];
  /**
   * Where every run and every hole actually sits, per super-mesh, in
   * `pickables()` order.
   *
   * FOR TESTS. The free list's invariants — sorted, coalesced, aligned to
   * VERTICES_PER_TRIANGLE, never reaching `liveEnd` — are the reason a hole is
   * safe to leave inside the draw range, and they are checkable only against
   * the layout itself. Exposing it beats casting into the module.
   */
  arenaLayout(): ArenaLayout[];
  /**
   * Chunks whose geometry is in the scene.
   *
   * The mesh count stopped answering this at the 2026-08-21 merge, and several
   * tests had been using it as a proxy for "how many chunks got built" — for
   * the drain budget, and for locked terrain staying invisible. Both are real
   * contracts about CHUNKS, so they get a number about chunks rather than one
   * about whatever the renderer currently groups them into.
   */
  builtChunkCount(): number;
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
  scheduling?: MeshScheduling,
  /**
   * Where chunk geometry is built. Defaults to the direct (this-thread) source,
   * which is what tests and the preview harnesses want; the client passes the
   * worker-backed one. See render/chunkBuildSource.ts.
   */
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
    // Terrain is a closed-ish surface but the camera can dip toward the
    // horizon and see the underside of a far terrace; DoubleSide costs nothing
    // here (no shadows, no transparency) and avoids the holes that would show.
    side: DoubleSide,
  });
  makeSelfLitAware(material);
  // The ground darkens under whatever the plugins have put in the sky (#284).
  // AFTER makeSelfLitAware, and it chains rather than replacing: the shade
  // multiplies `outgoingLight` at <opaque_fragment>, which is the same anchor
  // the self-lit mix uses and immediately after it, so a rim triangle that has
  // just been mixed toward its own unlit colour is then shaded like everything
  // else — a cloud's shadow crossing a terrace outline must not stop at it.
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
   * Points the geometry at the super-mesh's CURRENT buffers. Run when the
   * super-mesh is created and again whenever its buffers had to grow — a typed
   * array cannot be resized, so growth means new arrays and therefore new
   * attributes, and the old geometry is disposed rather than left holding its
   * GPU buffers.
   *
   * IT IS ALSO WHAT SETS `reallocatedThisPass`, because it is the operation the
   * flag is a fact about: brand-new BufferAttributes take three's create path,
   * which uploads everything and leaves `updateRanges` UNCLEARED (only
   * `updateBuffer` clears them — WebGLAttributes.js:147), so every range added
   * to this super-mesh later in the pass is uploaded a second time on the next
   * frame. It used to be set by the caller, and the OTHER caller —
   * `createSuperMesh` — did not: a chunk streaming in got a fresh super-mesh
   * and spliced into it in the same pass, leaking that chunk's four ranges into
   * the following frame's upload. Set here, no caller can forget it.
   */
  const bindGeometry = (sm: SuperMesh): void => {
    sm.reallocatedThisPass = true;
    const positionAttribute = new BufferAttribute(sm.buffers.positions, 3);
    // `true` = NORMALIZED: the GPU reads these byte attributes back as
    // value/127 (signed) and value/255 (unsigned). Omitting the flag would feed
    // the shader raw integers up to 255 and blow out both lighting and colour.
    const normalAttribute = new BufferAttribute(sm.buffers.normals, 3, true);
    const colorAttribute = new BufferAttribute(sm.buffers.colors, 3, true);
    // NORMALISED, so the shader reads the flag's 0/255 bytes as 0.0/1.0 and the
    // injected mix() needs no conversion of its own.
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

    // LAST, AND IT HAS TO BE HERE. The geometry above is brand new and its
    // `boundingSphere` is null, and three computes a null sphere over the WHOLE
    // position attribute — including the dead tail past `liveEnd`, which
    // holds whatever a previous, longer occupant left there and would stretch
    // the sphere to the origin. Setting it here means a regrow never leaves a
    // window in which that can happen. Do not move it into the callers.
    updateBounds(sm);
  };

  /**
   * Grows a super-mesh's buffers to hold at least `vertices`, preserving what
   * is already in them, and rebinds. Returns true if it had to.
   *
   * GROWTH IS GEOMETRIC (doubling) rather than exact: a world fills in chunk by
   * chunk, and growing by one chunk's worth each time would reallocate and copy
   * the whole super-buffer on every chunk of every super-mesh — quadratic in
   * the chunk count, paid during the reveal the player is watching.
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
    // `bindGeometry` below, and so is the `reallocatedThisPass` flag that keeps
    // the rest of the pass from adding ranges on top of that upload. See the
    // field, and bindGeometry's own note.
    sm.growths++;
    if (site === 'splice') sm.strokeGrowths++;
    bindGeometry(sm);
    return true;
  };

  /**
   * The bound the renderer culls against: the union of the super-mesh's slot
   * boxes, which is O(64) rather than O(live vertices).
   *
   * EXACT, not conservative. The union of the chunks' own measured boxes IS the
   * AABB of the live vertices — a static box derived from the world size and
   * the height range would be wrong for every partially revealed super-mesh,
   * which is most of them while a world is being explored.
   *
   * The SPHERE is the AABB's centre plus its half-diagonal, which is
   * marginally looser than the old max-distance-over-vertices radius (that one
   * needed a second pass over every vertex to find the farthest). A looser
   * sphere culls a hair later; it never culls something that should be drawn.
   *
   * Hand-rolled rather than `geometry.computeBoundingSphere()` because that
   * reads the whole position attribute, and the tail past `liveEnd` is
   * whatever a previous, longer occupant left there.
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
      return;
    }
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
   * WITHOUT THIS, `needsUpdate` alone re-uploads the WHOLE attribute — tens of
   * megabytes on a developed super-mesh — for a splice that rewrote one chunk.
   * three's ranges are in ARRAY ELEMENTS, not vertices, so the vertex range is
   * scaled by the attribute's itemSize (WebGLAttributes.js:141 passes
   * `range.start`/`range.count` straight to `bufferSubData`'s element offsets).
   * three clears the ranges itself once it has uploaded them
   * (WebGLAttributes.js:147), so there is nothing to reset here.
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
   * Declares one vertex range of one super-mesh as the only part needing
   * re-upload, on all four attributes.
   *
   * CLAMPED TO THE ARENA, and skipped entirely on a super-mesh that
   * reallocated during this pass (§3e). Clamping is not defensive: the retreat
   * rule can pull `liveEnd` back BELOW a range that was correct when it was
   * computed — a shrink whose hole reached the end, say — and those vertices
   * leave the draw range instead of being uploaded as zeroes.
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
   * THE RETREAT RULE, and it is an invariant of the LIST rather than of any one
   * insertion: a hole that ends at the arena's extent is not dead space at all
   * — it is space that has simply stopped being live. Dropping it and pulling
   * `liveEnd` back costs no upload, because those vertices leave the draw range
   * instead of being sent as zeroes.
   *
   * A loop rather than an `if` only so the rule is stated as "while the list
   * still ends at `liveEnd`"; a coalesced list can never satisfy it twice.
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

  /**
   * Adds one dead run to the free list, keeping it sorted, coalesced and
   * retreated. THE ONLY WAY A HOLE IS EVER CREATED.
   */
  const insertHole = (sm: SuperMesh, offset: number, length: number): void => {
    if (length <= 0) return;
    let at = 0;
    while (at < sm.holes.length && sm.holes[at]!.offset < offset) at++;
    sm.holes.splice(at, 0, { offset, length });
    // FORWARD FIRST, then backward: merging with the next entry can make this
    // one adjacent to the previous, and doing it the other way round would
    // leave that second merge for nobody.
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
   * surplus stays on the list. Returns where the run may be written and how
   * many vertices of surplus follow it, or null if nothing fits.
   *
   * Lowest-first rather than best-fit because it keeps the live geometry
   * bunched toward offset 0, which is what makes the compactor's job short —
   * and because a best-fit scan would still be O(64) while leaving the arena
   * more scattered.
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
      // No retreat check: the split hole ENDS where the original did, so if it
      // had reached `liveEnd` the rule would already have removed it.
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
   * IN ONE PIECE, NEVER SPLIT ACROSS FRAMES: a partially moved live run draws
   * garbage between its halves. A run too dear for this frame's budget is
   * skipped and waits for a cheaper frame; that is the caller's decision, and
   * this function only ever runs when it has been made.
   *
   * The upload is one run plus one hole — `[hole.offset, oldRunEnd)` — and the
   * slot's BOUNDS are untouched, because a move changes where a run lives and
   * not what it contains.
   */
  const moveRunDown = (sm: SuperMesh, hole: Hole, run: ChunkSlot): void => {
    const from = run.offset;
    const runEnd = from + run.count;
    const to = hole.offset;
    const { positions, normals, colors, selfLit } = sm.buffers;
    // copyWithin, not set(subarray): source and destination overlap whenever
    // the hole is shorter than the run, and copyWithin is specified to behave
    // as if the range were copied first.
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
   * Closes holes, cheapest-first in free-list order, for as long as
   * `budgetMs` of ESTIMATED transfer is left. Returns what it spent.
   *
   * A skipped run is not a failure: the next hole is tried, and the run waits
   * for a frame with more budget (ARENA_COMPACT_IDLE_BUDGET_MS). Convergence
   * is not a constant here and is not asserted as one — one full sweep is at
   * most one move per run, since the lowest hole is carried past exactly one
   * run per move and absorbs every hole it meets.
   */
  const compactSuperMesh = (sm: SuperMesh, budgetMs: number): number => {
    let spentMs = 0;
    for (;;) {
      let moved = false;
      for (const hole of sm.holes) {
        const run = runStartingAt(sm, hole.offset + hole.length);
        // Only the highest hole can have no run above it, and the retreat rule
        // has already taken that one off the list.
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

  /**
   * One frame's compaction across every super-mesh, sharing one budget.
   *
   * SHARED, not per super-mesh: the budget is a statement about how much
   * transfer this FRAME can afford, and four super-meshes each spending it
   * would spend four times what the frame has.
   */
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
   * wherever it now fits — and never moving anybody else's.
   *
   * THE CONTRACT (docs/plans/vertex-arena-no-tail-move.md §2): a splice's
   * upload is bounded by the chunk it splices, never by the super-mesh. The
   * runs used to be packed in chunk-index order, so a chunk whose vertex count
   * changed moved every run after it and the ranged upload had to cover
   * `[slot.offset, liveEnd)` — measured on the owner's world at 19–21 MB per
   * stroke step on the busiest super-mesh, which is the whole 1.25 M-vertex
   * arena, twice per step for a two-chunk brush. Under the arena the upload is
   * this chunk's own run plus the run it vacated.
   *
   * WHY NOT A FIXED SLOT PER CHUNK (the alternative the packed layout was
   * chosen over, restated with the constants as they stand in 2026-08-28).
   * Sized for the worst chunk the builder may emit — CHUNK_TRIANGLE_BUDGET,
   * 131 072 triangles = 393 216 vertices = 7.5 MB — a super-mesh of
   * SUPER_MESH_SPAN_CHUNKS² = 64 slots is ~480 MB of buffer and submits ~8.4 M
   * triangles a frame to draw the ~50 k it holds. Sized for
   * INITIAL_CHUNK_TRIANGLE_CAPACITY (1 024 triangles = 3 072 vertices) instead,
   * it cannot hold the owner's world's MEDIAN chunk, which is 5 388 vertices.
   * There is no slot size that is both affordable and sufficient; the arena
   * gives every chunk exactly its own size and keeps the dead space on a list.
   *
   * PLACEMENT, decided first and capacity second (§3b). For a run of `count`
   * vertices replacing one of `old` at `[offset, offset+old)`:
   *
   *   1. count === old — overwrite in place. Upload: the run.
   *   2. count < old — overwrite in place; the remainder becomes a hole.
   *      Upload: the run and the hole, which are contiguous.
   *   3. count > old and the run ends at `liveEnd` — extend in place. This is
   *      the common case for a one-chunk super-mesh (every preview harness),
   *      and it is what keeps those hole-free. Upload: the run.
   *   4. count > old — the lowest hole that fits, split. Upload: the new run,
   *      the surplus, and the old run being zeroed. Three DISJOINT ranges, and
   *      three's own merge (`range.start <= prev.start + prev.count + 1`,
   *      WebGLAttributes.js) only joins adjacent ones, so they stay separate
   *      `bufferSubData` calls and the bound holds.
   *   5. count > old and nothing fits — append at `liveEnd`. Upload: the new
   *      run and the old one.
   *
   * A chunk arriving for the first time is case 3, 4 or 5 with `old = 0`.
   */
  const spliceChunk = (sm: SuperMesh, chunkIdx: number, answer: ChunkJobAnswer): void => {
    const count = answer.vertexCount;
    let slot = sm.slots.get(chunkIdx);
    if (slot === undefined) {
      slot = {
        // Placed below, by the same rules as any other run. An empty run at 0
        // is case 3 on an empty super-mesh and case 4/5 on a populated one,
        // which is exactly what "a new chunk" means.
        offset: 0,
        count: 0,
        // An empty box (min > max), which `updateBounds` skips. Filled by the
        // bounds copy below, in this same call.
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
      // Cases 1 and 2. The hole (empty when the counts match) is contiguous
      // with the run, so one range covers both.
      zeroVertices(sm, slot.offset + count, old - count);
      dirtied.push([slot.offset, old]);
      slot.count = count;
      insertHole(sm, slot.offset + count, old - count);
    } else if (slot.offset + old === sm.liveEnd) {
      // Case 3. CAPACITY IS AN EXTENT, not a delta: what has to fit is where
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
        // Case 5. COMPACT BEFORE DOUBLING: a capacity growth is one full
        // `bufferData` of the whole super-mesh (the arena does not bound that
        // one — plan §5), and a full sweep of the compactor is cheaper than it
        // whenever the arena is holding enough dead space to make room. This is
        // the one place a sweep runs without a budget.
        if (sm.liveEnd + count > capacityVertices(sm) && sm.holes.length > 0) {
          compactSuperMesh(sm, Infinity);
        }
        // CAPACITY FROM `count`, NEVER FROM `delta`. The packed layout left the
        // run where it was and needed `delta` more vertices; an append writes
        // the WHOLE run past the live end, so a test phrased in `delta`
        // under-requests by `old` and `set()` runs off the buffer — a
        // RangeError inside the frame hook.
        ensureSuperCapacity(sm, sm.liveEnd + count, 'splice');
        // READ AFTER THE COMPACTION, not before it: a sweep moves live runs,
        // and this chunk's own run is one of them.
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

    // MEASURED WHERE THE VERTICES WERE MADE, not here: the job walked them
    // once on its way out and sent six floats.
    slot.minX = answer.bounds[0]!;
    slot.minY = answer.bounds[1]!;
    slot.minZ = answer.bounds[2]!;
    slot.maxX = answer.bounds[3]!;
    slot.maxY = answer.bounds[4]!;
    slot.maxZ = answer.bounds[5]!;

    markDirty(sm);
    for (const [startVertex, vertexCount] of dirtied) addRange(sm, startVertex, vertexCount);

    // On non-indexed geometry the draw range counts VERTICES, and it covers the
    // arena's whole extent — holes included, which is what makes them have to
    // be zeroed rather than merely forgotten.
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
    updateBounds(sm);
  };

  /**
   * Chunks marked dirty and not yet rebuilt, in the order they were marked.
   *
   * A SET, so a chunk re-dirtied while it waits is still built once, and built
   * from the mirror's state at drain time rather than from the state it had
   * when it was marked. Insertion order is the drain order, which makes the
   * queue deterministic — the same sequence of updates always builds in the
   * same sequence, whatever the frame budget happens to allow on the day.
   */
  const pending = new Set<number>();

  /**
   * Chunks whose job is out and whose answer has not landed.
   *
   * AT MOST ONE JOB PER CHUNK, and it is an enforced invariant rather than an
   * implication of the queue. Two answers for one chunk could come back from
   * two workers in either order, and the older one splicing last would leave
   * the chunk drawing pre-edit geometry until something else dirtied it. A
   * chunk re-dirtied while its job is out simply stays in `pending` and is
   * re-submitted when the answer lands — the answer in flight is a correct
   * earlier picture, exactly as a queued build has always been.
   */
  const inFlight = new Set<number>();

  /** Finished jobs waiting for a frame's splice budget. */
  const ready: ChunkJobAnswer[] = [];

  /**
   * Chunks whose build was LOST (`ChunkBuildSource.build` answered null) and
   * which must be built again.
   *
   * A HOLDING PEN RATHER THAN `pending` DIRECTLY, and the reason is the one way
   * a retry can go wrong: a source is allowed to fail SYNCHRONOUSLY, inside
   * `submit`, and a chunk put straight back into `pending` there would be the
   * very chunk `nextSubmittable` hands the same loop on its next turn — a spin
   * that never ends and never builds anything. This set is merged into
   * `pending` only at the TOP of a drain or flush pass, so a lost job is
   * retried by the NEXT pass and never by the one that lost it.
   */
  const retry = new Set<number>();

  /**
   * A ring of recent splice costs — long enough to survive a held stroke's
   * worth of edits (a stroke emits ~8 intents a second and this keeps a few
   * seconds of them), short enough that the median tracks the world as it is
   * now rather than as it was when it was empty.
   */
  const SPLICE_SAMPLE_WINDOW = 64;
  const spliceMs: number[] = [];
  let spliceMsNext = 0;

  /**
   * Bumped whenever the world this builder draws is replaced. An answer
   * stamped with an older one is a picture of a world that no longer exists —
   * a rejoin, a world switch — and is dropped rather than spliced.
   */
  let generation = 0;

  /**
   * Takes one build's outcome off the pool. `answer` is null when the build
   * produced nothing — see `ChunkBuildSource.build`'s failure contract. The
   * chunk index is passed separately for exactly that case: a lost job has no
   * answer to read it from.
   */
  const receive = (chunkIdx: number, answer: ChunkJobAnswer | null): void => {
    inFlight.delete(chunkIdx);
    if (answer === null) {
      // TRIED AGAIN, not dropped: the chunk is still dirty and still drawing
      // its pre-edit geometry, so a later pass must build it — on a surviving
      // worker, or on this thread once the pool has none.
      if (mirror.received.has(chunkIdx)) retry.add(chunkIdx);
      return;
    }
    if (answer.generation !== generation) return;
    // Re-checked on ARRIVAL as well as on submission: a chunk can leave
    // `received` while its job is out (a rejoin replaces the world), and
    // splicing geometry for a chunk the mirror no longer holds would draw
    // terrain that is not there.
    if (!mirror.received.has(answer.chunkIdx)) return;
    ready.push(answer);
  };

  /** Sends one queued chunk to the build source. */
  const submit = (chunkIdx: number): void => {
    // Re-checked at SUBMIT time, not at queue time: a chunk can be dropped
    // from `received` between the two, and building one the mirror no longer
    // holds would read heights that are not there.
    if (!mirror.received.has(chunkIdx)) return;
    inFlight.add(chunkIdx);
    const answer = buildSource.build(mirror, chunkIdx, generation);
    if (answer instanceof Promise) void answer.then((settled) => receive(chunkIdx, settled));
    else receive(chunkIdx, answer);
  };

  /** Splices one finished job into its super-mesh, creating that if needed. */
  const spliceAnswer = (answer: ChunkJobAnswer): void => {
    const startedMs = now();
    // HANDED OVER, not re-derived. The plan this chunk was emitted from is
    // published here rather than planned a second time by whoever needs to know
    // what the rock looks like — see terrain/drawnGroundStore.ts. It arrives
    // already flat and already rasterised, from wherever the chunk was built.
    drawnGroundStore.publishRastered(
      answer.chunkIdx,
      answer.plan,
      answer.topLevel,
      answer.lips,
    );
    const superIdx = superIndexOf(answer.chunkIdx);
    const sm = superMeshes.get(superIdx) ?? createSuperMesh(superIdx);
    spliceChunk(sm, answer.chunkIdx, answer);
    // AFTER the splice and after the publish, so a handler sees both the chart
    // and the vertices this build produced.
    for (const handler of chunkDrawnHandlers) handler(answer.chunkIdx);
    // Timed around ALL THREE, because all three are what a frame pays per
    // answer — the run placement, the chart publish and the lip refresh.
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

  /**
   * Submits what the pool has room for, then splices finished answers until
   * `budgetMs` of wall clock is gone.
   *
   * ALWAYS SPLICES AT LEAST ONE, and that is not a rounding convenience: a
   * splice costing more than the entire budget would otherwise never happen and
   * the queue would stall permanently with the terrain frozen behind it.
   * Checking the clock AFTER a splice rather than before is what expresses that
   * — the first splice of a frame is unconditional and every one after it has
   * to fit. The constant is therefore a floor on progress, not a ceiling on
   * cost.
   */
  /** Folds lost builds back into the queue. Called at the top of a pass only. */
  const takeRetries = (): void => {
    if (retry.size === 0) return;
    for (const chunkIdx of retry) pending.add(chunkIdx);
    retry.clear();
  };

  /** Returns how many answers it spliced — what decides the compaction budget. */
  const drain = (budgetMs: number): number => {
    takeRetries();
    let spliced = 0;
    if (pending.size === 0 && ready.length === 0) return spliced;
    const startedMs = now();
    for (;;) {
      // Top the pool up FIRST, so a worker is never idle while this thread
      // splices.
      //
      // FINISHED ANSWERS COUNT AGAINST THE POOL, and that is what bounds the
      // DIRECT source. Its `build` returns an answer that is already finished,
      // so `receive` runs inline and has released the `inFlight` slot before
      // `submit` even returns: a condition on `inFlight.size` alone re-tests
      // 0 < 1 for ever and builds EVERY pending chunk inside one drain call,
      // ignoring the budget entirely (the clock is only read after a splice).
      // Counting `ready` too means one unspliced answer is one occupied slot,
      // so the direct path builds exactly one chunk per pass and the budget
      // bounds building as well as splicing — which is what the worker path
      // gets for free, its answers being genuinely in flight. `flush` is the
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
   * worker source cannot finish on this thread by definition, so a client using
   * it gets "everything submitted, and everything already answered spliced" —
   * which is all a flush can honestly mean there. Every caller that depends on
   * the world being complete when this returns (the tests, the preview
   * harnesses) is on the direct source.
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
    // "BUILD EVERYTHING NOW" ALSO MEANS "AND LEAVE NO HOLES". Every caller of
    // this path — the headless suite, the six preview-* harnesses, the bench —
    // wants the world finished when it returns, and an arena still holding dead
    // space is not finished. There is no later frame to compact on.
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
    // The queue holds indices into the world being dropped. Draining them
    // against the replacement would build chunks nobody asked for, at best;
    // this is why clear() and not just dispose() empties it.
    pending.clear();
    // Same reasoning: a lost build's chunk index belongs to the world going
    // away, and rebuilding it against the replacement would draw terrain
    // nobody asked for.
    retry.clear();
    // And the jobs already out are pictures of the world being dropped. The
    // generation bump is what makes their answers arrive and be discarded.
    inFlight.clear();
    ready.length = 0;
    generation++;
  };

  /**
   * COMPACTION IS ITS OWN SEAM ON THE FRAME, not a step inside `drain`.
   *
   * `drain` returns the moment there is nothing to build and nothing to splice,
   * so a settled frame — the only kind with budget to spare — would never reach
   * anything placed after the splices inside it. And a stroke frame's FIRST
   * splice already spends the splice budget (medianSpliceMs 1.4–1.7 against
   * CHUNK_SPLICE_FRAME_BUDGET_MS's 1.5), so compaction sharing that budget
   * would never run either. Two budgets, two seams.
   */
  /**
   * When `update` was last called, on the same clock the budgets are measured
   * against. Half of the quiet test — see `settle`.
   *
   * NEGATIVE INFINITY until the first update, because "nothing has been asked
   * of the terrain yet" is the quietest the terrain ever is.
   */
  let lastUpdateMs = Number.NEGATIVE_INFINITY;

  /** The largest run this super-mesh currently holds, in vertices. */
  const largestRunVertices = (sm: SuperMesh): number => {
    let largest = 0;
    for (const slot of sm.slots.values()) {
      if (slot.count > largest) largest = slot.count;
    }
    return largest;
  };

  /**
   * Free capacity this super-mesh must hold when the terrain is quiet, in
   * vertices: ARENA_HEADROOM_RUN_MULTIPLE times its own largest run, never
   * below ARENA_HEADROOM_FLOOR_TRIANGLES.
   */
  const headroom = (sm: SuperMesh): number =>
    Math.max(
      ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices(sm),
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );

  /**
   * Whether any chunk of this super-mesh is still on its way to being drawn —
   * queued, out at the build source, answered and awaiting a splice, or waiting
   * to be retried.
   *
   * ALL FOUR QUEUES, AND `drain` RETURNING 0 IS NOT A SUBSTITUTE: on the worker
   * source most reveal frames splice nothing while jobs are out, and during a
   * held stroke roughly sixteen of every seventeen frames splice nothing
   * between intents. Either would read as quiet.
   *
   * O(queue) per call, and the queues are empty exactly when it matters.
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
   * THE CONTRACT: when the terrain is quiet, every super-mesh holds at least
   * `headroom(sm)` of free capacity, and capacity is only ever GROWN while the
   * terrain is quiet. Before this seam existed, how much slack a super-mesh had
   * after streaming was an accident of where the doubling ladder stopped, so
   * whether a stroke reallocated — one full `bufferData` of the whole
   * super-mesh, measured at ~3 MB and up to 505 ms, on a frame the player is
   * watching — was decided by streaming order rather than by anything.
   *
   * ONE SUPER-MESH PER CALL. Each growth is one `bufferData` of a whole
   * super-mesh (≤ 30 MB ≈ 30 ms on the owner's world at
   * ARENA_TRANSFER_MS_PER_VERTEX); paying several on one frame would replace a
   * stroke hitch with a bigger idle one.
   *
   * NOT CALLED BY `flush`. On the no-scheduler path `update` calls `flush` on
   * every sculpt step, so a headroom pass there would be growth inside the
   * stroke — precisely what this exists to prevent.
   */
  const settle = (options?: SettleOptions): void => {
    // The global half of the quiet test, checked once: no `update` at all
    // within the window means no super-mesh can be quiet. A caller that has
    // just finished building a world knows this without a clock and says so —
    // see SettleOptions.assumeQuiet, which skips THIS gate and not the queue
    // test below it.
    if (options?.assumeQuiet !== true && now() - lastUpdateMs < TERRAIN_QUIET_MS) return;
    for (const [superIdx, sm] of superMeshes) {
      if (capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      if (superMeshHasChunkQueued(superIdx)) continue;
      // Deliberately NOT a second rounding ladder: `ensureSuperCapacity` keeps
      // its doubling-from-current rule and lands on whichever rung holds this.
      ensureSuperCapacity(sm, sm.liveEnd + headroom(sm), 'settle');
      return;
    }
  };

  const stopDraining = scheduling?.onFrame(() => {
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    const spliced = drain(CHUNK_SPLICE_FRAME_BUDGET_MS);
    compact(spliced > 0 ? ARENA_COMPACT_STROKE_BUDGET_MS : ARENA_COMPACT_IDLE_BUDGET_MS);
    // LAST, AND ONLY HERE. `settle` is the one seam allowed to reallocate, and
    // it must see this frame's splices and compaction before deciding whether
    // the terrain still lacks headroom.
    settle();
  });

  return {
    update(dirty: Iterable<number>): void {
      // BEFORE the loop and unconditionally, including for a dirty set that is
      // entirely locked chunks: the quiet test asks when the terrain was last
      // ASKED to change, not when it last managed to.
      lastUpdateMs = now();
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        pending.add(chunkIdx);
      }
      // No frames to defer to — see the module header. The queue still exists
      // (so both paths dedupe and drop unreceived chunks identically); it is
      // simply emptied before the call returns.
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
      // THE BUILD SOURCE IS NOT DISPOSED HERE, and that is deliberate: it is
      // the caller's, and the client's worker pool outlives the mesh set (a
      // rejoin replaces the meshes and would otherwise terminate and respawn
      // two threads for nothing). The default direct source holds nothing to
      // release. `clear()` above has already bumped the generation, so answers
      // still in flight for this world are dropped when they land.
    },
  };
}
