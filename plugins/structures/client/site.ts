// site.ts — CARD 33 "Fishing Villages": deciding a settlement's SITE, the
// first divergence of the tier ladder by WHERE a structure stands rather
// than how long it has survived. tiers.ts and life.ts (server-side, the CA
// and the age/neighbour tier schedule) are UNTOUCHED by this card: a coastal
// structure is founded, ages and upgrades on exactly the same schedule as an
// inland one. Site only ever changes which MODEL a tier renders as — see
// models.ts's SITE_TOP_TIER_VARIANTS, the one place that fact is consumed.
//
// CLIENT-ONLY, exactly durands.ts's shape: no wire message, no server-side
// concept of "site" exists anywhere in this plugin.
//
// WHY CLIENT-ONLY, NOT A NEW FIELD ON THE WIRE. The server already
// classifies an equally terrain-derived fact for buildability
// (suitability.ts's isFlatEnough), so putting "coastal" there too and
// broadcasting it would be a small, legitimate option — but it would spend
// bandwidth on a fact this client can derive itself from terrain it already
// receives for placement (placement.ts's GroundLookup), the same reasoning
// that already keeps a settlement's RACE (protocol.ts's settlementRace) off
// the wire, extended from a position hash to a terrain read. Nothing here
// affects gameplay (the CA, tiers, persistence, anti-cheat are all
// unreachable from this file), so there is no authority to protect by moving
// it server-side.
//
// WHY A "CONFIRMED WATER" TEST BASED ON THE RENDERED BAND, NOT RAW HEIGHT.
// This client has no raw-height accessor: ClientPluginCtx.terrainHeightAt
// (client/src/plugins/types.ts) returns the band-QUANTISED render Y, never
// the raw Int16 height core stores. Band 0 (world Y 0) straddles the sea
// level line: `bandOf` floors raw height by BAND_HEIGHT, so band 0 covers
// raw heights [0, BAND_HEIGHT) — water at exactly h = 0, dry land at every
// other height in that range — and this client cannot tell those two apart
// from the rendered Y alone. Band -1 and below (world Y <= -1), by contrast,
// is UNAMBIGUOUS: it covers raw heights [-BAND_HEIGHT, -1], entirely at or
// below SEA_LEVEL (0), i.e. always water (`isWater`, @terrace/shared). This
// module therefore only ever counts a cell as "confirmed water" once its
// rendered Y drops to -1 or lower — never at exactly 0 — which is a
// systematic UNDER-count of true water (a handful of genuine sea-level cells
// are never counted) and never an OVER-count. That is the safe direction to
// be wrong in for skiffs.ts, which anchors boats only on cells this module
// confirms: better to occasionally miss a paper-thin waterline cell than to
// ever float a boat on grass.

