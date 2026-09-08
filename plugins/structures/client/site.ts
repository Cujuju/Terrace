import {
  CELL_WORLD_SIZE,
  CHUNK_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import { BAND_GRID_CELLS } from '../../../client/src/terrain/bandGrid.ts';
import { HARBOUR_INSHORE_BAND_WORLD_UNITS, structureKey } from '../protocol.ts';
import type { GroundLookup } from './placement.ts';
import {
  SKIFF_MAX_PER_SETTLEMENT,
  SKIFF_MOORING_CLEARANCE_WORLD_UNITS,
  SKIFF_MOORING_SPACING_WORLD_UNITS,
} from './skiffs.ts';

export type SiteKind = 'inland' | 'coastal';

export const COASTAL_SEARCH_RADIUS_CELLS = cellsAcross(4);

export const COASTAL_MIN_WATER_CELLS = cellsOverArea(2);

const CONFIRMED_WATER_MAX_WORLD_Y = -1;

const SURVEY_MOORINGS_RETAINED = 2 * SKIFF_MAX_PER_SETTLEMENT;

export const SKIFF_MOORING_CLEARANCE_CELLS = Math.ceil(
  SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE,
);

const SKIFF_MOORING_REACH_CELLS = SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE;

const HARBOUR_INSHORE_BAND_CELLS = HARBOUR_INSHORE_BAND_WORLD_UNITS / CELL_WORLD_SIZE;

export const SKIFF_MOORING_SPACING_CELLS_SQUARED =
  (SKIFF_MOORING_SPACING_WORLD_UNITS / CELL_WORLD_SIZE) ** 2;

const MOORING_SAMPLES_PER_AXIS =
  Math.round((2 * SKIFF_MOORING_CLEARANCE_CELLS) / BAND_GRID_CELLS) + 1;

type MooringVerdict = 'moorable' | 'blocked' | 'undrawn';

function mooringVerdict(drawnAt: GroundLookup, cellX: number, cellY: number): MooringVerdict {
  const origin = -SKIFF_MOORING_CLEARANCE_CELLS;
  let sawUndrawn = false;
  for (let iy = 0; iy < MOORING_SAMPLES_PER_AXIS; iy++) {
    const sampleY = cellY + origin + iy * BAND_GRID_CELLS;
    for (let ix = 0; ix < MOORING_SAMPLES_PER_AXIS; ix++) {
      const sampleX = cellX + origin + ix * BAND_GRID_CELLS;
      const drawn = drawnAt(sampleX, sampleY);
      if (drawn === null) sawUndrawn = true;
      else if (drawn > CONFIRMED_WATER_MAX_WORLD_Y) return 'blocked';
    }
  }
  return sawUndrawn ? 'undrawn' : 'moorable';
}

function buildTightDisc(radius: number): { dx: Int32Array; dy: Int32Array } {
  const threshold = radius * (radius - 1);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  offsets.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
  return {
    dx: Int32Array.from(offsets, (o) => o[0]),
    dy: Int32Array.from(offsets, (o) => o[1]),
  };
}

const COASTAL_SEARCH_OFFSETS = buildTightDisc(COASTAL_SEARCH_RADIUS_CELLS);

export interface SiteSurvey {
  readonly kind: SiteKind;
  readonly pending: boolean;
  readonly moorings: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

export function surveySite(
  groundAt: GroundLookup,
  drawnAt: GroundLookup,
  x: number,
  y: number,
): SiteSurvey {
  const { dx: offsetsX, dy: offsetsY } = COASTAL_SEARCH_OFFSETS;
  const moorings: Array<{ x: number; y: number }> = [];
  let confirmed = 0;
  let unknown = 0;
  let mooringUndrawn = false;
  let shoreCells: number | null = null;
  let mooringsClosed = false;
  const mooringsPending = (): boolean =>
    mooringUndrawn && moorings.length < SURVEY_MOORINGS_RETAINED;

  for (let i = 0; i < offsetsX.length; i++) {
    const cellX = x + offsetsX[i];
    const cellY = y + offsetsY[i];
    const sample = groundAt(cellX, cellY);
    if (sample === null) {
      unknown++;
      continue;
    }
    if (sample > CONFIRMED_WATER_MAX_WORLD_Y) continue;
    confirmed++;
    if (!mooringsClosed) {
      const distance = Math.sqrt(offsetsX[i] * offsetsX[i] + offsetsY[i] * offsetsY[i]);
      if (shoreCells === null) shoreCells = distance;
      if (distance + SKIFF_MOORING_REACH_CELLS > shoreCells + HARBOUR_INSHORE_BAND_CELLS) {
        mooringsClosed = true;
      } else if (
        moorings.every((kept) => {
          const dxk = cellX - kept.x;
          const dyk = cellY - kept.y;
          return dxk * dxk + dyk * dyk >= SKIFF_MOORING_SPACING_CELLS_SQUARED;
        })
      ) {
        const verdict = mooringVerdict(drawnAt, cellX, cellY);
        if (verdict === 'moorable') {
          moorings.push({ x: cellX, y: cellY });
          if (moorings.length >= SURVEY_MOORINGS_RETAINED) mooringsClosed = true;
        } else if (verdict === 'undrawn') mooringUndrawn = true;
      }
    }
    if (confirmed >= COASTAL_MIN_WATER_CELLS && mooringsClosed) {
      return { kind: 'coastal', pending: mooringsPending(), moorings };
    }
  }

  if (confirmed >= COASTAL_MIN_WATER_CELLS) {
    return { kind: 'coastal', pending: mooringsPending(), moorings };
  }
  if (confirmed + unknown < COASTAL_MIN_WATER_CELLS) {
    return { kind: 'inland', pending: false, moorings: [] };
  }
  return { kind: 'inland', pending: true, moorings: [] };
}

const UNCACHEABLE_REVISION = -1;

export type TerrainRevisionLookup = (x: number, y: number) => number;

function buildChunkProbeOffsets(radius: number): readonly number[] {
  const offsets: number[] = [];
  for (let d = -radius; d < radius; d += CHUNK_SIZE) offsets.push(d);
  offsets.push(radius);
  return offsets;
}

const CHUNK_PROBE_OFFSETS = buildChunkProbeOffsets(COASTAL_SEARCH_RADIUS_CELLS);

function neighbourhoodRevision(revisionAt: TerrainRevisionLookup, x: number, y: number): number {
  let sum = 0;
  for (const dy of CHUNK_PROBE_OFFSETS) {
    for (const dx of CHUNK_PROBE_OFFSETS) sum += revisionAt(x + dx, y + dy);
  }
  return sum;
}

interface CachedSurvey {
  revision: number;
  survey: SiteSurvey;
  pass: number;
}

export interface SiteSurveyCache {
  beginPass(): void;
  surveyAt(
    groundAt: GroundLookup,
    drawnAt: GroundLookup,
    x: number,
    y: number,
  ): SiteSurvey;
  endPass(): void;
  clear(): void;
  size(): number;
}

export function createSiteSurveyCache(revisionAt: TerrainRevisionLookup): SiteSurveyCache {
  const entries = new Map<number, CachedSurvey>();
  let pass = 0;

  return {
    beginPass(): void {
      pass++;
    },

    surveyAt(groundAt: GroundLookup, drawnAt: GroundLookup, x: number, y: number): SiteSurvey {
      const key = structureKey(x, y);
      const revision = neighbourhoodRevision(revisionAt, x, y);
      const cached = entries.get(key);
      if (cached !== undefined && cached.revision === revision) {
        cached.pass = pass;
        return cached.survey;
      }
      const survey = surveySite(groundAt, drawnAt, x, y);
      if (survey.pending) {
        if (cached !== undefined) {
          cached.revision = UNCACHEABLE_REVISION;
          cached.survey = survey;
          cached.pass = pass;
        } else {
          entries.set(key, { revision: UNCACHEABLE_REVISION, survey, pass });
        }
        return survey;
      }
      if (cached === undefined) entries.set(key, { revision, survey, pass });
      else {
        cached.revision = revision;
        cached.survey = survey;
        cached.pass = pass;
      }
      return survey;
    },

    endPass(): void {
      for (const [key, entry] of entries) if (entry.pass !== pass) entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}
