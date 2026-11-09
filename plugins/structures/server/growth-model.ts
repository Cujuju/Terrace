import type { StructureCell } from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import type { StructuresWorld } from './suitability.ts';

export const STRUCTURES_MODEL_ENV = 'STRUCTURES_MODEL';
export const GROWTH_MODEL_VERSION = 3;

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

/** A growth model ranks by tier and may not know building kinds; structures fills them in. */
export type GrowthCellRecord = Omit<BoardCellRecord, 'kind'> & { readonly kind?: number };

export type GrowthCell = Omit<StructureCell, 'kind'> & { readonly kind?: number };

export interface GrowthStage {
  readonly kind: number;
  readonly tier: number;
}

export interface GrowthStepResult {
  readonly nextLive: Map<number, GrowthCellRecord>;
  readonly born: GrowthCell[];
  readonly upgraded: GrowthCell[];
  readonly died: Array<{ x: number; y: number }>;
  readonly emitted: ReadonlyArray<{ x: number; y: number }>;
}

export interface GrowthContext {
  /** Omitting kind surveys founding ground; a resolved kind surveys its complete lot. */
  isBuildable(x: number, y: number, kind?: number): boolean;
  resolveStage(x: number, y: number, tier: number, current?: GrowthCellRecord): GrowthStage;
  /** One authored chain entry, constrained by the site's complexity ceiling. */
  nextStage(x: number, y: number, ceiling: number, current: GrowthCellRecord): GrowthStage;
  readonly maxTier: number;
  /** The proposed kind is resolved before testing either current or staged occupancy. */
  hasBuildingWithinSeparation(
    cells: ReadonlyMap<number, BoardCellRecord>,
    x: number,
    y: number,
    kind: number,
  ): boolean;
  /** Earlier accepted camps relinquish the lot claimed by an upgraded building. */
  absorbedByUpgrade(cells: ReadonlyMap<number, BoardCellRecord>, x: number, y: number, kind: number): readonly number[];
}

export interface GrowthModel {
  readonly name: string;
  readonly contractVersion: number;
  step(
    world: StructuresWorld,
    live: ReadonlyMap<number, BoardCellRecord>,
    ctx: GrowthContext,
  ): GrowthStepResult;
  afterSwap?(emitted: ReadonlyArray<{ x: number; y: number }>): void;
}

let registered: GrowthModel | null = null;

export function setGrowthModel(model: GrowthModel | null): void {
  if (model !== null && model.contractVersion !== GROWTH_MODEL_VERSION) {
    registered = null;
    console.warn('[structures] incompatible growth-model contract — reload both growth plugins');
    return;
  }
  registered = model;
}

export function growthModel(): GrowthModel | null {
  return registered;
}
