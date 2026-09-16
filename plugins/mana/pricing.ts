import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  chunksPerEdge,
  chunksWithinSweep,
  pressDisplacementUnits,
  revealReachCells,
  sculptDisplacementUnits,
  sculptOptionsOf,
  strokeSweep,
  sweepAt,
  sweptCellCount,
} from '@terrace/shared';
import type {
  SculptIntent,
  SculptProfile,
  SculptTool,
  StrokeSweep,
} from '@terrace/shared';

/** A disc costs the same wherever it lands, so a quote with no cell uses this one. */
const QUOTE_CELL = 0;

/** A carve reshapes rock that is already there, so it pays a quarter. */
const CARVE_PRICE_DIVISOR = 4;

/** A drag presses every cell its capsule sweeps; every other tool its disc. */
function sweptDisplacementUnits(
  sweep: StrokeSweep,
  profile: SculptProfile,
  tool: SculptTool,
  depthBands: number,
): number {
  return tool === 'drag'
    ? pressDisplacementUnits(sweptCellCount(sweep))
    : sculptDisplacementUnits(sweep.radius, tool, profile, depthBands);
}

export function sculptSweepManaCost(
  manaPerBandCell: number,
  sweep: StrokeSweep,
  profile: SculptProfile,
  tool: SculptTool,
  depthBands: number,
): number {
  const base = Math.ceil(
    (manaPerBandCell * sweptDisplacementUnits(sweep, profile, tool, depthBands)) / BAND_HEIGHT,
  );
  return tool === 'carve' ? Math.ceil(base / CARVE_PRICE_DIVISOR) : base;
}

export function sculptManaCost(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  depthBands: number,
): number {
  return sculptSweepManaCost(
    manaPerBandCell,
    sweepAt(QUOTE_CELL, QUOTE_CELL, radius),
    profile,
    tool,
    depthBands,
  );
}

/**
 * Flat and perk-free: one chunk of frontier costs what a radius-2 hard stamp
 * costs, about 2% of raising that chunk's cells one band. Retune here.
 */
export const CHUNK_UNLOCK_MANA = 2;

/** The unlock half of a price: what the frontier a stroke opens costs. */
export function chunkUnlockFee(openedChunks: number): number {
  return openedChunks * CHUNK_UNLOCK_MANA;
}

/** What the material a stroke moved costs. The charge half of every price. */
export function displacementManaCost(displacementUnits: number, manaPerBandCell: number): number {
  return Math.ceil((manaPerBandCell * displacementUnits) / BAND_HEIGHT);
}

/**
 * What a stroke could cost at worst, from the intent alone. Admission asks
 * this, because the diff the charge measures does not exist yet.
 */
export function sculptIntentCost(
  manaPerBandCell: number,
  intent: SculptIntent,
  openedChunks: number,
): number {
  const options = sculptOptionsOf(intent);
  const stroke = sculptSweepManaCost(
    manaPerBandCell,
    strokeSweep(intent),
    options.profile,
    options.tool,
    options.depthBands,
  );
  return stroke + chunkUnlockFee(openedChunks);
}

export function openedChunkCount(
  worldSize: number,
  sweep: StrokeSweep,
  isOpen: (cx: number, cy: number) => boolean,
): number {
  const cols = chunksPerEdge(worldSize);
  let opened = 0;
  for (const index of chunksWithinSweep(worldSize, sweep, revealReachCells(sweep.radius))) {
    if (!isOpen(index % cols, Math.floor(index / cols))) opened++;
  }
  return opened;
}

export function chunkOriginCell(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE };
}
