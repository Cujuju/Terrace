import { Matrix4, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import type { RigAsset } from './rigAsset.ts';

export interface AssetPart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly localMatrices: Matrix4[];
}

export interface FlattenAssetOptions {
  readonly exclude?: readonly string[];
}

export function flattenAssetParts(
  asset: RigAsset,
  options: FlattenAssetOptions = {},
): AssetPart[] {
  asset.scene.updateMatrixWorld(true);

  const excluded = new Set(options.exclude ?? []);
  const parts: AssetPart[] = [];
  const partsByGeometry = new Map<BufferGeometry, AssetPart[]>();

  asset.scene.traverse((child: Object3D) => {
    if (excluded.has(child.name)) return;
    const mesh = child as Partial<Mesh> & Object3D;
    if (mesh.isMesh !== true) return;
    const material = (mesh as Mesh).material as Material | Material[];
    if (Array.isArray(material)) {
      throw new Error(
        `flattenAssetParts: mesh "${mesh.name || '(unnamed)'}" has several materials — ` +
          `it cannot be one part; load the asset through rigAsset.ts, which rejects this`,
      );
    }
    const geometry = (mesh as Mesh).geometry as BufferGeometry;
    const local = child.matrixWorld.clone();

    const sharing = partsByGeometry.get(geometry);
    const existing = sharing?.find((part) => part.material === material);
    if (existing !== undefined) {
      existing.localMatrices.push(local);
      return;
    }
    const part: AssetPart = { geometry, material, localMatrices: [local] };
    parts.push(part);
    if (sharing === undefined) partsByGeometry.set(geometry, [part]);
    else sharing.push(part);
  });

  if (parts.length === 0) {
    throw new Error(
      `flattenAssetParts: the asset has no drawable mesh left ` +
        `(excluded: ${[...excluded].join(', ') || 'none'})`,
    );
  }
  return parts;
}
