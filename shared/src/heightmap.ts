import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL } from './constants.ts';

export {
  bandOf,
  cellIndex,
  cellX,
  cellY,
  chebyshevDistance,
  createHeightmap,
  forEachLineCell,
  inBounds,
  quantizeToBand,
  type Heightmap,
} from './grid.ts';

import { spanIndexCoveringBand } from './columns.ts';
import { cellIndex, cellX, cellY, type Heightmap } from './grid.ts';
import { diffOf, type CellDiff } from './sculpt/diff.ts';
import { canSpreadBandTo, graspedCeiling, layerSpanIndex } from './sculpt/grasp.ts';
import { anchoredTargetHeight, assertBrushArgs, forEachFootprintCell } from './sculpt/footprint.ts';
import {
  applyBrush,
  applyLevelFillBrush,
  stampEdgeShape,
} from './sculpt/stamp.ts';
import { writeWithEdges } from './sculpt/edges.ts';
import { applyDragRegion, dragEdgeShape } from './sculpt/drag.ts';
import { applyCarve } from './sculpt/carve.ts';
import { applyMound, moundEdgeShape } from './sculpt/mound.ts';
import { applyNudge } from './sculpt/nudge.ts';
import { applyOutlineSmooth } from './sculpt/outlineSmooth.ts';
export { carveAdmittedCells } from './sculpt/carve.ts';
import { smooth } from './sculpt/relax.ts';
import { smoothCascadeReachCells } from './sculpt/reach.ts';
import type { SpillBand } from './sculpt/layerView.ts';
import {
  FULL_HEIGHT_SPAN,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  NUDGE_STRENGTH_DEFAULT,
  NUDGE_STRENGTH_MAX,
  NUDGE_STRENGTH_MIN,
  SMOOTH_KINK_HALF_CELLS_DEFAULT,
  SMOOTH_KINK_HALF_CELLS_MAX,
  SMOOTH_KINK_HALF_CELLS_MIN,
  LIBRARY_SCULPT_TOOL,
  SMOOTH_FEATHER_DEFAULT,
  SMOOTH_FEATHER_MAX,
  SMOOTH_FEATHER_MIN,
  SMOOTH_KERNELS,
  SMOOTH_KERNEL_DEFAULT,
  SMOOTH_LAMBDA_DEFAULT,
  SMOOTH_RIM_DEFAULT,
  SMOOTH_RIM_MAX,
  SMOOTH_RIM_MIN,
  SMOOTH_LAMBDA_MAX,
  SMOOTH_LAMBDA_MIN,
} from './sculpt/options.ts';
import type { SculptOptions, SmoothKernel } from './sculpt/options.ts';

export type { CellDiff } from './sculpt/diff.ts';

export { canSpreadBandTo } from './sculpt/grasp.ts';

export { forEachFootprintOffset } from './sculpt/footprint.ts';

export {
  applyBrush,
  applyLevelFillBrush,
  sculptSweepRadius,
  softApronBandDrop,
  softApronReachCells,
} from './sculpt/stamp.ts';

export { sculptDisplacementUnits } from './sculpt/price.ts';

export { sculptReachCells, smoothCascadeReachCells } from './sculpt/reach.ts';

export { smooth } from './sculpt/relax.ts';

