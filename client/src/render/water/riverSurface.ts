import { bandOf, cellIndex, type Heightmap, type RiverNetwork } from '@terrace/shared';

export interface RiverSurface {
  readonly cells: Int32Array;
  readonly bands: Int16Array;
  readonly sources: Int32Array;
}

export const EMPTY_RIVER_SURFACE: RiverSurface = {
  cells: new Int32Array(0),
  bands: new Int16Array(0),
  sources: new Int32Array(0),
};

export function flattenRiverNetwork(map: Heightmap, network: RiverNetwork): RiverSurface {
  const bandByCell = new Map<number, number>();
  const sources: number[] = [];

  for (const river of network.rivers) {
    const source = river.courses[0]?.points[0];
    if (source !== undefined) sources.push(cellIndex(map, source.x, source.y));
    for (const course of river.courses) {
      for (const point of course.points) {
        const cell = cellIndex(map, point.x, point.y);
        const band = point.pooled ? bandOf(point.poolHeight ?? 0) : bandOf(map.cells[cell]!);
        const existing = bandByCell.get(cell);
        if (existing === undefined || band > existing) bandByCell.set(cell, band);
      }
    }
  }

  const cells = new Int32Array(bandByCell.size);
  const bands = new Int16Array(bandByCell.size);
  let write = 0;
  for (const [cell, band] of bandByCell) {
    cells[write] = cell;
    bands[write] = band;
    write++;
  }
  return { cells, bands, sources: Int32Array.from(sources) };
}
