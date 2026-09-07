// Critical code — the client performance contract (design doc): mesh updates
// patch vertex buffers in place and never rebuild geometry per edit. A diff
// rewrites the affected chunks' arrays and flips `needsUpdate`; it never
// re-adds anything to the scene graph.

// Buffer strategy, 2026-08-14: a chunk's triangle count runs from ~10 (flat) to
// tens of thousands, and preallocating the worst case is 24 MB/chunk (600 MB
// for a revealed 512² world) to serve chunks that need 1% of it.

// So: preallocate a working capacity, draw a prefix with setDrawRange, and
// double on overflow. Capacity never shrinks, so every patch after convergence
// is pure array writes.

// Against the held-sculpt budget: a held brush emits ~8 intents/s over up to 4
// chunks, ~32 patches/s. Growth events are the only spike, at most
// log2(capacity) per chunk ever.

// Garbage, named rather than hidden: ~100 KB of short-lived point objects per
// rebuild, nursery traffic a generational GC scavenges without promoting. What
// must hold: no GPU buffer is respecified mid-stroke.

// 111 bytes/triangle at rest. Non-indexed is deliberate: every triangle owning
// its own vertices is what gives flat shading a hard crease at every cap and
// skirt boundary.

// Queue → job → splice (issue #47; build moved off-thread 2026-08-28). A chunk
// still waiting keeps drawing its previous mesh — stale by a frame or two,
// never absent.

// A frame pays only for the SPLICE — run placement, chart publish,
// `onChunkDrawn`, ~1 ms on a developed super-mesh. Everything else happens in
// render/chunkBuildSource.ts's worker pool.

// Frame callbacks run before `renderer.render`, so a sculpt between two frames
// draws on the very next one plus the worker job's own ~6 ms.

// What it fixes: four chunks rebuilt inside one `update` call cost ~9 ms each,
// a ~36 ms frame. Spreading them removed the compounding; the off-thread build
// removed the remaining floor.

// A chart is published by the SPLICE, not by `update`: anything reading what a
// chunk drew must be driven by `onChunkDrawn`, since the dirty set reads the
// pre-edit chart for any chunk not yet landed.

// No frame hook, no deferral: deferring is meaningless with no frame loop, so a
// caller without one gets synchronous behaviour. Such a caller is on the direct
// build source by definition.

// Draw-call tradeoff accepted for v1. Worlds start small, and per-chunk meshes
// make streaming and locked-chunk omission trivial: an unreceived chunk has no
// mesh, so it can't be drawn or picked.

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
 * 1.5, about a fifth of a 140 fps frame's 7.1 ms — a frame only copies a
 * finished answer into its super-mesh (~1 ms developed), never marches it.
 *
 * Roughly one splice per frame, and "always splices at least one" is a floor on
 * progress, not a ceiling on cost.
 */
export const CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5;

/**
 * 2026-08-28, RTX 3090 / Chrome-ANGLE (docs/plans/vertex-arena-no-tail-move.md
 * §1): a frame uploading 19-21 MB spent 3.5-12 ms in `bufferSubData` plus about
 * as much again stalled on the next frame — ~1 ms/MB all in.
 *
 * An estimator, not a clock: compaction decides whether it can afford a move
 * BEFORE making it.
 */
export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

/**
 * A 140 fps frame has 7.1 ms and already owes ~3.7 (render, splice, plugins). Of
 * the 3.4 left, half is held back for the backpressure a transfer bills the
 * frame after (§1) — 1.7, rounded down to 1.0, about 52k vertices.
 */
export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

/**
 * Same arithmetic for a frame that spliced nothing: 7.1 - 1.7 - 0.5 = 4.9,
 * halved for backpressure, rounded down to 3.
 *
 * Residual (plan §5): a chunk at CHUNK_TRIANGLE_BUDGET (393k vertices ≈ 7.5 ms)
 * wouldn't fit even here, so that hole waits until its run changes size.
 */
export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

/**
 * 2026-08-29, `arenaLayout()` over 400 streamed chunks
 * (docs/plans/frame-budget-growth-and-draw-calls.md §A3): p90 is 40,959
 * vertices = 13,653 triangles.
 *
 * In triangles because every arena offset is a multiple of
 * VERTICES_PER_TRIANGLE.
 */
