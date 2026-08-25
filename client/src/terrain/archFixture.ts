// A hand-authored arch and cave, carved into the client's mirror at join.
//
// STEP 3 of the layered-column work (#129, plan in
// ~/.claude/plans/terrace-layered-columns.md). Steps 1 and 2 widened the column
// to a list of solid spans and taught the mesh builder and the picker to
// express a ceiling, both with the one-span invariant held so nothing changed
// on screen. This module is what puts the first ceiling in a world, and it
// exists to answer ONE question with something visible: does the terraced look
// — the band palette, the skirts, the lighting — survive an underside?
//
// DELIBERATELY CLIENT-ONLY, AND DELIBERATELY NOT SCULPTABLE. The wire carries
// one height per cell (`ChunkPayload.heights`), so a layered column cannot come
// from the server yet; carving the mirror after the snapshot lands sidesteps
// that entirely and keeps the wire work deferred until there is a reason to do
// it. Nothing here is a tool, nothing here is authoritative: the server does
// not know this mound exists, so sculpting it, walking on it or persisting it
// are all out of scope, and the next terrain diff that lands on these cells
// will simply overwrite their heights.
//
// GATED behind `?arch=1` — off in the ordinary client, present only when
// someone is looking at it on purpose.

import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  cellIndex,
  chunkIndex,
  heightAt,
  quantizeToBand,
  setColumn,
  type Span,
} from '@terrace/shared';

import { chunksDirtiedByCell, hasChunk, type TerrainMirror } from './mirror.ts';

/** Query flag that asks for the fixture. */
const ARCH_FIXTURE_QUERY_KEY = 'arch';

/**
 * Half-extents of the mound, in cells, along the tunnel's cross-axis (X) and
 * along the tunnel itself (Z). 30 × 14 cells is 7.5 × 3.5 world units — big
 * enough that the tunnel is a passage rather than a notch, small enough to sit
 * inside the starter footprint of received chunks.
 */
const MOUND_RADIUS_X_CELLS = 30;
const MOUND_RADIUS_Z_CELLS = 14;

/**
 * The mound's terraces, in bands above the ground it stands on: a flat crest
 * over the middle, one step down, then a rim that drops straight to the
 * terrain. The RIM is what the tunnel mouths open onto, so it is the number
 * that matters most — it must clear the opening below with a band of roof left
 * over, which is exactly `MOUND_RIM_BANDS > TUNNEL_OPENING_BANDS`.
 */
const MOUND_CREST_BANDS = 6;
const MOUND_SHOULDER_BANDS = 5;
const MOUND_RIM_BANDS = 4;

/** Where the crest gives way to the shoulder, and the shoulder to the rim, as
 * a fraction of the mound's radius — squared, since the ellipse test is. */
const MOUND_CREST_EDGE_SQUARED = 0.5 * 0.5;
const MOUND_SHOULDER_EDGE_SQUARED = 0.8 * 0.8;

/** Headroom under the roof, in bands. Three bands is 48 units — a passage a
 * settler-scale figure would read as walkable, and enough that the underside
 * is visible from a normal camera pitch rather than only from ground level. */
const TUNNEL_OPENING_BANDS = 3;

/** Half-width of a tunnel, in cells: 3 either side of the centre line makes a
 * 7-cell bore, a little under two world units. */
const TUNNEL_HALF_WIDTH_CELLS = 3;

/** Where the two tunnels sit along the mound's long axis, as an offset in
 * cells from its centre. The first runs clean through — that is the ARCH. The
 * second stops inside — that is the CAVE. */
const ARCH_TUNNEL_OFFSET_CELLS = -14;
const CAVE_TUNNEL_OFFSET_CELLS = 14;

/**
 * How far the cave bores in from the mound's near edge, as a fraction of the
 * crossing. Two thirds leaves a solid third at the far end, so the cave reads
 * as a dead end rather than as a second arch.
 */
const CAVE_DEPTH_FRACTION = 2 / 3;

/** Whether the URL asks for the fixture. */
export function archFixtureRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(ARCH_FIXTURE_QUERY_KEY) === '1';
}

/** Whether the chunk owning a cell has been received. Out-of-bounds is false. */
function cellAvailable(mirror: TerrainMirror, x: number, y: number): boolean {
  const size = mirror.map.size;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return hasChunk(
    mirror,
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
  );
}

/**
 * The mound's height above its base, in bands, at a cell — or 0 outside it.
 * Three terraces read through the band palette; a smooth dome would not, and
 * the point of the fixture is to look at the bands.
 */
