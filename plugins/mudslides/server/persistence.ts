// The plugin's persistence slice: the watched sites, the slides in mid-run, the
// debris the client decorates with, and the RNG.
//
// WHY A SLIDE IS PERSISTED. It is the only thing in this repo that MOVES THE
// GROUND on its own, and it does it over several seconds through a sequence of
// sculpts. A restart in the middle of one would leave a scarp with no run-out —
// a hole in the world that nothing would ever fill, because the ledger that owed
// the mass died with the process. Saving the run means the toe still gets built.
//
// WHY THE SITES ARE PERSISTED. Saturation is ninety seconds of weather this world
// has already lived through. Dropping it would mean a server that restarts every
// few minutes can never have a mudslide at all, which is the kind of bug that
// only shows up on somebody else's box.
//
// STRUCTURAL VALIDATION ON LOAD, exactly as every other plugin's slice does: the
// saved blob comes from a database file that may predate this code, so a shape
// that does not parse is DISCARDED WHOLE rather than half-applied.
//
// WHAT DISCARDING COSTS, stated rather than assumed: the world forgets which
// hillsides were wet and abandons any slide in flight — leaving whatever that
// slide had already sculpted, which is saved by CORE and not by this slice, so
// nothing is corrupted; the world just has one scar whose run-out is thinner than
// it should have been. That is cheap enough for this parse to be total.

import { MUDSLIDE_STOPS, type DebrisCell, type MudslideStop } from '../protocol.ts';
import {
  restoreSlides,
  slidesSnapshot,
  type SerializedSlide,
  type Site,
  type SlidesSnapshot,
} from './slides.ts';
import { isFiniteNumber, parseRecordArray } from '@terrace/shared';

/** Bumped when `save`'s shape changes in a way `load` cannot read blind. */
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

  // The stop reason is a closed set on the wire AND here: an unknown string is a
  // slice written by a newer build, and running it would put a slide into a phase
  // this code has no rule for.
  const parsedStop = parseStop(stop);
  if (parsedStop === undefined) return null;

  const parsedPath = parseRecordArray(path, parseCell);
  // An EMPTY path is not a slide: the run is the thing being restored.
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

/**
 * Restores what `save` produced. `fromVersion` is unread: 1 is the only version
 * there has ever been, and the host parks anything higher before this is called
 * (server/src/plugins/slice-envelope.ts).
 */
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