const ARENA_P90_RUN_TRIANGLES = 13_653;

/**
 * A regrow appends at most one new run of about the old run's size while the old
 * run is still live, and a brush straddles two chunks per step — one run's slack
 * isn't enough, and three buys nothing extra.
 */
export const ARENA_HEADROOM_RUN_MULTIPLE = 2;

/**
 * The multiple above is taken against what a super-mesh has ALREADY drawn, and a
 * barely-revealed one has drawn almost nothing. The floor sizes it for the run
 * it is likely to get next instead.
 */
export const ARENA_HEADROOM_FLOOR_TRIANGLES =
  ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES;

/**
 * A held brush's slowest gap between intents is its first repeat, after which
 * the interval ramps down. One delay would let a slow first repeat read as a
 * lifted brush; two is margin enough that it can't.
 */
export const TERRAIN_QUIET_MS = 2 * SCULPT_REPEAT_DELAY_MS;

/** Terrain is dielectric; a little roughness variation is not worth a map. */
const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/** One string shared by the geometry that writes it and the shader patch that reads it, so a rename can't silently unbind it. */
const SELF_LIT_ATTRIBUTE = 'selfLit';

/**
 * A flagged vertex is shaded as its own colour and nothing else.
 *
 * Why (owner, 2026-08-14, low-angle screenshot): a skirt's brightened silt rim
 * is vertical under one directional sun, so it reads from overhead and
 * disappears at a low camera — a lighting dependence only shading can remove.
 *
 * Injected BEFORE `<opaque_fragment>`, so tone mapping, colour space and fog
 * still apply: a rim still fogs at distance, it just never darkens for facing
 * the wrong way. Verified against three 0.185's meshphysical include order.
 *
 * Not a second material: an unlit MeshBasicMaterial group costs a second draw
 * call on every chunk with underwater geometry — every chunk, since a world
 * starts as ocean — and needs rim triangles contiguous, which the builder does
 * not produce.
 *
 * Not faked normals: flatShading takes its normal from screen-space
 * derivatives, ignoring any attribute, and would still tie rim brightness to
 * the light rig.
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
    // three assumes vertex colour is already linear. The exact sRGB EOTF, not the
    // 2.2-gamma approximation: the deep ramp lives where they disagree most.
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
 * Superseded 2026-08-20, kept as the record: the deep ramp did not survive
 * quantising in linear (28 of 64 blue-column stops collapsed into ties, vs zero
 * in sRGB). sRGB now goes to the GPU untouched, decoded by `<color_vertex>`.
 */
function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

/**
 * The merge factor of this module's 2026-08-21 rewrite. A chunk was the sync
 * payload, the reveal quantum AND the draw quantum; the third was an accident of
 * the first two, and the one that costs.
 *
 * On a live day-one world: 400 meshes drawing 19,000 triangles, ~34 per draw
 * call where a modern renderer carries thousands. Draw calls are CPU work that
 * scales with world revealed, not with what is on screen.
 *
 * Eight covers 32 world units, well under CAMERA_INITIAL_DISTANCE (80), so the
 * horizon still culls. Raise it if draw calls are still the bottleneck; lower it
 * if a pan starts submitting off-camera geometry.
 */
export const SUPER_MESH_SPAN_CHUNKS = 8;

/** Non-indexed geometry: three vertices per triangle, never shared. */
const VERTICES_PER_TRIANGLE = 3;

/**
 * The chunk is still the unit of BUILDING (what a sculpt invalidates), but no
 * longer the unit of DRAWING.
 */
interface ChunkSlot {
  /** An index into the packed buffers, not a byte offset. */
  offset: number;
  count: number;
  /**
   * Per slot rather than recomputed on every splice: scanning the whole
   * super-mesh (1.25M vertices on the busiest, ~14 ms) for a 4.5k-vertex edit
   * would be wasteful. The super-mesh's bound is the union of at most 64 boxes.
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
 * Zeroed in all four attributes: three zero positions are a zero-area triangle
 * at the origin — no fragments, and `Ray.intersectTriangle` rejects it via
 * `DdN === 0`.
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
  /** Equal to the total length of the free list. */
  deadVertices: number;
  holeCount: number;
  /** Each one is a full `bufferData`. */
  growths: number;
  /**
   * The subset taken DURING A SPLICE — every one `settle` did not schedule.
   *
   * Streaming climbs the doubling ladder off-stroke (accepted); a stroke
   * outrunning its headroom reallocates on a frame the player is watching
   * (#229). Only WHEN it happened distinguishes them.
   */
  strokeGrowths: number;
}