function moundBandsAt(dx: number, dz: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const nz = dz / MOUND_RADIUS_Z_CELLS;
  const rSquared = nx * nx + nz * nz;
  if (rSquared > 1) return 0;
  if (rSquared <= MOUND_CREST_EDGE_SQUARED) return MOUND_CREST_BANDS;
  if (rSquared <= MOUND_SHOULDER_EDGE_SQUARED) return MOUND_SHOULDER_BANDS;
  return MOUND_RIM_BANDS;
}

/**
 * Whether a cell is inside one of the two tunnels — the volume that must be
 * left OPEN between the ground and the roof.
 *
 * `dz` is measured from the mound's centre along the tunnel's own axis, so the
 * arch spans the whole crossing while the cave stops short of the far side.
 */
function insideTunnel(dx: number, dz: number): boolean {
  if (Math.abs(dx - ARCH_TUNNEL_OFFSET_CELLS) <= TUNNEL_HALF_WIDTH_CELLS) return true;
  if (Math.abs(dx - CAVE_TUNNEL_OFFSET_CELLS) > TUNNEL_HALF_WIDTH_CELLS) return false;
  // The cave bores in from the -Z edge and stops: its mouth is on that side,
  // and the far end of the mound stays solid rock.
  const caveEnd = -MOUND_RADIUS_Z_CELLS + 2 * MOUND_RADIUS_Z_CELLS * CAVE_DEPTH_FRACTION;
  return dz <= caveEnd;
}

/**
 * Carves the fixture into the mirror, returning the chunks whose meshes are now
 * stale. Call it INSIDE a `PredictionStore.applyAuthoritative` mutation, the
 * same way a chunk payload is applied: the store re-derives the rendered map
 * from its authoritative copy, so a carve made outside one is erased by the
 * next diff that arrives.
 *
 * The mound is centred on the world's middle cell. If that cell's chunk has not
 * been received there is nothing to stand on and nothing to draw, so the carve
 * is skipped outright rather than placed somewhere arbitrary.
 */
export function carveArchFixture(mirror: TerrainMirror): Set<number> {
  const dirty = new Set<number>();
  const size = mirror.map.size;
  const centreX = Math.floor(size / 2);
  const centreZ = Math.floor(size / 2);
  if (!cellAvailable(mirror, centreX, centreZ)) {
    console.warn('[terrace] arch fixture: the world centre has not been received — skipped');
    return dirty;
  }

  // The whole mound stands on ONE base height, quantized to a band boundary:
  // a roof that followed the terrain would tilt, and the question this fixture
  // asks is about the underside's shading, not about a sloped ceiling.
  const base = quantizeToBand(heightAt(mirror.map, centreX, centreZ));

  for (let dz = -MOUND_RADIUS_Z_CELLS; dz <= MOUND_RADIUS_Z_CELLS; dz++) {
    for (let dx = -MOUND_RADIUS_X_CELLS; dx <= MOUND_RADIUS_X_CELLS; dx++) {
      const bands = moundBandsAt(dx, dz);
      if (bands === 0) continue;

      const x = centreX + dx;
      const z = centreZ + dz;
      if (!cellAvailable(mirror, x, z)) continue;

      const moundTop = base + bands * BAND_HEIGHT;
      const ground = mirror.map.cells[cellIndex(mirror.map, x, z)]!;
      const roofFloor = base + TUNNEL_OPENING_BANDS * BAND_HEIGHT;

      let spans: readonly Span[];
      if (
        insideTunnel(dx, dz) &&
        // A tunnel needs a floor below its opening and a roof above it. Where
        // the terrain has risen into the opening, or the mound is too low here
        // to leave any roof, the cell stays solid — a hole with no roof over it
        // is not an arch, it is a gap in the mound. A floor AT bedrock is the
        // same refusal: the span below the opening would be empty, and a
        // column standing on nothing is not what this fixture is testing.
        ground > BEDROCK_FLOOR &&
        ground < roofFloor &&
        roofFloor < moundTop
      ) {
        spans = [
          { floor: BEDROCK_FLOOR, ceiling: ground },
          { floor: roofFloor, ceiling: moundTop },
        ];
      } else {
        spans = [{ floor: BEDROCK_FLOOR, ceiling: moundTop }];
      }

      setColumn(mirror.map, x, z, spans);
      for (const idx of chunksDirtiedByCell(size, x, z)) dirty.add(idx);
    }
  }

  return dirty;
}
