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
// NOW THE PREVIEW HARNESS'S FIXTURE ONLY (#129 step 4.2, 2026-08-24). It was
// client-only because the wire carried one height per cell and a layered
// column could not come from the server; `ChunkPayload.layered` changed that,
// so the REAL fixture is authored server-side at genesis
// (server/src/world/arch-fixture.ts, ARCH_FIXTURE=1) and arrives by the
// ordinary path — chunk payload, snapshot, restore — which is what makes it
// worth anything as verification. The live client no longer carves at all.
//
// What is left here serves `previewArch.ts`, which renders the mound with NO
// SERVER AT ALL and therefore has to put it on the map itself. Nothing here is
// a tool and nothing here is authoritative.
//
// The two copies of the mound's geometry are deliberate and bounded: this one
// exists to draw a mound in a harness with no world behind it, and it is the
// one that gets deleted when the preview does. Keep the CONSTANTS in step —
// they are the numbers the step-3 eyes-on pass settled.

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
const MOUND_CREST_BANDS = 9;
const MOUND_SHOULDER_BANDS = 8;
const MOUND_RIM_BANDS = 7;

/** Where the crest gives way to the shoulder, and the shoulder to the rim, as
 * a fraction of the mound's radius — squared, since the ellipse test is. */
const MOUND_CREST_EDGE_SQUARED = 0.5 * 0.5;
const MOUND_SHOULDER_EDGE_SQUARED = 0.8 * 0.8;

/**
 * Headroom under the roof, in bands — and the number the first eyes-on pass
 * moved (2026-08-24). At three bands the opening rendered correctly and still
 * read as a SHADOWED TERRACE STEP rather than as an arch: a band of height is
 * one world unit of run (MAX_STEP), so three bands of opening was barely two
 * units of air under a mound fifteen units across, and the roof's underside
 * eats one of them (spanUndersideHeight). Five bands clears that margin.
 */
const TUNNEL_OPENING_BANDS = 5;

/** Half-width of a tunnel, in cells: 6 either side of the centre line makes a
 * 13-cell bore, a little over three world units — wide enough to read as a
 * passage against a mound this size, for the same reason the opening is. */
const TUNNEL_HALF_WIDTH_CELLS = 6;

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

/**
 * Where the fixture's features land, in CELL coordinates, for a world of this
 * size — what a camera has to aim at to see an underside at all.
 *
 * Exported because the preview harness (previewArch.ts) frames the shot from
 * outside this module, and the alternative is restating the tunnel offsets
 * there, where they would drift the first time one of them moved.
 */
export function archFixtureAim(worldSize: number): {
  readonly archBore: { x: number; z: number };
  readonly caveMouth: { x: number; z: number };
  readonly crest: { x: number; z: number };
} {
  const centreX = Math.floor(worldSize / 2);
  const centreZ = Math.floor(worldSize / 2);
  return {
    archBore: { x: centreX + ARCH_TUNNEL_OFFSET_CELLS, z: centreZ },
    // The cave opens where its bore meets the mound's -Z rim. That is NOT the
    // mound's own -Z extreme: the rim is an ellipse, so a bore offset along X
    // reaches the edge short of it, and aiming at the extreme aims at bare
    // ground outside the mound (measured, 2026-08-24).
    caveMouth: {
      x: centreX + CAVE_TUNNEL_OFFSET_CELLS,
      z: centreZ - moundEdgeZCells(CAVE_TUNNEL_OFFSET_CELLS),
    },
    crest: { x: centreX, z: centreZ },
  };
}

/**
 * How far the mound reaches along Z at an X offset, in whole cells — the
 * ellipse solved for dz, floored so the answer names a cell that is actually
 * inside the mound rather than the first one outside it.
 */
function moundEdgeZCells(dx: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const remaining = 1 - nx * nx;
  if (remaining <= 0) return 0;
  return Math.floor(MOUND_RADIUS_Z_CELLS * Math.sqrt(remaining));
}

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
      for (const idx of chunksDirtiedByCell(mirror, x, z)) dirty.add(idx);
    }
  }

  return dirty;
}
