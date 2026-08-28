// Per-chunk terrain meshes and the in-place vertex patch path.
//
// CRITICAL CODE — this is the client performance contract (design doc §8):
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
// MULTI-FRAME MESHING (issue #47, 2026-08-20). `update` does not build
// anything. It marks chunks dirty in a queue, and a frame hook drains that
// queue under a wall-clock budget (CHUNK_BUILD_FRAME_BUDGET_MS), rebuilding as
// many as fit and leaving the rest for the next frame. A chunk still waiting
// its turn keeps DRAWING ITS PREVIOUS MESH — stale by a frame or two, never
// absent — which is what makes deferral invisible rather than a flicker.
//
// WHY IT COSTS NO LATENCY. Frame callbacks run before `renderer.render`
// (render/scene.ts's renderFrame), so a sculpt that lands between two frames is
// queued, drained and drawn on the very next frame — exactly the frame it would
// have appeared on when `update` built it inline. What changes is only what
// happens when the queue holds MORE work than a frame can afford.
//
// WHAT IT FIXES. A radius-4 brush straddles up to four chunks and every one of
// them was rebuilt inside a single `update` call, so their costs ADDED: four
// floor-depth chunks at the measured worst case (~9 ms each — see
// terrain/capEmission.ts's budget table) was a ~36 ms frame, two and a half
// vsync intervals. Spread across frames the same work costs one chunk's worth
// per frame and the compounding is gone.
//
// WHAT IT DOES NOT FIX, STATED PLAINLY: the cost of ONE chunk. The drain always
// builds at least one chunk per frame — it must, or a chunk costing more than
// the whole budget would sit in the queue forever — so a single 9 ms chunk is
// still a 9 ms frame. Removing THAT requires suspending a build partway through
// its own level walk, which is a change to the builder rather than to the
// scheduler; capEmission.ts's two budgets are what stand in for it meanwhile.
//
// NO FRAME HOOK, NO DEFERRAL. `createTerrainMeshes` takes the scheduler as an
// option and falls back to draining inside `update` when it is absent. That is
// not a test affordance: deferring work to a later frame is meaningless without
// a frame loop to defer to, and a caller that has none (the headless suite, and
// anything that wants the world complete before it looks at it) should get the
// synchronous behaviour rather than a queue nobody pumps.
//
// DRAW-CALL TRADEOFF, known and accepted for v1: one mesh per 16×16 chunk
// means a fully revealed 512² world would be 1024 draw calls. That is a lot,
// but (a) worlds start with a handful of unlocked chunks and grow slowly by
// design (§3.4), and (b) per-chunk meshes are what make streaming and
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
import { CLIFF_PALETTE, TERRAIN_PALETTE, type Rgb } from '../terrain/bandColors.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  createChunkGeometryBuffers,
  writeChunkVertexData,
  type ChunkGeometryBuffers,
  type ChunkPalettes,
} from '../terrain/vertexGrid.ts';
import {
  createDrawnGroundStore,
  type DrawnGroundStore,
} from '../terrain/drawnGroundStore.ts';
import { spliceShader } from './shaderSplice.ts';

/**
 * Wall-clock milliseconds one frame may spend rebuilding chunk geometry.
 *
 * FOUR, and it is a share of the frame rather than a measured cost. A 60 fps
 * frame is 16.67 ms and meshing is not what the frame is FOR: the renderer's
 * own draw submission, the controls' damping update and every plugin's frame
 * hook come out of the same interval. A quarter of it is the largest slice
 * that leaves the other three quarters recognisably intact.
 *
 * It is also comfortably more than the common case needs, which is the number
 * that actually matters for feel: an ordinary chunk patch is ~1 ms (see the
 * measured table at terrain/capEmission.ts's CHUNK_TRIANGLE_BUDGET), so all
 * four chunks a radius-4 brush can straddle still land in the SAME frame and
 * held sculpting is byte-for-byte as immediate as it was before the queue.
 * Only genuinely heavy chunks — deep pits at the bottom of the world — spill
 * into the next frame, which is exactly the population this exists for.
 *
 * DELIBERATELY SMALLER THAN THE WORST LEGITIMATE CHUNK (~9 ms). A budget that
 * fitted one would have to fit four to be worth anything, and four is the
 * 36 ms frame this change exists to break up.
 */
