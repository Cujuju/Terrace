// The arch-and-cave fixture, authored into the world at genesis.
//
// STEP 4.2 of the layered-column work (#129). This module is the client-side
// fixture (client/src/terrain/archFixture.ts, step 3) MOVED TO THE SERVER, and
// the move is the point: step 3's carve happened in the client's mirror after
// the snapshot landed, because the wire could only carry one height per cell.
// Now it can carry a span, so the mound is authored ONCE, in the authoritative
// world, and everything downstream of it — the chunk payload, the diff, the
// snapshot blob, a second browser joining — is exercised for real rather than
// simulated locally.
//
// That is why this is a fixture and not a feature: it is the strongest eyes-on
// verification available for free. Nothing here is a tool and nothing here is
// reachable by a player.
//
// GATED behind ARCH_FIXTURE=1, and it only ever runs at GENESIS — a world that
// already exists is loaded from its snapshot and is never re-carved, so
// flipping the flag on an existing world does nothing. Author a new one.

import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  cellIndex,
  heightAt,
  quantizeToBand,
  setColumn,
  type Heightmap,
  type Span,
} from '@terrace/shared';

/**
 * Half-extents of the mound, in cells, along the tunnel's cross-axis (X) and
 * along the tunnel itself (Z). 30 × 14 cells is 7.5 × 3.5 world units — big
 * enough that the tunnel is a passage rather than a notch, small enough to sit
 * inside the starter footprint of unlocked chunks.
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
 * Headroom under the roof, in bands — the number the step-3 eyes-on pass moved
 * (2026-08-24). At three bands the opening rendered correctly and still read as
 * a SHADOWED TERRACE STEP rather than as an arch: a band of height is one world
 * unit of run (MAX_STEP), so three bands was barely two units of air under a
 * mound fifteen units across, and the roof's underside eats one of them
 * (spanUndersideHeight). Five bands clears that margin.
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

/** The environment variable that asks for the fixture, and the only value that
 * counts as yes — anything else, including "true", is off, so a typo cannot
 * quietly author a mound into someone's new world. */
const ARCH_FIXTURE_ENV_KEY = 'ARCH_FIXTURE';
const ARCH_FIXTURE_ENV_ON = '1';

/** Whether this server was asked to author the fixture into a new world. */
export function archFixtureRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCH_FIXTURE_ENV_KEY] === ARCH_FIXTURE_ENV_ON;
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
 * Carves the fixture into a world's heightmap, centred on its middle cell.
 * Returns how many columns ended up layered — 0 means the mound was built but
 * nothing opened under it, which is a bug worth seeing in the boot log rather
 * than discovering on screen.
 *
 * Called at GENESIS, before the first snapshot is written, so the mound is part
 * of the world's initial terrain and reaches clients by the ordinary path.
 * Walks the mound in row-major order (dz outer, dx inner) so two servers given
 * the same genesis terrain produce byte-identical worlds.
 */
export function carveArchFixture(map: Heightmap): number {
  const centreX = Math.floor(map.size / 2);
  const centreZ = Math.floor(map.size / 2);

  // The whole mound stands on ONE base height, quantized to a band boundary: a
  // roof that followed the terrain would tilt, and the question this fixture
  // asks is about the underside's shading, not about a sloped ceiling.
  const base = quantizeToBand(heightAt(map, centreX, centreZ));
  let layered = 0;

  for (let dz = -MOUND_RADIUS_Z_CELLS; dz <= MOUND_RADIUS_Z_CELLS; dz++) {
    for (let dx = -MOUND_RADIUS_X_CELLS; dx <= MOUND_RADIUS_X_CELLS; dx++) {
      const bands = moundBandsAt(dx, dz);
      if (bands === 0) continue;

      const x = centreX + dx;
      const z = centreZ + dz;
      if (x < 0 || z < 0 || x >= map.size || z >= map.size) continue;

      const moundTop = base + bands * BAND_HEIGHT;
      const ground = map.cells[cellIndex(map, x, z)]!;
      const roofFloor = base + TUNNEL_OPENING_BANDS * BAND_HEIGHT;

      let spans: readonly Span[];
      if (
        insideTunnel(dx, dz) &&
        // A tunnel needs a floor below its opening and a roof above it. Where
        // the terrain has risen into the opening, or the mound is too low here
        // to leave any roof, the cell stays solid — a hole with no roof over it
        // is not an arch, it is a gap in the mound. A floor AT bedrock is the
        // same refusal: the span below the opening would be empty, and a column
        // standing on nothing is not what this fixture is testing.
        ground > BEDROCK_FLOOR &&
        ground < roofFloor &&
        roofFloor < moundTop
      ) {
        spans = [
          { floor: BEDROCK_FLOOR, ceiling: ground },
          { floor: roofFloor, ceiling: moundTop },
        ];
        layered++;
      } else {
        spans = [{ floor: BEDROCK_FLOOR, ceiling: moundTop }];
      }

      setColumn(map, x, z, spans);
    }
  }

  return layered;
}