export {
  CARVE_DEFAULT_DEPTH_BANDS,
  CARVE_MAX_DEPTH_BANDS,
  CARVE_MIN_DEPTH_BANDS,
  FULL_HEIGHT_SPAN,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  LIBRARY_SCULPT_TOOL,
  LOWEST_CARVEABLE_BAND,
  MAX_BAND,
  MIN_BAND,
  NUDGE_STRENGTH_DEFAULT,
  NUDGE_STRENGTH_MAX,
  NUDGE_STRENGTH_MIN,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  SMOOTH_KINK_HALF_CELLS_DEFAULT,
  SMOOTH_KINK_HALF_CELLS_MAX,
  SMOOTH_KINK_HALF_CELLS_MIN,
  SMOOTH_FEATHER_DEFAULT,
  SMOOTH_FEATHER_MAX,
  SMOOTH_FEATHER_MIN,
  SMOOTH_KERNELS,
  SMOOTH_KERNEL_DEFAULT,
  SMOOTH_LAMBDA_DEFAULT,
  SMOOTH_RIM_DEFAULT,
  SMOOTH_RIM_MAX,
  SMOOTH_RIM_MIN,
  SMOOTH_LAMBDA_MAX,
  SMOOTH_LAMBDA_MIN,
  TOOLS_WITHOUT_DIRECTION,
  TOOLS_WITHOUT_EDGE_PROFILE,
  isValidCarveDepth,
} from './sculpt/options.ts';

export type {
  LibrarySculptTool,
  ResolvedSculptOptions,
  SculptAnchor,
  SculptOperation,
  SculptOptions,
  SculptProfile,
  SculptSpill,
  SculptTool,
  SmoothKernel,
  SweepOrigin,
} from './sculpt/options.ts';

export function heightAt(map: Heightmap, x: number, y: number): number {
  return map.cells[cellIndex(map, x, y)];
}

export function isWater(h: number): boolean {
  return h <= SEA_LEVEL;
}

