import {
  TERRACE_BAND_COUNT,
  cellsAcross,
  cellsOverArea,
  drawnBandOfSample,
  isWater,
} from '@terrace/shared';
import authored from './spawn-bands.json' with { type: 'json' };
import { BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS, MAX_BUILDING_TIER } from './buildingKinds.ts';

export type SiteRule = 'coastal' | 'inland' | 'any';

export interface CategoryRule {
  readonly id: string;
  readonly site: SiteRule;
  readonly minBand: number;
  readonly maxBand: number;
  /** Building kinds, in upgrade order. */
  readonly chain: readonly number[];
  readonly landmarks: readonly number[];
}

export interface LandmarkRule {
  readonly kind: number;
  readonly minBand: number;
  readonly maxBand: number;
  readonly spacingCells: number;
}

export interface SettlementRules {
  readonly buildingIds: readonly string[];
  readonly tiers: readonly number[];
  readonly categories: readonly CategoryRule[];
  readonly landmarks: ReadonlyMap<number, LandmarkRule>;
}

const SITES: readonly SiteRule[] = ['coastal', 'inland', 'any'];
const SOURCE = 'plugins/structures/spawn-bands.json';

function fail(message: string): never {
  throw new Error(`${SOURCE}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function bandRange(value: unknown, where: string): [number, number] {
  const maxBand = TERRACE_BAND_COUNT - 1;
  if (!Array.isArray(value) || value.length !== 2) fail(`${where}.bands must be [lowest, highest]`);
  const [low, high] = value as unknown[];
  if (!Number.isInteger(low) || !Number.isInteger(high)) fail(`${where}.bands must be whole numbers`);
  const lo = low as number;
  const hi = high as number;
  if (lo < 0 || hi > maxBand || lo > hi) fail(`${where}.bands must satisfy 0 <= lowest <= highest <= ${maxBand}`);
  return [lo, hi];
}

export function parseSettlementRules(raw: unknown): SettlementRules {
  const root = record(raw, 'the file');
  const buildings = record(root.buildings, 'buildings');
  const buildingIds = Object.keys(buildings);
  const tiers: number[] = [];
  for (const id of buildingIds) {
    if (BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS[id] === undefined) fail(`buildings.${id} has no model`);
    const tier = record(buildings[id], `buildings.${id}`).tier;
    if (!Number.isInteger(tier) || (tier as number) < 0 || (tier as number) > MAX_BUILDING_TIER) {
      fail(`buildings.${id}.tier must be a whole number from 0 to ${MAX_BUILDING_TIER}`);
    }
    tiers.push(tier as number);
  }
  const kindOf = (id: unknown, where: string): number => {
    const kind = typeof id === 'string' ? buildingIds.indexOf(id) : -1;
    if (kind < 0) fail(`${where} names ${JSON.stringify(id)}, which is not under buildings`);
    return kind;
  };

  const landmarks = new Map<number, LandmarkRule>();
  for (const [id, value] of Object.entries(record(root.landmarks, 'landmarks'))) {
    const rule = record(value, `landmarks.${id}`);
    const [minBand, maxBand] = bandRange(rule.bands, `landmarks.${id}`);
    const spacing = rule.spacingWorldUnits;
    if (typeof spacing !== 'number' || !(spacing > 0)) fail(`landmarks.${id}.spacingWorldUnits must be positive`);
    const kind = kindOf(id, 'landmarks');
    landmarks.set(kind, { kind, minBand, maxBand, spacingCells: cellsAcross(spacing) });
  }

  const categories: CategoryRule[] = [];
  for (const [id, value] of Object.entries(record(root.categories, 'categories'))) {
    const rule = record(value, `categories.${id}`);
    if (!SITES.includes(rule.site as SiteRule)) fail(`categories.${id}.site must be one of ${SITES.join(', ')}`);
    const [minBand, maxBand] = bandRange(rule.bands, `categories.${id}`);
    if (!Array.isArray(rule.chain) || rule.chain.length === 0) fail(`categories.${id}.chain must list at least one building`);
    const chain = rule.chain.map((entry, i) => kindOf(entry, `categories.${id}.chain[${i}]`));
    if (new Set(chain).size !== chain.length) fail(`categories.${id}.chain lists a building twice`);
    if (tiers[chain[0]!] !== 0) fail(`categories.${id}.chain must start with a tier-0 building: settlements start camp-grade`);
    if (!Array.isArray(rule.landmarks)) fail(`categories.${id}.landmarks must be a list`);
    const categoryLandmarks = rule.landmarks.map((entry, i) => {
      const kind = kindOf(entry, `categories.${id}.landmarks[${i}]`);
      if (!landmarks.has(kind)) fail(`categories.${id}.landmarks[${i}] is not under landmarks`);
      return kind;
    });
    categories.push({ id, site: rule.site as SiteRule, minBand, maxBand, chain, landmarks: categoryLandmarks });
  }
  return { buildingIds, tiers, categories, landmarks };
}

export const SETTLEMENT_RULES: SettlementRules = parseSettlementRules(authored);

export const BUILDING_KIND_COUNT = SETTLEMENT_RULES.buildingIds.length;

export function isBuildingKind(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < BUILDING_KIND_COUNT;
}

export function buildingIdOf(kind: number): string {
  return SETTLEMENT_RULES.buildingIds[kind]!;
}

export function buildingKindOf(id: string): number | null {
  const kind = SETTLEMENT_RULES.buildingIds.indexOf(id);
  return kind < 0 ? null : kind;
}

export function tierOfKind(kind: number): number {
  return SETTLEMENT_RULES.tiers[kind]!;
}

export function footprintRadiusOfKind(kind: number): number {
  return BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS[buildingIdOf(kind)]!;
}

export const MAX_FOOTPRINT_RADIUS_CELLS = Math.max(
  ...SETTLEMENT_RULES.buildingIds.map((id) => BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS[id]!),
);

/** Each footprint's edge cell surveys half a cell, so neighbouring footprints keep a whole cell between them. */
const FOOTPRINT_EDGE_CELLS = 1;

export function lotSeparationCells(kindA: number, kindB: number): number {
  return footprintRadiusOfKind(kindA) + footprintRadiusOfKind(kindB) + FOOTPRINT_EDGE_CELLS;
}

export interface SettlementWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

export const COASTAL_SEARCH_RADIUS_CELLS = cellsAcross(4);

export const COASTAL_MIN_WATER_CELLS = cellsOverArea(2);

/** Cell offsets strictly inside the search radius, nearest first. */
export const COASTAL_SEARCH_OFFSETS: ReadonlyArray<readonly [number, number]> = (() => {
  const radius = COASTAL_SEARCH_RADIUS_CELLS;
  const threshold = radius * (radius - 1);
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= threshold) offsets.push([dx, dy]);
    }
  }
  return offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
})();

export function isCoastalSite(world: SettlementWorld, x: number, y: number): boolean {
  let water = 0;
  for (const [dx, dy] of COASTAL_SEARCH_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (isWater(world.heightAt(nx, ny)) && ++water >= COASTAL_MIN_WATER_CELLS) return true;
  }
  return false;
}

export function bandAt(world: SettlementWorld, x: number, y: number): number {
  return drawnBandOfSample(world.heightAt(x, y));
}

function siteMatches(site: SiteRule, coastal: () => boolean): boolean {
  if (site === 'any') return true;
  return coastal() === (site === 'coastal');
}

/** The first category, in file order, whose band range and site hold the anchor cell. */
export function categoryAt(world: SettlementWorld, x: number, y: number): CategoryRule | null {
  const height = world.heightAt(x, y);
  if (isWater(height)) return null;
  const band = drawnBandOfSample(height);
  let coastal: boolean | null = null;
  const isCoastal = (): boolean => (coastal ??= isCoastalSite(world, x, y));
  for (const category of SETTLEMENT_RULES.categories) {
    if (band < category.minBand || band > category.maxBand) continue;
    if (siteMatches(category.site, isCoastal)) return category;
  }
  return null;
}

/**
 * Where a building stands in its category's chain. A building from elsewhere (a saved world,
 * or ground whose category changed) stands at the last step no more complex than it.
 */
export function chainStepOf(category: CategoryRule, kind: number): number {
  const exact = category.chain.indexOf(kind);
  if (exact >= 0) return exact;
  const tier = tierOfKind(kind);
  let step = 0;
  for (let i = 0; i < category.chain.length; i++) {
    if (tierOfKind(category.chain[i]!) <= tier) step = i;
  }
  return step;
}

/** The chain's building for a saved tier: the last step no more complex than it, else the first. */
export function kindForTier(category: CategoryRule, tier: number): number {
  let kind = category.chain[0]!;
  for (const candidate of category.chain) {
    if (tierOfKind(candidate) <= tier) kind = candidate;
  }
  return kind;
}

export function nextKindInChain(category: CategoryRule, kind: number): number | null {
  const next = category.chain[chainStepOf(category, kind) + 1];
  return next ?? null;
}

export function landmarksFor(category: CategoryRule, band: number): LandmarkRule[] {
  const eligible: LandmarkRule[] = [];
  for (const kind of category.landmarks) {
    const rule = SETTLEMENT_RULES.landmarks.get(kind)!;
    if (band >= rule.minBand && band <= rule.maxBand) eligible.push(rule);
  }
  return eligible;
}

export function isLandmarkKind(kind: number): boolean {
  return SETTLEMENT_RULES.landmarks.has(kind);
}
