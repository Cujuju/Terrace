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

export interface SlotNodeType {
  position: 'vec3';
  normal: 'vec3';
  color: 'vec3';
  opacity: 'float';
  emissive: 'vec3';
  output: 'vec4';
}

export type MaterialSlot = keyof SlotNodeType;

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

export function compose<S extends MaterialSlot>(
  material: NodeMaterial,
  slot: S,
  effect: (previous: Node<SlotNodeType[S]>) => Node,
): void {
  const nodes = material as unknown as SlotNodes;
  const property = SLOT_PROPERTY[slot];
  const previous = (nodes[property] ?? SLOT_DEFAULT[slot]()) as Node<SlotNodeType[S]>;
  nodes[property] = effect(previous);
}

const keeps = new WeakMap<Node, Node<'bool'>>();
const joinedKeeps = new WeakMap<Node, WeakMap<Node, Node<'bool'>>>();

// One node per input: materials given the same discards share a mask, so their program keys agree.
function memo<K extends Node>(cache: WeakMap<K, Node<'bool'>>, key: K, make: () => Node<'bool'>) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const made = make();
  cache.set(key, made);
  return made;
}

// `Discard` stacks where called, so it cannot be built outside a shader build.
// `maskNode` is the declarative equivalent: three discards where the mask is
// false, so conditions AND their keeps.
export function discard(material: NodeMaterial, condition: Node<'bool'>): void {
  const previous = material.maskNode as Node<'bool'> | null;
  const keep = memo(keeps, condition, () => not(condition));
  if (previous === null) {
    material.maskNode = keep;
    return;
  }
  let joined = joinedKeeps.get(previous);
  if (joined === undefined) {
    joined = new WeakMap();
    joinedKeeps.set(previous, joined);
  }
  material.maskNode = memo(joined, keep, () => and(previous, keep));
}
