// The sea: a single flat translucent plane at SEA_LEVEL.
//
// Design decision Q3 (docs/DESIGN.md): water is a DERIVED fact of the
// heightmap, never simulated state — anything at or below SEA_LEVEL is
// underwater. So there is nothing to sync on the wire and the GEOMETRY never
// updates per tick; this is one static quad, still true after the change
// below. Phase 1 deliberately adds no wave or shimmer animation: the doc
// allows it as a purely client-side visual, but it earns nothing yet and a
// still sea makes the terrace steps easier to judge while tuning them.
//
// DEPTH-AWARE ALPHA (2026-08-19, Deep Strata follow-up — mechanics card 41
// added a self-lit lava band at MIN_HEIGHT, and the owner reported digging
// down to it and being unable to see it through the sea). Confirmed by
// screenshotting the actual owner-dug lava crater in server/data/world.db
// through the live client: the flat CONSTANT opacity below — 0.62 for every
// cell, shelf or trench alike — already read as fully opaque over that
// crater, even though the lava band itself renders correctly (self-lit, full
// brightness — terrain/capEmission.ts). The fix stays a rendering change over
// derived data, per Q3: alpha is now a function of each cell's water-column
// DEPTH (SEA_LEVEL minus the mirror's own height there), computed once by the
// pure curve in terrain/waterDepth.ts and looked up per fragment from a
// small DataTexture, not by adding simulated state or subdividing the quad.
// See waterDepth.ts's header for why a texture lookup rather than per-vertex
// geometry, and for the curve's shape and constants.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  type Object3D,
} from 'three';
import {
  CHUNK_SIZE,
  SEA_LEVEL,
  chunksPerEdge,
} from '@terrace/shared';
import {
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
  WATER_SURFACE_LIFT,
} from '../config.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  WATER_SELF_LIGHT_RADIANCE,
  WATER_DEEP_TINT,
  WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  WATER_SHADE_MIX_DEFAULT_BYTE,
  WATER_SHALLOW_TINT,
  WATER_SPECULAR_FACTOR_DEFAULT_BYTE,
  writeWaterDepthTexels,
} from '../terrain/waterDepth.ts';
import { spliceShader } from './shaderSplice.ts';
import { makeBanded } from './water/waterBands.ts';

/**
 * Exported so other render modules that want to blend toward "the sea" — the
 * frontier mist curtain (render/frontierFog.ts) — derive it from this one
 * definition rather than picking a second water colour that could drift out
 * of sync.
 */
export const WATER_COLOR = 0x2f6f9e;
/**
 * 0.15 → 0.6 (owner, 2026-08-14: "I'm not sure I like the sun being so
 * visible"). At 0.15 the surface was near-mirror and painted a large white
 * specular bloom of the sun across the sea; 0.6 spreads that highlight into a
 * broad soft sheen — the water still reads wet, but no patch of it reads as
 * the sun. Tuned together with the scene's key/fill rebalance in scene.ts.
 */
const WATER_ROUGHNESS = 0.9;
/**
 * Zero, with the roughness above near-full (second pass, 2026-08-14: at 0.6 /
 * 0.1 the lowered sun still washed a broad white sheen across the whole
 * sun-side sea — the owner's "white aura"). The water reads as water from its
 * colour, translucency and the seabed under it, not from reflecting the sun.
 */
const WATER_METALNESS = 0;

/**
 * How the depth SHADE scales the sea's own colour at each end of the water
 * column (2026-08-24, owner: "Shallows should draw light, and the Deeper the
 * water, the darker it should render").
 *
 * Above 1 at the shallow end and well below it at the deep end, so the ramp
 * spends its range in BOTH directions from the flat colour the sea used to be
 * everywhere — shallows genuinely lighten rather than merely darkening less.
 * The mix parameter between them is the texel waterDepth.ts's depthToShadeMix
 * writes; these two constants are the only place the range lives.
 */


