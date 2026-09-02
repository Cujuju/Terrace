// A string substitution into a stock three.js shader that REFUSES to no-op.
//
// Extracted from render/terrainMeshes.ts (issue: the self-lit-attribute patch
// and water.ts's depth-alpha patch both needed the exact same "splice at a
// named include, or throw" primitive — two copies of the same contract is
// the duplication the project's own review checklist calls out, so this is
// the one place it is written).
//
// A plain `.replace` on a missing needle returns the source untouched, and
// the only symptom would be the dependent visual feature quietly breaking on
// some future three.js upgrade — silently, in a form no test would notice.
// Every anchor used by a caller of this function is a shader include three
// has carried for many major versions, so this can only fire when an upgrade
// genuinely moves the ground under the patch: it throws on the first frame,
// on the developer's machine, naming the anchor that moved and the material
// it belongs to.

export function spliceShader(
  source: string,
  anchor: string,
  replacement: string,
  materialLabel: string,
): string {
  if (!source.includes(anchor)) {
    throw new Error(
      `${materialLabel} shader patch failed: three no longer emits "${anchor}". ` +
        `Re-anchor the patch at its call site.`,
    );
  }
  return source.replace(anchor, replacement);
}

/**
 * Formats a JS number as a GLSL float literal.
 *
 * GLSL ES forbids mixing int and float in an expression, so a spliced-in
 * constant that happens to be integral (`4`) fails to compile where `4.0` is
 * fine; `toFixed` guarantees the decimal point whatever the value is.
 *
 * RESIDUAL, NAMED: render/water.ts carries a private copy of this function,
 * written before there was a shared home for it. Folding it in is a pure
 * rename in a file this sequence otherwise only appends to, so it is left for
 * whoever next edits water.ts's splices rather than bundled in here.
 */
export function glslFloat(value: number): string {
  return value.toFixed(6);
}

/**
 * The vertex-stage world position, as `tWorldPosition` (a `vec4`).
 *
 * WHY THIS IS NOT `#include <worldpos_vertex>`. three emits that chunk, but its
 * BODY sits behind `#if defined( USE_ENVMAP ) || defined( DISTANCE ) ||
 * defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) ||
 * NUM_SPOT_LIGHT_COORDS > 0` — verified in this project's installed three
 * 0.185.1, `src/renderers/shaders/ShaderChunk/worldpos_vertex.glsl.js`. On an
 * unlit, unshadowed material with no environment map — a `PointsMaterial`
 * column, a `MeshBasicMaterial` haze sheet, the terrain itself — `worldPosition`
 * is therefore simply not declared, and a patch that read it would compile on
 * some materials and fail on others for reasons no call site can see. This
 * restates the chunk's own arithmetic unconditionally, including its batching
 * and instancing branches so an `InstancedMesh` lands where it is drawn.
 *
 * ANCHOR IT AFTER `#include <project_vertex>`, which is the last chunk to
 * touch `transformed` in every ShaderLib program this codebase patches
 * (meshphysical, meshbasic, meshlambert, points, linedashed — all five
 * verified) and is exactly where three emits `<worldpos_vertex>` itself.
 *
 * INDENTATION CONVENTION as plugins/kit/puffDeck.ts: the first line carries no
 * indent and the rest carry the shader body's four spaces.
 */
export const WORLD_POSITION_VERTEX_GLSL = `vec4 tWorldPosition = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        tWorldPosition = batchingMatrix * tWorldPosition;
    #endif
    #ifdef USE_INSTANCING
        tWorldPosition = instanceMatrix * tWorldPosition;
    #endif
    tWorldPosition = modelMatrix * tWorldPosition;`;

/** The anchor `WORLD_POSITION_VERTEX_GLSL` must be spliced after. */
export const WORLD_POSITION_VERTEX_ANCHOR = '#include <project_vertex>';
