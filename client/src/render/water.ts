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
  DataTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  UnsignedByteType,
  type Object3D,
} from 'three';
import { SEA_LEVEL } from '@terrace/shared';
import {
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
  WATER_SURFACE_LIFT,
} from '../config.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  writeWaterDepthTexels,
} from '../terrain/waterDepth.ts';
import { spliceShader } from './shaderSplice.ts';

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
 * Cells of open ocean drawn beyond the world's edge. Purely cosmetic: it stops
 * the sea ending in a visible straight edge when the camera looks outward past
 * a small revealed area.
 */
const WATER_MARGIN_CELLS = 256;

/** Quarter turn: PlaneGeometry is built in XY, and the sea lies in XZ. */
const PLANE_TO_GROUND_ROTATION_X = -Math.PI / 2;

export interface Water {
  /**
   * Re-sizes and re-centres the sea once the world's size is known, and
   * reallocates the depth-alpha texture (below) for the new size — always,
   * even when the size is unchanged: a rejoin resends every chunk this
   * client has unlocked in the new JoinSnapshotMessage, so the `refresh`
   * call world.ts makes right after with that snapshot's dirty set
   * repopulates every texel a visible chunk needs. Matches how resetWorld
   * already rebuilds the whole mirror/mesh set on every snapshot regardless
   * of a size change (world.ts) — one fewer "did it actually change"
   * branch to keep in sync with that contract.
   */
  setWorldSize(worldSize: number): void;
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
 * NearestFilter/no-mipmaps would show a hard step at every cell boundary;
 * LinearFilter interpolates smoothly between adjacent cells' depths instead,
 * which is also the right visual for a soft alpha cue. No mipmaps: the sea
 * is viewed near-perpendicular from the game's usual high camera, so
 * minification aliasing is not a concern worth a mip chain for an NPOT
 * (world sizes are multiples of CHUNK_SIZE, not necessarily of 2) texture.
 */
function createDepthAlphaTexture(worldSize: number): {
  texture: DataTexture;
  buffer: Uint8Array;
} {
  const buffer = new Uint8Array(worldSize * worldSize).fill(
    WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  );
  const texture = new DataTexture(buffer, worldSize, worldSize, RedFormat, UnsignedByteType);
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
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
 */
function makeDepthAware(
  material: MeshStandardMaterial,
  depthAlphaTexture: DataTexture,
  worldSizeUniform: { value: number },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterDepthAlpha = { value: depthAlphaTexture };
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
      // CELL_WORLD_SIZE is fixed at 1 (config.ts), so world XZ IS cell
      // coordinates with no scale factor to apply here.
      '#include <begin_vertex>\nvWaterCellXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;',
      'water',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        '#include <common>\nvarying vec2 vWaterCellXZ;\nuniform sampler2D uWaterDepthAlpha;\nuniform float uWorldSizeCells;',
        'water',
      ),
      '#include <opaque_fragment>',
      // ClampToEdgeWrapping (DataTexture's default) handles the margin ring
      // beyond the world border: UVs past [0,1] just hold the edge cell's
      // depth, the same "clamp to world" rule terrain/mirror.ts's own
      // sampleHeight applies to any out-of-bounds read.
      'diffuseColor.a *= texture2D( uWaterDepthAlpha, vWaterCellXZ / uWorldSizeCells ).r;\n#include <opaque_fragment>',
      'water',
    );
  };
}

export function createWater(parent: Object3D, initialWorldSize: number): Water {
  const { texture: depthAlphaTexture, buffer: initialDepthAlphaBuffer } =
    createDepthAlphaTexture(initialWorldSize);
  // Reassigned wholesale by setWorldSize; depthAlphaTexture itself never is
  // (see makeDepthAware's doc comment).
  let depthAlphaBuffer = initialDepthAlphaBuffer;
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
  makeDepthAware(material, depthAlphaTexture, worldSizeUniform);

  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.rotation.x = PLANE_TO_GROUND_ROTATION_X;
  // Lifted off the SEA_LEVEL plane on purpose — band-0 terrain renders exactly
  // there and would z-fight. See WATER_SURFACE_LIFT for the full reasoning.
  mesh.position.y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;
  parent.add(mesh);

  const setWorldSize = (worldSize: number): void => {
    const span = (worldSize - 1 + WATER_MARGIN_CELLS * 2) * CELL_WORLD_SIZE;
    const centre = ((worldSize - 1) * CELL_WORLD_SIZE) / 2;
    // Rebuilding this geometry is fine: it happens once per join, not per
    // edit. The no-rebuild rule is about the terrain patch path.
    mesh.geometry.dispose();
    mesh.geometry = new PlaneGeometry(span, span);
    mesh.position.x = centre;
    mesh.position.z = centre;

    // See the Water.setWorldSize doc comment: reallocated unconditionally,
    // every call — the caller's next `refresh` with the fresh snapshot's
    // dirty set repopulates every texel a revealed chunk needs.
    depthAlphaBuffer = new Uint8Array(worldSize * worldSize).fill(
      WATER_DEPTH_ALPHA_DEFAULT_BYTE,
    );
    depthAlphaTexture.image = { data: depthAlphaBuffer, width: worldSize, height: worldSize };
    depthAlphaTexture.needsUpdate = true;
    worldSizeUniform.value = worldSize;
  };

  setWorldSize(initialWorldSize);

  return {
    setWorldSize,
    refresh(mirror: TerrainMirror, dirty: Iterable<number>): void {
      writeWaterDepthTexels(depthAlphaBuffer, worldSizeUniform.value, mirror, dirty);
      depthAlphaTexture.needsUpdate = true;
    },
    dispose(): void {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      depthAlphaTexture.dispose();
    },
  };
}
