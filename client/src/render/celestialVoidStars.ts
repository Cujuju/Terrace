export interface StarGridSpec {
  seed: number;
  radius: number;
  depth: number;
  scale: number;
  density: number;
}

export interface StarGridBuffers {
  count: number;
  position: Float32Array;
  shape: Float32Array;
}

const STAR_POINT_BOOST = 3;

const STAR_RADIUS_MIN_CELLS = 0.03;
const STAR_RADIUS_SPAN_CELLS = 0.05;

const STAR_BRIGHTNESS_FLOOR = 0.5;

const TAU = 2 * Math.PI;

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

export function starGridCount(spec: StarGridSpec): number {
  return Math.round(
    spec.density * STAR_POINT_BOOST * Math.PI * spec.radius * spec.radius * spec.scale * spec.scale,
  );
}

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
