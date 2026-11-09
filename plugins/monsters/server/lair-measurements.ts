import { HABITAT_BIT_SET } from './habitat-index.ts';
import {
  habitatReachHeightUnits,
  reachesIntoHabitat,
  type HabitatRegime,
  type LairFitRule,
} from './habitat.ts';
import { LairCandidates } from './lair-candidates.ts';

/** Component membership and BFS order stay fixed until connectivity or fit changes. */
export class LairMeasurements {
  readonly region;
  private readonly order: Int32Array;
  private readonly heights: Int32Array;
  private readonly heap: Int32Array;
  private readonly positions: Int32Array;
  private readonly candidates: LairCandidates[];
  private readonly fit: readonly Uint8Array[];
  private readonly rules: readonly LairFitRule[];
  private readonly regime: HabitatRegime;
  private readonly worldSize: number;

  constructor(
    seedIndex: number,
    order: Int32Array,
    heights: Int32Array,
    fit: readonly Uint8Array[],
    rules: readonly LairFitRule[],
    regime: HabitatRegime,
    worldSize: number,
  ) {
    this.fit = fit;
    this.rules = rules;
    this.regime = regime;
    this.worldSize = worldSize;
    this.order = order.slice();
    this.heights = Int32Array.from(order, (cell) => heights[cell]!);
    this.heap = Int32Array.from(order, (_cell, ordinal) => ordinal);
    this.positions = this.heap.slice();
    for (let parent = Math.floor(order.length / 2) - 1; parent >= 0; parent--) this.down(parent);

    const fittingCells: number[] = [];
    this.candidates = rules.map((rule, ruleIndex) => {
      let fitting = 0;
      const qualifies = Uint8Array.from(order, (cell, ordinal) => {
        if (fit[ruleIndex]![cell] !== HABITAT_BIT_SET) return 0;
        fitting++;
        return Number(reachesIntoHabitat(regime, this.heights[ordinal]!, rule.minReachBands));
      });
      fittingCells.push(fitting);
      return new LairCandidates(seedIndex, ruleIndex, qualifies);
    });
    this.region = {
      cells: order.length, x: 0, y: 0, extremeHeight: 0, fittingCells,
      summonableCells: this.candidates.map((sample) => sample.size),
      summonCandidates: this.candidates.map((sample) => sample.cells(this.order)),
    };
    this.refreshExtreme();
  }

  update(ordinal: number, height: number): void {
    const previous = this.heights[ordinal]!;
    if (previous === height) return;
    const cell = this.order[ordinal]!;
    for (let ruleIndex = 0; ruleIndex < this.rules.length; ruleIndex++) {
      if (this.fit[ruleIndex]![cell] !== HABITAT_BIT_SET) continue;
      const rule = this.rules[ruleIndex]!;
      const before = reachesIntoHabitat(this.regime, previous, rule.minReachBands);
      const after = reachesIntoHabitat(this.regime, height, rule.minReachBands);
      if (before === after) continue;
      const sample = this.candidates[ruleIndex]!;
      sample.update(ordinal, after ? 1 : -1);
      this.region.summonableCells[ruleIndex] = sample.size;
      this.region.summonCandidates[ruleIndex] = sample.cells(this.order);
    }
    this.heights[ordinal] = height;
    this.down(this.up(this.positions[ordinal]!));
    this.refreshExtreme();
  }

  private precedes(left: number, right: number): boolean {
    const difference = habitatReachHeightUnits(this.regime, this.heights[left]!) -
      habitatReachHeightUnits(this.regime, this.heights[right]!);
    return difference > 0 || (difference === 0 && left < right);
  }

  private swap(left: number, right: number): void {
    const first = this.heap[left]!;
    const second = this.heap[right]!;
    this.heap[left] = second;
    this.heap[right] = first;
    this.positions[first] = right;
    this.positions[second] = left;
  }

  private up(position: number): number {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!this.precedes(this.heap[position]!, this.heap[parent]!)) break;
      this.swap(position, parent);
      position = parent;
    }
    return position;
  }

  private down(position: number): void {
    while (position * 2 + 1 < this.heap.length) {
      let child = position * 2 + 1;
      if (child + 1 < this.heap.length && this.precedes(this.heap[child + 1]!, this.heap[child]!)) child++;
      if (!this.precedes(this.heap[child]!, this.heap[position]!)) break;
      this.swap(position, child);
      position = child;
    }
  }

  private refreshExtreme(): void {
    const ordinal = this.heap[0]!;
    const cell = this.order[ordinal]!;
    this.region.x = cell % this.worldSize;
    this.region.y = Math.floor(cell / this.worldSize);
    this.region.extremeHeight = this.heights[ordinal]!;
  }
}
