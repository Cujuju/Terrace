import {
  and,
  materialColor,
  materialEmissive,
  materialNormal,
  materialOpacity,
  not,
  output,
  positionLocal,
} from 'three/tsl';
import type { Node, NodeMaterial } from 'three/webgpu';

export type MaterialSlot =
  | 'position'
  | 'normal'
  | 'color'
  | 'opacity'
  | 'emissive'
  | 'output';

type SlotProperty =
  | 'positionNode'
  | 'normalNode'
  | 'colorNode'
  | 'opacityNode'
  | 'emissiveNode'
  | 'outputNode';

const SLOT_PROPERTY: Readonly<Record<MaterialSlot, SlotProperty>> = {
  position: 'positionNode',
  normal: 'normalNode',
  color: 'colorNode',
  opacity: 'opacityNode',
  emissive: 'emissiveNode',
  output: 'outputNode',
};

// three's own default for each slot, so a material with no effect stays the
// stock material. `output` is the post-lighting, pre-tone-mapping vec4.
const SLOT_DEFAULT: Readonly<Record<MaterialSlot, () => Node>> = {
  position: () => positionLocal,
  normal: () => materialNormal,
  color: () => materialColor,
  opacity: () => materialOpacity,
  emissive: () => materialEmissive,
  output: () => output,
};

// NodeMaterial types each slot property with its own node-type union; the
// contract composes all six uniformly.
type SlotNodes = Record<SlotProperty, Node | null>;

export function compose(
  material: NodeMaterial,
  slot: MaterialSlot,
  effect: (previous: Node) => Node,
): void {
  const nodes = material as unknown as SlotNodes;
  const property = SLOT_PROPERTY[slot];
  nodes[property] = effect(nodes[property] ?? SLOT_DEFAULT[slot]());
}

// `Discard` stacks where called, so it cannot be built outside a shader build.
// `maskNode` is the declarative equivalent: three discards where the mask is
// false, so conditions AND their keeps.
export function discard(material: NodeMaterial, condition: Node<'bool'>): void {
  const previous = material.maskNode as Node<'bool'> | null;
  const keep = not(condition);
  material.maskNode = previous === null ? keep : and(previous, keep);
}
