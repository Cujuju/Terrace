import {
  BufferGeometry,
  OrthographicCamera,
  ClampToEdgeWrapping,
  CustomBlending,
  Float32BufferAttribute,
  HalfFloatType,
  InstancedBufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  OneFactor,
  type PerspectiveCamera,
  PlaneGeometry,
  type PixelFormat,
  RedFormat,
  RenderTarget,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  Sprite,
  type SpriteMaterial,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import { NodeMaterial, PointsNodeMaterial, type Node, type UniformNode } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  atan,
  attribute,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  log,
  max,
  min,
  mix,
  mod,
  modelWorldMatrixInverse,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  screenDPR,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  transpose,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEFAULT_WORLD_SPAN, MAX_HEIGHT, MIN_HEIGHT } from '@terrace/shared';
import {
  CAMERA_FOV_DEGREES,
  CAMERA_MAX_DISTANCE,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../config.ts';
import { generateStarGrid, type StarGridSpec } from './celestialVoidStars.ts';
import type { Viewport } from './scene.ts';
import { radianceForDisplay } from './displayRadiance.ts';

export type VoidStyle = 'nebula' | 'wheel';

export type VoidAnchor = 'view' | 'world';

const WHEEL_TILT_DEGREES = 60;

const DISK_SCALE = 0.85;

const VIEW_HUB_DISTANCE = 2.6 / DISK_SCALE;

const VIEW_FOCAL = 1.2;

const NEBULA_ZOOM = 2.2;

const LOCKED_WORLD_UNITS_PER_DISK_UNIT = 200 * DISK_SCALE;

const DISK_THICKNESS_WORLD = 4;
const DISK_THICKNESS = DISK_THICKNESS_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FIELD_DEPTH_WORLD = 120;
const STAR_FIELD_DEPTH = STAR_FIELD_DEPTH_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FINE_DEPTH = 0.5 * STAR_FIELD_DEPTH;

const LOCKED_HUB_CLEARANCE_WORLD = 2;

const LOCKED_HUB_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE - LOCKED_HUB_CLEARANCE_WORLD;

const GAS_INNER_R = 0.12;

const S_LOG_EPS = 0.05;

const R_BAKE_MAX = 12;

const GAS_BAKE_S_MIN = Math.log(S_LOG_EPS);
const GAS_BAKE_S_SPAN = Math.log(R_BAKE_MAX + S_LOG_EPS) - GAS_BAKE_S_MIN;

const GAS_BAKE_SIZE = 2048;

const FADE_END_HEIGHTS = 12.0 / 1.3;

const FADE_GROUND_REACH = Math.sqrt(FADE_END_HEIGHTS * FADE_END_HEIGHTS - 1);

const GAS_DISK_RADIUS = 1.7;

const CELL_FADE_PX = 4.0;

const ARM_GRID_GAIN = 2.5;

const STAR_COARSE_CELLS_PER_UNIT = 16;
const STAR_FINE_CELLS_PER_UNIT = 32;
const STAR_ARM_CELLS_PER_UNIT = 40;
const STAR_COARSE_DENSITY = 0.07;
const STAR_FINE_DENSITY = 0.05;
const STAR_ARM_DENSITY = 0.35;

const STAR_COARSE_SEED = 1;
const STAR_FINE_SEED = 2;
const STAR_ARM_SEED = 3;

const STAR_TARGET_OFFSET_WORLD = (DEFAULT_WORLD_SPAN / 2) * Math.SQRT2;

const STAR_TARGET_HEIGHT_WORLD =
  (MAX_HEIGHT - MIN_HEIGHT) * HEIGHT_WORLD_SCALE + LOCKED_HUB_CLEARANCE_WORLD;

const STAR_COARSE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    FADE_GROUND_REACH * STAR_TARGET_HEIGHT_WORLD +
    FADE_END_HEIGHTS * CAMERA_MAX_DISTANCE) /
  LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FINE_MAX_RES_Y = 2160;

const STAR_FINE_SDIST_MAX =
  (Math.max(VIEW_FOCAL, 0.5 / Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) *
    STAR_FINE_MAX_RES_Y) /
  (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);

const STAR_FINE_CROSS_COS =
  ((STAR_FINE_SDIST_MAX * LOCKED_WORLD_UNITS_PER_DISK_UNIT) / FADE_END_HEIGHTS -
    STAR_TARGET_HEIGHT_WORLD) /
  CAMERA_MAX_DISTANCE;

const STAR_FINE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    CAMERA_MAX_DISTANCE * Math.sqrt(1 - STAR_FINE_CROSS_COS * STAR_FINE_CROSS_COS)) /
    LOCKED_WORLD_UNITS_PER_DISK_UNIT +
  STAR_FINE_SDIST_MAX;

const STAR_ARM_CUTOFF = 0.02;

const STAR_ARM_RADIUS = GAS_DISK_RADIUS * Math.log(ARM_GRID_GAIN / STAR_ARM_CUTOFF);

const STAR_ARM_GRID_ENABLED = false;

const STAR_GRIDS: readonly StarGridSpec[] = [
  {
    seed: STAR_COARSE_SEED,
    radius: STAR_COARSE_RADIUS,
    depth: STAR_FIELD_DEPTH,
    scale: STAR_COARSE_CELLS_PER_UNIT,
    density: STAR_COARSE_DENSITY,
  },
  {
    seed: STAR_FINE_SEED,
    radius: STAR_FINE_RADIUS,
    depth: STAR_FINE_DEPTH,
    scale: STAR_FINE_CELLS_PER_UNIT,
    density: STAR_FINE_DENSITY,
  },
  ...(STAR_ARM_GRID_ENABLED
    ? [
        {
          seed: STAR_ARM_SEED,
          radius: STAR_ARM_RADIUS,
          depth: DISK_THICKNESS,
          scale: STAR_ARM_CELLS_PER_UNIT,
          density: STAR_ARM_DENSITY,
        },
      ]
    : []),
];

