import { MUDSLIDE_STOPS, type DebrisCell, type MudslideStop } from '../protocol.ts';
import {
  restoreSlides,
  slidesSnapshot,
  type SerializedSlide,
  type Site,
  type SlidesSnapshot,
} from './slides.ts';
import { isFiniteNumber, parseRecordArray } from '@terrace/shared';

export const MUDSLIDES_SLICE_VERSION = 1;

export function saveSlides(): unknown {
  return slidesSnapshot();
}

function parseCell(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if ((x as number) < 0 || (y as number) < 0) return null;
  return { x: x as number, y: y as number };
}

function parseSite(value: unknown): Site | null {
  const cell = parseCell(value);
  if (cell === null) return null;
  const { saturation, cooldownSeconds, freshwater } = value as Record<string, unknown>;
  if (!isFiniteNumber(saturation) || saturation < 0) return null;
  if (!isFiniteNumber(cooldownSeconds) || cooldownSeconds < 0) return null;
  if (typeof freshwater !== 'boolean') return null;
  return { x: cell.x, y: cell.y, saturation, cooldownSeconds, freshwater };
}

function parseDebris(value: unknown): DebrisCell | null {
  const cell = parseCell(value);
  if (cell === null) return null;
  const { depth } = value as Record<string, unknown>;
  if (!isFiniteNumber(depth) || depth <= 0) return null;
  return { x: cell.x, y: cell.y, depth };
}

function parseStop(value: unknown): MudslideStop | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return MUDSLIDE_STOPS.includes(value as MudslideStop) ? (value as MudslideStop) : undefined;
}

function parseSlide(value: unknown): SerializedSlide | null {
  if (typeof value !== 'object' || value === null) return null;
  const {
    id,
    headX,
    headY,
    x,
    y,
    nextX,
    nextY,
    progress,
    sculptTimerSeconds,
    headSteps,
    toeSteps,
    excavated,
    carried,
    gain,
    unmeasuredCells,
    path,
    stop,
    lingerSeconds,
  } = value as Record<string, unknown>;

  if (!Number.isInteger(id)) return null;
  for (const integer of [headX, headY, x, y, nextX, nextY, headSteps, toeSteps, unmeasuredCells]) {
    if (!Number.isInteger(integer)) return null;
  }
  for (const number of [
    progress,
    sculptTimerSeconds,
    excavated,
    carried,
    gain,
    lingerSeconds,
  ]) {
    if (!isFiniteNumber(number) || number < 0) return null;
  }

  const parsedStop = parseStop(stop);
  if (parsedStop === undefined) return null;

  const parsedPath = parseRecordArray(path, parseCell);
  if (parsedPath === null || parsedPath.length === 0) return null;

  return {
    id: id as number,
    headX: headX as number,
    headY: headY as number,
    x: x as number,
    y: y as number,
    nextX: nextX as number,
    nextY: nextY as number,
    progress: progress as number,
    sculptTimerSeconds: sculptTimerSeconds as number,
    headSteps: headSteps as number,
    toeSteps: toeSteps as number,
    excavated: excavated as number,
    carried: carried as number,
    gain: gain as number,
    unmeasuredCells: unmeasuredCells as number,
    path: parsedPath,
    stop: parsedStop,
    lingerSeconds: lingerSeconds as number,
  };
}

export function loadSlides(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const { nextSlideId, rngState, sites, slides, debris } = data as Record<string, unknown>;
  if (!Number.isInteger(nextSlideId) || !Number.isInteger(rngState)) return;
  const parsedSites = parseRecordArray(sites, parseSite);
  if (parsedSites === null) return;

  const parsedSlides = parseRecordArray(slides, parseSlide);
  if (parsedSlides === null) return;

  const parsedDebris = parseRecordArray(debris, parseDebris);
  if (parsedDebris === null) return;

  const snapshot: SlidesSnapshot = {
    nextSlideId: nextSlideId as number,
    rngState: rngState as number,
    sites: parsedSites,
    slides: parsedSlides,
    debris: parsedDebris,
  };
  restoreSlides(snapshot);
}
