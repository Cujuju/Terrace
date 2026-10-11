import type { Material } from 'three';
import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  PointsNodeMaterial,
  SpriteNodeMaterial,
  type NodeMaterial,
} from 'three/webgpu';

const NODE_CLASS_BY_TYPE: Readonly<Record<string, new () => NodeMaterial>> = {
  MeshBasicMaterial: MeshBasicNodeMaterial,
  MeshLambertMaterial: MeshLambertNodeMaterial,
  MeshPhongMaterial: MeshPhongNodeMaterial,
  MeshPhysicalMaterial: MeshPhysicalNodeMaterial,
  MeshStandardMaterial: MeshStandardNodeMaterial,
  MeshToonMaterial: MeshToonNodeMaterial,
  PointsMaterial: PointsNodeMaterial,
  SpriteMaterial: SpriteNodeMaterial,
};

// The same property copy three's own NodeLibrary.fromMaterial does, hoisted to
// app level so a loaded material can carry slots before it reaches the renderer.
export function toNodeMaterial(source: Material): NodeMaterial {
  if ((source as Partial<NodeMaterial>).isNodeMaterial === true) return source as NodeMaterial;
  const NodeClass = NODE_CLASS_BY_TYPE[source.type];
  if (NodeClass === undefined) {
    throw new Error(`toNodeMaterial: "${source.type}" has no node material counterpart`);
  }
  const material = new NodeClass();
  const target = material as unknown as Record<string, unknown>;
  const values = source as unknown as Record<string, unknown>;
  for (const key in values) target[key] = values[key];
  return material;
}