/**
 * THE SEA IS DRAWN ONLY OVER REVEALED CHUNKS (owner, 2026-08-24: "I'd like to
 * eliminate both of those. The user experience with them is poor").
 *
 * WHAT IT REPLACES, and the two artefacts that were one bug. The sea used to
 * be a single quad spanning the whole world plus a 256-world-unit ring of
 * cosmetic open ocean on every side — 1024 units across on a default world,
 * against a revealed area that starts at a few chunks. Two square outlines
 * came out of that, and the owner could read neither as playable ground:
 *
 *   1. the quad's own silhouette, an ocean four times the world's area with
 *      nothing in it, which is what the world looked like from any camera
 *      pulled back far enough to see the revealed island; and
 *   2. a second, tonal square INSIDE that silhouette, which read as another
 *      surface entirely. MEASURED, not inferred (headless client, 2026-08-24):
 *      hiding this one mesh removes BOTH squares, so the inner one is not a
 *      second object; and flat-filling the depth-alpha texture darkens that
 *      region alone, so it is this shader's own out-of-world sampling. The
 *      depth-alpha and specular-factor samples below are `worldCellXZ /
 *      worldSizeCells`, so every fragment of the margin ring sampled outside
 *      [0, 1] and got border texels smeared over it by ClampToEdgeWrapping —
 *      an alpha nobody chose, painted over four times the world's area. (The
 *      exact reason the step landed on one corner region rather than a full
 *      nine-patch was not chased down; it stops existing below.)
 *
 * Clipping the surface to the RECEIVED-CHUNK SET removes both at once, and
 * removes the second one structurally rather than by tuning: no fragment of
 * the sea exists outside the world any more, so no sample can leave [0, 1] and
 * there is no clamp region to see the edge of. What is left is a sea exactly
 * coextensive with the ground the player actually has — the same statement the
 * frontier mist (render/frontierFog.ts) already makes, and the mist stands at
 * that boundary by construction (its base row sits below min(local terrain,
 * sea level)), so the surface's cut edge is veiled where it ends.
 *
 * ONE QUAD PER RECEIVED CHUNK, spanning exactly the ground that chunk's
 * terrain mesh draws — the lattice of cell CENTRES, [x0, x0 + CHUNK_SIZE] in
 * cells (terrain/vertexGrid.ts's "KNOWN, ACCEPTED" note) — so sea and terrain
 * tile the same plane with no gap or overlap at any chunk seam.
 *
 * STILL ONE DRAW CALL AND STILL NO PER-TICK GEOMETRY. Every quad goes into one
 * BufferGeometry, rebuilt only by `sync` — i.e. on join and on chunk unlock,
 * the same two events frontierFog.sync answers to, never on a sculpt. Q3's
 * "water is derived, never simulated" is untouched: this changes WHERE the
 * surface is drawn, not what decides it.
 */
const VERTICES_PER_CHUNK_QUAD = 4;
/** Two triangles. */
const INDICES_PER_CHUNK_QUAD = 6;


