import { describe, expect, it } from 'vitest';
import {
  BEDROCK_BAND,
  cellIndex,
  columnCoversBand,
  columnSampleAtBand,
  drawnBandOfSample,
  OPEN_COLUMN_SAMPLE,
  spanAt,
  spanCount,
  type Span,
} from '@terrace/shared';
import {
  OVER_BUDGET,
  SPAN_COUNT_SHIFT,
  SPAN_OFFSET_MASK,
  SPAN_PAIR_WORDS,
  extractWindowEntry,
} from '../src/render/gpuMesher/terrainGpuInputs.ts';
import { renderSampleCell } from '../src/terrain/mirror.ts';
import {
  GOLDEN_WORLD_NAMES,
  LATTICE_PER_CHUNK,
  fixtureChunkCount,
  fixtureMirror,
} from './support/mesherFixtures.ts';

/** Bands swept either side of a chunk's own range, so an empty band is checked too. */
const BAND_SWEEP_MARGIN = 2;

interface WindowColumn {
  readonly height: number;
  readonly spans: readonly Span[];
}

/**
 * What the kernel reads out of the uploaded window: `spanFloorBand`,
 * `spanCeiling` and `spanCountOf`, in the same order, off the same words.
 */
function windowColumnAt(
  lattice: Int32Array,
  latticeDesc: Uint32Array,
  spanPairs: Int32Array,
  at: number,
): WindowColumn {
  const desc = latticeDesc[at]!;
  const height = lattice[at]!;
  if (desc === 0) return { height, spans: [{ floorBand: BEDROCK_BAND, ceiling: height }] };
  const count = desc >>> SPAN_COUNT_SHIFT;
  const base = desc & SPAN_OFFSET_MASK;
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) {
    const pair = (base + k) * SPAN_PAIR_WORDS;
    spans.push({ floorBand: spanPairs[pair]!, ceiling: spanPairs[pair + 1]! });
  }
  return { height, spans };
}

/** The kernel's `columnCoversBand`, over the kernel's own input words. */
function windowCoversBand(column: WindowColumn, band: number): boolean {
  for (const span of column.spans) {
    if (span.floorBand <= band && band <= drawnBandOfSample(span.ceiling)) return true;
  }
  return false;
}

/** The kernel's `columnSampleAtBand`, over the kernel's own input words. */
function windowSampleAtBand(column: WindowColumn, band: number): number {
  let below = OPEN_COLUMN_SAMPLE;
  for (const span of column.spans) {
    const capBand = drawnBandOfSample(span.ceiling);
    if (span.floorBand <= band && band <= capBand) return span.ceiling;
    if (capBand < band) below = span.ceiling;
  }
  return below;
}

describe('the GPU mesher window, over the golden fixtures', () => {
  for (const name of GOLDEN_WORLD_NAMES) {
    it(`packs ${name} as [floorBand, ceiling] the kernel reads back unchanged`, () => {
      const mirror = fixtureMirror(name);
      let layeredColumns = 0;
      let compared = 0;
      for (let chunkIdx = 0; chunkIdx < fixtureChunkCount(mirror); chunkIdx++) {
        const entry = extractWindowEntry(mirror, chunkIdx);
        expect(entry).not.toBe(OVER_BUDGET);
        if (entry === OVER_BUDGET) return;
        for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
          for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
            const at = j * LATTICE_PER_CHUNK + i;
            const cell = renderSampleCell(
              mirror,
              entry.originXCells + i,
              entry.originZCells + j,
            );
            const column = windowColumnAt(
              entry.lattice,
              entry.latticeDesc,
              entry.spanPairs,
              at,
            );
            const count = spanCount(mirror.map, cell.x, cell.y);
            expect(column.spans).toHaveLength(count);
            if (count > 1) layeredColumns++;
            for (let k = 0; k < count; k++) {
              expect(column.spans[k]).toEqual(spanAt(mirror.map, cell.x, cell.y, k));
            }
            expect(column.height).toBe(mirror.map.cells[cellIndex(mirror.map, cell.x, cell.y)]);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
      if (name === 'genesis-noise' || name === 'shoreline') expect(layeredColumns).toBe(0);
      else expect(layeredColumns).toBeGreaterThan(0);
    });

    it(`answers ${name}'s band queries the same way shared does`, () => {
      const mirror = fixtureMirror(name);
      let checked = 0;
      for (let chunkIdx = 0; chunkIdx < fixtureChunkCount(mirror); chunkIdx++) {
        const entry = extractWindowEntry(mirror, chunkIdx);
        if (entry === OVER_BUDGET) throw new Error(`chunk ${String(chunkIdx)} is over budget`);
        const lowest = entry.chunkLowestBand - BAND_SWEEP_MARGIN;
        const highest = entry.highestBand + BAND_SWEEP_MARGIN;
        for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
          for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
            const at = j * LATTICE_PER_CHUNK + i;
            const cell = renderSampleCell(mirror, entry.originXCells + i, entry.originZCells + j);
            const column = windowColumnAt(
              entry.lattice,
              entry.latticeDesc,
              entry.spanPairs,
              at,
            );
            for (let band = lowest; band <= highest; band++) {
              expect(windowCoversBand(column, band)).toBe(
                columnCoversBand(mirror.map, cell.x, cell.y, band),
              );
              expect(windowSampleAtBand(column, band)).toBe(
                columnSampleAtBand(mirror.map, cell.x, cell.y, band),
              );
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});
