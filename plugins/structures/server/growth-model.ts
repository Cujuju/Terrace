import type { StructureCell } from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import type { StructuresWorld } from './suitability.ts';

export const STRUCTURES_MODEL_ENV = 'STRUCTURES_MODEL';

export const STRUCTURES_MODEL_SETTING_KEY = 'model';

export const STRUCTURES_MODEL_LIFE = 'life';

export const STRUCTURES_MODEL_POPULOUS = 'populous';

export type StructuresModel = typeof STRUCTURES_MODEL_LIFE | typeof STRUCTURES_MODEL_POPULOUS;

export const STRUCTURES_MODELS: readonly StructuresModel[] = [
  STRUCTURES_MODEL_LIFE,
  STRUCTURES_MODEL_POPULOUS,
];

export function isStructuresModel(value: string): value is StructuresModel {
  return (STRUCTURES_MODELS as readonly string[]).includes(value);
}

export function readStructuresModel(env: NodeJS.ProcessEnv): StructuresModel {
  const raw = env[STRUCTURES_MODEL_ENV]?.trim();
  if (raw === undefined || raw === '') return STRUCTURES_MODEL_LIFE;
  if (isStructuresModel(raw)) return raw;
  throw new Error(
    `${STRUCTURES_MODEL_ENV} must be one of ${STRUCTURES_MODELS.join(' | ')}, got ${raw}`,
  );
}

export interface BoardCellRecord extends LiveCellRecord {
  readonly population?: number;
}

export interface GrowthStepResult {
  readonly nextLive: Map<number, BoardCellRecord>;
  readonly born: StructureCell[];
  readonly upgraded: StructureCell[];
  readonly died: Array<{ x: number; y: number }>;
  readonly emitted: ReadonlyArray<{ x: number; y: number }>;
}

export interface GrowthContext {
  isBuildable(x: number, y: number): boolean;
  readonly maxTier: number;
  hasBuildingWithinSeparation(
    cells: ReadonlyMap<number, BoardCellRecord>,
    x: number,
    y: number,
  ): boolean;
}

export interface GrowthModel {
  readonly name: string;
  step(
    world: StructuresWorld,
    live: ReadonlyMap<number, BoardCellRecord>,
    ctx: GrowthContext,
  ): GrowthStepResult;
  afterSwap?(emitted: ReadonlyArray<{ x: number; y: number }>): void;
}

let registered: GrowthModel | null = null;

export function setGrowthModel(model: GrowthModel | null): void {
  registered = model;
}

export function growthModel(): GrowthModel | null {
  return registered;
}