export interface Water {
  /**
   * Reallocates the depth-alpha texture (below) for a newly known world size — always,
   * even when the size is unchanged: a rejoin resends every chunk this
   * client has unlocked in the new JoinSnapshotMessage, so the `refresh`
   * call world.ts makes right after with that snapshot's dirty set
   * repopulates every texel a visible chunk needs. Matches how resetWorld
   * already rebuilds the whole mirror/mesh set on every snapshot regardless
   * of a size change (world.ts) — one fewer "did it actually change"
   * branch to keep in sync with that contract.
   *
   * It no longer sizes the surface: WHERE the sea is drawn is the received-set
   * question `sync` answers, and a world size with no chunks received yet has
   * no sea at all.
   */
  setWorldSize(worldSize: number): void;
  /**
   * Rebuilds the surface over exactly the chunks the mirror has received.
   *
   * Called wherever `frontierFog.sync` is (world.ts: the join snapshot and a
   * chunk unlock) and for the same reason — both layers are facts about the
   * RECEIVED SET and nothing else, so they are correct exactly when they are
   * refreshed together. Never called per sculpt: an edit changes heights,
   * which the depth texture handles through `refresh`, not which chunks exist.
   */
  sync(mirror: TerrainMirror): void;
  /**
   * Rewrites the depth-alpha texels for exactly the given dirty chunks —
   * the same set `terrainMeshes.update` and `frontierFog.refresh` are
   * already called with (world.ts's `applyDirty`, and the snapshot/
   * chunk-unlock handlers). Cheap and chunk-scoped, never a world-sized
   * rescan; see terrain/waterDepth.ts's writeWaterDepthTexels.
   */
  refresh(mirror: TerrainMirror, dirty: Iterable<number>): void;
  dispose(): void;
}

/**
 * Depth-alpha lookup: one byte per world cell, sampled per water FRAGMENT by
 * world-space XZ (not per vertex — the plane stays the single quad it always
 * was; see the file header and waterDepth.ts for why a texture rather than
 * subdividing the geometry). Uint8/RedFormat is the smallest texture three
 * supports for a single scalar channel: a full 512² world is 256 KB, and a
 * dirty-chunk `refresh` touches at most a few hundred texels — both figures
 * the same order as the terrain patch path's own per-edit budget
 * (render/terrainMeshes.ts's header).
 *
 * NEAREST, NOT LINEAR (2026-08-27 — this comment used to argue the exact
 * opposite, and the argument was the second half of the bug terrain/
 * waterDepth.ts's bandFloorWaterDepthWorldUnits describes). "A hard step at
 * every cell boundary" is not a cost here, it is the entire requirement: the
 * terrain under this texture is a staircase, and the owner's report is that the
 * sea over it shows no steps at all. LinearFilter smeared each texel across its
 * neighbours, so even once the data underneath became a per-band step (it now
 * is) the screen would still have received a ramp — the two changes only work
 * together, which is why neither was enough on its own. "The right visual for a
 * soft alpha cue" was a real preference and it is the one being overruled: a
 * soft cue is what makes two adjacent bands indistinguishable. No mipmaps: the sea
 * is viewed near-perpendicular from the game's usual high camera, so
 * minification aliasing is not a concern worth a mip chain for an NPOT
 * (world sizes are multiples of CHUNK_SIZE, not necessarily of 2) texture.
 *
 * AMENDMENT (2026-08-20): every word above applies unchanged to a SECOND
 * texture of the identical shape — the specular-factor lookup created by the
 * same factory just below (waterDepth.ts's depthToSpecularFactor is the
 * other half of the milky-water fix; see its module comment for why it is a
 * second texture rather than a second channel squeezed out of this one).
 */
function createDepthTexture(
  worldSize: number,
  defaultByte: number,
): { texture: DataTexture; buffer: Uint8Array } {
  const buffer = new Uint8Array(worldSize * worldSize).fill(defaultByte);
  const texture = new DataTexture(buffer, worldSize, worldSize, RedFormat, UnsignedByteType);
  texture.generateMipmaps = false;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return { texture, buffer };
}