const VOID_RENDER_ORDER = -1000;

const STARS_RENDER_ORDER = VOID_RENDER_ORDER + 1;

// A unit quad, so the sprite's offset spans +-0.5 of the point size.
const STAR_SPRITE_QUAD_SIZE = 1;

const GAS_RES_DIVISOR = 2;

const FULLSCREEN_TRIANGLE_POSITIONS = [-1, -1, 0, 3, -1, 0, -1, 3, 0];

// The shipped GLSL baked DISK_THICKNESS with toFixed(3); the nodes keep that value so the look holds.
const DISK_THICKNESS_SHIPPED_DECIMALS = 3;
const SHADER_DISK_THICKNESS = Number(DISK_THICKNESS.toFixed(DISK_THICKNESS_SHIPPED_DECIMALS));

const TAU = Math.PI * 2;

const NEBULA_RATE = 0.15;
// World anchor only: how much of the eye's offset from the hub slides the clouds.
const NEBULA_PARALLAX = 0.25;

// rad/s, about five minutes per turn; negative is clockwise from above.
const WHEEL_RATE = -0.021;
// Depth fade in multiples of the eye's height above the plane, so it is the same at every zoom.
const FADE_START_HEIGHTS = 2.0;
const ARMS = 4.0;
// Log-spiral pitch: how tightly the arms wind.
const WIND = 8.0;
const ARM_SHARPNESS = 1.4;
const GAS_GAIN = 1.0;
const BULGE_GAIN = 0.25;
const ARM_WOBBLE = 0.25;
// Floor under the arm profile so gas spills across the gaps.
const ARM_BLEED = 0.18;
const WOBBLE_SCALE = 0.6;
const STREAK_ALONG = 1.6;
// Grain cells around the full circle across the arms; an integer, the y period.
const STREAK_ACROSS = 40.0;
const HUE_SCALE = 0.7;
const GAS_STEPS = 6;
const GAS_TOP_Z = -0.12 * SHADER_DISK_THICKNESS;
const GAS_BOTTOM_Z = -0.88 * SHADER_DISK_THICKNESS;
// sech^2 scale height of each patch about its own level.
const GAS_SCALE_H = 0.12 * SHADER_DISK_THICKNESS;
const LEVEL_SCALE = 5.0;
const LIT_FROM_ABOVE = 0.6;
// Optical depth per unit density per disk unit.
const GAS_EXTINCTION = 100.0;
const PUFF_SCALE = 12.0;
const PUFF_Z_SCALE = 3.0 / SHADER_DISK_THICKNESS;
const PUFF_DEPTH = 0.7;
const PUFF_OCTAVE2 = 0.4;
const STAR_GAS_SHADE = 0.7;
const STAR_MIN_PX = 0.8;
const GLOW_FRACTION = 0.15;
const GLOW_RADIUS = 4.0;
const GLOW_GAIN = 0.35;
const TWINKLE_FRACTION = 0.3;
const TWINKLE_DEPTH = 0.35;
const TWINKLE_RATE = 2.2;

const FBM_OCTAVES = 5;
// Fields read only on the broad scale keep the first octaves, so the look is unchanged.
const FBM_LOW_OCTAVES = 3;
const FBM_LACUNARITY = 2.03;
// Lacunarity exactly 2 and no y offset keep every periodic octave periodic.
const PFBM_LACUNARITY = 2.0;

const STAR_GRID_FINE = 1.0;
const STAR_GRID_ARM = 2.0;
const FINE_GRID_WEIGHT = 0.6;
const FIELD_GAS_LIFT = 0.45;
const FIELD_GAS_GAIN = 0.9;
const POINT_SPRITE_MARGIN_PX = 2.0;
// Clip-space x/y well outside the frustum, for a star that must not rasterise at all.
const OFF_SCREEN_NDC = 2.0;
// Any depth inside both backends' clip range: the stars neither test nor write depth.
const STAR_CLIP_DEPTH = 0.5;

const BAKE_FIELD_PATTERN = 0;
const BAKE_FIELD_LEVEL = 1;

interface VoidUniforms {
  readonly res: UniformNode<'vec2', Vector2>;
  readonly time: UniformNode<'float', number>;
  readonly focal: UniformNode<'float', number>;
  readonly toDisk: UniformNode<'mat3', Matrix3>;
  readonly origin: UniformNode<'vec3', Vector3>;
  readonly dome: UniformNode<'float', number>;
  readonly gasRes: UniformNode<'vec2', Vector2>;
}

// gl_FragCoord: screenCoordinate follows WebGPU (y down); the void's math is written y up.
function glFragCoord(height: Node<'float'>): Node<'vec2'> {
  return vec2(screenCoordinate.x, height.sub(screenCoordinate.y));
}

function viewRay(u: VoidUniforms, uv: Node<'vec2'>): Node<'vec3'> {
  return u.toDisk.mul(normalize(vec3(uv, u.focal.negate())));
}

// Lambert azimuthal equal-area projection from the nadir: seamless over every direction but up.
function dome(d: Node<'vec3'>): Node<'vec2'> {
  return d.xy.mul(sqrt(float(2.0).div(float(1.0).sub(d.z))));
}

