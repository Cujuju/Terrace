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
 *
 * With `lobing`, the disc becomes a LOBED BLOB instead: see `puffLobeScaleGlsl`.
 * The snippet then also leaves `lobeScale` in scope, so a renderer that lights
 * its puffs as spheres can shade the lumps it drew (cumulusDeck.ts does).
 */
export function puffMaskGlsl(innerEdge: string, lobing?: PuffLobing): string {
  const lobed = lobing ? `${puffLobeScaleGlsl(lobing)}
    ` : '';
  const radius = lobing ? 'length(vQuad) / lobeScale' : 'length(vQuad)';
  return `${lobed}float radius = ${radius};
    float puff = 1.0 - smoothstep(${innerEdge}, 1.0, radius);
    if (puff <= 0.0) discard;`;
}

/** What makes one puff's silhouette its own — see `puffLobeScaleGlsl`. */
export interface PuffLobing {
  /**
   * How far the rim wanders from a circle, as a fraction of the half-width
   * either way. 0 is a disc; the sum of the harmonics is normalised so this
   * IS the peak excursion, not a per-harmonic one.
   */
  readonly amplitude: number;
  /** GLSL name of the per-puff 0…1 seed varying that picks the shape. */
  readonly seedVarying: string;
}

/**
 * The angular harmonics a lobed puff is built from, and the multipliers that
 * turn one seed into an independent phase for each.
 *
 * THREE LOW HARMONICS, MUTUALLY PRIME. The rim is a circle whose radius is
 * modulated by sin(kθ + φ) for each k; with k coprime the sum never repeats
 * within one turn, so no puff has the mirror or rotational symmetry that would
 * give away a formula. k = 2 alone is an ellipse, 3 a trefoil, 5 a scallop —
 * summed at random phases they are a cauliflower head. Higher k would start to
 * look like spikes at billboard scale, and cost a `sin` each per fragment.
 *
 * Phase multipliers are far apart and irrational-looking so the three phases
 * derived from ONE seed do not correlate (the same reasoning cumulusDeck.ts
 * gives for its own seed hashes).
 */
const PUFF_LOBE_HARMONICS: ReadonlyArray<{ readonly k: number; readonly phaseHash: number }> = [
  { k: 2, phaseHash: 2.17 },
  { k: 3, phaseHash: 4.73 },
  { k: 5, phaseHash: 9.11 },
];

const TWO_PI = Math.PI * 2;

/**
 * Per-fragment radius scale that gives a puff an IRREGULAR silhouette
 * (#323 — the owner: "at the moment it looks like they're all spheres").
 *
 * Writes `float lobeScale`, in [1 - amplitude, 1 + amplitude]: the rim's
 * distance from the centre in this fragment's direction, as a fraction of the
 * half-width. Dividing `length(vQuad)` by it bends the circular mask into a
 * blob that is stable per instance (the seed) and rotates with nothing, so it
 * reads the same from every camera. Pure fragment maths — no geometry variant,
 * no texture, no extra draw call — which is what keeps it within the deck's
 * fill budget: one `atan` and three `sin` per fragment.
 *
 * Expects `vQuad` and the seed varying named in `lobing`.
 */
export function puffLobeScaleGlsl(lobing: PuffLobing): string {
  const perHarmonic = 1 / PUFF_LOBE_HARMONICS.length;
  const terms = PUFF_LOBE_HARMONICS.map(
    ({ k, phaseHash }) =>
      `sin(${k.toFixed(1)} * lobeAngle + fract(${lobing.seedVarying} * ${phaseHash.toFixed(2)}) * ${TWO_PI.toFixed(6)})`,
  ).join(' +\n      ');
  return `float lobeAngle = atan(vQuad.y, vQuad.x);
    float lobeScale = 1.0 + ${(lobing.amplitude * perHarmonic).toFixed(4)} * (${terms});`;
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
