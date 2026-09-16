import {
  atan,
  cameraProjectionMatrix,
  float,
  fract,
  length,
  modelViewMatrix,
  positionGeometry,
  sin,
  smoothstep,
  varying,
  vec4,
} from 'three/tsl';
import type { Node, NodeMaterial } from 'three/webgpu';
import { compose } from '../../render/materialSlots.ts';

// The quad is authored two units across, so this is the offset from its centre in half-widths.
// Vertex stage only: puffBillboard reads the raw attribute.
export const PUFF_QUAD = positionGeometry.xy;

// Fragment-stage copy of the offset above, on an explicit varying: sharing one
// node between positionNode and the fragment draws full quads on WebGPU.
export const PUFF_QUAD_FRAGMENT = varying(PUFF_QUAD, 'puffQuad');

export function puffInstanceBase(instanceMatrix: Node<'mat4'>): Node<'vec3'> {
  return instanceMatrix.mul(vec4(0, 0, 0, 1)).xyz;
}

// The quad's vertex in VIEW space: the anchor, spread by the quad across the view plane. Not a
// position-slot value; `billboardPuffs` wires it.
export function puffBillboard(anchor: Node<'vec3'>, size: Node<'vec2'> | Node<'float'>): Node<'vec3'> {
  const viewPosition = modelViewMatrix.mul(vec4(anchor, 1));
  return vec4(viewPosition.xy.add(PUFF_QUAD.mul(size)), viewPosition.zw).xyz;
}

// The anchor is the world position, so world-space effects (the reveal clip) keep or drop a
// puff whole. The spread lands in the clip-space slot only.
export function billboardPuffs(
  material: NodeMaterial,
  anchor: Node<'vec3'>,
  size: Node<'vec2'> | Node<'float'>,
): void {
  compose(material, 'position', () => anchor);
  compose(material, 'vertex', () => cameraProjectionMatrix.mul(vec4(puffBillboard(anchor, size), 1)));
}

export interface PuffMask {
  readonly puff: Node<'float'>;
  readonly discarded: Node<'bool'>;
}

export function puffMask(innerEdge: Node<'float'> | number, lobing?: PuffLobing): PuffMask {
  const radius = lobing ? length(puffLobedQuad(lobing)) : length(PUFF_QUAD_FRAGMENT);
  const puff = float(1).sub(smoothstep(innerEdge, 1, radius));
  return { puff, discarded: puff.lessThanEqual(0) };
}

export interface PuffLobing {
  readonly amplitude: number;
  readonly seed: Node<'float'>;
}

// The longest lobe in unit-disc radii. A lobed puff's spread must be scaled by this, or the
// quad's square edge clips the lobe with a hard, screen-aligned line.
export function puffLobeReach(lobing: PuffLobing): number {
  return 1 + lobing.amplitude;
}

// The fragment's offset in lobed-disc radii: 1 is the lobe's own edge.
export function puffLobedQuad(lobing: PuffLobing): Node<'vec2'> {
  return PUFF_QUAD_FRAGMENT.mul(puffLobeReach(lobing)).div(puffLobeScale(lobing));
}

const PUFF_LOBE_HARMONICS: ReadonlyArray<{ readonly k: number; readonly phaseHash: number }> = [
  { k: 2, phaseHash: 2.17 },
  { k: 3, phaseHash: 4.73 },
  { k: 5, phaseHash: 9.11 },
];

const TWO_PI = Math.PI * 2;

export function puffLobeScale(lobing: PuffLobing): Node<'float'> {
  const perHarmonic = 1 / PUFF_LOBE_HARMONICS.length;
  const lobeAngle = atan(PUFF_QUAD_FRAGMENT.y, PUFF_QUAD_FRAGMENT.x);
  const terms = PUFF_LOBE_HARMONICS.map(({ k, phaseHash }) =>
    sin(lobeAngle.mul(k).add(fract(lobing.seed.mul(phaseHash)).mul(TWO_PI))),
  ).reduce((sum, term) => sum.add(term));
  return float(1).add(terms.mul(lobing.amplitude * perHarmonic));
}

const PUFF_ALPHA_DISCARD_THRESHOLD = 0.004;

export function puffAlphaDiscard(alpha: Node<'float'>): Node<'bool'> {
  return alpha.lessThanEqual(PUFF_ALPHA_DISCARD_THRESHOLD);
}