/**
 * Wires the depth-alpha texture into the water material's fragment shader.
 *
 * Same technique render/terrainMeshes.ts already uses for its self-lit
 * attribute (onBeforeCompile + spliceShader) rather than a second material or
 * a custom ShaderMaterial: one texture sample and one multiply costs nothing
 * extra to draw, and it keeps every other MeshStandardMaterial behaviour
 * (roughness/metalness response, tone mapping, colour space, the DoubleSide
 * back-face render) exactly as tuned — see the 2026-08-14 sun-glare comments
 * above, which this patch does not touch.
 *
 * uWaterDepthAlpha and uWorldSizeCells are plain objects the caller mutates
 * in place (texture.image swapped, .value reassigned) rather than reassigned
 * wholesale, so nothing here needs to run again after the first compile.
 *
 * AMENDMENT (2026-08-20, specular suppression — the other half of the
 * milky-water-over-Deep-Strata fix, see waterDepth.ts's "SPECULAR
 * SUPPRESSION" comment for why this needs its own texture rather than
 * reusing uWaterDepthAlpha's own sample). A second splice, at the exact spot
 * three's meshphysical fragment shader finishes summing
 * `reflectedLight.directSpecular + reflectedLight.indirectSpecular` into
 * `totalSpecular` — i.e. before that value is folded into `outgoingLight`
 * a few lines later (`outgoingLight = totalDiffuse + totalSpecular +
 * totalEmissiveRadiance;`) — scales just the specular term by the
 * depth-derived factor. Anchored there rather than on `outgoingLight`
 * itself so ONLY the lit sheen (the broad sun highlight WATER_ROUGHNESS
 * produces) is suppressed with depth; totalDiffuse — the water's own base
 * colour response — is untouched, and the existing diffuseColor.a multiply
 * below (unchanged by this amendment) still separately governs how much of
 * the terrain shows through. Verified against the same three 0.185
 * meshphysical fragment chunk render/terrainMeshes.ts's own splice cites.
 */
/**
 * Formats a JS number as a GLSL float literal. GLSL ES forbids mixing int and
 * float in an expression, so a spliced-in constant that happens to be integral
 * (`4`) would fail to compile where `4.0` is fine; `toFixed` guarantees the
 * decimal point that makes the literal a float whatever the value is.
 */
function glslFloat(value: number): string {
  return value.toFixed(6);
}

/** The same, for a colour constant that lives in TypeScript as a triple. */
function glslVec3(value: readonly [number, number, number]): string {
  return `vec3( ${value.map(glslFloat).join(', ')} )`;
}

