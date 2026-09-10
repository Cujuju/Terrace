import type { InstancedMesh } from 'three';
import { StorageInstancedBufferAttribute, type Node } from 'three/webgpu';
import { instanceIndex, storage } from 'three/tsl';

const MATRIX_ELEMENTS = 16;

// three applies the instance matrix before the position slot and exposes no node for it. Storage
// backing gives three's instancing and this node one shared GPU buffer.
export function instanceMatrix(mesh: InstancedMesh): Node<'mat4'> {
  const current = mesh.instanceMatrix;
  const matrices =
    current instanceof StorageInstancedBufferAttribute
      ? current
      : new StorageInstancedBufferAttribute(current.array as Float32Array, MATRIX_ELEMENTS);
  mesh.instanceMatrix = matrices;
  return storage(matrices, 'mat4', matrices.count).element(instanceIndex);
}
