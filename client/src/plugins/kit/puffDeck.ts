// The instanced view-space billboard puff — the GLSL two renderers write the
// same way.
//
// WHAT A PUFF DECK IS. One quad geometry, instanced N times, where the instance
// matrix carries ONLY a world position and every other thing about where the
// particle goes is computed in the vertex shader from per-instance attributes.
// The quad is then offset AFTER the view transform, which faces it at the
// camera exactly, for free, with no rotation written from the CPU and no chance
// of lagging the camera by a frame. The fragment shader masks it to a soft round
// blob and discards outside it.
//
// WHAT IS SHARED AND WHAT IS NOT. The placement — a cyclone's logarithmic spiral
// arms, a volcano's rising column — is the whole of what makes one renderer not
// the other, and it stays in each renderer. What is shared is the mechanism
// around it: reading the instance matrix as a position, the billboard offset,
// the radial mask, and the alpha floor under which a puff is not worth blending.
//
// THESE ARE SNIPPETS, NOT A SHADER GENERATOR, deliberately. A builder that
// assembled whole shaders from options would have to be able to express every
// difference between the two — and the differences ARE the shaders. Named
// snippets keep the shared lines in one place while each renderer's source stays
// readable as source.
//
// INDENTATION CONVENTION. Every snippet's FIRST line carries no indent and its
// later lines carry the four spaces a shader body sits at, so a call site writes
// `    ${PUFF_BILLBOARD_GLSL}` and gets exactly the text it had before.

/**
 * Reads the instance's world position out of the instance matrix.
 *
 * The matrix carries a POSITION AND NOTHING ELSE — no rotation, no scale — so
 * this is the translation column, not a full transform of the vertex. That is
 * what leaves the vertex free to be billboarded below.
 */
export const PUFF_INSTANCE_BASE_GLSL = `vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;`;

/**
 * The billboard itself: offset the vertex AFTER the view transform.
 *
 * Expects `world` (the particle's world-space centre) and `size` (its half-width
 * in world units) to be in scope, and `position` to be the quad's own vertex,
 * authored two units across.
 */
export const PUFF_BILLBOARD_GLSL = `vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;`;

/**
 * The radial mask that makes a quad a puff, and discards the corners.
 *
 * `innerEdge` is the GLSL literal where the falloff STARTS: `0.0` fades from the
 * very centre (a soft blob with no core), a larger value holds a flat middle and
 * fades only the rim. Expects the varying `vQuad` — the quad's own `position.xy`
 * — which is the offset from the puff's centre in half-widths, so everything
 * past 1 is outside the disc.
 */
export function puffMaskGlsl(innerEdge: string): string {
  return `float radius = length(vQuad);
    float puff = 1.0 - smoothstep(${innerEdge}, 1.0, radius);
    if (puff <= 0.0) discard;`;
}

/**
 * The faintest puff worth blending.
 *
 * Below this the fragment contributes less than one step of 8-bit alpha, so it
 * is a fill-rate cost with no picture attached — which on a deck of thousands of
 * overlapping transparent quads is the cost that matters.
 */
const PUFF_ALPHA_DISCARD_THRESHOLD = 0.004;

/** Discards a fragment too faint to be worth blending. Expects `alpha`. */
export const PUFF_ALPHA_DISCARD_GLSL = `if (alpha <= ${PUFF_ALPHA_DISCARD_THRESHOLD.toFixed(3)}) discard;`;
