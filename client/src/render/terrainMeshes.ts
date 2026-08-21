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
  SRGBColorSpace,
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

interface ChunkMesh {
  mesh: Mesh;
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  selfLitAttribute: BufferAttribute;
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
  /** Meshes the raycaster should test. */
  pickables(): Mesh[];
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
  scheduling?: MeshScheduling,
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
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

  const meshes = new Map<number, ChunkMesh>();

  /**
   * Builds the geometry and attributes around a chunk's CURRENT buffers. Run
   * once when the chunk's mesh is created, and again only on the rare patch
   * that grew the buffers — a typed array cannot be resized, so a grown chunk
   * needs new attributes, and the old geometry is disposed rather than left to
   * hold its GPU buffers until the world is replaced.
   */
  const bindGeometry = (entry: ChunkMesh): void => {
    const positionAttribute = new BufferAttribute(entry.buffers.positions, 3);
    // `true` = NORMALIZED: the GPU reads these byte attributes back as
    // value/127 (signed) and value/255 (unsigned). Omitting the flag would feed
    // the shader raw integers up to 255 and blow out both lighting and colour.
    const normalAttribute = new BufferAttribute(entry.buffers.normals, 3, true);
    const colorAttribute = new BufferAttribute(entry.buffers.colors, 3, true);
    // NORMALISED, so the shader reads the flag's 0/255 bytes as 0.0/1.0 and the
    // injected mix() needs no conversion of its own.
    const selfLitAttribute = new BufferAttribute(entry.buffers.selfLit, 1, true);
    // All four attributes are rewritten on every edit that touches this chunk.
    positionAttribute.setUsage(DynamicDrawUsage);
    normalAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    selfLitAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', normalAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setAttribute(SELF_LIT_ATTRIBUTE, selfLitAttribute);

    const previous = entry.mesh.geometry;
    entry.mesh.geometry = geometry;
    // The mesh is only ever pointed at one geometry at a time, and no other
    // mesh shares it (nothing is shared between chunks any more — geometry is
    // non-indexed, so there is no world-independent index buffer to share).
    if (previous !== geometry) previous.dispose();

    entry.positionAttribute = positionAttribute;
    entry.normalAttribute = normalAttribute;
    entry.colorAttribute = colorAttribute;
    entry.selfLitAttribute = selfLitAttribute;
  };

  /**
   * Rewrites one chunk's geometry in place and re-syncs everything downstream
   * of the vertex data: the GPU upload flags, the draw range (the triangle
   * count moves whenever a sculpt reshapes a contour), and the bound.
   */
  const writeChunk = (chunkIdx: number, entry: ChunkMesh): void => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;

    // In place: same arrays, same attributes, same geometry, same mesh —
    // unless this chunk's geometry outgrew its capacity, which is the one case
    // that reallocates (see the buffer strategy in the module header).
    const counts = writeChunkVertexData(mirror, cx, cy, entry.buffers, palettes);
    if (counts.capacityGrew) bindGeometry(entry);

    entry.positionAttribute.needsUpdate = true;
    entry.normalAttribute.needsUpdate = true;
    entry.colorAttribute.needsUpdate = true;
    entry.selfLitAttribute.needsUpdate = true;

    // The live prefix of the buffers. Three honours drawRange in BOTH the
    // renderer and Mesh.raycast, so the unused tail is neither drawn nor
    // pickable — verified against three 0.185 src/objects/Mesh.js. On
    // non-indexed geometry the range counts VERTICES.
    entry.mesh.geometry.setDrawRange(0, counts.vertexCount);

    // Heights changed, so the culling/raycast bound is stale. Skipping it makes
    // edited chunks vanish at certain camera angles and stop being clickable.
    // computeBoundingSphere ignores drawRange and reads the whole attribute,
    // which is exactly why writeChunkVertexData collapses the unused tail onto
    // a vertex inside this chunk instead of leaving it stale or zeroed.
    entry.mesh.geometry.computeBoundingSphere();
  };

  const createChunkMesh = (chunkIdx: number): ChunkMesh => {
    const buffers = createChunkGeometryBuffers();
    // The mesh starts on an empty geometry that bindGeometry immediately
    // replaces; it exists only so the entry is well-typed before its buffers
    // are bound.
    const mesh = new Mesh(new BufferGeometry(), material);
    const placeholder = new BufferAttribute(new Float32Array(0), 3);
    const entry: ChunkMesh = {
      mesh,
      buffers,
      positionAttribute: placeholder,
      normalAttribute: placeholder,
      colorAttribute: placeholder,
      selfLitAttribute: placeholder,
    };
    bindGeometry(entry);
    // One code path fills the buffers and sets the draw range, whether the
    // chunk is new or being re-patched — a mesh created with a stale (default,
    // Infinity) draw range would draw its whole unwritten tail on frame one.
    writeChunk(chunkIdx, entry);

    group.add(mesh);
    return entry;
  };

  const disposeEntry = (entry: ChunkMesh): void => {
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
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

  /** Builds one queued chunk, creating its mesh if this is its first build. */
  const buildChunk = (chunkIdx: number): void => {
    // Re-checked at DRAIN time, not at queue time: a chunk can be dropped from
    // `received` between the two (a rejoin replaces the world), and building
    // one the mirror no longer holds would read heights that are not there.
    if (!mirror.received.has(chunkIdx)) return;
    const existing = meshes.get(chunkIdx);
    if (existing === undefined) {
      meshes.set(chunkIdx, createChunkMesh(chunkIdx));
    } else {
      writeChunk(chunkIdx, existing);
    }
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
    for (const entry of meshes.values()) disposeEntry(entry);
    meshes.clear();
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
      return Array.from(meshes.values(), (entry) => entry.mesh);
    },
    dispose(): void {
      stopDraining?.();
      clear();
      material.dispose();
    },
  };
}
