import type { CellDiff } from '@terrace/shared';
import {
  BODY_RIM_PROBE_OFFSETS,
  CELL_CENTRE_OFFSET,
  type HabitatRegime,
  type HabitatRegimeId,
  type LairFitRule,
  type LairWorld,
  habitatRangeOf,
  isHabitatHeight,
} from './habitat.ts';

export const HABITAT_BIT_SET = 1;
const HABITAT_BIT_CLEAR = 0;

const MAX_REPAIR_GENERATION = 0xffffffff;

const FULL_SURVEY_PASSES_PER_CELL = 2;
const REPAIR_TOUCHES_PER_DIRTY_CELL = 5;

export function repairableDirtyCellCap(cellCount: number): number {
  return Math.floor((cellCount * FULL_SURVEY_PASSES_PER_CELL) / REPAIR_TOUCHES_PER_DIRTY_CELL);
}

export interface FitProbe {
  readonly offsets: readonly (readonly [number, number])[];
  readonly windowCells: number;
}

export interface RegimeIndex {
  readonly regime: HabitatRegime;
  readonly rules: readonly LairFitRule[];
  readonly probes: readonly FitProbe[];
  readonly habitat: Uint8Array;
  readonly range: readonly Uint8Array[];
  readonly derivedRanges: readonly { readonly regime: HabitatRegime; readonly bits: Uint8Array }[];
  readonly fit: readonly Uint8Array[];
  readonly dirtyCells: number[];
}

export interface HabitatIndex {
  readonly size: number;
  readonly heights: Int32Array;
  readonly unlocked: Uint8Array;
  readonly regimes: ReadonlyMap<HabitatRegimeId, RegimeIndex>;
  readonly repairStamp: Uint32Array;
  readonly unlockedChunks: Uint8Array | null;
  readonly chunksPerEdge: number;
}

export interface HabitatIndexSpec {
  readonly regime: HabitatRegime;
  readonly fitRules: readonly LairFitRule[];
}

function fitProbeFor(rule: LairFitRule): FitProbe {
  if (rule.radiusCells <= 0) return { offsets: [], windowCells: 0 };

  const offsets = BODY_RIM_PROBE_OFFSETS.map(
    ([ux, uy]) =>
      [
        Math.floor(CELL_CENTRE_OFFSET + ux * rule.radiusCells),
        Math.floor(CELL_CENTRE_OFFSET + uy * rule.radiusCells),
      ] as const,
  );
  let windowCells = 0;
  for (const [dx, dy] of offsets) {
    windowCells = Math.max(windowCells, Math.abs(dx), Math.abs(dy));
  }
  return { offsets, windowCells };
}

function readUnlockedChunks(world: LairWorld): Uint8Array | null {
  const perEdge = world.chunksPerEdge;
  const isChunkUnlocked = world.isChunkUnlocked;
  if (perEdge === undefined || perEdge <= 0 || isChunkUnlocked === undefined) return null;
  const mask = new Uint8Array(perEdge * perEdge);
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      mask[cy * perEdge + cx] = isChunkUnlocked.call(world, cx, cy)
        ? HABITAT_BIT_SET
        : HABITAT_BIT_CLEAR;
    }
  }
  return mask;
}

function habitatBitAt(
  regime: HabitatRegime,
  unlocked: Uint8Array,
  heights: Int32Array,
  index: number,
): number {
  if (unlocked[index] !== HABITAT_BIT_SET) return HABITAT_BIT_CLEAR;
  return isHabitatHeight(regime, heights[index]!) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
}

function recomputeFitBit(
  size: number,
  range: Uint8Array,
  fit: Uint8Array,
  probe: FitProbe,
  x: number,
  y: number,
): boolean {
  const index = y * size + x;
  const before = fit[index];
  let after = HABITAT_BIT_SET;
  if (range[index] !== HABITAT_BIT_SET) {
    after = HABITAT_BIT_CLEAR;
  } else {
    for (const [dx, dy] of probe.offsets) {
      const rimX = x + dx;
      const rimY = y + dy;
      if (rimX < 0 || rimY < 0 || rimX >= size || rimY >= size) {
        after = HABITAT_BIT_CLEAR;
        break;
      }
      if (range[rimY * size + rimX] !== HABITAT_BIT_SET) {
        after = HABITAT_BIT_CLEAR;
        break;
      }
    }
  }
  fit[index] = after;
  return after !== before;
}

