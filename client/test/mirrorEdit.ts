import {
  applySculpt,
  setColumn,
  type SculptOptions,
  type Span,
} from '@terrace/shared';
import { refreshRenderCellsAt, type TerrainMirror } from '../src/terrain/mirror.ts';

/** A write to `mirror.map` leaves `renderMap` stale until every changed cell is reported. */
export function setMirrorColumn(
  mirror: TerrainMirror,
  x: number,
  y: number,
  spans: readonly Span[],
): void {
  setColumn(mirror.map, x, y, spans);
  refreshRenderCellsAt(mirror, x, y);
}

export function sculptMirror(
  mirror: TerrainMirror,
  x: number,
  y: number,
  radius: number,
  amount: number,
  options?: SculptOptions,
): void {
  for (const cell of applySculpt(mirror.map, x, y, radius, amount, options)) {
    refreshRenderCellsAt(mirror, cell.x, cell.y);
  }
}