const hash = Fn(([q]: [Node<'vec2'>]) => {
  const p = fract(q.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'voidHash', type: 'float', inputs: [{ name: 'q', type: 'vec2' }] });

const vnoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const g = fract(p);
  const f = g.mul(g).mul(vec2(3.0).sub(g.mul(2.0)));
  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x),
    f.y,
  );
}).setLayout({ name: 'voidNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

const hash3 = Fn(([q]: [Node<'vec3'>]) => {
  const p = fract(q.mul(vec3(123.34, 456.21, 789.13))).toVar();
  p.addAssign(dot(p, p.yzx.add(45.32)));
  return fract(p.x.mul(p.y).mul(p.z));
}).setLayout({ name: 'voidHash3', type: 'float', inputs: [{ name: 'q', type: 'vec3' }] });

const vnoise3 = Fn(([p]: [Node<'vec3'>]) => {
  const i = floor(p);
  const g = fract(p);
  const f = g.mul(g).mul(vec3(3.0).sub(g.mul(2.0)));
  const corner = (x: number, y: number, z: number) => hash3(i.add(vec3(x, y, z)));
  return mix(
    mix(mix(corner(0, 0, 0), corner(1, 0, 0), f.x), mix(corner(0, 1, 0), corner(1, 1, 0), f.x), f.y),
    mix(mix(corner(0, 0, 1), corner(1, 0, 1), f.x), mix(corner(0, 1, 1), corner(1, 1, 1), f.x), f.y),
    f.z,
  );
}).setLayout({ name: 'voidNoise3', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

function fbmOctaves(start: Node<'vec2'>, octaves: number): Node<'float'> {
  let p = start;
  let a = 0.5;
  let s: Node<'float'> = float(0.0);
  for (let octave = 0; octave < octaves; octave++) {
    s = s.add(vnoise(p).mul(a));
    p = p.mul(FBM_LACUNARITY).add(vec2(17.3, 9.1));
    a *= 0.5;
  }
  return s;
}

const fbm = Fn(([p]: [Node<'vec2'>]) => fbmOctaves(p, FBM_OCTAVES)).setLayout({
  name: 'voidFbm',
  type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }],
});

const fbmLow = Fn(([p]: [Node<'vec2'>]) => fbmOctaves(p, FBM_LOW_OCTAVES)).setLayout({
  name: 'voidFbmLow',
  type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }],
});

// The same noise, periodic in y with period per cells, so a domain whose y is an angle has no seam.
const pvnoise = Fn(([p, per]: [Node<'vec2'>, Node<'float'>]) => {
  const i = floor(p);
  const g = fract(p);
  const f = g.mul(g).mul(vec2(3.0).sub(g.mul(2.0)));
  const y0 = mod(i.y, per);
  const y1 = mod(i.y.add(1.0), per);
  return mix(
    mix(hash(vec2(i.x, y0)), hash(vec2(i.x.add(1.0), y0)), f.x),
    mix(hash(vec2(i.x, y1)), hash(vec2(i.x.add(1.0), y1)), f.x),
    f.y,
  );
}).setLayout({
  name: 'voidPeriodicNoise',
  type: 'float',
  inputs: [
    { name: 'p', type: 'vec2' },
    { name: 'per', type: 'float' },
  ],
});

const pfbm = Fn(([start, startPer]: [Node<'vec2'>, Node<'float'>]) => {
  let p = start;
  let per = startPer;
  let a = 0.5;
  let s: Node<'float'> = float(0.0);
  for (let octave = 0; octave < FBM_OCTAVES; octave++) {
    s = s.add(pvnoise(p, per).mul(a));
    p = p.mul(PFBM_LACUNARITY).add(vec2(17.3, 0.0));
    per = per.mul(PFBM_LACUNARITY);
    a *= 0.5;
  }
  return s;
}).setLayout({
  name: 'voidPeriodicFbm',
  type: 'float',
  inputs: [
    { name: 'p', type: 'vec2' },
    { name: 'per', type: 'float' },
  ],
});

// Star layer: one candidate per grid cell, soft falloff, steady.
const stars = Fn(([p, density]: [Node<'vec2'>, Node<'float'>]) => {
  const i = floor(p);
  const f = fract(p).sub(0.5);
  const h = hash(i);
  const o = vec2(hash(i.add(3.1)), hash(i.add(7.7))).sub(0.5);
  const d = length(f.sub(o.mul(0.8)));
  const size = float(0.03).add(hash(i.add(9.2)).mul(0.05));
  const star = smoothstep(size, 0.0, d).mul(float(0.5).add(h.mul(0.5).div(density)));
  return select(h.greaterThan(density), float(0.0), star);
}).setLayout({
  name: 'voidStars',
  type: 'float',
  inputs: [
    { name: 'p', type: 'vec2' },
    { name: 'density', type: 'float' },
  ],
});

const rot = Fn(([p, a]: [Node<'vec2'>, Node<'float'>]) => {
  const c = cos(a);
  const s = sin(a);
  return vec2(c.mul(p.x).sub(s.mul(p.y)), s.mul(p.x).add(c.mul(p.y)));
}).setLayout({
  name: 'voidRotate',
  type: 'vec2',
  inputs: [
    { name: 'p', type: 'vec2' },
    { name: 'a', type: 'float' },
  ],
});

// A full-screen pass: the triangle is authored in clip space.
const FULLSCREEN_VERTEX = vec4(positionGeometry.xy, 0.0, 1.0);

// The fullscreen vertex ignores the camera, but WebGPURenderer still calls
// updateProjectionMatrix on it, which a bare Camera lacks (QuadMesh.js:7 uses this one).
const fullscreenCamera = (): OrthographicCamera => new OrthographicCamera(-1, 1, 1, -1, 0, 1);

