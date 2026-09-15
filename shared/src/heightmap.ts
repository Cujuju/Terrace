import { MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL, SMOOTH_REACH_CELLS } from './constants.ts';

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
import { cellIndex, type Heightmap } from './grid.ts';
import { diffOf, type CellDiff } from './sculpt/diff.ts';
import { canSpreadBandTo, graspedCeiling, layerSpanIndex } from './sculpt/grasp.ts';
import { anchoredTargetHeight, forEachFootprintCell } from './sculpt/footprint.ts';
import { applyBrush, applyLevelFillBrush, applySoftApron } from './sculpt/stamp.ts';
import { applyDragRegion } from './sculpt/drag.ts';
import { applyCarve } from './sculpt/carve.ts';
import { smooth } from './sculpt/relax.ts';
import type { SpillBand } from './sculpt/layerView.ts';
import {
  FULL_HEIGHT_SPAN,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  LIBRARY_SCULPT_TOOL,
} from './sculpt/options.ts';
import type { SculptOptions } from './sculpt/options.ts';

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

export { sculptReachCells } from './sculpt/reach.ts';

export { smooth } from './sculpt/relax.ts';

export {
  CARVE_BANDS_PER_STROKE,
  FULL_HEIGHT_SPAN,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  LIBRARY_SCULPT_TOOL,
  MAX_BAND,
  MIN_BAND,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  TOOLS_WITHOUT_DIRECTION,
  TOOLS_WITHOUT_EDGE_PROFILE,
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
  const sweepFrom = options?.sweepFrom ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.sweepFrom;

  if (spanBand !== null && spanIndexCoveringBand(map, cx, cy, spanBand) === null) {
    return [];
  }

  if (tool === 'carve') {
    const carveChanged = new Set<number>();
    if (spanBand !== null && amount < 0) {
      applyCarve(map, cx, cy, radius, spanBand, carveChanged);
    }
    return diffOf(map, carveChanged);
  }

  if (tool === 'drag') {
    const dragChanged = new Set<number>();
    if (targetBand !== null && amount !== 0) {
      applyDragRegion(map, cx, cy, radius, amount > 0, targetBand, profile, sweepFrom, dragChanged);
    }
    return diffOf(map, dragChanged);
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
  const anchorTarget = anchoredSmooth
    ? anchoredTargetHeight(map, cx, cy, amount > 0, targetBand, spanBand)
    : 0;
  const softCore = profile === 'soft' && anchor === 'clicked' && tool === 'stamp';
  const skirtCoreTarget = softCore
    ? anchoredTargetHeight(map, cx, cy, strokeAmount > 0, targetBand, spanBand)
    : 0;
  // Smooth never deposits: relaxation alone melts roughness within anchor bounds.
  if (deposits) {
    // A soft clicked stamp keeps the anchor ceiling but moves each cell by
    // the linear falloff: the centre reaches the target, the edge moves
    // partway. Hard stays a flat fill.
    if (profile === 'hard') {
      applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand, spanBand);
    } else {
      applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand, spanBand);
    }
  }
  if (softCore) {
    applySoftApron(map, cx, cy, radius, strokeAmount, skirtCoreTarget, spanBand, changed);
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
      const raising = amount > 0;
      const clickedIndex = cellIndex(map, cx, cy);
      anchorBounds = new Map<number, SpillBand>();
      for (const i of footprint as Set<number>) {
        const k = layerSpanIndex(map, i, spanBand);
        if (k === null) continue;
        const h = graspedCeiling(map, i, k);
        if (raising ? h > anchorTarget : h < anchorTarget) {
          anchorBounds.set(i, { lo: h, hi: h });
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
      tool === 'smooth' ? SMOOTH_REACH_CELLS : null,
    );
  }

  return diffOf(map, changed);
}