export function applySculpt(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  options?: SculptOptions,
): CellDiff[] {
  const tool = options?.tool ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.tool;
  const profile = options?.profile ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.profile;
  const spill = options?.spill ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spill;
  const anchor = options?.anchor ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor;
  const targetBand = options?.targetBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand;
  const spanBand = options?.spanBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand;
  const depthBands = options?.depthBands ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.depthBands;
  const sweepFrom = options?.sweepFrom ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.sweepFrom;
  const smoothLambda = Math.min(
    SMOOTH_LAMBDA_MAX,
    Math.max(SMOOTH_LAMBDA_MIN, options?.smoothLambda ?? SMOOTH_LAMBDA_DEFAULT),
  );
  const smoothFeather = Math.min(
    SMOOTH_FEATHER_MAX,
    Math.max(SMOOTH_FEATHER_MIN, options?.smoothFeather ?? SMOOTH_FEATHER_DEFAULT),
  );
  const smoothRim = Math.min(
    SMOOTH_RIM_MAX,
    Math.max(SMOOTH_RIM_MIN, options?.smoothRim ?? SMOOTH_RIM_DEFAULT),
  );
  const smoothKernel: SmoothKernel = SMOOTH_KERNELS.includes(options?.smoothKernel ?? SMOOTH_KERNEL_DEFAULT)
    ? (options?.smoothKernel ?? SMOOTH_KERNEL_DEFAULT)
    : SMOOTH_KERNEL_DEFAULT;
  const smoothBilateral = options?.smoothBilateral ?? false;
  const smoothFullSteps = options?.smoothFullSteps ?? false;
  const smoothCooldown = options?.smoothCooldown ?? false;
  const smoothUnbiased = options?.smoothUnbiased ?? false;

  if (spanBand !== null && spanIndexCoveringBand(map, cx, cy, spanBand) === null) {
    return [];
  }

  if (tool === 'carve') {
    const carveChanged = new Set<number>();
    if (spanBand !== null && amount < 0) {
      applyCarve(map, cx, cy, radius, spanBand, depthBands, carveChanged);
    }
    return diffOf(map, carveChanged);
  }

  if (tool === 'drag') {
    const dragChanged = new Set<number>();
    if (targetBand !== null && amount !== 0) {
      // No grabbed column named a run, so the slab is the target band alone.
      const runFloorBand =
        options?.runFloorBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.runFloorBand ?? targetBand;
      const dragAlt = options?.dragAlt ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.dragAlt;
      const shape = dragEdgeShape(cx, cy, radius, amount > 0, targetBand, sweepFrom);
      writeWithEdges(map, shape, dragChanged, () => {
        applyDragRegion(
          map,
          cx,
          cy,
          radius,
          amount > 0,
          targetBand,
          runFloorBand > targetBand ? targetBand : runFloorBand,
          profile,
          sweepFrom,
          dragChanged,
          dragAlt,
        );
      });
    }
    return diffOf(map, dragChanged);
  }

  if (tool === 'smooth' && anchor !== 'free') {
    const smoothed = new Set<number>();
    const kinkHalfCells = Math.min(
      SMOOTH_KINK_HALF_CELLS_MAX,
      Math.max(SMOOTH_KINK_HALF_CELLS_MIN, options?.smoothKinkHalfCells ?? SMOOTH_KINK_HALF_CELLS_DEFAULT),
    );
    applyOutlineSmooth(map, cx, cy, radius, kinkHalfCells, options?.smoothWalls ?? false, spanBand, smoothed);
    return diffOf(map, smoothed);
  }

  if (tool === 'nudge') {
    const nudged = new Set<number>();
    const strength = Math.min(
      NUDGE_STRENGTH_MAX,
      Math.max(NUDGE_STRENGTH_MIN, options?.nudgeStrength ?? NUDGE_STRENGTH_DEFAULT),
    );
    // HUD way spreads bands apart; the other way draws them together.
    if (amount !== 0) applyNudge(map, cx, cy, radius, amount > 0, strength, spanBand, nudged);
    return diffOf(map, nudged);
  }

  if (tool === 'stamp' && anchor === 'clicked') {
    const built = new Set<number>();
    if (amount !== 0) {
      const raising = amount > 0;
      writeWithEdges(map, moundEdgeShape(cx, cy, radius, profile, raising, spanBand), built, () =>
        applyMound(map, cx, cy, radius, raising, profile, spanBand, built),
      );
    }
    return diffOf(map, built);
  }

  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return [];
  }

  const strokeAmount =
    anchor === 'band' && amount !== 0
      ? (amount > 0 ? FULL_HEIGHT_SPAN : -FULL_HEIGHT_SPAN)
      : amount;

  const changed = new Set<number>();
  // 'smooth' relaxes only; 'settle' deposits first and then relaxes.
  const relaxes = tool === 'smooth' || tool === LIBRARY_SCULPT_TOOL;
  const deposits = tool === 'stamp' || tool === LIBRARY_SCULPT_TOOL;
  const anchoredSmooth = relaxes && anchor !== 'free' && amount !== 0;
  // Anchored smooth returned above, so the stroke direction reads straight.
  const meltRaising = amount > 0;
  const anchorTarget = anchoredSmooth
    ? anchoredTargetHeight(map, cx, cy, meltRaising, targetBand, spanBand)
    : 0;
  // Settle's relaxation grades only what its deposit adds, so it needs the ground before it.
  const settles = tool === LIBRARY_SCULPT_TOOL && !anchoredSmooth;
  if (settles) assertBrushArgs(map, cx, cy, radius, strokeAmount);
  const beforeDeposit = settles ? footprintHeights(map, cx, cy, radius) : null;
  // Smooth never deposits: relaxation alone melts roughness within anchor bounds.
  if (deposits) {
    const levels = profile !== 'soft';
    const deposit = (): void => {
      // Radius names the disc under every profile: a clicked disc moves every
      // cell one band, and a skirt hangs outside that edge.
      if (levels) {
        applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand, spanBand);
      } else {
        applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand, spanBand);
      }
    };
    if (tool === 'stamp' && levels) {
      const shape = stampEdgeShape(cx, cy, radius, null, strokeAmount > 0, spanBand);
      writeWithEdges(map, shape, changed, deposit);
    } else {
      deposit();
    }
  }
  if (relaxes) {
    let footprint: Set<number> | undefined;
    if (changed.size === 0 || spill === 'banded' || anchoredSmooth) {
      const cells = new Set<number>();
      forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
      footprint = cells;
    }
    let anchorBounds: Map<number, SpillBand> | undefined;
    if (anchoredSmooth) {
      const raising = meltRaising;
      const clickedIndex = cellIndex(map, cx, cy);
      // The click pin guards a deposit; pure smooth deposits nothing.
      const pinCenter = changed.size > 0;
      anchorBounds = new Map<number, SpillBand>();
      for (const i of footprint as Set<number>) {
        const k = layerSpanIndex(map, i, spanBand);
        if (k === null) continue;
        const h = graspedCeiling(map, i, k);
        if (raising ? h > anchorTarget : h < anchorTarget) {
          anchorBounds.set(i, { lo: h, hi: h });
        } else if (!pinCenter) {
          // Symmetric window, both ends: an independent kernel with any
          // unbounded side deletes hillsides, so each cell moves about a
          // band per stroke while the target side still directs it.
          anchorBounds.set(
            i,
            raising
              ? { lo: Math.max(MIN_HEIGHT, h - BAND_HEIGHT), hi: Math.min(anchorTarget, h + BAND_HEIGHT) }
              : { lo: Math.max(anchorTarget, h - BAND_HEIGHT), hi: Math.min(MAX_HEIGHT, h + BAND_HEIGHT) },
          );
        } else {
          anchorBounds.set(
            i,
            raising
              ? { lo: i === clickedIndex ? h : MIN_HEIGHT, hi: anchorTarget }
              : { lo: anchorTarget, hi: i === clickedIndex ? h : MAX_HEIGHT },
          );
        }
      }
    }
    smooth(
      map,
      changed,
      changed.size === 0 ? footprint : undefined,
      spill === 'banded' ? footprint : undefined,
      anchorBounds,
      spanBand,
      // settle keeps the unbounded cascade its plugin cones were tuned against.
      tool === 'smooth' ? smoothCascadeReachCells(radius) : null,
      // Laplacian is the player melt only: free smooth keeps exact exchange.
      anchoredSmooth ? smoothLambda : null,
      // Rim shaping is a player-smooth option: settle and free smooth keep
      // their untapered passes and full band clamps.
      anchoredSmooth && (smoothFeather > 0 || smoothRim > 0)
        ? { cx, cy, reach: smoothCascadeReachCells(radius), feather: smoothFeather, rim: smoothRim }
        : null,
      smoothKernel,
      smoothBilateral,
      smoothFullSteps,
      smoothCooldown,
      smoothUnbiased,
      beforeDeposit === null ? null : depositedFrom(map, beforeDeposit, changed),
    );
  }

  return diffOf(map, changed);
}

interface FootprintHeights {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly heights: Int16Array;
}

/** Heights of the square the brush can write, before it writes. */
function footprintHeights(map: Heightmap, cx: number, cy: number, radius: number): FootprintHeights {
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const x1 = Math.min(map.size - 1, cx + radius);
  const y1 = Math.min(map.size - 1, cy + radius);
  const width = x1 - x0 + 1;
  const heights = new Int16Array(width * (y1 - y0 + 1));
  for (let y = y0; y <= y1; y++) heights.set(map.cells.subarray(y * map.size + x0, y * map.size + x1 + 1), (y - y0) * width);
  return { x0, y0, width, heights };
}

/** Each deposited cell's height before the deposit. */
function depositedFrom(map: Heightmap, before: FootprintHeights, changed: ReadonlySet<number>): Map<number, number> {
  const deposited = new Map<number, number>();
  const rows = before.heights.length / before.width;
  for (const i of changed) {
    const gx = cellX(map.size, i) - before.x0;
    const gy = cellY(map.size, i) - before.y0;
    if (gx < 0 || gy < 0 || gx >= before.width || gy >= rows) continue;
    deposited.set(i, before.heights[gy * before.width + gx]!);
  }
  return deposited;
}