function nebulaFragment(u: VoidUniforms): Node<'vec4'> {
  return Fn(() => {
    const suv = glFragCoord(u.res.y).sub(u.res.mul(0.5)).div(u.res.y);
    const d = viewRay(u, suv);
    const t = u.time.mul(NEBULA_RATE);
    // World anchor: clouds on a dome around the world. View anchor: the cloud plane z = 0.
    const p = select(
      u.dome.greaterThan(0.5),
      dome(d).mul(NEBULA_ZOOM).add(u.origin.xy.mul(NEBULA_PARALLAX)),
      u.origin.xy.add(d.xy.mul(u.origin.z.div(d.z.negate()))),
    );
    // The reference's screen coordinate, for the star layers.
    const uv = p.div(NEBULA_ZOOM);
    const q = vec2(fbm(p.add(t.mul(0.3))), fbm(p.add(vec2(5.2, 1.3)).sub(t.mul(0.2))));
    const r = vec2(
      fbm(p.add(q.mul(3.0)).add(vec2(1.7, 9.2)).add(t.mul(0.15))),
      fbm(p.add(q.mul(3.0)).add(vec2(8.3, 2.8)).sub(t.mul(0.1))),
    );
    const n = fbm(p.add(r.mul(2.5)));
    const deep = vec3(0.05, 0.05, 0.14);
    const violet = vec3(0.26, 0.14, 0.42);
    const ember = vec3(0.82, 0.45, 0.28);
    const pale = vec3(0.55, 0.62, 0.85);
    const col = mix(deep, violet, smoothstep(0.25, 0.6, n)).toVar();
    col.assign(
      mix(col, ember, smoothstep(0.55, 0.85, n).mul(0.55).mul(float(0.4).add(length(q).mul(0.6)))),
    );
    col.assign(mix(col, pale, smoothstep(0.7, 0.95, n).mul(0.35)));
    const s = stars(uv.mul(90.0), 0.06).add(stars(uv.mul(180.0).add(31.0), 0.04).mul(0.6));
    col.addAssign(vec3(0.9, 0.9, 1.0).mul(s));
    // toneMapped: false is inert on WebGPU, so the displayed colour is inverted through ACES.
    return vec4(radianceForDisplay(col), 1.0);
  })();
}

interface GasPattern {
  readonly pattern: Node<'float'>;
  readonly gasCol: Node<'vec3'>;
}

// Arms, grain, lanes and colour on the rotating-frame plane; columnar through the slab, so baked
// once into the log-polar texture.
function gasPattern(rf: Node<'vec2'>): GasPattern {
  const r = length(rf);
  const th = atan(rf.y, rf.x);
  const s = log(r.add(S_LOG_EPS));
  const wobble = fbmLow(rf.div(WOBBLE_SCALE).add(vec2(3.0, 8.0))).sub(0.5).mul(2.0 * ARM_WOBBLE);
  const phase = th.mul(ARMS).sub(s.mul(WIND)).add(wobble);
  const arm = mix(pow(float(0.5).add(cos(phase).mul(0.5)), ARM_SHARPNESS), 1.0, ARM_BLEED);
  // Unwind by minus the arm's own twist so the wound angle is constant along an arm.
  const wound = rot(rf, s.mul(WIND).sub(wobble).div(ARMS).negate());
  const thw = atan(wound.y, wound.x);
  const aq = vec2(s.mul(STREAK_ALONG), thw.div(TAU).add(0.5).mul(STREAK_ACROSS));
  const grain = pfbm(aq.add(vec2(4.0, 0.0)), float(STREAK_ACROSS))
    .mul(0.6)
    .add(pfbm(aq.mul(2.0).add(vec2(1.0, 0.0)), float(STREAK_ACROSS * 2.0)).mul(0.4));
  const haze = fbmLow(rf.mul(1.4).add(vec2(9.0, 2.0)));
  const radial = exp(r.div(GAS_DISK_RADIUS).negate()).mul(smoothstep(0.0, GAS_INNER_R, r));
  // Dark dust lanes cut through the arms.
  const lanes = smoothstep(0.6, 0.78, grain).mul(arm).mul(0.45);
  const deepBlue = vec3(0.08, 0.24, 0.88);
  const violet = vec3(0.4, 0.14, 0.82);
  const rose = vec3(0.95, 0.3, 0.6);
  const teal = vec3(0.12, 0.7, 0.85);
  const hue = fbmLow(rf.div(HUE_SCALE).add(vec2(2.0, 5.0)));
  const blueToViolet = mix(deepBlue, violet, smoothstep(0.35, 0.7, hue));
  const withRose = mix(blueToViolet, rose, smoothstep(0.55, 0.9, grain).mul(0.7));
  const gasCol = mix(withRose, teal, smoothstep(0.6, 0.85, haze).mul(0.35));
  const pattern = arm
    .mul(float(0.35).add(grain.mul(1.1)))
    .add(haze.mul(0.1))
    .mul(radial)
    .mul(float(1.0).sub(lanes));
  return { pattern, gasCol };
}

// This patch's depth in the slab, baked alongside the pattern.
function gasLevel(rf: Node<'vec2'>): Node<'float'> {
  return mix(float(GAS_TOP_Z), GAS_BOTTOM_Z, fbmLow(rf.mul(LEVEL_SCALE).add(vec2(6.0, 13.0))));
}

// rf -> bake coordinate: theta across u (wrapping), s = log(r + eps) up v (clamped past the rim).
function gasBakeUv(rf: Node<'vec2'>): Node<'vec2'> {
  return vec2(
    atan(rf.y, rf.x).div(TAU).add(0.5),
    log(length(rf).add(S_LOG_EPS)).sub(GAS_BAKE_S_MIN).div(GAS_BAKE_S_SPAN),
  );
}

// ...and back: exactly the inverse of gasBakeUv, so a lookup lands on the texel written for it.
function gasBakeRf(uv: Node<'vec2'>): Node<'vec2'> {
  const th = uv.x.sub(0.5).mul(TAU);
  return vec2(cos(th), sin(th)).mul(exp(uv.y.mul(GAS_BAKE_S_SPAN).add(GAS_BAKE_S_MIN)).sub(S_LOG_EPS));
}

// Reads through whichever branch of atan has its cut a quarter turn away, so the quad that
// straddles u's jump does not drop to the coarsest mip.
function gasBakeFetch(bake: Texture, uv: Node<'vec2'>): Node<'vec4'> {
  const nearCut = texture(bake, vec2(uv.x.add(1.0).sub(step(0.5, uv.x)), uv.y));
  return mix(texture(bake, uv), nearCut, step(0.25, abs(uv.x.sub(0.5))));
}