function makeDepthAware(
  material: MeshStandardMaterial,
  depthAlphaTexture: DataTexture,
  specularFactorTexture: DataTexture,
  shadeMixTexture: DataTexture,
  worldSizeUniform: { value: number },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterDepthAlpha = { value: depthAlphaTexture };
    shader.uniforms.uWaterSpecularFactor = { value: specularFactorTexture };
    shader.uniforms.uWaterShadeMix = { value: shadeMixTexture };
    shader.uniforms.uWorldSizeCells = worldSizeUniform;
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        '#include <common>\nvarying vec2 vWaterCellXZ;',
        'water',
      ),
      '#include <begin_vertex>',
      // World-space, not local: the plane is rotated and re-centred per
      // setWorldSize, and cell (0,0) must land on texel (0,0) regardless.
      // The scale factor is CELL_WORLD_SIZE (config.ts) and it is spliced in
      // as a literal rather than passed as a uniform because it is a
      // compile-time constant of the build — it was 1 until the 2026-08-21
      // re-sample, which is why this line used to have no factor at all.
      `#include <begin_vertex>\nvWaterCellXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz / ${glslFloat(CELL_WORLD_SIZE)};`,
      'water',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.fragmentShader,
          '#include <common>',
          '#include <common>\nvarying vec2 vWaterCellXZ;\nuniform sampler2D uWaterDepthAlpha;\nuniform sampler2D uWaterSpecularFactor;\nuniform sampler2D uWaterShadeMix;\nuniform float uWorldSizeCells;',
          'water',
        ),
        // Exact anchor copied verbatim from this project's installed three
        // 0.185 (client/node_modules/three/build/three.module.js, the
        // `fragment$5` / meshphysical PHYSICAL chunk): the line that sums
        // the two specular reflectedLight terms, immediately before
        // `#include <transmission_fragment>` and the `outgoingLight =
        // totalDiffuse + totalSpecular + totalEmissiveRadiance;` line that
        // consumes it. spliceShader throws if a future three upgrade moves
        // this line — the guard this codebase relies on (shaderSplice.ts).
        'vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;',
        // ClampToEdgeWrapping (DataTexture's default) handles the margin ring
        // beyond the world border, same as the depth-alpha sample below.
        'vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;\ntotalSpecular *= texture2D( uWaterSpecularFactor, wDepthUv ).r;',
        'water',
      ),
      // Spliced at <color_fragment> — the base colour BEFORE lighting, the same
      // anchor water/waterBands.ts uses, and for the same reason: the shade is
      // part of what colour this water IS, so it should be lit, tone-mapped and
      // fogged like any other surface colour rather than pasted over the lit
      // result. It composes with the bands by plain multiplication, which is
      // what lets the painted steps stay legible against a deep sea instead of
      // being flattened by it — the whole point of adding it.
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        // THE HALF-CELL, and it is a correction, not a flourish (2026-08-27).
        // A chunk's drawn area is the lattice of cell CENTRES, so cell i covers
        // world cell-units [i - 0.5, i + 0.5) (terrain/vertexGrid.ts's "KNOWN,
        // ACCEPTED" note) — while texel i covers [i, i + 1). Sampling at
        // vWaterCellXZ / worldSize therefore read the depth of the cell HALF A
        // CELL away for every fragment. Under the old LinearFilter that showed
        // up as a bias inside a smear and nobody could see it; unfiltered it is
        // a visible half-cell offset between the sea's bands and the terrace
        // they are drawn over, caught in a top-down capture of the staircase
        // fixture. The + 0.5 puts the sample on the texel CENTRE that belongs
        // to the cell the fragment is actually standing on.
        'vec2 wDepthUv = ( vWaterCellXZ + 0.5 ) / uWorldSizeCells;',
        // The depth-alpha sample is taken HERE rather than at its own
        // <opaque_fragment> splice below, where the alpha is applied.
        // ClampToEdgeWrapping (DataTexture's default) handles the margin ring
        // beyond the world border: UVs past [0,1] just hold the edge cell's
        // depth, the same "clamp to world" rule terrain/mirror.ts's own
        // sampleHeight applies to any out-of-bounds read.
        'float wDepthAlpha = texture2D( uWaterDepthAlpha, wDepthUv ).r;',
        // A COLOUR range, not a scalar one, since 2026-08-27 — see
        // terrain/waterDepth.ts's WATER_SHALLOW_TINT for why hue carries part
        // of the depth signal now.
        `diffuseColor.rgb *= mix( ${glslVec3(WATER_DEEP_TINT)}, ${glslVec3(
          WATER_SHALLOW_TINT,
        )}, texture2D( uWaterShadeMix, wDepthUv ).r );`,
      ].join('\n'),
      'water',
    );
    shader.fragmentShader = spliceShader(
      shader.fragmentShader,
      // three emits this include after <color_fragment> in the same main(), so
      // diffuseColor already carries the depth tint, and
      // `totalEmissiveRadiance` has just been initialised to `emissive`. What
      // is added here is summed into `outgoingLight` AFTER the lighting sum,
      // so it does not scale with the sky rig — this is the sea's own light,
      // and it is what keeps the water legible at night. See
      // WATER_SELF_LIGHT_RADIANCE for the value.
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * ${glslFloat(
        WATER_SELF_LIGHT_RADIANCE,
      )};`,
      'water',
    );
    shader.fragmentShader = spliceShader(
      shader.fragmentShader,
      '#include <opaque_fragment>',
      // wDepthAlpha was sampled at the <color_fragment> splice above, which
      // three emits earlier in the same main().
      'diffuseColor.a *= wDepthAlpha;\n#include <opaque_fragment>',
      'water',
    );
  };
}

export interface WaterOptions {}

export function createWater(
  parent: Object3D,
  initialWorldSize: number,
  options: WaterOptions = {},
): Water {
  const { texture: depthAlphaTexture, buffer: initialDepthAlphaBuffer } = createDepthTexture(
    initialWorldSize,
    WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  );
  // Second depth-derived texture (2026-08-20) — see makeDepthAware's
  // amendment and waterDepth.ts's "SPECULAR SUPPRESSION" comment.
  const { texture: specularFactorTexture, buffer: initialSpecularFactorBuffer } =
    createDepthTexture(initialWorldSize, WATER_SPECULAR_FACTOR_DEFAULT_BYTE);
  // Third depth-derived texture (2026-08-24) — the depth SHADE, which gives the
  // sea its own light-to-dark structure. See waterDepth.ts's depthToShadeMix
  // for why it is a third curve and not a reuse of either of the two above.
  const { texture: shadeMixTexture, buffer: initialShadeMixBuffer } = createDepthTexture(
    initialWorldSize,
    WATER_SHADE_MIX_DEFAULT_BYTE,
  );
  // Reassigned wholesale by setWorldSize; depthAlphaTexture/specularFactorTexture
  // themselves never are (see makeDepthAware's doc comment).
  let depthAlphaBuffer = initialDepthAlphaBuffer;
  let specularFactorBuffer = initialSpecularFactorBuffer;
  let shadeMixBuffer = initialShadeMixBuffer;
  // Mutated in place on every setWorldSize; the compiled shader holds this
  // same object by reference, so no re-wiring is needed after a resize.
  const worldSizeUniform = { value: initialWorldSize };

  const material = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    // No longer a flat constant here — see makeDepthAware. Left at the
    // MeshStandardMaterial default (1) and multiplied down per fragment.
    roughness: WATER_ROUGHNESS,
    metalness: WATER_METALNESS,
    // Terrain is opaque and therefore drawn first; the sea then blends over
    // it. Not writing depth is what lets submerged terrain remain visible
    // through the surface instead of being hidden by it.
    depthWrite: false,
    // Visible from below, for when the camera dips toward the horizon.
    side: DoubleSide,
  });
  makeDepthAware(
    material,
    depthAlphaTexture,
    specularFactorTexture,
    shadeMixTexture,
    worldSizeUniform,
  );
  // The sea gets the same painted bands the rivers do — one rule, in
  // water/waterBands.ts, precisely so the ocean cannot be left behind when the
  // rivers get a treatment. Applied AFTER makeDepthAware because makeBanded
  // chains onto whatever onBeforeCompile is already there; the reverse order
  // would drop the depth-alpha splice and take the shallows with it.
  makeBanded(material);

  // Built in WORLD space rather than as a rotated local plane: a quad's XZ
  // corners come straight from its chunk's cell coordinates, and the shader's
  // own sample is world-space too (see makeDepthAware), so there is no local
  // frame left for either to disagree about.
  const geometry = new BufferGeometry();
  const mesh = new Mesh(geometry, material);
  // Nothing to draw until the first `sync`; a mesh with an empty draw range
  // still costs a frustum test, and this is the state between construction and
  // the join snapshot.
  mesh.visible = false;
  parent.add(mesh);
  // Lifted off the SEA_LEVEL plane on purpose — band-0 terrain renders exactly
  // there and would z-fight. See WATER_SURFACE_LIFT for the full reasoning.
  const surfaceY = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

  /**
   * Quads the current buffers can hold. Grown by doubling and never shrunk,
   * so revealing territory reallocates O(log chunks) times over a session
   * rather than once per unlock.
   */
  let quadCapacity = 0;
  let positions = new Float32Array(0);
  let normals = new Float32Array(0);
  let indices = new Uint32Array(0);

  const growTo = (quads: number): void => {
    if (quads <= quadCapacity) return;
    let capacity = quadCapacity === 0 ? 1 : quadCapacity;
    while (capacity < quads) capacity *= 2;
    quadCapacity = capacity;
    positions = new Float32Array(capacity * VERTICES_PER_CHUNK_QUAD * 3);
    normals = new Float32Array(capacity * VERTICES_PER_CHUNK_QUAD * 3);
    indices = new Uint32Array(capacity * INDICES_PER_CHUNK_QUAD);
    // The surface is flat and horizontal everywhere, so every normal is +Y and
    // every quad's index pattern is the same one shifted by its vertex offset —
    // both are written once here rather than per rebuild.
    for (let vertex = 0; vertex < capacity * VERTICES_PER_CHUNK_QUAD; vertex++) {
      normals[vertex * 3 + 1] = 1;
    }
    for (let quad = 0; quad < capacity; quad++) {
      const v = quad * VERTICES_PER_CHUNK_QUAD;
      const i = quad * INDICES_PER_CHUNK_QUAD;
      // (v+0, v+2, v+1) and (v+1, v+2, v+3) wind counter-clockwise seen from
      // above, i.e. front-facing with the +Y normals written above.
      indices[i] = v;
      indices[i + 1] = v + 2;
      indices[i + 2] = v + 1;
      indices[i + 3] = v + 1;
      indices[i + 4] = v + 2;
      indices[i + 5] = v + 3;
    }
    geometry.dispose();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
  };

  const setWorldSize = (worldSize: number): void => {
    // See the Water.setWorldSize doc comment: reallocated unconditionally,
    // every call — the caller's next `refresh` with the fresh snapshot's
    // dirty set repopulates every texel a revealed chunk needs.
    depthAlphaBuffer = new Uint8Array(worldSize * worldSize).fill(
      WATER_DEPTH_ALPHA_DEFAULT_BYTE,
    );
    depthAlphaTexture.image = { data: depthAlphaBuffer, width: worldSize, height: worldSize };
    depthAlphaTexture.needsUpdate = true;
    // Same reallocate-unconditionally contract as depthAlphaBuffer above.
    specularFactorBuffer = new Uint8Array(worldSize * worldSize).fill(
      WATER_SPECULAR_FACTOR_DEFAULT_BYTE,
    );
    specularFactorTexture.image = {
      data: specularFactorBuffer,
      width: worldSize,
      height: worldSize,
    };
    specularFactorTexture.needsUpdate = true;
    // Same reallocate-unconditionally contract again.
    shadeMixBuffer = new Uint8Array(worldSize * worldSize).fill(WATER_SHADE_MIX_DEFAULT_BYTE);
    shadeMixTexture.image = { data: shadeMixBuffer, width: worldSize, height: worldSize };
    shadeMixTexture.needsUpdate = true;
    worldSizeUniform.value = worldSize;
  };

  setWorldSize(initialWorldSize);

  return {
    setWorldSize,
    sync(mirror: TerrainMirror): void {
      const chunkCols = chunksPerEdge(mirror.map.size);
      const chunkWorldSpan = CHUNK_SIZE * CELL_WORLD_SIZE;
      growTo(mirror.received.size);
      let quad = 0;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      // Ascending chunk index: the received set's own iteration order is
      // insertion order, which differs between a join and the unlocks that
      // follow it. Sorting keeps a chunk's vertices in the same place across
      // rebuilds, so a diff of two frames' buffers is readable.
      for (const chunkIdx of [...mirror.received].sort((a, b) => a - b)) {
        const x0 = (chunkIdx % chunkCols) * chunkWorldSpan;
        const z0 = Math.floor(chunkIdx / chunkCols) * chunkWorldSpan;
        const x1 = x0 + chunkWorldSpan;
        const z1 = z0 + chunkWorldSpan;
        const v = quad * VERTICES_PER_CHUNK_QUAD * 3;
        positions[v] = x0; positions[v + 1] = surfaceY; positions[v + 2] = z0;
        positions[v + 3] = x1; positions[v + 4] = surfaceY; positions[v + 5] = z0;
        positions[v + 6] = x0; positions[v + 7] = surfaceY; positions[v + 8] = z1;
        positions[v + 9] = x1; positions[v + 10] = surfaceY; positions[v + 11] = z1;
        if (x0 < minX) minX = x0;
        if (z0 < minZ) minZ = z0;
        if (x1 > maxX) maxX = x1;
        if (z1 > maxZ) maxZ = z1;
        quad++;
      }
      const positionAttribute = geometry.getAttribute('position') as BufferAttribute | undefined;
      if (positionAttribute) positionAttribute.needsUpdate = true;
      geometry.setDrawRange(0, quad * INDICES_PER_CHUNK_QUAD);
      if (quad === 0) {
        mesh.visible = false;
        return;
      }
      // Bounds are SET, never computed. three's computeBoundingSphere() walks
      // the whole position attribute — including the slots past the draw range,
      // which still hold (0, 0, 0) from the last capacity growth — so it would
      // stretch the sphere to the world's origin corner and cull the sea late.
      // The surface is a flat axis-aligned rectangle, so its exact sphere is
      // this, in closed form.
      const centreX = (minX + maxX) / 2;
      const centreZ = (minZ + maxZ) / 2;
      geometry.boundingSphere = new Sphere(
        new Vector3(centreX, surfaceY, centreZ),
        Math.hypot(maxX - centreX, maxZ - centreZ),
      );
      geometry.boundingBox = new Box3(
        new Vector3(minX, surfaceY, minZ),
        new Vector3(maxX, surfaceY, maxZ),
      );
      mesh.visible = quad > 0;
    },
    refresh(mirror: TerrainMirror, dirty: Iterable<number>): void {
      // NOTHING DIRTY MEANS NOTHING UPLOADED. The three `needsUpdate` flags
      // below cost a FULL re-upload of three world-sized textures each
      // (768 KB on a 512² world) whether or not a texel changed, so a call
      // with an empty set is the single most expensive no-op in the refresh
      // path. world.ts's `applyDirty` already returns before reaching here on
      // an empty set; this is the second layer, because `refresh` is public
      // and the snapshot/chunk-unlock paths call it directly.
      //
      // WHY NOT RANGED UPLOADS for the rows a sculpt actually touches: all
      // three textures are RedFormat/UnsignedByteType (createDepthTexture,
      // above) — one byte per texel. three's `updateTexture`
      // (WebGLTextures.js:799 in three 0.185.1) hard-codes
      // `componentStride = 4` with the comment "only RGBA supported" and
      // derives the uploaded pixel window as `range.start / 4` …
      // `ceil(range.count / 4)`. For a single-channel texture that addresses
      // the WRONG texels — it does not degrade to a full upload, it uploads a
      // quarter-width window at a quarter offset — so `addUpdateRange` is not
      // usable on these three until three supports non-RGBA strides. The win
      // ranged uploads were meant to buy is bought instead by this guard plus
      // the prediction filter: the echo that used to re-upload everything for
      // no change now does not call `refresh` at all.
      // Counted, never CONSUMED: `dirty` is typed `Iterable`, and probing a
      // one-shot iterator for emptiness would eat the element it found. Only
      // the sized collections every real caller passes are short-circuited;
      // anything else falls through to the full path.
      if (dirty instanceof Set && dirty.size === 0) return;
      if (Array.isArray(dirty) && dirty.length === 0) return;
      writeWaterDepthTexels(
        depthAlphaBuffer,
        worldSizeUniform.value,
        mirror,
        dirty,
        specularFactorBuffer,
        shadeMixBuffer,
      );
      depthAlphaTexture.needsUpdate = true;
      specularFactorTexture.needsUpdate = true;
      shadeMixTexture.needsUpdate = true;
    },
    dispose(): void {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      shadeMixTexture.dispose();
      depthAlphaTexture.dispose();
      specularFactorTexture.dispose();
    },
  };
}
