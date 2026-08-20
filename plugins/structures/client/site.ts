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

import type { GroundLookup } from './placement.ts';

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
 * How far out a structure looks for open water, in cells.
 *
 * 4 — reusing the project's own "tight integer disc" footprint convention
 * (docs/DESIGN.md's sculpt-brush disc, `dx² + dy² < r·(r-1)`) rather than
 * inventing a second shape language for "a compact neighbourhood of radius
 * r". At radius 4 that disc holds 37 cells including its own centre (the
 * same count the brush-footprint table documents for radius 4), so a
 * structure looks a short, fixed walk from its own doorstep: comfortably
 * past isFlatEnough's single-cell orthogonal check (suitability.ts),
 * nowhere near SETTLER_DISTRICT_CELLS (16, protocol.ts) — which would make
 * an entire chunk's worth of inland cells read as coastal just for sharing a
 * district with a shoreline.
 */
export const COASTAL_SEARCH_RADIUS_CELLS = 4;

/**
 * Minimum CONFIRMED-water cells (see the file banner) within the search disc
 * before a site counts as coastal.
 *
 * 2 — enough to rule out a single stray deep cell (a one-cell borrow pit a
 * player dug, or a lone sculpted trench) reading as "the sea", while staying
 * low because the confirmed-water test already under-counts real water by
 * construction (see the file banner): demanding a large count on top of an
 * already-conservative signal would miss genuine coastline too.
 */
export const COASTAL_MIN_WATER_CELLS = 2;

/**
 * The highest rendered band that is unambiguously water — see the file
 * banner's "why a water test based on the rendered band" section. `bandOf`
 * floors, so this is also the highest raw height (-1) that can only ever be
 * water.
 */
const CONFIRMED_WATER_MAX_WORLD_Y = -1;

function buildTightDisc(radius: number): ReadonlyArray<readonly [number, number]> {
  const threshold = radius * (radius - 1);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue; // the structure's own cell is checked separately (isBuildableCell already guarantees it is dry)
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  return offsets;
}

/** Offsets of the `COASTAL_SEARCH_RADIUS_CELLS` disc, excluding the centre — built once at module load. */
const COASTAL_SEARCH_OFFSETS: ReadonlyArray<readonly [number, number]> = buildTightDisc(
  COASTAL_SEARCH_RADIUS_CELLS,
);

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
   * Confirmed water cells found in the search disc, NEAREST FIRST — skiffs.ts
   * anchors boats on these. Always empty for a non-coastal result.
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
  const waterCells: Array<{ x: number; y: number; distanceSquared: number }> = [];
  let unknown = 0;

  for (const [dx, dy] of COASTAL_SEARCH_OFFSETS) {
    const sample = groundAt(x + dx, y + dy);
    if (sample === null) {
      unknown++;
      continue;
    }
    if (sample <= CONFIRMED_WATER_MAX_WORLD_Y) {
      waterCells.push({ x: x + dx, y: y + dy, distanceSquared: dx * dx + dy * dy });
    }
  }

  if (waterCells.length >= COASTAL_MIN_WATER_CELLS) {
    waterCells.sort((a, b) => a.distanceSquared - b.distanceSquared);
    return { kind: 'coastal', pending: false, waterCells: waterCells.map(({ x: wx, y: wy }) => ({ x: wx, y: wy })) };
  }
  // Even if every still-unknown neighbour resolved to confirmed water, the
  // total could not reach the threshold — the verdict is settled 'inland'
  // for good, not merely for now.
  if (waterCells.length + unknown < COASTAL_MIN_WATER_CELLS) {
    return { kind: 'inland', pending: false, waterCells: [] };
  }
  // Not enough confirmed water yet, but enough unknowns remain that the
  // verdict could still flip once they resolve.
  return { kind: 'inland', pending: true, waterCells: [] };
}
