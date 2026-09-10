import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  Vector3,
  type RenderTarget,
  type Renderer,
  type Texture,
} from 'three/webgpu';
import type { SkyRigState } from '../plugins/types.ts';

export const SKY_ENVIRONMENT_WIDTH = 256;
const SKY_ENVIRONMENT_HEIGHT = SKY_ENVIRONMENT_WIDTH / 2;

export const SKY_ENVIRONMENT_REFRESH_MS = 1000;

const RADIANCE_SEARCH_MAX = 64;
const RADIANCE_SEARCH_STEPS = 40;

const GROUND_RADIANCE_FRACTION = 0.3;

const HORIZON_BRIGHTENING = 1.6;

const SUN_GLOW_SHARPNESS = 256;
const SUN_GLOW_GAIN = 6;

const HORIZON_BLEND_HALF_HEIGHT = 0.1;

const TEXEL_COMPONENTS = 4;

export interface SkyEnvironment {
  readonly texture: Texture;
  retint(state: SkyRigState): void;
  flush(nowMs: number): void;
  dispose(): void;
}

export function createSkyEnvironment(
  renderer: Renderer,
  initial: SkyRigState,
  nowMs: number,
): SkyEnvironment {
  const texels = new Float32Array(
    SKY_ENVIRONMENT_WIDTH * SKY_ENVIRONMENT_HEIGHT * TEXEL_COMPONENTS,
  );
  const source = new DataTexture(
    texels,
    SKY_ENVIRONMENT_WIDTH,
    SKY_ENVIRONMENT_HEIGHT,
    RGBAFormat,
    FloatType,
  );
  source.mapping = EquirectangularReflectionMapping;
  source.colorSpace = LinearSRGBColorSpace;
  source.minFilter = LinearFilter;
  source.magFilter = LinearFilter;

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const skyColor = new Color();
  const groundColor = new Color();
  const sunColor = new Color();
  const skyRadiance = new Color();
  const groundRadiance = new Color();
  const sunDirection = new Vector3();
  const direction = new Vector3();

  const paint = (state: SkyRigState): void => {
    skyColor.setHex(state.backgroundColor);
    groundColor.setHex(state.hemisphereGroundColor);
    sunColor.setHex(state.sunColor);
    sunDirection
      .set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
      .normalize();

    const zenithScale = radianceMatchingDisplay(skyColor, renderer) / HORIZON_BRIGHTENING;
    skyRadiance.copy(skyColor).multiplyScalar(zenithScale);
    groundRadiance.copy(groundColor).multiplyScalar(zenithScale * GROUND_RADIANCE_FRACTION);

    let i = 0;
    for (let row = 0; row < SKY_ENVIRONMENT_HEIGHT; row++) {
      const v = (row + 0.5) / SKY_ENVIRONMENT_HEIGHT;
      const y = Math.sin((v - 0.5) * Math.PI);
      const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      const t = Math.min(
        1,
        Math.max(0, (y + HORIZON_BLEND_HALF_HEIGHT) / (2 * HORIZON_BLEND_HALF_HEIGHT)),
      );
      const skyWeight = t * t * (3 - 2 * t);
      const horizonWeight = 1 - Math.max(0, y);
      const skyGain = 1 + (HORIZON_BRIGHTENING - 1) * horizonWeight;
      const skyR = skyRadiance.r * skyGain;
      const skyG = skyRadiance.g * skyGain;
      const skyB = skyRadiance.b * skyGain;
      const baseR = groundRadiance.r + (skyR - groundRadiance.r) * skyWeight;
      const baseG = groundRadiance.g + (skyG - groundRadiance.g) * skyWeight;
      const baseB = groundRadiance.b + (skyB - groundRadiance.b) * skyWeight;
      for (let column = 0; column < SKY_ENVIRONMENT_WIDTH; column++) {
        const u = (column + 0.5) / SKY_ENVIRONMENT_WIDTH;
        const azimuth = (u - 0.5) * 2 * Math.PI;
        direction.set(horizontal * Math.cos(azimuth), y, horizontal * Math.sin(azimuth));
        const towardSun = Math.max(0, direction.dot(sunDirection));
        const glow = Math.pow(towardSun, SUN_GLOW_SHARPNESS) * state.sunIntensity * SUN_GLOW_GAIN;
        texels[i++] = baseR + sunColor.r * glow;
        texels[i++] = baseG + sunColor.g * glow;
        texels[i++] = baseB + sunColor.b * glow;
        texels[i++] = 1;
      }
    }
    source.needsUpdate = true;
  };

  const fingerprintOf = (state: SkyRigState): string =>
    [
      state.sunDirection.x,
      state.sunDirection.y,
      state.sunDirection.z,
      state.sunColor,
      state.sunIntensity,
      state.backgroundColor,
      state.hemisphereGroundColor,
      renderer.toneMapping,
      renderer.toneMappingExposure,
    ].join(',');

  paint(initial);
  let target: RenderTarget = pmrem.fromEquirectangular(source);
  let painted = fingerprintOf(initial);
  let lastPaintMs = nowMs;
  let pending: SkyRigState | null = null;
  let disposed = false;

  return {
    texture: target.texture,
    retint(state: SkyRigState): void {
      if (fingerprintOf(state) === painted) {
        pending = null;
        return;
      }
      pending = state;
    },
    flush(now: number): void {
      if (pending === null || disposed) return;
      if (now - lastPaintMs < SKY_ENVIRONMENT_REFRESH_MS) return;
      paint(pending);
      target = pmrem.fromEquirectangular(source, target);
      painted = fingerprintOf(pending);
      pending = null;
      lastPaintMs = now;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.dispose();
      source.dispose();
      pmrem.dispose();
    },
  };
}

