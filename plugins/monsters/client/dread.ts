import { createSeededRng } from '@terrace/shared';
import {
  CTHULHU_EYE_HEIGHT,
  CTHULHU_LURK_DEPTH,
  CTHULHU_TOTAL_HEIGHT,
  CTHULHU_WIDTH_CELLS,
} from './anatomy.ts';
import {
  KRAKEN_EYE_HEIGHT,
  KRAKEN_LURK_DEPTH,
  KRAKEN_TOTAL_HEIGHT,
  KRAKEN_WIDTH_CELLS,
} from './kraken-anatomy.ts';

const TWO_PI = Math.PI * 2;

export const SILHOUETTE_ABOVE_WATER_CELLS = CTHULHU_TOTAL_HEIGHT - CTHULHU_LURK_DEPTH;

export const EYE_HEIGHT_ABOVE_WATER_CELLS = CTHULHU_EYE_HEIGHT - CTHULHU_LURK_DEPTH;

export const MIST_SPREAD_FOOTPRINTS = 1.2;
export const MIST_RADIUS_CELLS = CTHULHU_WIDTH_CELLS * MIST_SPREAD_FOOTPRINTS;

export const MIST_COLOR = 0x9fb2ad;

export interface MistLayerSpec {
  readonly height: number;
  readonly radiusScale: number;
  readonly opacity: number;
  readonly spinHz: number;
  readonly bobCells: number;
  readonly bobHz: number;
}

export const MIST_LAYERS: readonly MistLayerSpec[] = [
  { height: 0.15, radiusScale: 1, opacity: 0.22, spinHz: 0.02, bobCells: 0.06, bobHz: 0.05 },
  { height: 0.65, radiusScale: 0.85, opacity: 0.16, spinHz: -0.031, bobCells: 0.1, bobHz: 0.037 },
  { height: 1.25, radiusScale: 0.66, opacity: 0.11, spinHz: 0.043, bobCells: 0.14, bobHz: 0.029 },
];

export const MIST_EDGE_WOBBLE = 0.18;
export const MIST_EDGE_LOBES_A = 3;
export const MIST_EDGE_LOBES_B = 5;
export const MIST_EDGE_PHASE_A = 0.7;
export const MIST_EDGE_PHASE_B = 2.3;

export const MIST_EDGE_SOFTNESS = 1.8;

export const MIST_FADE_SECONDS = 2.5;

export const MEAN_FLASH_INTERVAL_SECONDS = 11;

export const MIN_FLASH_INTERVAL_SECONDS = 3;

export const MAX_FLASH_INTERVAL_SECONDS = 40;

export const FLASH_ATTACK_SECONDS = 0.05;
export const FLASH_DURATION_SECONDS = 0.32;

export const FLASH_DECAY_EXPONENT = 2.2;

export const FLASH_COLOR = 0xcfe3ff;

export const FLASH_LIGHT_PEAK_INTENSITY = 420;
export const FLASH_LIGHT_RANGE_CELLS = 60;

export const FLASH_LIGHT_HEIGHT_CELLS = SILHOUETTE_ABOVE_WATER_CELLS + 1.5;

export const BOLT_TOP_CELLS = 14;
export const BOLT_BOTTOM_CELLS = MIST_LAYERS[MIST_LAYERS.length - 1]!.height;

export const BOLT_CLEARANCE_CELLS = 1;
export const BOLT_MIN_RADIUS_CELLS = CTHULHU_WIDTH_CELLS / 2 + BOLT_CLEARANCE_CELLS;
export const BOLT_MAX_RADIUS_CELLS = MIST_RADIUS_CELLS;

export const FLASH_LIGHT_CLEARANCE_CELLS = 1.5;

export interface SwimmerDreadSpec {
  readonly eyeHeightAboveWaterCells: number;
  readonly silhouetteAboveWaterCells: number;
  readonly mistLayers: readonly MistLayerSpec[];
  readonly flashLightHeightCells: number;
  readonly boltMinRadiusCells: number;
  readonly boltBottomCells: number;
}