/** Per-super-mesh arena layout — see `TerrainMeshes.arenaLayout`. */
export interface ArenaLayout {
  slots: { chunkIdx: number; offset: number; count: number }[];
  holes: { offset: number; length: number }[];
}

/**
 * One drawn object: an ARENA of runs, one per chunk, in no particular order.
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
   * Sorted by offset, coalesced, every offset and length a multiple of
   * VERTICES_PER_TRIANGLE, bounded by one hole per run plus one — properties of
   * the LIST, kept by exactly one insert/take pair, not by every caller.
   */
  holes: Hole[];
  /** One past the highest live vertex; at least the sum of the slot counts. */
  liveEnd: number;
  /**
   * three's create path takes a full `bufferData` WITHOUT clearing
   * `updateRanges` (only `updateBuffer` does), so any range added later in the
   * same pass would double-upload next frame.
   *
   * On the super-mesh rather than a local, because the arena has two range
   * producers per pass — splices and compaction. Written only by
   * `bindGeometry`; a caller that binds without setting it brings the double
   * upload back.
   */
  reallocatedThisPass: boolean;
  growths: number;
  /** See `ArenaStats.strokeGrowths`. */
  strokeGrowths: number;
}

/**
 * Required at every callsite rather than defaulted, so a future call can't be
 * miscounted as planned growth by omission.
 */
type GrowthSite =
  /** Inside `spliceChunk`, i.e. inside a stroke. Counted in `strokeGrowths`. */
  | 'splice'
  /** From `settle`, on a quiet frame. The growth the headroom rule schedules. */
  | 'settle';

/** Absent means "there are no frames" — a real mode, not a test-only one; see the header. */
export interface MeshScheduling {
  onFrame: (handler: (dt: number) => void) => () => void;
  /** Monotonic ms clock the drain budget is measured against. Defaults to `performance.now`. */
  now?: () => number;
}

/** See `TerrainMeshes.settle`. */
export interface SettleOptions {
  /**
   * Skips the timestamp half of the quiet test, because the CALLER knows the
   * terrain is done: a caller with no frame hook runs update/flush/settle in one
   * synchronous turn, so that gate would race the build's own duration.
   *
   * The queue test still applies — growing a super-mesh about to be spliced into
   * would pay a second full `bufferData`. The caller may assert no more work is
   * coming, never that queued work is done.
   */
  readonly assumeQuiet?: boolean;
}

