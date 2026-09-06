// THE STAR FIELD'S GEOMETRY (perf, issue #342).
//
// The wheel used to find its stars by walking three 3-D voxel grids per
// fragment (`stars3` in celestialVoid.ts, before this change): every full-res
// pixel visited STAR_WALK voxels of each grid and hashed each one, which is
// about a millisecond at 1440p and was the shader's last bulk item. The stars
// are now a point cloud instead — generated ONCE into vertex buffers here and
// rasterised as GL_POINTS, so the GPU puts each star where it belongs rather
// than having every pixel search for it.
//
// WHY A SEEDED PRNG AND NOT A PORT OF THE VOXEL HASHES. Enumerating every
// voxel of the three grids through a JS `hash3` is roughly 40 M hash calls, a
// second of startup, and a float32 port would still not reproduce the GLSL
// draw bit for bit. So this reproduces the DISTRIBUTIONS rather than the
// draw: the same expected count, the same uniform spread over the disc and
// through the depth, and the same three per-star numbers the voxel hashes
// used to make. The field is therefore a fresh random draw with today's
// statistics — and a fixed one, because the seeds are constants, so it is the
// same field on every start.
//
// It imports nothing on purpose: pure functions over numbers and typed
// arrays, with each grid's parameters passed in. That is what lets the shader
// bench (.void-bench/gen.mjs) inline this exact source and build the very
// buffers the app builds, instead of the two drifting apart.

/** One voxel grid's parameters, as the wheel's shader used to state them. */
export interface StarGridSpec {
  /** Fixed PRNG seed: the field must be the same field on every start. */
  seed: number;
  /** Radius of the disc the stars are spread over, disk units. */
  radius: number;
  /** How far under the plane the grid reaches, disk units. */
  depth: number;
  /** Cells per disk unit of the voxel grid this stands in for. */
  scale: number;
  /** Stars per column of that grid's plane cells. */
  density: number;
}

/** One grid's vertex buffers, ready for a `Points` geometry. */
export interface StarGridBuffers {
  /** How many stars were generated — the draw's vertex count. */
  count: number;
  /** x, y, z per star: the ROTATING frame, in disk units, z at most 0. */
  position: Float32Array;
  /** radius (disk units), kind (0..1), brightness (0..1) per star. */
  shape: Float32Array;
}

/**
 * A ray had to pass within a star's radius in 3-D rather than cross a disc, so
 * the voxel grids carried more stars per voxel than the density asks for to
 * keep the count on screen right. The point cloud draws exactly the same
 * number, so the multiplier is still the density it always was.
 */
const STAR_POINT_BOOST = 3;

/**
 * Smallest star radius and the span above it, in GRID CELLS — the shader's own
 * `0.03 + 0.05*hash` before this change, which is why they are stated in cells
 * and divided by the grid's scale to reach disk units. With `stars3` gone this
 * is their only definition.
 */
const STAR_RADIUS_MIN_CELLS = 0.03;
const STAR_RADIUS_SPAN_CELLS = 0.05;

/**
 * Dimmest a star can be, as a fraction of a full one: the shader's own
 * `0.5 + 0.5*h/perVoxel`, with `h` uniform below `perVoxel` and so `h/perVoxel`
 * uniform on [0, 1).
 */
const STAR_BRIGHTNESS_FLOOR = 0.5;

const TAU = 2 * Math.PI;

/**
 * mulberry32 — the well-known ten-line 32-bit PRNG (Tommy Ettinger, public
 * domain). Chosen over the voxel hashes for the reason in the header, and over
 * `Math.random` because the field has to be identical on every start; it passes
 * gjrand's suite at this size and is a handful of integer ops per draw.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How many stars one grid holds: exactly `perVoxel * voxels` of the walk it
 * replaces, which reduces to the density times the boost times the number of
 * plane cells inside the disc — the depth cancels, because the walk spread a
 * column's density over that column's voxels precisely so a deeper field was
 * not a denser one.
 */
export function starGridCount(spec: StarGridSpec): number {
  return Math.round(
    spec.density * STAR_POINT_BOOST * Math.PI * spec.radius * spec.radius * spec.scale * spec.scale,
  );
}

/**
 * Builds one grid's stars. Uniform over the disc (r = R*sqrt(u) is what makes
 * it uniform in AREA rather than in radius), uniform in depth over
 * [-depth, 0], and the same three per-star draws the voxel hashes made.
 */
export function generateStarGrid(spec: StarGridSpec): StarGridBuffers {
  const count = starGridCount(spec);
  const position = new Float32Array(count * 3);
  const shape = new Float32Array(count * 3);
  const random = mulberry32(spec.seed);
  for (let i = 0; i < count; i++) {
    const r = spec.radius * Math.sqrt(random());
    const theta = TAU * random();
    position[i * 3] = r * Math.cos(theta);
    position[i * 3 + 1] = r * Math.sin(theta);
    position[i * 3 + 2] = -spec.depth * random();
    shape[i * 3] = (STAR_RADIUS_MIN_CELLS + STAR_RADIUS_SPAN_CELLS * random()) / spec.scale;
    shape[i * 3 + 1] = random();
    shape[i * 3 + 2] = STAR_BRIGHTNESS_FLOOR + (1 - STAR_BRIGHTNESS_FLOOR) * random();
  }
  return { count, position, shape };
}
