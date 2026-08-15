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
      ),
      '#include <begin_vertex>',
      `vSelfLit = ${SELF_LIT_ATTRIBUTE};\n#include <begin_vertex>`,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        '#include <common>\nvarying float vSelfLit;',
      ),
      '#include <opaque_fragment>',
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );\n#include <opaque_fragment>',
    );
  };
}

/**
 * String substitution into a stock three shader that REFUSES to no-op.
 *
 * A plain `.replace` on a missing needle returns the source untouched, and the
 * only symptom would be underwater outlines quietly going dark again on some
 * future three upgrade — the exact bug this whole path exists to close, back
 * in a form no test would notice. Every anchor used here is a shader include
 * that three has carried for many major versions, so this can only fire when
 * an upgrade genuinely moves the ground under the patch: it throws on the
 * first frame, on the developer's machine, naming the anchor that moved.
 */
function spliceShader(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) {
    throw new Error(
      `terrain shader patch failed: three no longer emits "${anchor}". ` +
        'Re-anchor the self-lit injection in render/terrainMeshes.ts.',
    );
  }
  return source.replace(anchor, replacement);
}

/**
 * Three's working colour space is linear; the palettes in bandColors.ts are
 * sRGB (that is how the hex values were chosen). Converting the nine palette
 * entries ONCE here, rather than per vertex per patch, is the whole reason
 * bandColors separates "which entry" from "the entry". The cliff ramp goes
 * through the same door: it is derived from the top ramp in sRGB (where the
 * darken factor was judged by eye) and converted here, never per face.
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

export interface TerrainMeshes {
  /**
   * Creates any missing meshes and re-patches the given chunks. Indices for
   * chunks the mirror has not received are ignored — that is the mechanism by
   * which locked terrain stays invisible.
   */
  update(dirty: Iterable<number>): void;
  /** Drops every mesh — used when a fresh join replaces the world. */
  clear(): void;
  /** Meshes the raycaster should test. */
  pickables(): Mesh[];
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const palettes: ChunkPalettes = {
    top: toLinearPalette(TERRAIN_PALETTE),
    cliff: toLinearPalette(CLIFF_PALETTE),
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
    const normalAttribute = new BufferAttribute(entry.buffers.normals, 3);
    const colorAttribute = new BufferAttribute(entry.buffers.colors, 3);
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

  const clear = (): void => {
    for (const entry of meshes.values()) disposeEntry(entry);
    meshes.clear();
  };

  return {
    update(dirty: Iterable<number>): void {
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        const existing = meshes.get(chunkIdx);
        if (existing === undefined) {
          meshes.set(chunkIdx, createChunkMesh(chunkIdx));
        } else {
          writeChunk(chunkIdx, existing);
        }
      }
    },
    clear,
    pickables(): Mesh[] {
      return Array.from(meshes.values(), (entry) => entry.mesh);
    },
    dispose(): void {
      clear();
      material.dispose();
    },
  };
}