export const CHUNK_BUILD_FRAME_BUDGET_MS = 4;

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
 * One drawn object: the merged geometry of a SUPER_MESH_SPAN_CHUNKS square of
 * chunks, holding their vertices back-to-back with no gaps.
 */
interface SuperMesh {
  mesh: Mesh;
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  selfLitAttribute: BufferAttribute;
  /**
   * The chunks built into this super-mesh, in ASCENDING CHUNK INDEX order —
   * which is the order their runs sit in the buffers, so a chunk's offset is
   * the sum of the counts before it. A sorted array rather than a Map's
   * insertion order because the packing depends on it: a splice shifts exactly
   * the runs that follow, and "the runs that follow" has to be well-defined
   * however the chunks happened to arrive.
   */
  order: number[];
  slots: Map<number, ChunkSlot>;
  /** Sum of every slot's count — the geometry's draw range, and its only one. */
  liveVertices: number;
}

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
  /** Chunks still waiting to be built. */
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
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
  const palettes: ChunkPalettes = {
    top: TERRAIN_PALETTE,
    cliff: CLIFF_PALETTE,
  };

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

  const superMeshes = new Map<number, SuperMesh>();

  /** What each built chunk drew — see the `drawnGround` accessor. */
  const drawnGroundStore = createDrawnGroundStore(worldSize);

  /** Build-completion subscribers — see `onChunkDrawn`. */
  const chunkDrawnHandlers = new Set<(chunkIdx: number) => void>();

  /**
   * The one buffer any chunk is emitted into, before its vertices are copied
   * to their run in a super-mesh.
   *
   * ONE, SHARED, FOR THE WHOLE WORLD — and this is most of the memory story of
   * the merge. Every chunk used to own a permanent set of buffers sized for
   * INITIAL_CHUNK_TRIANGLE_CAPACITY whether it needed them or not, so a fully
   * revealed 2048² world held 16 384 of them. Emission is synchronous and its
   * result is copied out before the next chunk is emitted, so one scratch does
   * the whole job; it grows to the largest chunk the world has ever contained
   * (writeChunkVertexData's own ensureCapacity) and stays there.
   */
  const scratch = createChunkGeometryBuffers();

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
   */
  const bindGeometry = (sm: SuperMesh): void => {
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
    geometry.setDrawRange(0, sm.liveVertices);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.normalAttribute = normalAttribute;
    sm.colorAttribute = colorAttribute;
    sm.selfLitAttribute = selfLitAttribute;

    // LAST, AND IT HAS TO BE HERE. The geometry above is brand new and its
    // `boundingSphere` is null, and three computes a null sphere over the WHOLE
    // position attribute — including the dead tail past `liveVertices`, which
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
  const ensureSuperCapacity = (sm: SuperMesh, vertices: number): boolean => {
    const capacity = sm.buffers.triangleCapacity * VERTICES_PER_TRIANGLE;
    if (vertices <= capacity) return false;
    let triangles = Math.max(sm.buffers.triangleCapacity, 1);
    while (triangles * VERTICES_PER_TRIANGLE < vertices) triangles *= 2;

    const grown = createChunkGeometryBuffers(triangles);
    grown.positions.set(sm.buffers.positions.subarray(0, sm.liveVertices * 3));
    grown.normals.set(sm.buffers.normals.subarray(0, sm.liveVertices * 3));
    grown.colors.set(sm.buffers.colors.subarray(0, sm.liveVertices * 3));
    grown.selfLit.set(sm.buffers.selfLit.subarray(0, sm.liveVertices));
    sm.buffers = grown;
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
   * reads the whole position attribute, and the tail past `liveVertices` is
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

  /** Measures the scratch's first `count` vertices into the slot's box. */
  const measureSlot = (slot: ChunkSlot, count: number): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const positions = scratch.positions;
    for (let v = 0; v < count; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    slot.minX = minX;
    slot.minY = minY;
    slot.minZ = minZ;
    slot.maxX = maxX;
    slot.maxY = maxY;
    slot.maxZ = maxZ;
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

  const createSuperMesh = (superIdx: number): SuperMesh => {
    const placeholder = new BufferAttribute(new Float32Array(0), 3);
    const sm: SuperMesh = {
      mesh: new Mesh(new BufferGeometry(), material),
      buffers: createChunkGeometryBuffers(),
      positionAttribute: placeholder,
      normalAttribute: placeholder,
      colorAttribute: placeholder,
      selfLitAttribute: placeholder,
      order: [],
      slots: new Map(),
      liveVertices: 0,
    };
    bindGeometry(sm);
    group.add(sm.mesh);
    superMeshes.set(superIdx, sm);
    return sm;
  };

  /**
   * Copies the scratch's first `count` vertices into `chunkIdx`'s run, moving
   * everything after it if the run changed length.
   *
   * THE SHIFT IS WHY THE RUNS ARE PACKED rather than each chunk owning a fixed
   * slot. A fixed slot needs no shifting, but it has to be sized for the worst
   * chunk and the dead space inside it still runs the vertex shader: at
   * INITIAL_CHUNK_TRIANGLE_CAPACITY per chunk a fully revealed world would
   * submit ~16.8 M triangles a frame to draw the ~4 M it actually has, trading
   * the draw-call bottleneck for a vertex one. Packing keeps the submitted
   * triangle count exactly what it was before the merge, so the merge costs
   * the GPU nothing at all.
   *
   * The shift is bounded by the super-mesh, not the world: a sculpt moves at
   * most the tail of one super-mesh, and it is a copyWithin of contiguous
   * memory rather than a rebuild.
   */
  const spliceChunk = (sm: SuperMesh, chunkIdx: number, count: number): void => {
    let slot = sm.slots.get(chunkIdx);
    if (slot === undefined) {
      // A new chunk goes where its index sorts to, so one that arrives late
      // still lands between its neighbours rather than at the end.
      let at = sm.order.length;
      for (let i = 0; i < sm.order.length; i++) {
        if (sm.order[i]! > chunkIdx) {
          at = i;
          break;
        }
      }
      const previous = at === 0 ? null : sm.slots.get(sm.order[at - 1]!)!;
      slot = {
        offset: previous === null ? 0 : previous.offset + previous.count,
        count: 0,
        // An empty box (min > max), which `updateBounds` skips. Filled by the
        // `measureSlot` below, in this same call.
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      sm.order.splice(at, 0, chunkIdx);
      sm.slots.set(chunkIdx, slot);
    }

    const delta = count - slot.count;
    // A REGROW IS EXEMPT from the ranged upload below: `bindGeometry` installs
    // brand-new BufferAttributes with no GL buffer behind them, so three takes
    // a full `bufferData` for the whole array whatever ranges are set.
    const grew = delta > 0 ? ensureSuperCapacity(sm, sm.liveVertices + delta) : false;

    const tailStart = slot.offset + slot.count;
    const tailLength = sm.liveVertices - tailStart;
    if (delta !== 0 && tailLength > 0) {
      const { positions, normals, colors, selfLit } = sm.buffers;
      // copyWithin, not set(subarray): the source and destination overlap, and
      // copyWithin is specified to behave as if the range were copied first.
      positions.copyWithin((tailStart + delta) * 3, tailStart * 3, (tailStart + tailLength) * 3);
      normals.copyWithin((tailStart + delta) * 3, tailStart * 3, (tailStart + tailLength) * 3);
      colors.copyWithin((tailStart + delta) * 3, tailStart * 3, (tailStart + tailLength) * 3);
      selfLit.copyWithin(tailStart + delta, tailStart, tailStart + tailLength);
    }

    if (delta !== 0) {
      const from = sm.order.indexOf(chunkIdx) + 1;
      for (let i = from; i < sm.order.length; i++) sm.slots.get(sm.order[i]!)!.offset += delta;
      sm.liveVertices += delta;
      slot.count = count;
    }

    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.set(scratch.positions.subarray(0, count * 3), slot.offset * 3);
    normals.set(scratch.normals.subarray(0, count * 3), slot.offset * 3);
    colors.set(scratch.colors.subarray(0, count * 3), slot.offset * 3);
    selfLit.set(scratch.selfLit.subarray(0, count), slot.offset);

    measureSlot(slot, count);

    sm.positionAttribute.needsUpdate = true;
    sm.normalAttribute.needsUpdate = true;
    sm.colorAttribute.needsUpdate = true;
    sm.selfLitAttribute.needsUpdate = true;
    if (!grew) {
      // From this chunk's first vertex to the END OF THE LIVE RANGE, using the
      // POST-update `liveVertices`: everything before the run is untouched,
      // everything after it was shifted by the tail move, and stopping at the
      // live count excludes both the dead tail a shrink left behind and the
      // capacity slack a growth has not reached.
      const dirtyVertices = sm.liveVertices - slot.offset;
      addVertexRange(sm.positionAttribute, slot.offset, dirtyVertices);
      addVertexRange(sm.normalAttribute, slot.offset, dirtyVertices);
      addVertexRange(sm.colorAttribute, slot.offset, dirtyVertices);
      addVertexRange(sm.selfLitAttribute, slot.offset, dirtyVertices);
    }

    // On non-indexed geometry the draw range counts VERTICES, and the packed
    // runs have no holes, so ONE range covers every chunk in this super-mesh.
    sm.mesh.geometry.setDrawRange(0, sm.liveVertices);
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

  /** Builds one queued chunk into its super-mesh, creating that if needed. */
  const buildChunk = (chunkIdx: number): void => {
    // Re-checked at DRAIN time, not at queue time: a chunk can be dropped from
    // `received` between the two (a rejoin replaces the world), and building
    // one the mirror no longer holds would read heights that are not there.
    if (!mirror.received.has(chunkIdx)) return;
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;
    const counts = writeChunkVertexData(mirror, cx, cy, scratch, palettes);
    // HANDED OVER, not re-derived. The plan this chunk was emitted from is
    // published here rather than planned a second time by whoever needs to know
    // what the rock looks like — see terrain/drawnGroundStore.ts.
    drawnGroundStore.publish(chunkIdx, counts.drawnCaps);
    const superIdx = superIndexOf(chunkIdx);
    const sm = superMeshes.get(superIdx) ?? createSuperMesh(superIdx);
    spliceChunk(sm, chunkIdx, counts.vertexCount);
    // AFTER the splice and after the publish, so a handler sees both the chart
    // and the vertices this build produced.
    for (const handler of chunkDrawnHandlers) handler(chunkIdx);
  };

  const now = scheduling?.now ?? (() => performance.now());

  /**
   * Builds queued chunks until `budgetMs` of wall clock is gone, or the queue
   * empties.
   *
   * ALWAYS BUILDS AT LEAST ONE, and that is not a rounding convenience: a chunk
   * whose own build costs more than the entire budget would otherwise never be
   * built, and the queue would stall permanently on the first heavy chunk with
   * the terrain frozen behind it. Checking the clock AFTER a build rather than
   * before is what expresses that — the first build of a frame is unconditional
   * and every one after it has to fit.
   */
  const drain = (budgetMs: number): void => {
    if (pending.size === 0) return;
    const startedMs = now();
    for (const chunkIdx of pending) {
      pending.delete(chunkIdx);
      buildChunk(chunkIdx);
      if (now() - startedMs >= budgetMs) break;
    }
  };

  const flush = (): void => {
    for (const chunkIdx of pending) {
      pending.delete(chunkIdx);
      buildChunk(chunkIdx);
    }
  };

  const stopDraining = scheduling?.onFrame(() => drain(CHUNK_BUILD_FRAME_BUDGET_MS));

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
  };

  return {
    update(dirty: Iterable<number>): void {
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
    pendingCount(): number {
      return pending.size;
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
    },
  };
}