import {
  CHUNK_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import { structureKey } from '../protocol.ts';
import type { GroundLookup } from './placement.ts';
import { SKIFF_MAX_PER_SETTLEMENT } from './skiffs.ts';

/**
 * Every site a settlement's location can qualify as. 'inland' is the
 * fallback every cell defaults to; every OTHER kind is a positive claim
 * about a cell's surroundings. Adding a third kind (e.g. 'highland') means:
 * extend this union, give it its own predicate (mirroring testCoastal
 * below), and add a matching entry to models.ts's SITE_TOP_TIER_VARIANTS —
 * nothing else in this plugin's client half ever branches on a site kind by
 * name; every consumer keys a lookup table off this type instead.
 */
export type SiteKind = 'inland' | 'coastal';

/**
 * How far out a structure looks for open water, in cells — four WORLD UNITS,
 * converted, because it is "a short walk from the doorstep" and a walk is
 * measured across the ground.
 *
 * 4 — reusing the project's own "tight integer disc" footprint convention
 * (docs/DESIGN.md's sculpt-brush disc, `dx² + dy² < r·(r-1)`) rather than
 * inventing a second shape language for "a compact neighbourhood of radius
 * r". THE COUNT IS A FACT ABOUT THE RADIUS IN CELLS, NOT IN WORLD UNITS, and
 * the 2026-08-21 re-sample moved it: this is `cellsAcross(4)` = 16 cells, so
 * the disc holds 748 offsets, not the 37 a radius-4-in-cells disc holds (the
 * count the brush-footprint table documents, and the number this comment
 * claimed until 2026-09-01). Four world units either way — a structure looks
 * a short, fixed walk from its own doorstep: comfortably
 * past isFlatEnough's single-cell orthogonal check (suitability.ts),
 * nowhere near SETTLER_DISTRICT_CELLS (16 world units, protocol.ts) — which would make
 * an entire chunk's worth of inland cells read as coastal just for sharing a
 * district with a shoreline.
 */
export const COASTAL_SEARCH_RADIUS_CELLS = cellsAcross(4);

/**
 * Minimum CONFIRMED-water cells (see the file banner) within the search disc
 * before a site counts as coastal.
 *
 * 2 SQUARE WORLD UNITS of it — an AREA, so it scales as the square of the
 * sampling density (32 cells since the 2026-08-21 re-sample). Enough to rule
 * out a stray patch of deep (a small borrow pit a player dug, or a lone
 * sculpted trench) reading as "the sea", while staying
 * low because the confirmed-water test already under-counts real water by
 * construction (see the file banner): demanding a large count on top of an
 * already-conservative signal would miss genuine coastline too.
 */
export const COASTAL_MIN_WATER_CELLS = cellsOverArea(2);

/**
 * The highest rendered band that is unambiguously water — see the file
 * banner's "why a water test based on the rendered band" section. `bandOf`
 * floors, so this is also the highest raw height (-1) that can only ever be
 * water.
 */
const CONFIRMED_WATER_MAX_WORLD_Y = -1;

/**
 * How many of the disc's confirmed-water cells a survey KEEPS.
 *
 * Bound by what the only consumer can use: skiffs.ts anchors at most
 * SKIFF_MAX_PER_SETTLEMENT boats and reads `waterCells` nearest-first, so a
 * survey that retained the whole shoreline was building (and, before
 * 2026-09-01, sorting) hundreds of objects per structure to hand three of them
 * on. Retaining exactly that many keeps every anchor the fleet can place.
 *
 * REQUIRES `SURVEY_WATER_CELLS_RETAINED <= COASTAL_MIN_WATER_CELLS`, and the
 * scan below leans on it: it stops the moment the coastal threshold is met, so
 * a retention larger than the threshold could stop with fewer cells kept than
 * a caller asked for. 3 <= 32 today, with room to spare.
 */
const SURVEY_WATER_CELLS_RETAINED = SKIFF_MAX_PER_SETTLEMENT;

/**
 * The disc's offsets, NEAREST FIRST, as two parallel primitive arrays.
 *
 * SORTED AT MODULE LOAD SO THE SURVEY NEVER SORTS. `waterCells` is contracted
 * to come back nearest-first; scanning a distance-ordered disc produces that
 * order for free, where the old row-major scan had to build a
 * `{x, y, distanceSquared}` object per water cell, sort the lot, and `.map()`
 * a second array — per structure, per rebuild. Scanning nearest-first is also
 * what makes the early-out in `surveySite` sound: the first cells it finds ARE
 * the nearest, so it can stop as soon as the coastal threshold is met without
 * risking a nearer cell later in the scan.
 *
 * ORDER-IDENTICAL TO THE OLD SORT. `Array.prototype.sort` has been stable since
 * ES2019, so equal-distance offsets keep the row-major order they were built
 * in — exactly the order the old code's stable sort left them in.
 */
function buildTightDisc(radius: number): { dx: Int32Array; dy: Int32Array } {
  const threshold = radius * (radius - 1);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue; // the structure's own cell is checked separately (isBuildableCell already guarantees it is dry)
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  offsets.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
  return {
    dx: Int32Array.from(offsets, (o) => o[0]),
    dy: Int32Array.from(offsets, (o) => o[1]),
  };
}

/** Offsets of the `COASTAL_SEARCH_RADIUS_CELLS` disc, excluding the centre — built once at module load. */
const COASTAL_SEARCH_OFFSETS = buildTightDisc(COASTAL_SEARCH_RADIUS_CELLS);

export interface SiteSurvey {
  readonly kind: SiteKind;
  /**
   * True when some sampled neighbour's ground is still unknown AND that
   * uncertainty could still flip the verdict once it resolves (see
   * surveySite below). The caller should retry once more terrain streams
   * in; until then `kind` reads 'inland', the conservative default.
   */
  readonly pending: boolean;
  /**
   * The NEAREST confirmed water cells found in the search disc, nearest first
   * — skiffs.ts anchors boats on these. Always empty for a non-coastal result,
   * and never longer than `SURVEY_WATER_CELLS_RETAINED` (see that constant for
   * why a survey stops keeping them once the fleet's anchors are covered).
   */
  readonly waterCells: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/**
 * Surveys the neighbourhood of one structure cell and classifies its site.
 *
 * Today this is a single inline predicate (coastal-or-not) rather than a
 * generic rule table, because there is exactly one alternative to 'inland'
 * to test for. The moment a second one exists, extract both into a small
 * `{ kind, test }` list evaluated in priority order — the SiteKind union and
 * every downstream consumer (models.ts's Record-keyed lookup) are already
 * shaped for that; only this one function's body would grow.
 */
export function surveySite(groundAt: GroundLookup, x: number, y: number): SiteSurvey {
  const { dx: offsetsX, dy: offsetsY } = COASTAL_SEARCH_OFFSETS;
  const waterCells: Array<{ x: number; y: number }> = [];
  let confirmed = 0;
  let unknown = 0;

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
    // The scan is nearest-first, so the first cells kept are the nearest ones
    // and nothing later in the disc can displace them.
    if (waterCells.length < SURVEY_WATER_CELLS_RETAINED) waterCells.push({ x: cellX, y: cellY });
    // EARLY OUT: the verdict is coastal and cannot become anything else, and
    // every anchor a fleet can use has been kept (see
    // SURVEY_WATER_CELLS_RETAINED's threshold requirement). The rest of the
    // disc has nothing left to say. `pending` is false for the same reason the
    // old code returned it false here: a settled verdict is not provisional.
    if (confirmed >= COASTAL_MIN_WATER_CELLS) {
      return { kind: 'coastal', pending: false, waterCells };
    }
  }

  // Even if every still-unknown neighbour resolved to confirmed water, the
  // total could not reach the threshold — the verdict is settled 'inland'
  // for good, not merely for now.
  if (confirmed + unknown < COASTAL_MIN_WATER_CELLS) {
    return { kind: 'inland', pending: false, waterCells: [] };
  }
  // Not enough confirmed water yet, but enough unknowns remain that the
  // verdict could still flip once they resolve.
  return { kind: 'inland', pending: true, waterCells: [] };
}


// ---------------------------------------------------------------------------
// Caching a survey across rebuilds (GH #258)
// ---------------------------------------------------------------------------
//
// WHY A CACHE AND NOT A CHEAPER SURVEY. `surveySite` is 748 ground samples,
// and `rebuild` (client/index.ts) runs it for EVERY structure this client
// holds on every `structures:changes` delta, whatever the delta's size —
// measured at 2.85 ms for 512 inland structures and 9.74 ms at 70 % coastal,
// against a 7.1 ms frame budget. The cost is not in any one survey; it is in
// re-deriving 512 answers when at most a handful of them can have changed.
// Nothing about the disc's arithmetic can fix that, because the answer for an
// unchanged structure over unchanged terrain is genuinely already known.
//
// WHAT MAKES A CACHED ANSWER STALE, and nothing else does: a survey is a pure
// function of the ground under its disc (see `surveySite`'s own note), so it
// survives every event that does not move that ground — a founding elsewhere,
// an upgrade, a keepalive, the 2 Hz ground retry. The one input that can
// change under it is the terrain, and core reports that per chunk through
// `ClientPluginCtx.terrainRevisionAt`.
//
// WHY A SUM OF CHUNK REVISIONS IS A SOUND FINGERPRINT. Each chunk's revision
// is MONOTONICALLY INCREASING (client/src/world.ts), and the set of chunks one
// structure's disc covers is fixed for as long as the structure stands, so the
// sum over that set strictly increases whenever ANY chunk in it changes and
// cannot otherwise move. Equal sums therefore mean "no chunk under this disc
// has changed" — never a collision.

/**
 * Core's opaque terrain-change counter for the chunk holding a cell — exactly
 * `ClientPluginCtx.terrainRevisionAt`'s contract. Compared for equality only.
 */
export type TerrainRevisionLookup = (x: number, y: number) => number;

/**
 * Cell offsets at which a disc's covering chunks are probed, one probe per
 * chunk the disc's bounding box can touch.
 *
 * Stepping by CHUNK_SIZE from one edge of the box to the other visits every
 * chunk column it spans (consecutive probes are at most one chunk apart, so
 * none can be stepped over), and the far edge is added explicitly because the
 * span is not in general a whole number of chunks. Derived rather than written
 * out: at today's radius (16 cells) and chunk size (16 cells) it is three
 * offsets per axis — nine probes — but neither number is load-bearing here.
 */
function buildChunkProbeOffsets(radius: number): readonly number[] {
  const offsets: number[] = [];
  for (let d = -radius; d < radius; d += CHUNK_SIZE) offsets.push(d);
  offsets.push(radius);
  return offsets;
}

const CHUNK_PROBE_OFFSETS = buildChunkProbeOffsets(COASTAL_SEARCH_RADIUS_CELLS);

/**
 * A fingerprint of the terrain under one structure's search disc: the sum of
 * the terrain revisions of every chunk the disc can reach. See the section
 * banner above for why the sum is collision-free.
 */
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
  /** The pass that last asked for this cell — see `endPass`'s sweep. */
  pass: number;
}

