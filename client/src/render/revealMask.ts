// revealClip — nothing is drawn off the received map or past the world edge.
//
// THE DEFECT (#284). `mirror.received` is the client's whole notion of what
// exists (terrain/mirror.ts invariant 1), and core already derives the terrain
// meshes, the frontier mist and the sea from it. A PLUGIN had no way to ask:
// `ClientPluginCtx` carries a terrain height and nothing about what has been
// revealed. So a rain mass straddling the frontier drew its column, its haze
// and its deck over floor this client was never sent, and a mass near the
// border drew them over the void past the world's edge.
//
// WHY A MASK TEXTURE RATHER THAN A CPU TEST. The things that need clipping are
// GPU geometry — instanced puff decks, haze sheets, a `Points` column of ten
// thousand drops — and a per-particle `Set` lookup covers only the column while
// costing ~10 k lookups a frame. One R8 texel per CHUNK is 16 KB for the
// largest world this codebase allows (2048 cells → 128² chunks), uploaded only
// when `received` actually changes, and costs one texture fetch per clipped
// fragment. See plan §6 for the two alternatives this replaced.
//
// LINEAR FILTERING, DELIBERATELY. The mask fades across one chunk width instead
// of cutting on a chunk line, and REVEAL_CLIP_THRESHOLD puts the visible edge
// back on the boundary itself — the same line the frontier mist is drawn on, so
// the band the fade occupies is already covered by mist. Nothing here needs a
// half-texel correction of the kind render/water.ts's depth sample needs: that
// sample must read the cell the fragment stands on, this one is meant to blur.
//
// THE WORLD EDGE IS THE SAME RULE. A UV outside [0,1]² is off the map, and the
// fragment discards on it — so "past the world edge" needs no second clause and
// cannot disagree with the first.

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  type Material,
} from 'three';
import {
  CELL_WORLD_SIZE,
  CHUNK_SIZE,
  chunksPerEdge,
  chunkIndex,
} from '@terrace/shared';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  WORLD_POSITION_VERTEX_ANCHOR,
  WORLD_POSITION_VERTEX_GLSL,
  glslFloat,
  spliceShader,
} from './shaderSplice.ts';

/**
 * Whether cell (x, y) is inside the world AND in a chunk the server has sent
 * us — THE definition of "revealed" on the client, in one place.
 *
 * IT LIVES HERE rather than in world.ts because there were two copies of it
 * before this module existed (world.ts's chart closure, and every plugin that
 * wanted to ask and could not). The GPU mask below is built from exactly this
 * predicate, which is what makes a plugin's CPU answer and its clipped
 * geometry incapable of disagreeing.
 *
 * OUTSIDE THE WORLD IS FALSE, and that is the difference from `sampleHeight`,
 * which CLAMPS (mirror.ts). A height must answer something for a sample one
 * cell past the border; "is this revealed" must not, or a received chunk on
 * the border would make the whole infinite margin beyond the world read as
 * revealed ground.
 *
 * Fractional coordinates are floored, exactly as `chunkIndexOfCell` defines
 * chunk ownership — a caller holding a mass's interpolated centre asks with
 * the coordinate it has.
 */
export function revealedAtCell(mirror: TerrainMirror, x: number, y: number): boolean {
  const size = mirror.map.size;
  if (!(x >= 0 && y >= 0 && x < size && y < size)) return false;
  return mirror.received.has(
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
  );
}

/**
 * The byte a received chunk's texel carries. Full range rather than 1: the
 * sampler normalises a `RedFormat`/`UnsignedByteType` texel to [0,1] by
 * dividing by 255, so 255 is what makes a received chunk read as exactly 1.0
 * in the shader and the threshold below a plain midpoint.
 */
export const REVEAL_MASK_RECEIVED_BYTE = 255;

/**
 * Where the clip cuts, on the mask's linear ramp.
 *
 * THE MIDPOINT, and it is derived rather than tuned: with LinearFilter the
 * sampled value falls from 1 to 0 across the one chunk width between a
 * received texel's centre and its unreceived neighbour's, so the level 0.5 is
 * reached exactly at the chunk BOUNDARY — the line `received` actually draws,
 * and the line the frontier mist is hung on. Any other value would move the
 * geometry's edge off the terrain's own edge by a fraction of a chunk.
 */
export const REVEAL_CLIP_THRESHOLD = 0.5;