// The bake is written and read in WebGPU's texel orientation, so screenCoordinate is used as is.
function bakeFragment(field: UniformNode<'float', number>): Node<'vec4'> {
  const rf = gasBakeRf(screenCoordinate.div(GAS_BAKE_SIZE));
  const { pattern, gasCol } = gasPattern(rf);
  return select(
    field.greaterThan(0.5),
    vec4(gasLevel(rf), 0.0, 0.0, 1.0),
    vec4(gasCol, pattern),
  );
}

// The gas's variation through the thickness: a sech^2 layer about this patch's own level,
// broken up by 3-D puffs. Multiplies the baked pattern.
function gasDepthProfile(rf: Node<'vec2'>, z: Node<'float'>, level: Node<'float'>): Node<'float'> {
  const dz = z.sub(level).div(GAS_SCALE_H);
  const ch = exp(dz).add(exp(dz.negate()));
  const vert = float(4.0).div(ch.mul(ch));
  const pq = vec3(rf.mul(PUFF_SCALE), z.mul(PUFF_Z_SCALE));
  const puff = vnoise3(pq)
    .mul(1.0 - PUFF_OCTAVE2)
    .add(vnoise3(pq.mul(2.1).add(vec3(3.0, 1.0, 7.0))).mul(PUFF_OCTAVE2));
  // Mean 1.
  const puffMod = float(1.0 - PUFF_DEPTH).add(puff.mul(2.0 * PUFF_DEPTH));
  return vert.mul(puffMod);
}

function gasFragment(u: VoidUniforms, gasBake: Texture, gasLevelBake: Texture): Node<'vec4'> {
  return Fn(() => {
    // The full-res pixel this texel stands for, scaled by the exact ratio of the two buffers.
    const full = glFragCoord(u.gasRes.y).mul(u.res.div(u.gasRes));
    const uv = full.sub(u.res.mul(0.5)).div(u.res.y);
    const a = u.time.mul(WHEEL_RATE);
    const d = viewRay(u, uv);
    // Above the plane's horizon there is no gas to march.
    const result = vec4(0.0).toVar();
    If(d.z.lessThan(0.0), () => {
      const sdist = u.origin.z.negate().div(d.z);
      const pp = u.origin.xy.add(d.xy.mul(sdist));
      const rf = rot(pp, a.negate());
      const bakeUv = gasBakeUv(rf);
      const baked = gasBakeFetch(gasBake, bakeUv);
      const level = gasBakeFetch(gasLevelBake, bakeUv).r;
      const tBottom = u.origin.z.add(SHADER_DISK_THICKNESS).div(d.z.negate());
      const dt = tBottom.sub(sdist).div(GAS_STEPS);
      const gasAcc = float(0.0).toVar();
      const transmittance = float(1.0).toVar();
      for (let step = 0; step < GAS_STEPS; step++) {
        const t = sdist.add(dt.mul(step + 0.5));
        const q = u.origin.add(d.mul(t));
        const dens = baked.a.mul(gasDepthProfile(rot(q.xy, a.negate()), q.z, level));
        // Deeper gas is darker.
        const lit = float(1.0).sub(
          clamp(q.z.negate().div(SHADER_DISK_THICKNESS), 0.0, 1.0).mul(LIT_FROM_ABOVE),
        );
        const alpha = float(1.0).sub(exp(dens.mul(GAS_EXTINCTION).mul(dt).negate())).toVar();
        gasAcc.addAssign(transmittance.mul(alpha).mul(lit));
        transmittance.mulAssign(float(1.0).sub(alpha));
      }
      // Lit colour before GAS_GAIN; alpha is the total gas opacity.
      result.assign(vec4(baked.rgb.mul(gasAcc), float(1.0).sub(transmittance)));
    });
    return result;
  })();
}

function wheelFragment(u: VoidUniforms, gasHalf: Texture): Node<'vec4'> {
  return Fn(() => {
    const uv = glFragCoord(u.res.y).sub(u.res.mul(0.5)).div(u.res.y);
    const a = u.time.mul(WHEEL_RATE);
    const col = vec3(0.012, 0.014, 0.03).toVar();
    const d = viewRay(u, uv);
    If(d.z.lessThan(0.0), () => {
      const sdist = u.origin.z.negate().div(d.z);
      const pp = u.origin.xy.add(d.xy.mul(sdist));
      const rf = rot(pp, a.negate());
      const r = length(rf);
      const depthFade = float(1.0).sub(
        smoothstep(u.origin.z.mul(FADE_START_HEIGHTS), u.origin.z.mul(FADE_END_HEIGHTS), sdist),
      );
      // Fully faded: nothing below would show.
      If(depthFade.greaterThan(0.0), () => {
        // The half-res gas pass, read at this pixel in the texture's own orientation.
        const gasCol = texture(gasHalf, screenCoordinate.div(u.res)).rgb;
        const bulge = exp(r.mul(2.0).negate());
        const warm = vec3(1.0, 0.88, 0.62);
        col.addAssign(gasCol.mul(GAS_GAIN).add(warm.mul(bulge).mul(BULGE_GAIN)).mul(depthFade));
      });
    }).Else(() => {
      // Above the plane's horizon: a still, sparse field fixed to the sky direction.
      col.addAssign(vec3(0.8, 0.82, 0.9).mul(0.4).mul(stars(dome(d).mul(110.0).add(5.0), 0.03)));
    });
    // toneMapped: false is inert on WebGPU, so the displayed colour is inverted through ACES.
    return vec4(radianceForDisplay(col), 1.0);
  })();
}

interface StarProgram {
  readonly positionNode: Node<'vec3'>;
  readonly sizeNode: Node<'float'>;
  readonly fragmentNode: Node<'vec4'>;
}

