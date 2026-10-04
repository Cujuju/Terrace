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

/** Every carve price, nominal or charge, takes the discount. */
function carveDiscounted(cost: number, tool: SculptTool): number {
  return tool === 'carve' ? Math.ceil(cost / CARVE_PRICE_DIVISOR) : cost;
}

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
  return carveDiscounted(base, tool);
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
export function displacementManaCost(
  displacementUnits: number,
  manaPerBandCell: number,
  tool: SculptTool,
): number {
  return carveDiscounted(Math.ceil((manaPerBandCell * displacementUnits) / BAND_HEIGHT), tool);
}

/** The nominal stroke half of a price, from the intent alone. */
export function nominalStrokeCost(manaPerBandCell: number, intent: SculptIntent): number {
  const options = sculptOptionsOf(intent);
  return sculptSweepManaCost(
    manaPerBandCell,
    strokeSweep(intent),
    options.profile,
    options.tool,
    options.depthBands,
  );
}

/**
 * The stroke half of a charge: what the stroke moved, capped at its nominal. A
 * mound stamp can move more than the nominal it was admitted against.
 */
export function strokeChargeCost(
  displacementUnits: number,
  manaPerBandCell: number,
  intent: SculptIntent,
): number {
  const moved = displacementManaCost(displacementUnits, manaPerBandCell, sculptOptionsOf(intent).tool);
  return Math.min(moved, nominalStrokeCost(manaPerBandCell, intent));
}

/**
 * The price a stroke is admitted against, from the intent alone: the diff the
 * charge measures does not exist yet. The charge never exceeds it.
 */
export function sculptIntentCost(
  manaPerBandCell: number,
  intent: SculptIntent,
  openedChunks: number,
): number {
  return nominalStrokeCost(manaPerBandCell, intent) + chunkUnlockFee(openedChunks);
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
