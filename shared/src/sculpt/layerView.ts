import { MAX_HEIGHT } from '../constants.ts';
import { bandLevelHeight } from '../bands.ts';
import {
  highestCeilingUnderSpan,
  moveSpanCeiling,
  spanAt,
  spanCount,
} from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { layerSpanIndex } from './grasp.ts';

export interface SpillBand {
  readonly lo: number;
  readonly hi: number;
}

export type SpillBoundsOf = (index: number) => SpillBand | null;

export interface LayerView {
  readonly heights: Int16Array;
  readonly excluded: Uint8Array;
  readonly spanCaps: ReadonlyMap<number, SpillBand>;
  readonly base: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

export const LAYER_VIEW_SLACK_ROWS = 8;

export function buildLayerView(
  map: Heightmap,
  spanBand: number | null,
  firstRow: number,
  lastRow: number,
  previous: LayerView | null,
): LayerView {
  const base = firstRow * map.size;
  const end = (lastRow + 1) * map.size;
  const heights = map.cells.slice(base, end);
  const excluded = new Uint8Array(end - base);
  const spanCaps = new Map<number, SpillBand>();
  for (const i of map.columnSpans.keys()) {
    if (i < base || i >= end) continue;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) {
      excluded[i - base] = 1;
      continue;
    }
    const span = spanAt(map, x, y, k);
    heights[i - base] = span.ceiling;
    const isTop = k === spanCount(map, x, y) - 1;
    spanCaps.set(i, {
      lo: bandLevelHeight(span.floorBand),
      hi: isTop ? MAX_HEIGHT : highestCeilingUnderSpan(spanAt(map, x, y, k + 1)),
    });
  }
  if (previous !== null) heights.set(previous.heights, previous.base - base);
  return { heights, excluded, spanCaps, base, firstRow, lastRow };
}

export function commitLayerView(map: Heightmap, view: LayerView, spanBand: number | null, changed: ReadonlySet<number>): void {
  for (const i of changed) {
    const v = i - view.base;
    if (v < 0 || v >= view.heights.length) {
      throw new RangeError(`layer view does not cover changed cell ${i}`);
    }
    if (view.excluded[v] === 1) continue;
    if (!map.columnSpans.has(i)) {
      map.cells[i] = view.heights[v]!;
      continue;
    }
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) continue;
    moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, view.heights[v]!);
  }
}