export function buildHabitatIndex(
  world: LairWorld,
  specs: readonly HabitatIndexSpec[],
): HabitatIndex {
  const size = world.worldSize;
  const cellCount = size * size;
  const heights = new Int32Array(cellCount);
  const unlocked = new Uint8Array(cellCount);

  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      heights[row + x] = world.heightAt(x, y);
      unlocked[row + x] = world.isCellUnlocked(x, y) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
    }
  }

  const regimes = new Map<HabitatRegimeId, RegimeIndex>();
  for (const { regime, fitRules } of specs) {
    const habitat = new Uint8Array(cellCount);
    for (let index = 0; index < cellCount; index++) {
      habitat[index] = habitatBitAt(regime, unlocked, heights, index);
    }

    const rangeBits = new Map<HabitatRegime, Uint8Array>([[regime, habitat]]);
    const derivedRanges: { regime: HabitatRegime; bits: Uint8Array }[] = [];
    const range = fitRules.map((rule) => {
      const ruleRange = habitatRangeOf(regime, rule.rangeBands);
      const held = rangeBits.get(ruleRange);
      if (held !== undefined) return held;
      const bits = new Uint8Array(cellCount);
      for (let index = 0; index < cellCount; index++) {
        bits[index] = habitatBitAt(ruleRange, unlocked, heights, index);
      }
      rangeBits.set(ruleRange, bits);
      derivedRanges.push({ regime: ruleRange, bits });
      return bits;
    });

    const probes = fitRules.map(fitProbeFor);
    const fit = probes.map((probe, rule) => {
      const bits = new Uint8Array(cellCount);
      const ruleRange = range[rule]!;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          recomputeFitBit(size, ruleRange, bits, probe, x, y);
        }
      }
      return bits;
    });

    regimes.set(regime.id, {
      regime,
      rules: fitRules,
      probes,
      habitat,
      range,
      derivedRanges,
      fit,
      dirtyCells: [],
    });
  }

  const unlockedChunks = readUnlockedChunks(world);
  return {
    size,
    heights,
    unlocked,
    regimes,
    repairStamp: new Uint32Array(cellCount),
    unlockedChunks,
    chunksPerEdge: unlockedChunks === null ? 0 : (world.chunksPerEdge ?? 0),
  };
}

export function indexAnswers(
  index: HabitatIndex,
  world: LairWorld,
  regime: HabitatRegime,
  fitRules: readonly LairFitRule[],
): boolean {
  if (index.size !== world.worldSize) return false;
  const regimeIndex = index.regimes.get(regime.id);
  if (regimeIndex === undefined) return false;
  if (regimeIndex.rules.length !== fitRules.length) return false;
  for (let rule = 0; rule < fitRules.length; rule++) {
    const held = regimeIndex.rules[rule]!;
    const wanted = fitRules[rule]!;
    if (held.radiusCells !== wanted.radiusCells) return false;
    if (held.rangeBands !== wanted.rangeBands) return false;
    if (held.minReachBands !== wanted.minReachBands) return false;
  }
  return true;
}

let live: HabitatIndex | null = null;

let repairGeneration = 0;

export function syncedHabitatIndex(
  world: LairWorld,
  specs: readonly HabitatIndexSpec[],
): HabitatIndex {
  const shapeStale =
    live === null ||
    live.size !== world.worldSize ||
    !specs.every(({ regime, fitRules }) => indexAnswers(live!, world, regime, fitRules));

  if (shapeStale) {
    live = buildHabitatIndex(world, specs);
    return live;
  }

  const held = live!;
  const mask = readUnlockedChunks(world);
  if (mask === null && held.unlockedChunks === null) return held;
  if (mask === null || held.unlockedChunks === null || mask.length !== held.unlockedChunks.length) {
    live = buildHabitatIndex(world, specs);
    return live;
  }

  const opened: number[] = [];
  for (let chunk = 0; chunk < mask.length; chunk++) {
    const now = mask[chunk]!;
    const before = held.unlockedChunks[chunk]!;
    if (now === before) continue;
    if (now !== HABITAT_BIT_SET) {
      live = buildHabitatIndex(world, specs);
      return live;
    }
    opened.push(chunk);
  }

  if (opened.length > 0) applyNewlyUnlockedChunks(held, world, mask, opened);
  return held;
}

function nextRepairGeneration(repairStamp: Uint32Array): number {
  if (repairGeneration >= MAX_REPAIR_GENERATION) {
    repairStamp.fill(0);
    repairGeneration = 0;
  }
  return ++repairGeneration;
}

function markDirtyCell(regimeIndex: RegimeIndex, cellIndex: number, cap: number): void {
  if (regimeIndex.dirtyCells.length <= cap) regimeIndex.dirtyCells.push(cellIndex);
}