// One star grid. Its clip position comes from the disk frame, not three's camera, so it is carried
// back through the camera's inverse to where three's projection lands it.
function starProgram(
  u: VoidUniforms,
  gasHalf: Texture,
  starGrid: UniformNode<'float', number>,
  pointSizeMax: UniformNode<'float', number>,
): StarProgram {
  const position = attribute<'vec3'>('starPosition', 'vec3');
  const starShape = attribute<'vec3'>('starShape', 'vec3');
  const a = u.time.mul(WHEEL_RATE);
  // The rotating frame back into disk space, so the field turns rigidly with the gas.
  const P = vec3(rot(position.xy, a), position.z);
  const rel = P.sub(u.origin);
  // u_toDisk is a rotation, so its inverse is its transpose.
  const v = transpose(u.toDisk).mul(rel);
  const behind = v.z.greaterThanEqual(0.0);
  const suv = v.xy.negate().mul(u.focal).div(v.z);
  const ndc = suv.mul(u.res.y).mul(2.0).div(u.res);
  const t = length(rel);
  const sdist = u.origin.z.negate().mul(t).div(rel.z);
  const depthFade = float(1.0).sub(
    smoothstep(u.origin.z.mul(FADE_START_HEIGHTS), u.origin.z.mul(FADE_END_HEIGHTS), sdist),
  );
  const pxPerUnit = u.focal.mul(u.res.y).div(sdist);
  const cellFade = smoothstep(
    CELL_FADE_PX,
    CELL_FADE_PX * 3.0,
    pxPerUnit.div(STAR_FINE_CELLS_PER_UNIT),
  );
  const gridWeight = select(
    starGrid.lessThan(STAR_GRID_FINE),
    float(1.0),
    select(starGrid.lessThan(STAR_GRID_ARM), cellFade.mul(FINE_GRID_WEIGHT), cellFade),
  );
  // A star never shrinks below STAR_MIN_PX.
  const rPx = max(starShape.x.mul(u.focal).mul(u.res.y).div(t), STAR_MIN_PX);
  const glow = select(starShape.y.lessThan(GLOW_FRACTION), float(1.0), float(0.0));
  const size = min(
    rPx.mul(2.0).mul(mix(float(1.0), GLOW_RADIUS, glow)).add(POINT_SPRITE_MARGIN_PX),
    pointSizeMax,
  );
  // Faded out, or off screen by more than half a sprite: no fragment, and no fetch.
  const culled = behind
    .or(depthFade.lessThanEqual(0.0))
    .or(gridWeight.lessThanEqual(0.0))
    .or(abs(ndc.x).greaterThan(float(1.0).add(size.div(u.res.x))))
    .or(abs(ndc.y).greaterThan(float(1.0).add(size.div(u.res.y))));
  // Total gas opacity along the ray, fetched only for a star that will draw.
  const gas = Fn(() => {
    const opacity = float(0.0).toVar();
    If(culled.not(), () => {
      opacity.assign(texture(gasHalf, vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))).a);
    });
    return opacity;
  })();
  // Field grids are dimmed by the gas over them and lifted by the gas in front; in-arm stars
  // are inside the gas, which is what reveals them.
  const fieldGrid = starGrid.lessThan(STAR_GRID_ARM);
  const above = select(fieldGrid, gas, float(0.0));
  const outer = select(fieldGrid, gas.mul(FIELD_GAS_GAIN).add(FIELD_GAS_LIFT), float(1.0));
  const weight = select(fieldGrid, gridWeight, gridWeight.mul(gas).mul(ARM_GRID_GAIN));
  const dim = float(1.0).sub(
    clamp(position.z.negate().div(SHADER_DISK_THICKNESS), 0.0, 1.0).mul(above).mul(STAR_GAS_SHADE),
  );
  // Glow stars carry a halo, the next TWINKLE_FRACTION breathe, the rest are steady.
  const twinkles = glow.lessThan(0.5).and(starShape.y.lessThan(GLOW_FRACTION + TWINKLE_FRACTION));
  const twinkle = select(
    twinkles,
    float(1.0).sub(
      float(0.5)
        .add(sin(u.time.mul(TWINKLE_RATE).add(starShape.y.mul(40.0))).mul(0.5))
        .mul(TWINKLE_DEPTH),
    ),
    float(1.0),
  );
  const vCol = varying(
    vec3(0.95, 0.93, 0.9)
      .mul(starShape.z)
      .mul(dim)
      .mul(twinkle)
      .mul(weight)
      .mul(outer)
      .mul(depthFade)
      .mul(depthFade),
    'v_col',
  );
  const vShape = varying(vec3(rPx, glow, size), 'v_shape');

  const clip = select(culled, vec2(OFF_SCREEN_NDC), ndc);
  const viewPoint = cameraProjectionMatrixInverse.mul(vec4(clip, STAR_CLIP_DEPTH, 1.0));
  const positionNode = modelWorldMatrixInverse
    .mul(cameraWorldMatrix.mul(vec4(viewPoint.xyz.div(viewPoint.w), 1.0)))
    .xyz;
  // PointsNodeMaterial scales sizeNode by the DPR; size is already in drawing-buffer pixels.
  const sizeNode = select(culled, float(0.0), size).div(screenDPR);

  const fragmentNode = Fn(() => {
    // The sprite quad spans +-0.5, so this is gl_PointCoord - 0.5 across the sprite in pixels.
    const d = length(positionGeometry.xy.mul(vShape.z));
    const core = smoothstep(vShape.x, 0.0, d).toVar();
    If(vShape.y.greaterThan(0.5), () => {
      core.addAssign(smoothstep(vShape.x.mul(GLOW_RADIUS), 0.0, d).mul(GLOW_GAIN));
    });
    // toneMapped: false is inert on WebGPU, so the displayed colour is inverted through ACES.
    return vec4(radianceForDisplay(vCol.mul(core)), 0.0);
  })();

  return { positionNode, sizeNode, fragmentNode };
}

