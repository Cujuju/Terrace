import type { StrokeScriptStep } from '../support/goldenCorpus.ts';
import type { GoldenWorldName } from './worlds.ts';

// Carve and drag lead: both need an exposed face at the clicked band, which a
// stamp or a smooth would have flattened away.

// Settle trails: its cascade is unbounded, so it would relax away every later
// stroke's context.

export const COMMON_SCRIPT_KEY = 'common';

const COMMON: readonly StrokeScriptStep[] = [
  {
    name: 'carve-click-band',
    tool: 'carve',
    spanBand: { fromClick: 0 },
    cx: 14,
    cy: 22,
    radius: 2,
    amount: -16,
  },
  {
    name: 'carve-second-site',
    tool: 'carve',
    spanBand: { fromClick: 0 },
    cx: 24,
    cy: 22,
    radius: 2,
    amount: -16,
  },
  {
    name: 'drag-raise-one-band',
    tool: 'drag',
    targetBand: { fromClick: 1 },
    cx: 20,
    cy: 18,
    radius: 3,
    amount: 16,
  },
  {
    name: 'drag-lower-swept',
    tool: 'drag',
    targetBand: { fromClick: -1 },
    sweepFrom: { x: 28, y: 18 },
    cx: 32,
    cy: 18,
    radius: 3,
    amount: -16,
  },
  {
    name: 'stamp-band-anchored',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'band',
    targetBand: { fromClick: 0 },
    cx: 18,
    cy: 22,
    radius: 3,
    amount: 16,
  },
  {
    name: 'stamp-hard-raise-centre',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 58,
    cy: 48,
    radius: 4,
    amount: 16,
  },
  {
    name: 'stamp-soft-raise',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 12,
    cy: 46,
    radius: 6,
    amount: 16,
  },
  {
    name: 'stamp-soft-lower',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 46,
    cy: 12,
    radius: 5,
    amount: -16,
  },
  {
    name: 'stamp-hard-lower-free',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'free',
    cx: 52,
    cy: 52,
    radius: 3,
    amount: -32,
  },
  {
    name: 'smooth-banded-raise',
    tool: 'smooth',
    spill: 'banded',
    anchor: 'clicked',
    cx: 24,
    cy: 14,
    radius: 5,
    amount: 16,
  },
  {
    name: 'smooth-free-lower',
    tool: 'smooth',
    spill: 'free',
    anchor: 'free',
    cx: 50,
    cy: 45,
    radius: 5,
    amount: -16,
  },
  {
    name: 'edge-stamp-origin-corner',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 0,
    cy: 0,
    radius: 3,
    amount: 16,
  },
  {
    name: 'edge-stamp-far-column',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 63,
    cy: 31,
    radius: 4,
    amount: -16,
  },
  {
    name: 'edge-smooth-left-edge',
    tool: 'smooth',
    spill: 'banded',
    anchor: 'clicked',
    cx: 0,
    cy: 26,
    radius: 5,
    amount: 16,
  },
  {
    name: 'edge-drag-left-edge',
    tool: 'drag',
    targetBand: { fromClick: 1 },
    cx: 0,
    cy: 4,
    radius: 2,
    amount: 16,
  },
  {
    name: 'settle-library-tool',
    tool: 'settle',
    profile: 'soft',
    anchor: 'free',
    cx: 16,
    cy: 50,
    radius: 4,
    amount: 16,
  },
];

// Per-world strokes run first, on pristine terrain, so a world's own feature is
// still there to aim at.

const GENESIS_NOISE: readonly StrokeScriptStep[] = [
  {
    name: 'noise-basin-raise',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 8,
    cy: 56,
    radius: 5,
    amount: 32,
  },
];

const ARCH: readonly StrokeScriptStep[] = [
  {
    name: 'arch-roof-carve',
    tool: 'carve',
    spanBand: { fromClick: 0 },
    cx: 18,
    cy: 32,
    radius: 3,
    amount: -16,
  },
  {
    name: 'arch-rim-drag-up',
    tool: 'drag',
    targetBand: { fromClick: 1 },
    cx: 32,
    cy: 20,
    radius: 2,
    amount: 16,
  },
  {
    name: 'arch-crest-smooth',
    tool: 'smooth',
    spill: 'banded',
    anchor: 'clicked',
    cx: 32,
    cy: 28,
    radius: 6,
    amount: -16,
  },
];

const TERRACE: readonly StrokeScriptStep[] = [
  {
    name: 'min-floor-rim-lower',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 4,
    cy: 32,
    radius: 2,
    amount: -16,
  },
  {
    name: 'max-ceiling-rim-raise',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 59,
    cy: 32,
    radius: 2,
    amount: 16,
  },
  {
    name: 'max-ceiling-lower',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 62,
    cy: 40,
    radius: 3,
    amount: -16,
  },
  {
    name: 'slab-carve',
    tool: 'carve',
    spanBand: { fromClick: 0 },
    cx: 20,
    cy: 32,
    radius: 2,
    amount: -16,
  },
  {
    name: 'min-floor-raise',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 1,
    cy: 8,
    radius: 3,
    amount: 16,
  },
];

const SHORELINE: readonly StrokeScriptStep[] = [
  {
    name: 'waterline-stamp-raise',
    tool: 'stamp',
    profile: 'soft',
    anchor: 'clicked',
    cx: 20,
    cy: 34,
    radius: 3,
    amount: 16,
  },
  {
    name: 'deep-water-lower',
    tool: 'stamp',
    profile: 'hard',
    anchor: 'clicked',
    cx: 2,
    cy: 34,
    radius: 3,
    amount: -16,
  },
  {
    name: 'shore-drag-terrace',
    tool: 'drag',
    targetBand: { fromClick: 1 },
    sweepFrom: { x: 24, y: 42 },
    cx: 28,
    cy: 42,
    radius: 2,
    amount: 16,
  },
];

const PLAYED: readonly StrokeScriptStep[] = [
  {
    name: 'played-carve-under-roof',
    tool: 'carve',
    spanBand: 17,
    cx: 17,
    cy: 9,
    radius: 2,
    amount: -16,
  },
  {
    name: 'played-drag-into-gap',
    tool: 'drag',
    targetBand: 18,
    cx: 17,
    cy: 9,
    radius: 2,
    amount: 16,
  },
  {
    name: 'played-roof-smooth',
    tool: 'smooth',
    spill: 'banded',
    anchor: 'clicked',
    cx: 20,
    cy: 12,
    radius: 5,
    amount: -16,
  },
];

export const STROKE_SCRIPTS: Readonly<
  Record<GoldenWorldName | typeof COMMON_SCRIPT_KEY, readonly StrokeScriptStep[]>
> = {
  [COMMON_SCRIPT_KEY]: COMMON,
  'genesis-noise': GENESIS_NOISE,
  arch: ARCH,
  terrace: TERRACE,
  shoreline: SHORELINE,
  played: PLAYED,
};

export function scriptFor(world: GoldenWorldName): StrokeScriptStep[] {
  return [...STROKE_SCRIPTS[world], ...COMMON];
}