export interface TerrainMeshes {
  /**
   * Indices the mirror has not received are ignored — the mechanism by which
   * locked terrain stays invisible.
   *
   * A chunk marked twice before it is built is built ONCE, from the mirror's
   * state at drain time: a held stroke re-dirtying one chunk eight times a
   * second costs one rebuild per frame, always the newest heights.
   */
  update(dirty: Iterable<number>): void;
  /** Builds every queued chunk now, whatever the budget says. */
  flush(): void;
  /**
   * Gives one quiet super-mesh the capacity it is short of, so a later stroke
   * need not reallocate (#229). Run from the frame hook after splices and
   * compaction; a no-op while the terrain is busy.
   *
   * Public because paths with no frame hook build their world and stop, and only
   * they can name "the terrain has gone quiet". Deliberately NOT called by
   * `flush` — see the implementation.
   */
  settle(options?: SettleOptions): void;
  /** Queued, out at the build source, answered awaiting splice, or waiting retry after a lost build. */
  pendingCount(): number;
  /** Drops every mesh — used when a fresh join replaces the world. */
  clear(): void;
  /**
   * One per super-mesh, not one per chunk. Named for the raycasting it once
   * served; nothing raycasts terrain now (picking marches the height field).
   *
   * Survives for the differential test pinning that march against the old mesh,
   * and for tests inspecting the geometry actually submitted.
   */
  pickables(): Mesh[];
  /**
   * Owned here because the emitter is here: one call writes an entry and its
   * vertices and replaces both together, so a reader can hold the store for the
   * mirror's whole lifetime rather than invalidating by hand.
   */
  drawnGround(): DrawnGroundStore;
  /**
   * A build event, not the dirty set: the queue drains under budget, so anything
   * refreshed from the dirty set would read a stale chart for a deferred chunk.
   * This fires the moment a chunk's published geometry actually changes.
   */
  onChunkDrawn(handler: (chunkIdx: number) => void): () => void;
  /** With nothing culled — exposed so a test can hold a budget against it. */
  drawCallCount(): number;
  /**
   * The number CHUNK_SPLICE_FRAME_BUDGET_MS is sized against. A headless bench
   * can't report it — the direct source builds inline and measures the whole
   * build — so this exists for an in-browser probe.
   */
  medianSpliceMs(): number | null;
  /**
   * In `pickables()` order. Dead space is not asserted as a bound anywhere (plan
   * §3d argues convergence, not a bound), so tests, bench and probe OBSERVE it;
   * `growths` counts the one upload the arena doesn't bound (§5).
   */
  arenaStats(): ArenaStats[];
  /**
   * For tests: the free list's invariants — sorted, coalesced, aligned, never
   * reaching `liveEnd` — are what make a hole safe inside the draw range, and
   * are checkable only against the layout itself.
   */
  arenaLayout(): ArenaLayout[];
  /**
   * The mesh count stopped answering this at the 2026-08-21 merge, though the
   * contracts tests hold (drain budget, locked-terrain invisibility) are about
   * CHUNKS — so this counts chunks, not whatever the renderer groups them into.
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
    // The camera can dip toward the horizon and see under a far terrace.
    // DoubleSide costs nothing here — no shadows, no transparency.
    side: DoubleSide,
  });
  makeSelfLitAware(material);
  // The ground darkens under whatever plugins put in the sky (#284). AFTER
  // makeSelfLitAware, and chaining rather than replacing: the shade multiplies
  // `outgoingLight` right after the self-lit mix, so a rim is still shaded.
  applyGroundShade(material, 'terrain');

  const superMeshes = new Map<number, SuperMesh>();

  const drawnGroundStore = createDrawnGroundStore(worldSize);

  const chunkDrawnHandlers = new Set<(chunkIdx: number) => void>();

  const superIndexOf = (chunkIdx: number): number => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;
    const sx = Math.floor(cx / SUPER_MESH_SPAN_CHUNKS);
    const sy = Math.floor(cy / SUPER_MESH_SPAN_CHUNKS);
    return sy * superCols + sx;
  };

  /**
   * Run on creation and whenever buffers grow — a typed array can't resize, so
   * growth means new attributes and the old geometry is disposed.
   *
   * Sets `reallocatedThisPass` HERE so no caller can forget it: it used to be
   * the callers' job, and `createSuperMesh` didn't, leaking a newly-streamed
   * chunk's ranges into the next frame's upload.
   */
  const bindGeometry = (sm: SuperMesh): void => {
    sm.reallocatedThisPass = true;
    const positionAttribute = new BufferAttribute(sm.buffers.positions, 3);
    // `true` = NORMALIZED: the GPU reads these bytes back as value/127 (signed)
    // and value/255 (unsigned); omitting it feeds the shader raw integers.
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

    // LAST, and never in the callers: the new geometry's `boundingSphere` is
    // null, and three would compute one over the whole position attribute —
    // dead tail included, stretching the sphere to the origin.
    updateBounds(sm);
  };