export interface CelestialVoid {
  setStyle(style: VoidStyle): void;
  setAnchor(anchor: VoidAnchor): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface DiskFrame {
  focal: number;
  toDisk: Matrix3;
  origin: Vector3;
}

function viewAnchorFrame(style: VoidStyle): DiskFrame {
  if (style === 'nebula') {
    return {
      focal: VIEW_FOCAL,
      toDisk: new Matrix3().identity(),
      origin: new Vector3(0, 0, NEBULA_ZOOM * VIEW_FOCAL),
    };
  }
  const tilt = (WHEEL_TILT_DEGREES * Math.PI) / 180;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // prettier-ignore
  const toDisk = new Matrix3().set(
    1, 0,   0,
    0, ct, -st,
    0, st,  ct,
  );
  return {
    focal: VIEW_FOCAL,
    toDisk,
    origin: new Vector3(0, -st * VIEW_HUB_DISTANCE, ct * VIEW_HUB_DISTANCE),
  };
}

// prettier-ignore
const WORLD_TO_DISK = new Matrix3().set(
  1, 0,  0,
  0, 0, -1,
  0, 1,  0,
);

const CORE_RIG_STARS_NAME = 'core:void-stars';
const CORE_RIG_VOID_NAME = 'core:void';

export function createCelestialVoid(
  viewport: Viewport,
  initialStyle: VoidStyle,
  initialAnchor: VoidAnchor,
  worldSize: () => number,
): CelestialVoid {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(FULLSCREEN_TRIANGLE_POSITIONS, 3),
  );

  const u: VoidUniforms = {
    res: uniform(new Vector2(1, 1)),
    time: uniform(0),
    focal: uniform(VIEW_FOCAL),
    toDisk: uniform(new Matrix3()),
    origin: uniform(new Vector3()),
    dome: uniform(0),
    gasRes: uniform(new Vector2(1, 1)),
  };
  const writeFrame = (frame: DiskFrame): void => {
    u.focal.value = frame.focal;
    u.toDisk.value.copy(frame.toDisk);
    u.origin.value.copy(frame.origin);
  };

  let style = initialStyle;
  let anchor = initialAnchor;
  const worldFrame: DiskFrame = {
    focal: VIEW_FOCAL,
    toDisk: new Matrix3(),
    origin: new Vector3(),
  };
  const cameraToWorld = new Matrix3();
  const hub = new Vector3();
  const writeWorldFrame = (camera: PerspectiveCamera): void => {
    worldFrame.focal = 0.5 / Math.tan((camera.fov * Math.PI) / 360);
    cameraToWorld.setFromMatrix4(camera.matrixWorld);
    worldFrame.toDisk.multiplyMatrices(WORLD_TO_DISK, cameraToWorld);
    const halfSpan = (worldSize() * CELL_WORLD_SIZE) / 2;
    hub.set(halfSpan, LOCKED_HUB_WORLD_Y, halfSpan);
    worldFrame.origin
      .copy(camera.position)
      .sub(hub)
      .applyMatrix3(WORLD_TO_DISK)
      .divideScalar(LOCKED_WORLD_UNITS_PER_DISK_UNIT);
    writeFrame(worldFrame);
  };
  const applyAnchor = (): void => {
    u.dome.value = anchor === 'world' ? 1 : 0;
    if (anchor === 'view') writeFrame(viewAnchorFrame(style));
  };
  applyAnchor();

  const makeBakeTarget = (format: PixelFormat): RenderTarget =>
    new RenderTarget(GAS_BAKE_SIZE, GAS_BAKE_SIZE, {
      type: HalfFloatType,
      format,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });

  let bakeTargets: RenderTarget[] = [];
  let gasBakeTexture: Texture | null = null;
  let gasLevelTexture: Texture | null = null;
  const bakeGasPattern = (): void => {
    const bakeField = uniform(BAKE_FIELD_PATTERN);
    const material = new NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;
    material.vertexNode = FULLSCREEN_VERTEX;
    material.fragmentNode = bakeFragment(bakeField);
    const bakeMesh = new Mesh(geometry, material);
    bakeMesh.frustumCulled = false;
    const bakeScene = new Scene().add(bakeMesh);
    const bakeCamera = fullscreenCamera();
    const { renderer } = viewport;
    const previous = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    bakeTargets = [makeBakeTarget(RGBAFormat), makeBakeTarget(RedFormat)];
    for (const field of [BAKE_FIELD_PATTERN, BAKE_FIELD_LEVEL]) {
      bakeField.value = field;
      renderer.setRenderTarget(bakeTargets[field] as RenderTarget);
      renderer.render(bakeScene, bakeCamera);
    }
    renderer.setRenderTarget(previous, previousCubeFace, previousMipmap);
    material.dispose();
    gasBakeTexture = (bakeTargets[BAKE_FIELD_PATTERN] as RenderTarget).texture;
    gasLevelTexture = (bakeTargets[BAKE_FIELD_LEVEL] as RenderTarget).texture;
  };

  let gasTarget: RenderTarget | null = null;
  let gasMaterial: NodeMaterial | null = null;
  let gasScene: Scene | null = null;
  let gasCamera: OrthographicCamera | null = null;
  const drawingBuffer = new Vector2();

  const sizeGasTarget = (width: number, height: number): void => {
    if (gasTarget === null) return;
    const w = Math.ceil(width / GAS_RES_DIVISOR);
    const h = Math.ceil(height / GAS_RES_DIVISOR);
    if (gasTarget.width === w && gasTarget.height === h) return;
    gasTarget.setSize(w, h);
    u.gasRes.value.set(w, h);
  };