/**
 * Per-structure-cell survey memo. One per client session; `placementsFor`
 * drives it, and every miss falls through to the same `surveySite` an uncached
 * caller would have run, so a cached result is the fresh result by
 * construction.
 */
export interface SiteSurveyCache {
  /** Opens a placement pass. Every pass must be closed with `endPass`. */
  beginPass(): void;
  surveyAt(groundAt: GroundLookup, x: number, y: number): SiteSurvey;
  /** Closes the pass, dropping the entries of structures that no longer stand. */
  endPass(): void;
  clear(): void;
  /** Live entry count — for tests and diagnostics; never read by the render path. */
  size(): number;
}

export function createSiteSurveyCache(revisionAt: TerrainRevisionLookup): SiteSurveyCache {
  const entries = new Map<number, CachedSurvey>();
  let pass = 0;

  return {
    beginPass(): void {
      pass++;
    },

    surveyAt(groundAt: GroundLookup, x: number, y: number): SiteSurvey {
      const key = structureKey(x, y);
      const revision = neighbourhoodRevision(revisionAt, x, y);
      const cached = entries.get(key);
      if (cached !== undefined && cached.revision === revision) {
        cached.pass = pass;
        return cached.survey;
      }
      const survey = surveySite(groundAt, x, y);
      if (cached === undefined) entries.set(key, { revision, survey, pass });
      else {
        cached.revision = revision;
        cached.survey = survey;
        cached.pass = pass;
      }
      return survey;
    },

    endPass(): void {
      // A DEMOLISHED STRUCTURE'S ENTRY GOES, or the map grows without bound
      // across a session's foundings and fells. Bounded by the structures this
      // client holds (STRUCTURES_CAP at the very worst), so the sweep is a
      // few hundred iterations against a survey it saves hundreds of.
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
