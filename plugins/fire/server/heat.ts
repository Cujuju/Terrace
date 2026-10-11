import { erlangSample } from '@terrace/shared';

import { fireRandom } from './rng.ts';

export type HeatTargetKey = number | string;

const IGNITION_THRESHOLD_MEAN_HEAT = 1;

export const IGNITION_THRESHOLD_SHAPE = 8;

interface HeatEntry {
  heat: number;
  readonly threshold: number;
  step: number;
}

export class HeatLedger {
  private readonly entries = new Map<HeatTargetKey, HeatEntry>();
  private step = 0;

  absorb(key: HeatTargetKey, ratePerSecond: number, seconds: number): boolean {
    if (!(ratePerSecond > 0) || !(seconds > 0) || !Number.isFinite(seconds)) return false;

    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        heat: 0,
        threshold: erlangSample(fireRandom, IGNITION_THRESHOLD_SHAPE, IGNITION_THRESHOLD_MEAN_HEAT),
        step: this.step,
      };
      this.entries.set(key, entry);
    }

    entry.heat += ratePerSecond * seconds;
    entry.step = this.step;
    return entry.heat >= entry.threshold;
  }

  excessHeat(key: HeatTargetKey): number {
    const entry = this.entries.get(key);
    if (entry === undefined) return 0;
    return Math.max(0, entry.heat - entry.threshold);
  }

  consume(key: HeatTargetKey): void {
    this.entries.delete(key);
  }

  endStep(): void {
    for (const [key, entry] of this.entries) {
      if (entry.step !== this.step) this.entries.delete(key);
    }
    this.step++;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