/** The shared uniform object — one upload reaches every clipped material. */
export interface RevealClipUniforms {
  readonly uRevealMask: { value: DataTexture };
  readonly uRevealChunksPerEdge: { value: number };
  readonly uWorldUnitsPerChunk: { value: number };
}

export interface RevealMask {
  /**
   * The one uniform object every clipped material shares. Its FIELDS are
   * rewritten in place on a world-size change, so a material patched before a
   * rejoin still points at the live texture afterwards.
   */
  uniforms(): RevealClipUniforms;
  /**
   * Rewrites the mask from `received`. Call it at every site that changes that
   * set — beside `fog.sync`, whose curtain is derived from the same fact, so
   * the two can never disagree. Reallocates when the world size changed;
   * flags an upload only when a texel actually moved.
   */
  sync(mirror: TerrainMirror): void;
  /**
   * onBeforeCompile clip for a STOCK three material (`MeshBasicMaterial`,
   * `LineBasicMaterial`, `PointsMaterial`, `MeshLambertMaterial`,
   * `MeshStandardMaterial`). CHAINS onto whatever the material already had —
   * a `ShaderMaterial` caller pastes the snippets below instead.
   */
  applyRevealClip(material: Material, label: string): void;
  dispose(): void;
}

// ── The GLSL, shared with `ShaderMaterial` callers via kit/revealClip.ts ─────
//
// INDENTATION CONVENTION as plugins/kit/puffDeck.ts: a snippet's first line
// carries no indent and its later lines carry the four spaces a shader body
// sits at. The declarations block is the exception — it is pasted at file
// scope, where there is no indent to match.

/**
 * The declarations, pasted into the header of BOTH stages.
 *
 * ONE SNIPPET FOR BOTH, rather than a vertex half and a fragment half: a
 * varying must be declared identically in the two stages or the link fails,
 * and two snippets that must agree are two snippets that can drift. The
 * vertex stage's copy of the uniforms is unused and the compiler drops it.
 */
export const REVEAL_CLIP_UNIFORMS_GLSL = `uniform sampler2D uRevealMask;
uniform float uRevealChunksPerEdge;
uniform float uWorldUnitsPerChunk;
varying vec2 vRevealXZ;
#define REVEAL_CLIP_THRESHOLD ${glslFloat(REVEAL_CLIP_THRESHOLD)}`;

/**
 * The vertex half. Expects `world` — the vertex's world-space position as a
 * `vec3` — in scope, the same name kit/puffDeck.ts's billboard expects.
 */
export const REVEAL_CLIP_VERTEX_GLSL = `vRevealXZ = world.xz;`;

/**
 * The fragment half: discard off the received map, and discard off the world.
 *
 * The two clauses are one lookup and one bounds test on the SAME UV, which is
 * why "past the world edge" needs no separate rule — a mass hanging over the
 * void has a UV outside [0,1]² and is gone by the same line that removes a
 * mass over unrevealed floor.
 */
export const REVEAL_CLIP_FRAGMENT_GLSL = `vec2 revealUv = vRevealXZ / ( uRevealChunksPerEdge * uWorldUnitsPerChunk );
    if ( any( lessThan( revealUv, vec2( 0.0 ) ) ) || any( greaterThan( revealUv, vec2( 1.0 ) ) ) ) discard;
    if ( texture2D( uRevealMask, revealUv ).r < REVEAL_CLIP_THRESHOLD ) discard;`;

/**
 * The fragment anchor: three's first line of `main()` in every ShaderLib
 * program this codebase patches, so a clipped fragment is discarded before any
 * of its own work is done. Verified against this project's installed three
 * 0.185.1 in meshphysical, meshbasic, meshlambert, points and linedashed.
 */
const REVEAL_CLIP_FRAGMENT_ANCHOR = '#include <clipping_planes_fragment>';

/** The header anchor, in both stages. */
const SHADER_COMMON_ANCHOR = '#include <common>';

