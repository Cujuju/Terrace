import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BufferGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import type { RigAsset } from '../../../client/src/render/rigAsset.ts';
import type { World } from '../../../server/src/world/world.ts';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { CHUNK_SIZE } from '@terrace/shared';
import type { ApachePayload } from '../protocol.ts';

interface Glb {
  nodes: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: { componentType: number; count: number; bufferView: number; byteOffset?: number }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  scenes: { nodes: number[] }[];
  scene?: number;
}

export function readAsset(url: URL): RigAsset {
  const bytes = readFileSync(url);
  const length = bytes.readUInt32LE(12);
  const glb = JSON.parse(bytes.toString('utf8', 20, 20 + length)) as Glb;
  const binary = bytes.subarray(28 + length);
  const material = new MeshStandardMaterial();
  const nodes = glb.nodes.map((source) => {
    const node = new Group();
    node.name = source.name ?? '';
    if (source.matrix) node.applyMatrix4(new Matrix4().fromArray(source.matrix));
    else {
      if (source.translation) node.position.fromArray(source.translation);
      if (source.rotation) node.quaternion.fromArray(source.rotation);
      if (source.scale) node.scale.fromArray(source.scale);
    }
    if (source.mesh !== undefined) for (const primitive of glb.meshes[source.mesh].primitives) {
      const accessor = glb.accessors[primitive.attributes.POSITION];
      assert.equal(accessor.componentType, 5126);
      const view = glb.bufferViews[accessor.bufferView];
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const positions: number[] = [];
      for (let i = 0; i < accessor.count; i++) for (let axis = 0; axis < 3; axis++) {
        positions.push(binary.readFloatLE(start + i * (view.byteStride ?? 12) + axis * 4));
      }
      const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
      if (primitive.indices !== undefined) {
        const index = glb.accessors[primitive.indices];
        const offset = (glb.bufferViews[index.bufferView].byteOffset ?? 0) + (index.byteOffset ?? 0);
        const indices: number[] = [];
        for (let i = 0; i < index.count; i++) {
          if (index.componentType === 5121) indices.push(binary.readUInt8(offset + i));
          else if (index.componentType === 5123) indices.push(binary.readUInt16LE(offset + i * 2));
          else { assert.equal(index.componentType, 5125); indices.push(binary.readUInt32LE(offset + i * 4)); }
        }
        geometry.setIndex(indices);
      }
      node.add(new Mesh(geometry, material));
    }
    return node;
  });
  glb.nodes.forEach((source, i) => { for (const child of source.children ?? []) nodes[i].add(nodes[child]); });
  const scene = new Group();
  for (const root of glb.scenes[glb.scene ?? 0].nodes) scene.add(nodes[root]);
  scene.updateMatrixWorld(true);
  const find = (name: string): Object3D => { const node = scene.getObjectByName(name); assert.ok(node); return node; };
  return {
    scene, node: find, anchor: (name) => find(name).getWorldPosition(new Vector3()),
    dispose() {
      scene.traverse((node) => { if (node instanceof Mesh) node.geometry.dispose(); });
      material.dispose();
    },
  };
}

export function testWorld(options: {
  heightAt?: (x: number, y: number) => number;
  visible?: (playerId: string, x: number, y: number) => boolean;
  structures?: readonly { x: number; y: number }[];
  unlocked?: (x: number, y: number) => boolean;
} = {}) {
  const messages: { playerId: string; payload: ApachePayload }[] = [];
  const reads: { x: number; y: number }[] = [];
  const world = {
    size: 512, chunksPerEdge: 512 / CHUNK_SIZE, difficulty: 1, genesisMillis: 1, simMillis: 0,
    players: () => [{ id: 'explorer', token: 'explorer' }, { id: 'viewer', token: 'viewer' }],
    heightAt(x: number, y: number) { reads.push({ x, y }); return options.heightAt?.(x, y) ?? 17; },
    isCellUnlocked: (x: number, y: number) => options.unlocked?.(x, y) ?? true,
    isCellVisibleTo: (id: string, x: number, y: number) => options.visible?.(id, x, y) ?? true,
    sendRawTo: (playerId: string, _type: string, payload: ApachePayload) => messages.push({ playerId, payload }),
  };
  // The fixture supplies only World members used by the actual plugin view; no world file or session is opened.
  const view = createWorldApi(world as unknown as World, {
    notifyTerrainChanged() {}, notifyChunkUnlockedForToken() {}, notifyWorldEvent() {},
  }, 'apache', {}, () => ({ standingStructures: () => options.structures ?? [{ x: 256, y: 256 }] }));
  return { ...view, messages, reads };
}
