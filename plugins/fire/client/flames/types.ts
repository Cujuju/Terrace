import type { Group } from 'three';

export interface FireInstance {
  readonly key: number;
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly fuelHeight: number;
  readonly intensity: number;
  readonly ageSeconds: number;
  readonly presence?: number;
  readonly seed: number;
}

export interface FlameRenderer {
  readonly name: string;
  readonly root: Group;
  apply(fires: readonly FireInstance[]): void;
  readonly drawnCount: number;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export type FlameRendererBuilder = () => FlameRenderer;