function emptyMask(worldSize: number): DataTexture {
  const edge = chunksPerEdge(worldSize);
  const texture = new DataTexture(
    new Uint8Array(edge * edge),
    edge,
    edge,
    RedFormat,
    UnsignedByteType,
  );
  // LINEAR, so the mask fades over one chunk rather than cutting on a texel
  // line (see the header). CLAMP, so a UV that grazes the border holds the
  // edge chunk rather than wrapping to the far side of the world — belt and
  // suspenders under the fragment's own [0,1]² test, which has already
  // discarded anything genuinely outside.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function createRevealMask(worldSize: number): RevealMask {
  /**
   * World units one chunk covers. Constant for the build — CHUNK_SPAN, stated
   * as the product it is so a re-sample of the world (2026-08-21) cannot move
   * one of the two factors without moving this.
   */
  const worldUnitsPerChunk = CHUNK_SIZE * CELL_WORLD_SIZE;

  const uniforms: RevealClipUniforms = {
    uRevealMask: { value: emptyMask(worldSize) },
    uRevealChunksPerEdge: { value: chunksPerEdge(worldSize) },
    uWorldUnitsPerChunk: { value: worldUnitsPerChunk },
  };

  return {
    uniforms: () => uniforms,

    sync(mirror: TerrainMirror): void {
      const edge = chunksPerEdge(mirror.map.size);
      if (edge !== uniforms.uRevealChunksPerEdge.value) {
        // A REJOIN INTO A WORLD OF ANOTHER SIZE. The uniform OBJECT is kept
        // and its fields replaced, because every material patched this session
        // holds that object and nothing re-patches them.
        uniforms.uRevealMask.value.dispose();
        uniforms.uRevealMask.value = emptyMask(mirror.map.size);
        uniforms.uRevealChunksPerEdge.value = edge;
      }
      const texture = uniforms.uRevealMask.value;
      const data = texture.image.data as Uint8Array;
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        const byte = mirror.received.has(i) ? REVEAL_MASK_RECEIVED_BYTE : 0;
        if (data[i] === byte) continue;
        data[i] = byte;
        changed = true;
      }
      // ONLY ON A REAL CHANGE: `sync` is called from both terrain sites
      // unconditionally (world.ts), and a snapshot that revealed nothing new
      // must not cost a 16 KB upload.
      if (changed) texture.needsUpdate = true;
    },

    applyRevealClip(material: Material, label: string): void {
      // CHAIN, NEVER OVERWRITE. Water and terrain already carry their own
      // onBeforeCompile, and a plugin's pooled material may too; assigning
      // over it would silently drop that patch's whole feature.
      const previous = material.onBeforeCompile.bind(material);
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.uniforms.uRevealMask = uniforms.uRevealMask;
        shader.uniforms.uRevealChunksPerEdge = uniforms.uRevealChunksPerEdge;
        shader.uniforms.uWorldUnitsPerChunk = uniforms.uWorldUnitsPerChunk;
        shader.vertexShader = spliceShader(
          spliceShader(
            shader.vertexShader,
            SHADER_COMMON_ANCHOR,
            `${SHADER_COMMON_ANCHOR}\n${REVEAL_CLIP_UNIFORMS_GLSL}`,
            label,
          ),
          WORLD_POSITION_VERTEX_ANCHOR,
          [
            WORLD_POSITION_VERTEX_ANCHOR,
            WORLD_POSITION_VERTEX_GLSL,
            'vec3 world = tWorldPosition.xyz;',
            REVEAL_CLIP_VERTEX_GLSL,
          ].join('\n    '),
          label,
        );
        shader.fragmentShader = spliceShader(
          spliceShader(
            shader.fragmentShader,
            SHADER_COMMON_ANCHOR,
            `${SHADER_COMMON_ANCHOR}\n${REVEAL_CLIP_UNIFORMS_GLSL}`,
            label,
          ),
          REVEAL_CLIP_FRAGMENT_ANCHOR,
          `${REVEAL_CLIP_FRAGMENT_ANCHOR}\n    ${REVEAL_CLIP_FRAGMENT_GLSL}`,
          label,
        );
      };
      // THE PROGRAM CACHE KEY, and it is not optional. three keys a compiled
      // program by material type plus parameters plus `customProgramCacheKey`
      // — NOT by onBeforeCompile — so a clipped LineBasicMaterial and an
      // unclipped one with the same parameters would share one program, and
      // whichever compiled first would decide whether BOTH clip.
      const previousKey = material.customProgramCacheKey.bind(material);
      material.customProgramCacheKey = () => `${previousKey()}|revealClip`;
      // Only matters if this material has already been compiled once; free
      // otherwise, and it is what makes patching a live material legal.
      material.needsUpdate = true;
    },

    dispose(): void {
      uniforms.uRevealMask.value.dispose();
    },
  };
}
