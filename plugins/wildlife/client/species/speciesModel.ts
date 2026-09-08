import type {
  Bone,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
} from 'three';
import type { MoverGait } from '../../../../client/src/plugins/kit/moverGait.ts';

export interface SpeciesModelPool {
  keepGeometry<T extends BufferGeometry>(geometry: T): T;
  lambert(color: number, options?: { flatShading?: boolean }): MeshLambertMaterial;
  unlit(color: number): MeshBasicMaterial;
  part(geometry: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh;
  rigged(): { root: Group; rig: Group };
}

export type SpeciesJoints = Readonly<Record<string, Bone>>;

export interface AuthoredSpecies {
  readonly root: Object3D;
  readonly joints: Readonly<Record<string, Object3D>>;
  animate(joints: SpeciesJoints, seconds: number, phase: number, gait: MoverGait): void;
  readonly posesByGait?: boolean;
}

export type SpeciesModelBuilder = (pool: SpeciesModelPool) => AuthoredSpecies;

export const TWO_PI = Math.PI * 2;
