// The one noise function every fire visual is deformed by, as GLSL source.
//
// WHY IT IS ITS OWN MODULE. It was written inside ./flames/shaderPlume.ts, where
// it was the plume's private business. ./smoke.ts needs exactly the same noise —
// same hash, same octaves, same scroll convention — because smoke leaving a fire
// and the flame it leaves must not writhe to two different rhythms; two columns
// of gas over one tree that disagree about which way the air is moving read as
// two effects rather than as one fire. Copying the function into the second file
// would let that agreement rot silently, so the source lives here and both
// stages inject it.
//
// It is a STRING, not a function: it is compiled by the GPU, and the only thing
// the TypeScript side ever does with it is paste it into a shader.

/**
 * Cheap 2D value noise — hash the four lattice corners, smoothstep between
 * them. `vnoise` is one bilinear lookup in −1…1; `fnoise` is two octaves of it,
 * which is what gives a plume both a slow lean and a fine gutter without a
 * second noise function. Three octaves cost more than the silhouette gains at
 * the size either of these things occupies on screen.
 *
 * The CONVENTION both callers share: the first axis is fed
 * (heightAlongColumn × frequency − time × speed) and the second a per-instance
 * seed. Scrolling the first axis downward with time is what makes the
 * deformation travel UP the column, which is the single thing that makes a
 * warped cone read as fire or as smoke rather than as jelly.
 */
export const VALUE_NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 smoothed = f * f * (3.0 - 2.0 * f);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y) * 2.0 - 1.0;
  }

  float fnoise(vec2 p) {
    return vnoise(p) * 0.65 + vnoise(p * 2.17 + 11.3) * 0.35;
  }
`;
