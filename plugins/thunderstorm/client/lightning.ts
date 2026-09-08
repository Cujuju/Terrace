import { WORLD_UNITS_PER_BAND, createSeededRng } from '@terrace/shared';
import { CLOUD_BASE_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';

export const MEAN_FLASH_INTERVAL_SECONDS = 9;

export const MIN_FLASH_INTERVAL_SECONDS = 3;

export const MAX_FLASH_INTERVAL_SECONDS = 45;

export const FLASH_ATTACK_SECONDS = 0.05;
export const FLASH_DURATION_SECONDS = 0.32;

export const FLASH_DECAY_EXPONENT = 2.2;

export const FLASH_COLOR = 0xcfe3ff;

export const FLASH_LIGHT_PEAK_INTENSITY = 520;
export const FLASH_LIGHT_RANGE_CELLS = 90;

export const BOLT_TOP_WORLD_Y = CLOUD_BASE_WORLD_Y;
export const BOLT_BOTTOM_WORLD_Y = 2 * WORLD_UNITS_PER_BAND;

export const BOLT_MAX_REACH_FRACTION = 0.85;

export const BOLT_WIDTH_WORLD_UNITS = 0.33;
export const BOLT_TIP_WIDTH_FRACTION = 0.35;
export const BOLT_JAG_WORLD_UNITS = 0.9;

export const FLASH_GLOW_OPACITY = 0.45;

export function nextFlashIntervalSeconds(uniform: number): number {
  const u = Math.min(Math.max(uniform, 0), 1 - Number.EPSILON);
  const interval = -Math.log(1 - u) * MEAN_FLASH_INTERVAL_SECONDS;
  if (interval < MIN_FLASH_INTERVAL_SECONDS) return MIN_FLASH_INTERVAL_SECONDS;
  if (interval > MAX_FLASH_INTERVAL_SECONDS) return MAX_FLASH_INTERVAL_SECONDS;
  return interval;
}

export function flashBrightness(since: number): number {
  if (!(since >= 0) || since >= FLASH_DURATION_SECONDS) return 0;
  if (since < FLASH_ATTACK_SECONDS) return since / FLASH_ATTACK_SECONDS;
  const decaying =
    (since - FLASH_ATTACK_SECONDS) / (FLASH_DURATION_SECONDS - FLASH_ATTACK_SECONDS);
  return Math.pow(1 - decaying, FLASH_DECAY_EXPONENT);
}

export interface Flash {
  readonly bearing: number;
  readonly reach: number;
  readonly yaw: number;
}

export function createFlashRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}

export class LightningGovernor {
  private sinceLastFlash = Number.POSITIVE_INFINITY;

  advance(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.sinceLastFlash += dt;
  }

  requestFlash(): boolean {
    if (this.sinceLastFlash < MIN_FLASH_INTERVAL_SECONDS) return false;
    this.sinceLastFlash = 0;
    return true;
  }

  secondsSinceLastFlash(): number {
    return this.sinceLastFlash;
  }

  reset(): void {
    this.sinceLastFlash = Number.POSITIVE_INFINITY;
  }
}

export class LightningSchedule {
  private sinceFlash = Number.POSITIVE_INFINITY;

  advance(dt: number): void {
    this.sinceFlash += Math.max(0, dt);
  }

  strike(governor: LightningGovernor): boolean {
    if (!governor.requestFlash()) return false;
    this.sinceFlash = 0;
    return true;
  }

  brightness(): number {
    return flashBrightness(this.sinceFlash);
  }

  reset(): void {
    this.sinceFlash = Number.POSITIVE_INFINITY;
  }
}
