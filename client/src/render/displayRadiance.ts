import { ACESFilmicToneMapping, Matrix3 } from 'three';
import {
  Fn,
  clamp,
  float,
  mat3,
  max,
  sRGBTransferEOTF,
  select,
  sqrt,
  toneMappingExposure,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

export const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
] as const;
export const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
] as const;
export const ACES_EXPOSURE_PRESCALE = 1 / 0.6;

const RRT_NUMERATOR_OFFSET = 0.0245786;
const RRT_NUMERATOR_BIAS = 0.000090537;
const RRT_DENOMINATOR_SCALE = 0.983729;
const RRT_DENOMINATOR_OFFSET = 0.432951;
const RRT_DENOMINATOR_BIAS = 0.238081;

export function rrtAndOdtFit(v: number): number {
  const a = v * (v + RRT_NUMERATOR_OFFSET) - RRT_NUMERATOR_BIAS;
  const b = v * (RRT_DENOMINATOR_SCALE * v + RRT_DENOMINATOR_OFFSET) + RRT_DENOMINATOR_BIAS;
  return a / b;
}

// The positive root of a·v² + b·v + c = 0, the fit rearranged for a known y.
export function rrtAndOdtFitInverse(y: number): number {
  const a = 1 - RRT_DENOMINATOR_SCALE * y;
  const b = RRT_NUMERATOR_OFFSET - RRT_DENOMINATOR_OFFSET * y;
  const c = -(RRT_NUMERATOR_BIAS + RRT_DENOMINATOR_BIAS * y);
  if (a === 0) return b === 0 ? 0 : -c / b;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return 0;
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

export type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

export function transform3(m: Mat3, v: Vec3): Vec3 {
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

export const ACES_INPUT_INVERSE = invert3(ACES_INPUT);
export const ACES_OUTPUT_INVERSE = invert3(ACES_OUTPUT);

function mat3Node(m: Mat3) {
  return mat3(new Matrix3().set(...m[0], ...m[1], ...m[2]));
}

function rrtAndOdtFitInverseNode(y: Node<'float'>): Node<'float'> {
  const a = float(1).sub(y.mul(RRT_DENOMINATOR_SCALE));
  const b = float(RRT_NUMERATOR_OFFSET).sub(y.mul(RRT_DENOMINATOR_OFFSET));
  const c = float(RRT_NUMERATOR_BIAS).add(y.mul(RRT_DENOMINATOR_BIAS)).negate();
  const discriminant = b.mul(b).sub(a.mul(c).mul(4));
  const linear = select(b.equal(0), float(0), c.negate().div(b));
  const root = select(
    discriminant.lessThan(0),
    float(0),
    b.negate().add(sqrt(discriminant)).div(a.mul(2)),
  );
  return select(a.equal(0), linear, root);
}

// WebGPU tone-maps every pixel. A displayed sRGB colour, clipped to the 8-bit range as WebGL's
// framebuffer did, becomes the radiance that maps back to it; unreachable colours clamp at zero.
export const radianceForDisplay = (displayed: Node<'vec3'>): Node<'vec3'> =>
  Fn((builder) => {
    const linear = sRGBTransferEOTF(clamp(displayed, 0, 1)) as Node<'vec3'>;
    if (builder.renderer.toneMapping !== ACESFilmicToneMapping) return linear;
    const fitted = mat3Node(ACES_OUTPUT_INVERSE).mul(linear);
    const mixed = vec3(
      rrtAndOdtFitInverseNode(fitted.x),
      rrtAndOdtFitInverseNode(fitted.y),
      rrtAndOdtFitInverseNode(fitted.z),
    );
    const exposed = mat3Node(ACES_INPUT_INVERSE).mul(mixed);
    // The typings give RendererReferenceNode no value type; three builds it as a float.
    const exposure = toneMappingExposure as unknown as Node<'float'>;
    return max(exposed.div(exposure.mul(ACES_EXPOSURE_PRESCALE)), vec3(0));
  })();