function scaledMistLayers(eyeHeightAboveWaterCells: number): readonly MistLayerSpec[] {
  const scale = eyeHeightAboveWaterCells / EYE_HEIGHT_ABOVE_WATER_CELLS;
  return MIST_LAYERS.map((layer) => ({
    ...layer,
    height: layer.height * scale,
    bobCells: layer.bobCells * scale,
  }));
}

function swimmerSpec(
  eyeHeight: number,
  lurkDepth: number,
  totalHeight: number,
  widthCells: number,
): SwimmerDreadSpec {
  const eyeAbove = eyeHeight - lurkDepth;
  const layers = scaledMistLayers(eyeAbove);
  return {
    eyeHeightAboveWaterCells: eyeAbove,
    silhouetteAboveWaterCells: totalHeight - lurkDepth,
    mistLayers: layers,
    flashLightHeightCells: totalHeight - lurkDepth + FLASH_LIGHT_CLEARANCE_CELLS,
    boltMinRadiusCells: widthCells / 2 + BOLT_CLEARANCE_CELLS,
    boltBottomCells: layers[layers.length - 1]!.height,
  };
}

export const SWIMMER_DREAD_SPECS: Readonly<Record<'cthulhu' | 'kraken', SwimmerDreadSpec>> = {
  cthulhu: swimmerSpec(
    CTHULHU_EYE_HEIGHT,
    CTHULHU_LURK_DEPTH,
    CTHULHU_TOTAL_HEIGHT,
    CTHULHU_WIDTH_CELLS,
  ),
  kraken: swimmerSpec(
    KRAKEN_EYE_HEIGHT,
    KRAKEN_LURK_DEPTH,
    KRAKEN_TOTAL_HEIGHT,
    KRAKEN_WIDTH_CELLS,
  ),
};

export function dreadSpecOf(kind: string): SwimmerDreadSpec | null {
  return kind === 'cthulhu' || kind === 'kraken' ? SWIMMER_DREAD_SPECS[kind] : null;
}

export const BOLT_WIDTH_CELLS = 0.25;
export const BOLT_TIP_WIDTH_FRACTION = 0.35;
export const BOLT_JAG_CELLS = 0.55;

export const FLASH_GLOW_OPACITY = 0.45;
export const FLASH_GLOW_LAYER_INDEX = 1;

export function approachEnvelope(
  current: number,
  target: number,
  dt: number,
  seconds: number,
): number {
  if (seconds <= 0) return target;
  const step = Math.max(0, dt) / seconds;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return target;
}

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
  const decaying = (since - FLASH_ATTACK_SECONDS) / (FLASH_DURATION_SECONDS - FLASH_ATTACK_SECONDS);
  return Math.pow(1 - decaying, FLASH_DECAY_EXPONENT);
}

export interface Strike {
  readonly bearing: number;
  readonly reach: number;
  readonly yaw: number;
}

export function createStrikeRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}

export class LightningSchedule {
  private readonly random: () => number;
  private untilNext: number;
  private sinceStrike = Number.POSITIVE_INFINITY;

  constructor(random: () => number = createStrikeRandom(Date.now())) {
    this.random = random;
    this.untilNext = nextFlashIntervalSeconds(random());
  }

  advance(dt: number, armed: boolean): Strike | null {
    const step = Math.max(0, dt);
    this.sinceStrike += step;
    if (!armed) return null;
    this.untilNext -= step;
    if (this.untilNext > 0) return null;

    this.untilNext = nextFlashIntervalSeconds(this.random());
    this.sinceStrike = 0;
    return {
      bearing: this.random() * TWO_PI,
      reach: this.random(),
      yaw: this.random() * TWO_PI,
    };
  }

  brightness(): number {
    return flashBrightness(this.sinceStrike);
  }
}
