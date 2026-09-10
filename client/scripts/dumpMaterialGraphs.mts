// Dumps the node graph of the migrated terrain and water materials, so a later
// change to either composition shows up as a diff rather than as a pixel.
// Run: node client/scripts/dumpMaterialGraphs.mts
import { Group, Mesh } from 'three';
import { CHUNK_SIZE, NEIGHBOURHOOD_CELLS } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import { createWater } from '../src/render/water.ts';
import type { NodeMaterial } from 'three/webgpu';

const WORLD = NEIGHBOURHOOD_CELLS * 4;

const SLOTS = [
  'positionNode',
  'normalNode',
  'colorNode',
  'opacityNode',
  'emissiveNode',
  'outputNode',
  'specularColorNode',
  'maskNode',
] as const;

function describe(label: string, material: NodeMaterial): void {
  const slots = material as unknown as Record<string, { toJSON?: () => unknown } | null>;
  const graph: Record<string, unknown> = {};
  for (const slot of SLOTS) {
    const node = slots[slot];
    graph[slot] = node === null || node === undefined ? null : (node.toJSON?.() ?? null);
  }
  console.log(JSON.stringify({ label, type: material.type, graph }, null, 2));
}

const mirror = createTerrainMirror(WORLD);
const snapshot = {
  type: 'snapshot' as const,
  worldSize: WORLD,
  chunks: [{ cx: 0, cy: 0, heights: new Array<number>(CHUNK_SIZE * CHUNK_SIZE).fill(0) }],
};

const terrainGroup = new Group();
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(applySnapshot(mirror, snapshot));
describe('terrain', meshes.pickables()[0]!.material as NodeMaterial);

const waterGroup = new Group();
createWater(waterGroup, WORLD);
const waterMesh = waterGroup.children[0];
if (waterMesh instanceof Mesh) describe('water', waterMesh.material as NodeMaterial);