function applyNewlyUnlockedChunks(
  index: HabitatIndex,
  world: LairWorld,
  mask: Uint8Array,
  opened: readonly number[],
): void {
  const { size, heights, unlocked, regimes, repairStamp } = index;
  const perEdge = index.chunksPerEdge;
  if (perEdge <= 0) return;
  const chunkCells = size / perEdge;
  const cap = repairableDirtyCellCap(size * size);

  for (const chunk of opened) {
    const cx = chunk % perEdge;
    const cy = (chunk - cx) / perEdge;
    const x0 = cx * chunkCells;
    const y0 = cy * chunkCells;
    for (let y = y0; y < y0 + chunkCells; y++) {
      const row = y * size;
      for (let x = x0; x < x0 + chunkCells; x++) {
        heights[row + x] = world.heightAt(x, y);
        unlocked[row + x] = world.isCellUnlocked(x, y) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
      }
    }
  }

  for (const regimeIndex of regimes.values()) {
    const { regime, habitat, derivedRanges } = regimeIndex;
    for (const chunk of opened) {
      const cx = chunk % perEdge;
      const cy = (chunk - cx) / perEdge;
      const x0 = cx * chunkCells;
      const y0 = cy * chunkCells;
      for (let y = y0; y < y0 + chunkCells; y++) {
        const row = y * size;
        for (let x = x0; x < x0 + chunkCells; x++) {
          const cellIndex = row + x;
          habitat[cellIndex] = habitatBitAt(regime, unlocked, heights, cellIndex);
          for (const derived of derivedRanges) {
            derived.bits[cellIndex] = habitatBitAt(derived.regime, unlocked, heights, cellIndex);
          }
          markDirtyCell(regimeIndex, cellIndex, cap);
        }
      }
    }
  }

  for (const regimeIndex of regimes.values()) {
    for (let rule = 0; rule < regimeIndex.fit.length; rule++) {
      const probe = regimeIndex.probes[rule]!;
      const bits = regimeIndex.fit[rule]!;
      const reach = probe.windowCells;
      const generation = nextRepairGeneration(repairStamp);

      for (const chunk of opened) {
        const cx = chunk % perEdge;
        const cy = (chunk - cx) / perEdge;
        const minX = Math.max(0, cx * chunkCells - reach);
        const maxX = Math.min(size - 1, cx * chunkCells + chunkCells - 1 + reach);
        const minY = Math.max(0, cy * chunkCells - reach);
        const maxY = Math.min(size - 1, cy * chunkCells + chunkCells - 1 + reach);
        for (let centreY = minY; centreY <= maxY; centreY++) {
          const row = centreY * size;
          for (let centreX = minX; centreX <= maxX; centreX++) {
            if (repairStamp[row + centreX] === generation) continue;
            repairStamp[row + centreX] = generation;
            if (recomputeFitBit(size, regimeIndex.range[rule]!, bits, probe, centreX, centreY)) {
              markDirtyCell(regimeIndex, row + centreX, cap);
            }
          }
        }
      }
    }
  }

  index.unlockedChunks?.set(mask);
}

export function noteTerrainChangedInIndex(diff: readonly CellDiff[]): void {
  const index = live;
  if (index === null || diff.length === 0) return;

  const { size, heights, unlocked, regimes, repairStamp } = index;

  for (const cell of diff) {
    const x = cell.x;
    const y = cell.y;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    heights[y * size + x] = cell.h;
  }

  const cap = repairableDirtyCellCap(size * size);
  for (const regimeIndex of regimes.values()) {
    const { regime, habitat, derivedRanges } = regimeIndex;
    for (const cell of diff) {
      const x = cell.x;
      const y = cell.y;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const cellIndex = y * size + x;
      habitat[cellIndex] = habitatBitAt(regime, unlocked, heights, cellIndex);
      for (const derived of derivedRanges) {
        derived.bits[cellIndex] = habitatBitAt(derived.regime, unlocked, heights, cellIndex);
      }
      markDirtyCell(regimeIndex, cellIndex, cap);
    }
  }

  for (const regimeIndex of regimes.values()) {
    for (let rule = 0; rule < regimeIndex.fit.length; rule++) {
      const probe = regimeIndex.probes[rule]!;
      const bits = regimeIndex.fit[rule]!;
      const reach = probe.windowCells;

      const generation = nextRepairGeneration(repairStamp);

      for (const cell of diff) {
        const x = cell.x;
        const y = cell.y;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const minX = Math.max(0, x - reach);
        const maxX = Math.min(size - 1, x + reach);
        const minY = Math.max(0, y - reach);
        const maxY = Math.min(size - 1, y + reach);
        for (let centreY = minY; centreY <= maxY; centreY++) {
          const row = centreY * size;
          for (let centreX = minX; centreX <= maxX; centreX++) {
            if (repairStamp[row + centreX] === generation) continue;
            repairStamp[row + centreX] = generation;
            if (recomputeFitBit(size, regimeIndex.range[rule]!, bits, probe, centreX, centreY)) {
              markDirtyCell(regimeIndex, row + centreX, cap);
            }
          }
        }
      }
    }
  }
}

export function releaseHabitatIndex(): void {
  live = null;
}
