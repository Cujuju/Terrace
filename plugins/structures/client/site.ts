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
//
// WHY A MOORING IS MORE THAN A WATER CELL (2026-09-04, GH #327 — owner: "the
// skiffs ... pass into the terrain"). The confirmed-water test above answers
// about ONE cell, and it answers from the LATTICE band. Neither is enough for a
// boat:
//
//   * A skiff is not a point. It orbits its anchor by up to
//     SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS and is 0.36 world units long, so some
//     part of it reaches SKIFF_MOORING_CLEARANCE_WORLD_UNITS = 0.46 (1.8 cells)
//     from the anchor. Handing it the NEAREST water cell — which, by
//     construction, is the SHORELINE — sailed it straight into the beach.
//   * The lattice is not what a player sees. `terrainHeightAt` reports the band
//     the CELL LATTICE assigns; the terrain DRAWS band caps over the region
//     inside a smoothed marched contour, and the two disagree by a whole band
//     wherever a cell sits on the wrong side of its own contour
//     (client/src/plugins/types.ts's drawnGroundYAt note,
//     client/src/terrain/drawnGround.ts's header). The shoreline IS a contour,
//     so the disagreement is guaranteed to be exactly where the boats go.
//
// So a survey now reports MOORINGS, not water cells: a mooring is a
// lattice-confirmed water cell every point of whose reachable square is DRAWN
// as water (`mooringVerdict`). The coastal/inland verdict is untouched and still
// counts lattice cells — it is a question about a NEIGHBOURHOOD, not about
// where a hull may swing, and re-deciding it on the drawn cap would change what
// a fishing village is for no reason the owner asked for.
//
// WHY A MOORING IS ALSO A ZONE AND A SPACING (2026-09-05, GH #327 — owner: the
// skiffs "collide with each other and with the warboats"). Being drawn water is
// a fact about ONE candidate in isolation, and two of the three ways a hull ends
// up inside another hull are facts about a PAIR:
//
//   * TWO SKIFFS. Moorable cells are adjacent — 0.25 world units apart — while
//     each skiff reaches SKIFF_MOORING_CLEARANCE_WORLD_UNITS (0.46) from its
//     anchor, so the nearest few moorings on any shoreline are three orbits over
//     one patch of water. Fixed by requiring
//     SKIFF_MOORING_SPACING_WORLD_UNITS between the moorings a survey keeps
//     (below), which makes the reach discs provably disjoint.
//   * A SKIFF AND A WAR BOAT. plugins/boats berths its fleet by the SAME rule on
//     the SAME nearest-first coastal disc about the SAME village cell
//     (server/fleet.ts's `surveyedLaunch`, 1011-1052), at the same minimum tier.
//     Fixed by ZONING the harbour relative to each village's OWN shoreline:
//     skiffs take the inshore strip (protocol.ts's
//     HARBOUR_INSHORE_BAND_WORLD_UNITS), war boats berth beyond it. Neither
//     plugin reads the other's placements; the band is what they agree on.
//
// The third way — two VILLAGES claiming one mooring, which handed
// hashStructureCell the identical cell and drew two identical orbits through
// each other — cannot be seen from inside a single survey at all, and is
// enforced in placement.ts's cross-settlement claiming pass instead. That is
// also why a survey now keeps SURVEY_MOORINGS_RETAINED candidates rather than
// exactly the fleet's worth: the pass needs spares to fall back to.

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
 * How many MOORINGS a survey keeps.
 *
 * TWICE the fleet (2026-09-05, GH #327), where it used to be exactly the fleet.
 * placement.ts now claims moorings across the WHOLE world, so neighbouring
 * villages on one bay compete for the same water and the nearest few are
 * routinely a neighbour's by the time this settlement is served. The spares are
 * what this settlement falls back to instead of floating nothing — the identical
 * reasoning, and the identical multiple, plugins/boats/server/fleet.ts:455-465
 * gives for its own MOORINGS_SURVEYED_PER_VILLAGE.
 *
 * IT NO LONGER BOUNDS THE SCAN (2026-09-04). The old early-out fired as soon as
 * the COASTAL threshold was met, which required this count to be
 * `<= COASTAL_MIN_WATER_CELLS` (6 <= 32, still true) to be sure the kept cells
 * were not short. A water cell is no longer automatically a mooring, so the
 * threshold says nothing about how many moorings have been found; the scan runs
 * on until it has this many, or until the inshore band closes, or until the disc
 * is exhausted — see `surveySite`.
 */
const SURVEY_MOORINGS_RETAINED = 2 * SKIFF_MAX_PER_SETTLEMENT;

/**
 * Half-side of the square of DRAWN ground a mooring must be water across, in
 * CELLS — the mooring clearance (skiffs.ts, in world units) converted, rounded
 * UP so the tested square always contains the disc the hull can actually reach.
 *
 * 2 today (0.46 / 0.25 = 1.84, ceiled), and the number is derived rather than
 * written because both of its inputs move: the orbit bound and the hull length
 * are skiffs.ts's, and CELL_WORLD_SIZE moved once already (2026-08-21).
 *
 * A SQUARE, NOT THE DISC ITSELF. The reachable set is a disc of radius
 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS about the anchor; the square that
 * circumscribes it is a strict superset, so testing the square can only ever
 * REJECT a mooring the disc would have allowed — the same
 * under-count-never-over-count direction the file banner commits to, and it
 * costs a rectangular loop instead of a per-row half-width.
 */
export const SKIFF_MOORING_CLEARANCE_CELLS = Math.ceil(
  SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE,
);

/**
 * The same hull reach in CELLS but NOT rounded — 1.84 today.
 *
 * Distinct from SKIFF_MOORING_CLEARANCE_CELLS above, which is ceiled because it
 * indexes a loop over a lattice of whole cells. This one is compared against a
 * Euclidean distance, so rounding it up would push the inshore bound in by a
 * sixth of a cell for no reason: it is an arithmetic term, not a loop bound.
 */
const SKIFF_MOORING_REACH_CELLS = SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE;

/**
 * The inshore strip (protocol.ts's HARBOUR_INSHORE_BAND_WORLD_UNITS) in CELLS —
 * 6 today. Converted here rather than written because CELL_WORLD_SIZE moved once
 * already (the 2026-08-21 re-sample) and the band is stated in world units,
 * which is the unit both plugins' copies agree in.
 */
const HARBOUR_INSHORE_BAND_CELLS = HARBOUR_INSHORE_BAND_WORLD_UNITS / CELL_WORLD_SIZE;

/**
 * The least allowed distance between two moorings, SQUARED and in CELLS —
 * 3.68² = 13.54 today. Squared so the test needs no square root; in cells
 * because moorings are cells.
 *
 * The rule itself, and its one-line disjointness proof, belong to skiffs.ts's
 * SKIFF_MOORING_SPACING_WORLD_UNITS. This is only its unit conversion.
 */
export const SKIFF_MOORING_SPACING_CELLS_SQUARED =
  (SKIFF_MOORING_SPACING_WORLD_UNITS / CELL_WORLD_SIZE) ** 2;

/**
 * Grid samples across one axis of that square, inclusive of both edges.
 *
 * STEPPED AT THE DRAWN GROUND'S OWN PITCH. `BAND_GRID_CELLS` (a quarter cell,
 * owned by client/src/terrain/bandGrid.ts — a leaf module that exists so this
 * import does not drag the store's `import.meta.env` into a node test run) is
 * the resolution at
 * which the store precomputes "which level does the terrain draw here", so it
 * is the finest answer `drawnAt` can give and the coarsest step that cannot
 * step OVER a feature the store resolved. Importing it rather than restating a
 * quarter is what keeps the two from drifting if the grid is ever refined.
 *
 * WHY A COARSER STEP WOULD BE WRONG. The drawn shoreline is a smoothed marched
 * contour, not an axis-aligned staircase: a spit or a bulge of land can enter
 * the square between two samples and leave again before the next one. Sampling
 * at the store's own pitch means every bulge the store itself resolved is seen
 * by at least one sample; a half-cell or whole-cell step would let a
 * quarter-cell tongue of beach sit inside a "clear" mooring.
 */
const MOORING_SAMPLES_PER_AXIS =
  Math.round((2 * SKIFF_MOORING_CLEARANCE_CELLS) / BAND_GRID_CELLS) + 1;

/**
 * What a candidate water cell turned out to be when its clearance square was
 * read off the DRAWN ground.
 *
 * 'undrawn' is separate from 'blocked' on purpose: a sample the client has not
 * been sent yet is not a verdict, and a survey that saw one is provisional
 * (`SiteSurvey.pending`) rather than settled — see `surveySite`.
 */
type MooringVerdict = 'moorable' | 'blocked' | 'undrawn';

/**
 * Is every point a hull moored at this cell could reach DRAWN as water?
 *
 * Samples the circumscribing square at the drawn ground's own grid pitch and
 * demands `drawnAt <= CONFIRMED_WATER_MAX_WORLD_Y` — the same unambiguous-water
 * bar the lattice test uses, applied to the surface the boat is actually seen
 * against. A NULL sample (a cell whose chunk this client has not received, or
 * has not yet drawn) is NOT moorable: unknown ground is treated as land, which
 * is the same direction of error the file banner commits to everywhere else.
 */
function mooringVerdict(drawnAt: GroundLookup, cellX: number, cellY: number): MooringVerdict {
  const origin = -SKIFF_MOORING_CLEARANCE_CELLS;
  let sawUndrawn = false;
  for (let iy = 0; iy < MOORING_SAMPLES_PER_AXIS; iy++) {
    const sampleY = cellY + origin + iy * BAND_GRID_CELLS;
    for (let ix = 0; ix < MOORING_SAMPLES_PER_AXIS; ix++) {
      const sampleX = cellX + origin + ix * BAND_GRID_CELLS;
      const drawn = drawnAt(sampleX, sampleY);
      // An undrawn sample cannot be resolved by looking further, but a DRAWN
      // land sample settles the cell outright — so land wins immediately and
      // 'undrawn' is only reported when nothing else disqualified the cell.
      if (drawn === null) sawUndrawn = true;
      else if (drawn > CONFIRMED_WATER_MAX_WORLD_Y) return 'blocked';
    }
  }
  return sawUndrawn ? 'undrawn' : 'moorable';
}

/**
 * The disc's offsets, NEAREST FIRST, as two parallel primitive arrays.
 *
 * SORTED AT MODULE LOAD SO THE SURVEY NEVER SORTS. `moorings` is contracted
 * to come back nearest-first; scanning a distance-ordered disc produces that
 * order for free, where the old row-major scan had to build a
 * `{x, y, distanceSquared}` object per water cell, sort the lot, and `.map()`
 * a second array — per structure, per rebuild. Scanning nearest-first is also
 * what makes the early-out in `surveySite` sound: the first cells it finds ARE
 * the nearest, so it can stop as soon as both the coastal threshold and the
 * fleet's anchors are settled, without risking a nearer cell later in the scan.
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
   * True when this survey could still change once more terrain resolves —
   * EITHER because unknown ground could still flip the coastal verdict, OR
   * because a candidate mooring was rejected only for an undrawn sample (see
   * surveySite below). The caller should retry once more terrain streams in;
   * until then `kind` reads 'inland' where the verdict is the open question,
   * which is the conservative default.
   *
   * A PENDING SURVEY IS NEVER MEMOISED — see `createSiteSurveyCache`, which
   * explains why the terrain revision alone cannot resolve the second case.
   */
  readonly pending: boolean;
  /**
   * The NEAREST MOORINGS found in the search disc, nearest first — a CANDIDATE
   * POOL, not an assignment: placement.ts picks from it and may reject an entry
   * a neighbouring settlement claimed first. Always empty for a non-coastal
   * result, and never longer than `SURVEY_MOORINGS_RETAINED`.
   *
   * THREE THINGS ARE TRUE OF EVERY ENTRY, all enforced in `surveySite`:
   *   1. MOORABLE — a lattice-confirmed water cell every point of whose hull
   *      reach is also DRAWN as water (`mooringVerdict`, and the file banner).
   *   2. INSHORE — its whole reach lies within HARBOUR_INSHORE_BAND_CELLS of the
   *      settlement's own nearest confirmed water, so it is inside the half of
   *      the harbour that belongs to skiffs rather than to war boats.
   *   3. SPACED — at least SKIFF_MOORING_SPACING from every other entry, so no
   *      two hulls anchored from this list can reach each other.
   *
   * IT MAY BE EMPTY ON A COASTAL SITE, and that is the guarantee working rather
   * than a failure: a settlement whose whole shoreline is too tight to swing a
   * boat in — or whose inshore band holds no clear water at all — is still a
   * coastal site (it still renders the fishing-hut variant) and simply floats
   * nothing. Better no skiff than a skiff in the sand, or in a war boat.
   */
  readonly moorings: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/**
 * Surveys the neighbourhood of one structure cell and classifies its site, and
 * picks the moorings a coastal settlement's boats may anchor at.
 *
 * TWO LOOKUPS, TWO QUESTIONS. `groundAt` is the LATTICE band
 * (ClientPluginCtx.terrainHeightAt) and answers "is this neighbourhood the
 * sea?" — the coastal verdict, unchanged. `drawnAt` is the DRAWN cap
 * (ClientPluginCtx.drawnGroundYAt) and answers "may a hull swing here?" — the
 * mooring test, which has to use the surface the boat is seen against because
 * the two disagree by a whole band exactly at the shoreline contour (see the
 * file banner).
 *
 * ZONED AND SPACED (2026-09-05, GH #327). A candidate must also lie INSIDE this
 * settlement's own inshore band and clear of every mooring already kept — see
 * `SiteSurvey.moorings` for the three guarantees and the inline comments below
 * for where each is applied. Both bounds only ever REJECT candidates, so the
 * scan's cost can only fall; the inshore bound additionally CLOSES the mooring
 * half early, because the disc is walked nearest-first and distance only grows.
 *
 * COST, worst case, per survey: COASTAL_SEARCH_OFFSETS.length lattice samples
 * (748) plus MOORING_SAMPLES_PER_AXIS² (17 x 17 = 289) drawn samples for every
 * candidate water cell tested. The drawn test is now paid only inside the
 * inshore band — a ring of at most HARBOUR_INSHORE_BAND_CELLS (6) cells' depth
 * about the shoreline — and only for candidates already spaced from the moorings
 * kept, so the old ceiling (a disc of 748 unmoorable water cells, 216 172 drawn
 * samples) is no longer reachable.
 *
 * MEASURED before the zoning (2026-09-04, a straight coast three cells east of
 * the site — the ordinary fishing village): 126 lattice samples and 883 drawn
 * samples, i.e. the early-out fired after three candidates and the drawn test is
 * what the survey mostly costs. The zoning does not raise either figure — it
 * spends the same nearest-first walk and rejects more of it. 512 such surveys,
 * ALL coastal and ALL missing the
 * cache, run 1.8 ms with an arithmetic lookup and about 16 ms against a stand-in
 * shaped like the real chart read (a Map get plus a typed-array index). The
 * second figure is over the 7.1 ms frame budget — as the pre-mooring code
 * already was at 70 % coastal (9.7 ms, see the cache banner below). That case is
 * every structure in the world re-surveying in one frame, which is exactly what
 * `createSiteSurveyCache` exists to stop: a delta only invalidates the
 * structures whose own disc moved.
 *
 * Today the site classification is a single inline predicate (coastal-or-not)
 * rather than a generic rule table, because there is exactly one alternative to
 * 'inland' to test for. The moment a second one exists, extract both into a
 * small `{ kind, test }` list evaluated in priority order — the SiteKind union
 * and every downstream consumer (models.ts's Record-keyed lookup) are already
 * shaped for that; only this one function's body would grow.
 */
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
  /** Some candidate was rejected ONLY because part of its square is not drawn yet. */
  let mooringUndrawn = false;
  /**
   * Distance in cells of the FIRST confirmed water cell the scan meets — this
   * settlement's own shoreline, since the disc is walked nearest-first. Null
   * until that cell is found, and every later distance is at least this one.
   */
  let shoreCells: number | null = null;
  /** No later candidate can qualify, so the drawn-ground test is no longer paid. */
  let mooringsClosed = false;
  /**
   * Is a re-survey worth it? Only when undrawn ground cost this settlement a
   * mooring it could still USE — a full pool is a settled answer however many
   * candidates were skipped on the way to it, and reporting it pending would
   * bar `createSiteSurveyCache` from ever memoising a busy shoreline.
   */
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
      // THE INSHORE BOUND. The whole disc the hull can reach must stay within
      // the band past this settlement's OWN shoreline — the water war boats
      // keep out of (protocol.ts's HARBOUR_INSHORE_BAND_WORLD_UNITS). The scan
      // is nearest-first, so `distance` only ever grows: once one candidate is
      // out of the band, no later one can be in it, and the mooring half of the
      // survey is finished for good. The COASTAL COUNT is a different question
      // (a neighbourhood, not a berth) and keeps walking the whole disc.
      if (distance + SKIFF_MOORING_REACH_CELLS > shoreCells + HARBOUR_INSHORE_BAND_CELLS) {
        mooringsClosed = true;
      } else if (
        // SPACED FROM EVERY MOORING ALREADY KEPT, so two of this settlement's
        // own skiffs can never reach each other (skiffs.ts's
        // SKIFF_MOORING_SPACING_WORLD_UNITS carries the proof). Cheap integer
        // test first: it rejects the adjacent cells that make up most of a
        // shoreline before any drawn sampling is paid for.
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
    // EARLY OUT, ON BOTH ANSWERS. The verdict is coastal and cannot become
    // anything else, AND the mooring half is closed — either full or past the
    // inshore band — so the rest of the disc has nothing left to say. It used to
    // fire on the verdict alone, which was sound only while every water cell was
    // an anchor. The disc itself is still the hard bound: nothing here scans
    // past COASTAL_SEARCH_RADIUS_CELLS.
    if (confirmed >= COASTAL_MIN_WATER_CELLS && mooringsClosed) {
      return { kind: 'coastal', pending: mooringsPending(), moorings };
    }
  }

  // Coastal, but the disc ran out before the pool was filled. The moorings kept
  // (possibly NONE — see SiteSurvey.moorings) are all there are. `pending` here
  // is only about the MOORINGS: the verdict is settled.
  if (confirmed >= COASTAL_MIN_WATER_CELLS) {
    return { kind: 'coastal', pending: mooringsPending(), moorings };
  }
  // Even if every still-unknown neighbour resolved to confirmed water, the
  // total could not reach the threshold — the verdict is settled 'inland'
  // for good, not merely for now.
  if (confirmed + unknown < COASTAL_MIN_WATER_CELLS) {
    return { kind: 'inland', pending: false, moorings: [] };
  }
  // Not enough confirmed water yet, but enough unknowns remain that the
  // verdict could still flip once they resolve.
  return { kind: 'inland', pending: true, moorings: [] };
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
//
// WHAT THE REVISION CANNOT SEE (2026-09-04, verified this session). The
// revision counter is bumped where the DIRTY SET is known — client/src/world.ts
// `applyDirty` calls `noteTerrainRevisions(dirty)` and then `meshes.update`,
// which only ENQUEUES a chunk build. The chunk's drawn chart lands one build
// later, in the splice, and its readers are driven by `onChunkDrawn` instead
// (world.ts's own comments on both, and terrainMeshes.ts). `ClientPluginCtx`
// exposes no `onChunkDrawn`, so this plugin cannot be driven that way; and
// until the chart is published, `world.drawnGroundYAt` answers from the blocky
// per-cell fallback (terrain/drawnGround.ts's MISSING CHUNKS note) — a number,
// not a null. NOTHING BUMPS THE REVISION AGAIN WHEN THE CHUNK IS FINALLY DRAWN.
//
// A survey taken in that window would therefore be memoised, against a
// fingerprint that will never move again, over ground the player has not been
// shown — and at a fresh join that window covers EVERY structure at once, not a
// rare race. The fix is upstream and here, in that order:
//
//   * client/src/world.ts's `drawnGroundYAt` now answers NULL for a cell whose
//     chunk has not been drawn yet, instead of guessing with the blocky
//     fallback. "I have not drawn this" is the same answer it already gives for
//     "I have not received this", and it is the honest one.
//   * a survey that saw such a null reports `pending: true`, and a pending
//     survey is NOT MEMOISED below. The plugin's existing 2 Hz retry
//     (client/index.ts's STRUCTURES_GROUND_RETRY_SECONDS, which already fires on
//     `pendingSite`) then re-surveys until the chunks under the disc are drawn.
//
// Cost of that, named: a structure whose moorings sit against permanently
// undrawn ground (the reveal frontier) re-surveys on every rebuild for as long
// as that holds — the same shape `pendingGround` already has, and bounded the
// same way, by the retry interval rather than by the frame.

/**
 * A revision no `neighbourhoodRevision` can ever return, used to park a
 * PROVISIONAL survey in the map so `endPass`'s liveness sweep still sees the
 * structure while the next pass is forced to re-survey it.
 *
 * -1: revisions are a sum of a monotonic epoch and non-negative per-chunk
 * counters (client/src/world.ts), so the smallest value the real lookup can
 * produce is 0.
 */
const UNCACHEABLE_REVISION = -1;

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
  surveyAt(
    groundAt: GroundLookup,
    drawnAt: GroundLookup,
    x: number,
    y: number,
  ): SiteSurvey;
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

    surveyAt(groundAt: GroundLookup, drawnAt: GroundLookup, x: number, y: number): SiteSurvey {
      const key = structureKey(x, y);
      const revision = neighbourhoodRevision(revisionAt, x, y);
      const cached = entries.get(key);
      if (cached !== undefined && cached.revision === revision) {
        cached.pass = pass;
        return cached.survey;
      }
      const survey = surveySite(groundAt, drawnAt, x, y);
      // A PROVISIONAL ANSWER IS NOT MEMOISED, and this is load-bearing rather
      // than tidy — see the section banner's "WHAT THE REVISION CANNOT SEE".
      // Storing it would pin a survey taken over ground that had not been
      // DRAWN yet against a revision that will never move again.
      if (survey.pending) {
        // Any stale entry for this cell goes with it: it is older than this
        // answer and no more settled. The `pass` bookkeeping still has to run,
        // or `endPass` would sweep a structure that does still stand — so the
        // entry is kept live but marked with a revision no fingerprint can
        // equal, forcing the next pass to re-survey.
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
