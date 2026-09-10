import {
  atan,
  cameraWorldMatrix,
  float,
  fract,
  length,
  modelViewMatrix,
  modelWorldMatrixInverse,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

// The quad is authored two units across, so this is the offset from its centre in half-widths.
export const PUFF_QUAD = positionGeometry.xy;

// (instanceMatrix * vec4(0, 0, 0, 1)).xyz, read back from three's instanced position. Exact because
// every puff instance matrix is a pure translation (identity rotation, unit scale).
export function puffInstanceBase(): Node<'vec3'> {
  return positionLocal.sub(positionGeometry);
}

// viewPosition = viewMatrix * world; viewPosition.xy += quad * size; returned in the position
// slot's space (after the instance matrix), so three's own model-view-projection lands it there.
export function puffBillboard(world: Node<'vec3'>, size: Node<'vec2'> | Node<'float'>): Node<'vec3'> {
  const viewPosition = modelViewMatrix.mul(vec4(world, 1));
  const billboarded = vec4(viewPosition.xy.add(PUFF_QUAD.mul(size)), viewPosition.zw);
  return modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(billboarded)).xyz;
}

export interface PuffMask {
  readonly puff: Node<'float'>;
  readonly discarded: Node<'bool'>;
}

export function puffMask(innerEdge: Node<'float'> | number, lobing?: PuffLobing): PuffMask {
  const radius = lobing ? length(PUFF_QUAD).div(puffLobeScale(lobing)) : length(PUFF_QUAD);
  const puff = float(1).sub(smoothstep(innerEdge, 1, radius));
  return { puff, discarded: puff.lessThanEqual(0) };
}

export interface PuffLobing {
  readonly amplitude: number;
  readonly seed: Node<'float'>;
}

const PUFF_LOBE_HARMONICS: ReadonlyArray<{ readonly k: number; readonly phaseHash: number }> = [
  { k: 2, phaseHash: 2.17 },
  { k: 3, phaseHash: 4.73 },
  { k: 5, phaseHash: 9.11 },
];

const TWO_PI = Math.PI * 2;

export function puffLobeScale(lobing: PuffLobing): Node<'float'> {
  const perHarmonic = 1 / PUFF_LOBE_HARMONICS.length;
  const lobeAngle = atan(PUFF_QUAD.y, PUFF_QUAD.x);
  const terms = PUFF_LOBE_HARMONICS.map(({ k, phaseHash }) =>
    sin(lobeAngle.mul(k).add(fract(lobing.seed.mul(phaseHash)).mul(TWO_PI))),
  ).reduce((sum, term) => sum.add(term));
  return float(1).add(terms.mul(lobing.amplitude * perHarmonic));
}

const PUFF_ALPHA_DISCARD_THRESHOLD = 0.004;

export function puffAlphaDiscard(alpha: Node<'float'>): Node<'bool'> {
  return alpha.lessThanEqual(PUFF_ALPHA_DISCARD_THRESHOLD);
}