  const createGasPass = (): void => {
    const { renderer } = viewport;
    renderer.getDrawingBufferSize(drawingBuffer);
    gasTarget = new RenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
    if (gasBakeTexture === null || gasLevelTexture === null) {
      throw new Error('celestialVoid: the gas pass needs the bake, which runs first');
    }
    gasMaterial = new NodeMaterial();
    gasMaterial.depthTest = false;
    gasMaterial.depthWrite = false;
    gasMaterial.vertexNode = FULLSCREEN_VERTEX;
    gasMaterial.fragmentNode = gasFragment(u, gasBakeTexture, gasLevelTexture);
    const gasMesh = new Mesh(geometry, gasMaterial);
    gasMesh.frustumCulled = false;
    gasScene = new Scene().add(gasMesh);
    gasCamera = fullscreenCamera();
  };

  const renderGasPass = (): void => {
    if (gasScene === null || gasCamera === null || gasTarget === null) return;
    const { renderer } = viewport;
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    const previousXrEnabled = renderer.xr.enabled;
    const previousInfoAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.info.autoReset = false;
    renderer.setRenderTarget(gasTarget);
    renderer.render(gasScene, gasCamera);
    renderer.info.autoReset = previousInfoAutoReset;
    renderer.xr.enabled = previousXrEnabled;
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmap);
  };

  let starPoints: Sprite[] = [];

  const createStarPoints = (): void => {
    if (gasTarget === null) {
      throw new Error('celestialVoid: the stars read the gas pass, which is created first');
    }
    const gasHalf = gasTarget.texture;
    const { renderer } = viewport;
    renderer.getDrawingBufferSize(drawingBuffer);
    const pointSizeMax = uniform(Math.max(drawingBuffer.x, drawingBuffer.y));
    starPoints = STAR_GRIDS.map((spec, grid) => {
      const buffers = generateStarGrid(spec);
      const starGeometry = new PlaneGeometry(STAR_SPRITE_QUAD_SIZE, STAR_SPRITE_QUAD_SIZE);
      starGeometry.setAttribute('starPosition', new InstancedBufferAttribute(buffers.position, 3));
      starGeometry.setAttribute('starShape', new InstancedBufferAttribute(buffers.shape, 3));
      const program = starProgram(u, gasHalf, uniform(grid), pointSizeMax);
      const material = new PointsNodeMaterial();
      material.sizeAttenuation = false;
      material.blending = CustomBlending;
      material.blendSrc = OneFactor;
      material.blendDst = OneFactor;
      material.transparent = false;
      material.depthTest = false;
      material.depthWrite = false;
      material.positionNode = program.positionNode;
      material.sizeNode = program.sizeNode;
      material.fragmentNode = program.fragmentNode;
      // Sized points on WebGPU are instanced quads: PointsNodeMaterial expands them only off Points.
      // The typings take SpriteMaterial alone; three's Sprite takes a SpriteNodeMaterial too.
      const points = new Sprite(material as unknown as SpriteMaterial);
      points.geometry = starGeometry;
      points.count = buffers.count;
      points.frustumCulled = false;
      points.matrixAutoUpdate = false;
      points.renderOrder = STARS_RENDER_ORDER;
      points.visible = style === 'wheel';
      points.name = `${CORE_RIG_STARS_NAME}-${String(grid)}`;
      viewport.scene.add(points);
      return points;
    });
  };

  const updateStarVisibility = (): void => {
    if (starPoints.length === 0) return;
    const wheel = style === 'wheel';
    const origin = u.origin.value;
    const res = u.res.value;
    const focal = u.focal.value;
    const fine =
      origin.z < (focal * res.y) / (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);
    starPoints.forEach((points, grid) => {
      points.visible = wheel && (grid === 0 || fine);
    });
  };

  const materials = new Map<VoidStyle, NodeMaterial>();
  const materialFor = (style: VoidStyle): NodeMaterial => {
    const cached = materials.get(style);
    if (cached !== undefined) return cached;
    if (style === 'wheel') {
      bakeGasPattern();
      createGasPass();
      createStarPoints();
    }
    const material = new NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;
    material.vertexNode = FULLSCREEN_VERTEX;
    if (style === 'wheel') {
      if (gasTarget === null) throw new Error('celestialVoid: the wheel reads the gas pass');
      material.fragmentNode = wheelFragment(u, gasTarget.texture);
    } else {
      material.fragmentNode = nebulaFragment(u);
    }
    materials.set(style, material);
    return material;
  };

  const mesh = new Mesh(geometry, materialFor(initialStyle));
  mesh.frustumCulled = false;
  mesh.renderOrder = VOID_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_renderer, _scene, camera): void => {
    if (anchor === 'world') writeWorldFrame(camera as PerspectiveCamera);
    updateStarVisibility();
    if (style === 'wheel') renderGasPass();
  };
  mesh.name = CORE_RIG_VOID_NAME;
  viewport.scene.add(mesh);

  const frozen = prefersReducedMotion();

  const stopFrames = viewport.onFrame((dt) => {
    if (!frozen) u.time.value += dt;
    viewport.renderer.getDrawingBufferSize(drawingBuffer);
    u.res.value.copy(drawingBuffer);
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
  });

  return {
    setStyle(next: VoidStyle): void {
      style = next;
      mesh.material = materialFor(next);
      applyAnchor();
      updateStarVisibility();
    },
    setAnchor(next: VoidAnchor): void {
      anchor = next;
      applyAnchor();
    },
    dispose(): void {
      stopFrames();
      viewport.scene.remove(mesh);
      for (const material of materials.values()) material.dispose();
      materials.clear();
      for (const target of bakeTargets) target.dispose();
      bakeTargets = [];
      gasMaterial?.dispose();
      gasMaterial = null;
      gasTarget?.dispose();
      gasTarget = null;
      gasScene?.clear();
      gasScene = null;
      gasCamera = null;
      for (const points of starPoints) {
        viewport.scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
      }
      starPoints = [];
      geometry.dispose();
    },
  };
}