const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
] as const;
const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
] as const;
const ACES_EXPOSURE_PRESCALE = 1 / 0.6;

const RRT_NUMERATOR_OFFSET = 0.0245786;
const RRT_NUMERATOR_BIAS = 0.000090537;
const RRT_DENOMINATOR_SCALE = 0.983729;
const RRT_DENOMINATOR_OFFSET = 0.432951;
const RRT_DENOMINATOR_BIAS = 0.238081;

const acesScratch = new Color();

function rrtAndOdtFit(v: number): number {
  const a = v * (v + RRT_NUMERATOR_OFFSET) - RRT_NUMERATOR_BIAS;
  const b = v * (RRT_DENOMINATOR_SCALE * v + RRT_DENOMINATOR_OFFSET) + RRT_DENOMINATOR_BIAS;
  return a / b;
}

// The positive root of a·v² + b·v + c = 0, the fit rearranged for a known y.
function rrtAndOdtFitInverse(y: number): number {
  const a = 1 - RRT_DENOMINATOR_SCALE * y;
  const b = RRT_NUMERATOR_OFFSET - RRT_DENOMINATOR_OFFSET * y;
  const c = -(RRT_NUMERATOR_BIAS + RRT_DENOMINATOR_BIAS * y);
  if (a === 0) return b === 0 ? 0 : -c / b;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return 0;
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

function acesFilmic(color: Color, exposure: number): Color {
  const k = exposure * ACES_EXPOSURE_PRESCALE;
  const r = color.r * k;
  const g = color.g * k;
  const b = color.b * k;
  const fr = rrtAndOdtFit(ACES_INPUT[0][0] * r + ACES_INPUT[0][1] * g + ACES_INPUT[0][2] * b);
  const fg = rrtAndOdtFit(ACES_INPUT[1][0] * r + ACES_INPUT[1][1] * g + ACES_INPUT[1][2] * b);
  const fb = rrtAndOdtFit(ACES_INPUT[2][0] * r + ACES_INPUT[2][1] * g + ACES_INPUT[2][2] * b);
  color.r = Math.min(1, Math.max(0, ACES_OUTPUT[0][0] * fr + ACES_OUTPUT[0][1] * fg + ACES_OUTPUT[0][2] * fb));
  color.g = Math.min(1, Math.max(0, ACES_OUTPUT[1][0] * fr + ACES_OUTPUT[1][1] * fg + ACES_OUTPUT[1][2] * fb));
  color.b = Math.min(1, Math.max(0, ACES_OUTPUT[2][0] * fr + ACES_OUTPUT[2][1] * fg + ACES_OUTPUT[2][2] * fb));
  return color;
}

function luminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function transform3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function invert3(m: Mat3): Mat3 {
  const cofactor = (r: number, c: number): number => {
    const rows = [0, 1, 2].filter((i) => i !== r);
    const cols = [0, 1, 2].filter((i) => i !== c);
    const minor =
      m[rows[0]!]![cols[0]!]! * m[rows[1]!]![cols[1]!]! -
      m[rows[0]!]![cols[1]!]! * m[rows[1]!]![cols[0]!]!;
    return (r + c) % 2 === 0 ? minor : -minor;
  };
  const determinant =
    m[0][0] * cofactor(0, 0) + m[0][1] * cofactor(0, 1) + m[0][2] * cofactor(0, 2);
  return [
    [cofactor(0, 0) / determinant, cofactor(1, 0) / determinant, cofactor(2, 0) / determinant],
    [cofactor(0, 1) / determinant, cofactor(1, 1) / determinant, cofactor(2, 1) / determinant],
    [cofactor(0, 2) / determinant, cofactor(1, 2) / determinant, cofactor(2, 2) / determinant],
  ];
}

const ACES_INPUT_INVERSE = invert3(ACES_INPUT);
const ACES_OUTPUT_INVERSE = invert3(ACES_OUTPUT);

// WebGPU tone-maps every pixel, the clear colour included
// (`_getFrameBufferTarget`). A background authored as a display colour must be
// handed over as the radiance that tone-maps back to it.
export function backgroundRadiance(displayedHex: number, renderer: Renderer): Color {
  const displayed = new Color().setHex(displayedHex);
  if (renderer.toneMapping !== ACESFilmicToneMapping) return displayed;
  const fitted = transform3(ACES_OUTPUT_INVERSE, [displayed.r, displayed.g, displayed.b]);
  const mixed: Vec3 = [
    rrtAndOdtFitInverse(fitted[0]),
    rrtAndOdtFitInverse(fitted[1]),
    rrtAndOdtFitInverse(fitted[2]),
  ];
  const exposed = transform3(ACES_INPUT_INVERSE, mixed);
  const k = renderer.toneMappingExposure * ACES_EXPOSURE_PRESCALE;
  return displayed.setRGB(exposed[0] / k, exposed[1] / k, exposed[2] / k, LinearSRGBColorSpace);
}

function radianceMatchingDisplay(displayed: Color, renderer: Renderer): number {
  if (renderer.toneMapping !== ACESFilmicToneMapping) return 1;
  const target = luminance(displayed);
  let low = 0;
  let high = RADIANCE_SEARCH_MAX;
  for (let i = 0; i < RADIANCE_SEARCH_STEPS; i++) {
    const mid = (low + high) / 2;
    acesScratch.copy(displayed).multiplyScalar(mid);
    if (luminance(acesFilmic(acesScratch, renderer.toneMappingExposure)) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