  /**
   * Geometric (doubling), not exact: a world fills chunk by chunk, and growing
   * by one chunk's worth each time would copy the whole super-buffer per chunk —
   * quadratic, paid during the reveal.
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
    // `bindGeometry` below installs the fresh attributes and sets
    // `reallocatedThisPass` — see its own note.
    sm.growths++;
    if (site === 'splice') sm.strokeGrowths++;
    bindGeometry(sm);
    return true;
  };

  /**
   * The union of the slot boxes, O(64) rather than O(live vertices), and EXACT:
   * a static box from world size and height range would be wrong for any
   * partially revealed super-mesh, which is most of them mid-exploration.
   *
   * The sphere is the AABB's centre plus half-diagonal — a hair looser than a
   * max-distance radius, but it avoids a second pass over every vertex, and it
   * culls late rather than wrongly.
   *
   * Hand-rolled rather than `computeBoundingSphere()`, which reads the whole
   * position attribute including the dead tail.
   *
   * The box is set too, being free: `Mesh.raycast` rejects on it after the
   * sphere, and a null box would make every ray clipping the sphere pay the full
   * triangle walk.
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
   * Without this, `needsUpdate` alone re-uploads the WHOLE attribute — tens of
   * megabytes on a developed super-mesh — for a splice rewriting one chunk.
   *
   * Ranges are in array elements, not vertices, hence the itemSize scaling
   * (WebGLAttributes.js:141); three clears them itself after upload (:147).
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

  const markDirty = (sm: SuperMesh): void => {
    sm.positionAttribute.needsUpdate = true;
    sm.normalAttribute.needsUpdate = true;
    sm.colorAttribute.needsUpdate = true;
    sm.selfLitAttribute.needsUpdate = true;
  };

  /**
   * Clamped to the arena, and skipped entirely on a super-mesh reallocated this
   * pass (§3e). Not defensive: the retreat rule can pull `liveEnd` below a range
   * that was correct when computed, and those vertices leave the draw range
   * instead of uploading as zeroes.
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
   * The retreat rule, an invariant of the LIST rather than of any one insertion:
   * a hole ending at the arena's extent isn't dead space, it's space that
   * stopped being live, and dropping it costs no upload.
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

  /** The ONLY way a hole is ever created, so sorted/coalesced/retreated hold by construction. */
  const insertHole = (sm: SuperMesh, offset: number, length: number): void => {
    if (length <= 0) return;
    let at = 0;
    while (at < sm.holes.length && sm.holes[at]!.offset < offset) at++;
    sm.holes.splice(at, 0, { offset, length });
    // FORWARD FIRST: merging with the next entry can make this one adjacent to
    // the previous, so the order matters.
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
   * First fit, lowest-first rather than best-fit: it keeps live geometry bunched
   * toward offset 0, shortening the compactor's job, where a best-fit scan would
   * still be O(64) and leave the arena more scattered.
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
      // No retreat check: the split hole ENDS where the original did, so the
      // rule would already have removed it.
      return { offset, surplus };
    }
    return null;
  };

  /** O(64). */
  const runStartingAt = (sm: SuperMesh, offset: number): ChunkSlot | undefined => {
    for (const slot of sm.slots.values()) {
      if (slot.count > 0 && slot.offset === offset) return slot;
    }
    return undefined;
  };

  /**
   * In one piece, never split across frames: a partially moved live run draws
   * garbage between its halves. A run too dear for this frame's budget is
   * skipped by the caller before this runs.
   *
   * The slot's BOUNDS are untouched — a move changes where a run lives, not what
   * it contains.
   */
  const moveRunDown = (sm: SuperMesh, hole: Hole, run: ChunkSlot): void => {
    const from = run.offset;
    const runEnd = from + run.count;
    const to = hole.offset;
    const { positions, normals, colors, selfLit } = sm.buffers;
    // copyWithin, not set(subarray): the ranges overlap whenever the hole is
    // shorter than the run.
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
   * Cheapest-first in free-list order, while `budgetMs` of ESTIMATED transfer
   * remains. A skipped run isn't a failure — it waits for a frame with more
   * budget.
   *
   * One full sweep is at most one move per run, since the lowest hole is carried
   * past exactly one run per move.
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

  /** One budget shared across every super-mesh: four each spending it would spend four times what the frame has. */
  const compact = (budgetMs: number): void => {
    let spentMs = 0;
    for (const sm of superMeshes.values()) {
      if (sm.holes.length === 0) continue;
      spentMs += compactSuperMesh(sm, budgetMs - spentMs);
      if (spentMs >= budgetMs) return;
    }
  };

  /** The live geometry, as against the extent. */
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
   * Places the run wherever it now fits, never moving anybody else's.
   *
   * The contract (docs/plans/vertex-arena-no-tail-move.md §2): a splice's upload
   * is bounded by the chunk it splices, never by the super-mesh. The old
   * index-ordered packing moved every run after a resized chunk — 19-21 MB per
   * stroke step on the busiest super-mesh.
   *
   * Not a fixed slot per chunk: sized for the worst chunk a 64-slot super-mesh
   * is ~480 MB and submits ~8.4M triangles to draw the ~50k it holds; sized for
   * the initial capacity it can't hold a median chunk. No slot size is both
   * affordable and sufficient.
   *
   * Placement first, capacity second (§3b). For a run of `count` replacing one
   * of `old` at `[offset, offset+old)`:
   *
   *   1. count === old — overwrite in place. Upload: the run.
   *   2. count < old — overwrite in place; remainder becomes a hole.
   *      Upload: the run and hole (contiguous).
   *   3. count > old and the run ends at `liveEnd` — extend in place, which
   *      keeps a one-chunk super-mesh hole-free. Upload: the run.
   *   4. count > old — the lowest hole that fits, split. Upload: new run,
   *      surplus, and old run zeroed — three disjoint ranges, since three's
   *      own merge only joins adjacent ones.
   *   5. count > old, nothing fits — append at `liveEnd`. Upload: both runs.
   *
   * A chunk arriving for the first time is case 3, 4 or 5 with `old = 0`.
   */
  const spliceChunk = (sm: SuperMesh, chunkIdx: number, answer: ChunkJobAnswer): void => {
    const count = answer.vertexCount;
    let slot = sm.slots.get(chunkIdx);
    if (slot === undefined) {
      slot = {
        // Placed below by the same rules as any other run: an empty run at 0 is
        // case 3 on an empty super-mesh, case 4 or 5 on a populated one.
        offset: 0,
        count: 0,
        // An empty box (min > max), which `updateBounds` skips; filled by the
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
      // Cases 1 and 2. The hole (empty when counts match) is contiguous with
      // the run, so one range covers both.
      zeroVertices(sm, slot.offset + count, old - count);
      dirtied.push([slot.offset, old]);
      slot.count = count;
      insertHole(sm, slot.offset + count, old - count);
    } else if (slot.offset + old === sm.liveEnd) {
      // Case 3. Capacity is an extent, not a delta: what must fit is where the
      // run now ends.
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
        // Case 5. Compact before doubling: a growth is one full `bufferData` of
        // the whole super-mesh (§5), cheaper to avoid with a full sweep whenever
        // there is dead space — the one place a sweep runs unbudgeted.
        if (sm.liveEnd + count > capacityVertices(sm) && sm.holes.length > 0) {
          compactSuperMesh(sm, Infinity);
        }
        // Capacity from `count`, never `delta`: an append writes the whole run
        // past the live end, so a delta request under-requests by `old` and
        // `set()` runs off the buffer.
        ensureSuperCapacity(sm, sm.liveEnd + count, 'splice');
        // AFTER the compaction: a sweep moves live runs, this chunk's included.
        freedOffset = slot.offset;
        slot.offset = sm.liveEnd;
        sm.liveEnd += count;
        dirtied.push([slot.offset, count]);
      }
      slot.count = count;
      // The run it left behind, offered back to the free list.
      zeroVertices(sm, freedOffset, old);
      dirtied.push([freedOffset, old]);
      insertHole(sm, freedOffset, old);
    }

    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.set(answer.positions, slot.offset * 3);
    normals.set(answer.normals, slot.offset * 3);
    colors.set(answer.colors, slot.offset * 3);
    selfLit.set(answer.selfLit, slot.offset);

    // Measured where the vertices were made: the job walked them once on its way
    // out and sent six floats.
    slot.minX = answer.bounds[0]!;
    slot.minY = answer.bounds[1]!;
    slot.minZ = answer.bounds[2]!;
    slot.maxX = answer.bounds[3]!;
    slot.maxY = answer.bounds[4]!;
    slot.maxZ = answer.bounds[5]!;

    markDirty(sm);
    for (const [startVertex, vertexCount] of dirtied) addRange(sm, startVertex, vertexCount);

    // The draw range counts VERTICES and covers the arena's whole extent, holes
    // included — why they must be zeroed rather than merely forgotten.
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
    updateBounds(sm);
  };

  /**
   * A SET, so a re-dirtied chunk is still built once, from the mirror's state at
   * drain time. Insertion order is the drain order — deterministic whatever the
   * frame budget allows on the day.
   */
  const pending = new Set<number>();

  /**
   * At most one job per chunk, enforced rather than implied: two answers could
   * return in either order, and the older splicing last would leave the chunk
   * drawing pre-edit geometry.
   */
  const inFlight = new Set<number>();

  /** Finished jobs waiting for a frame's splice budget. */
  const ready: ChunkJobAnswer[] = [];

  /**
   * A holding pen rather than `pending` directly: a source can fail
   * synchronously inside `submit`, and a chunk put straight back would be the
   * very one `nextSubmittable` hands the same loop next turn — an infinite spin.
   *
   * This merges into `pending` only at the top of a pass, so a lost job retries
   * next pass, never the one that lost it.
   */
  const retry = new Set<number>();

  /** Long enough to survive a held stroke, short enough that the median tracks the world as it is now. */
  const SPLICE_SAMPLE_WINDOW = 64;
  const spliceMs: number[] = [];
  let spliceMsNext = 0;

  /** An answer stamped with an older generation pictures a world that no longer exists, and is dropped rather than spliced. */
  let generation = 0;

  /** The chunk index is passed separately because a lost build has no answer to read it from. */
  const receive = (chunkIdx: number, answer: ChunkJobAnswer | null): void => {
    inFlight.delete(chunkIdx);
    if (answer === null) {
      // Tried again, not dropped: still dirty and still drawing its pre-edit
      // geometry.
      if (mirror.received.has(chunkIdx)) retry.add(chunkIdx);
      return;
    }
    if (answer.generation !== generation) return;
    // Re-checked on ARRIVAL as well as submission: a chunk can leave `received`
    // while its job is out, and splicing geometry the mirror no longer holds
    // would draw terrain that isn't there.
    if (!mirror.received.has(answer.chunkIdx)) return;
    ready.push(answer);
  };

  const submit = (chunkIdx: number): void => {
    // Re-checked at SUBMIT time, not queue time: a chunk can drop from
    // `received` between the two.
    if (!mirror.received.has(chunkIdx)) return;
    inFlight.add(chunkIdx);
    const answer = buildSource.build(mirror, chunkIdx, generation);
    if (answer instanceof Promise) void answer.then((settled) => receive(chunkIdx, settled));
    else receive(chunkIdx, answer);
  };

  const spliceAnswer = (answer: ChunkJobAnswer): void => {
    const startedMs = now();
    // Handed over, not re-derived: the plan arrives already flat and rasterised
    // from wherever the chunk was built.
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
    // Run placement, chart publish and lip refresh — what a frame pays per
    // answer.
    const elapsedMs = now() - startedMs;
    if (spliceMs.length < SPLICE_SAMPLE_WINDOW) spliceMs.push(elapsedMs);
    else {
      spliceMs[spliceMsNext] = elapsedMs;
      spliceMsNext = (spliceMsNext + 1) % SPLICE_SAMPLE_WINDOW;
    }
  };

  const now = scheduling?.now ?? (() => performance.now());

  const nextSubmittable = (): number | undefined => {
    for (const chunkIdx of pending) {
      if (!inFlight.has(chunkIdx)) return chunkIdx;
    }
    return undefined;
  };

  /** Called at the top of a pass only — see `retry`. */
  const takeRetries = (): void => {
    if (retry.size === 0) return;
    for (const chunkIdx of retry) pending.add(chunkIdx);
    retry.clear();
  };

  /**
   * Returns how many answers it spliced — what decides the compaction budget.
   *
   * Always splices at least one: a splice costing more than the whole budget
   * would otherwise never happen and the queue would stall for good. The clock
   * is checked AFTER a splice, so the first of a frame is unconditional.
   */
  const drain = (budgetMs: number): number => {
    takeRetries();
    let spliced = 0;
    if (pending.size === 0 && ready.length === 0) return spliced;
    const startedMs = now();
    for (;;) {
      // Top the pool up FIRST, so a worker is never idle while this thread
      // splices.

      // Finished answers count against the pool — what bounds the DIRECT source.
      // Its `build` answers inline, releasing the `inFlight` slot before
      // `submit` returns, so counting `inFlight` alone would re-test 0 < 1
      // forever and build every pending chunk in one call.

      // Counting `ready` too means one unspliced answer occupies one slot, so
      // the direct path builds one chunk per pass. The worker path gets this for
      // free, its answers being genuinely in flight.
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
   * Synchronous only on the direct source, which answers inside `build`. The
   * worker source can't finish on this thread, so a client using it gets
   * "everything submitted, everything already answered spliced" — all a flush
   * can honestly mean there.
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
    // "Build everything now" also means "leave no holes": every caller of this
    // path wants the world finished on return, with no later frame to compact.
    compact(Infinity);
  };

  const clear = (): void => {
    for (const sm of superMeshes.values()) {
      group.remove(sm.mesh);
      sm.mesh.geometry.dispose();
    }
    superMeshes.clear();
    // A stale chart would answer a water query with contours from the world
    // being replaced.
    drawnGroundStore.clear();
    // Draining these against the replacement would build chunks nobody asked
    // for.
    pending.clear();
    retry.clear();
    // The generation bump makes jobs already out arrive and be discarded.
    inFlight.clear();
    ready.length = 0;
    generation++;
  };

  /**
   * Compaction is its own seam on the frame, not a step inside `drain`: `drain`
   * returns the moment there is nothing to splice, so a settled frame would
   * never reach anything after its splices, and a stroke frame's first splice
   * already spends the splice budget. Two budgets, two seams.
   */

  /** Half of the quiet test (see `settle`). Negative infinity until the first update — the quietest state. */
  let lastUpdateMs = Number.NEGATIVE_INFINITY;

  const largestRunVertices = (sm: SuperMesh): number => {
    let largest = 0;
    for (const slot of sm.slots.values()) {
      if (slot.count > largest) largest = slot.count;
    }
    return largest;
  };

  /** Free capacity a super-mesh must hold when the terrain is quiet, in vertices. */
  const headroom = (sm: SuperMesh): number =>
    Math.max(
      ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices(sm),
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );

  /**
   * All four queues, since `drain` returning 0 is no substitute: on the worker
   * source most reveal frames splice nothing while jobs are out, and a held
   * stroke splices nothing on ~16 of 17 frames. O(queue) per call.
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
   * The contract (#229, part A of
   * docs/plans/frame-budget-growth-and-draw-calls.md): when quiet, every
   * super-mesh holds at least `headroom(sm)` free capacity, and capacity only
   * grows while quiet.
   *
   * Before this, post-streaming slack was an accident of the doubling ladder, so
   * whether a stroke reallocated (one full `bufferData`, ~3 MB and up to 505 ms,
   * on a frame the player watches) came down to streaming order.
   *
   * One super-mesh per call: each growth is one `bufferData` (≤30 MB ≈ 30 ms),
   * and several per frame would trade a stroke hitch for a bigger idle one.
   *
   * Not called by `flush`: on the no-scheduler path `update` flushes every
   * sculpt step, so a headroom pass there would be growth inside the stroke.
   */
  const settle = (options?: SettleOptions): void => {
    // The global half of the quiet test: no `update` in the window means no
    // super-mesh can be quiet. assumeQuiet skips only this gate.
    if (options?.assumeQuiet !== true && now() - lastUpdateMs < TERRAIN_QUIET_MS) return;
    for (const [superIdx, sm] of superMeshes) {
      if (capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      if (superMeshHasChunkQueued(superIdx)) continue;
      // Deliberately not a second rounding ladder: `ensureSuperCapacity` keeps
      // its doubling-from-current rule.
      ensureSuperCapacity(sm, sm.liveEnd + headroom(sm), 'settle');
      return;
    }
  };

  const stopDraining = scheduling?.onFrame(() => {
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    const spliced = drain(CHUNK_SPLICE_FRAME_BUDGET_MS);
    compact(spliced > 0 ? ARENA_COMPACT_STROKE_BUDGET_MS : ARENA_COMPACT_IDLE_BUDGET_MS);
    // LAST, and only here: `settle` must see this frame's splices and compaction
    // before deciding whether the terrain still lacks headroom.
    settle();
  });

  return {
    update(dirty: Iterable<number>): void {
      // BEFORE the loop, unconditionally: the quiet test asks when the terrain
      // was last ASKED to change, not when it last managed to.
      lastUpdateMs = now();
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        pending.add(chunkIdx);
      }
      // No frames to defer to. The queue still exists so both paths dedupe
      // identically; it is simply emptied before the call returns.
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
      // The build source is the CALLER's: the worker pool outlives the mesh set,
      // since a rejoin replaces the meshes without terminating threads.
      // `clear()` above bumped the generation, so in-flight answers are dropped.
    },
  };
}
