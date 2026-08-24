// World thumbnails — a world small enough to recognise in a list row.
//
// WHAT IT PRODUCES: a fixed WORLD_THUMBNAIL_SIZE² grid of BAND numbers, one
// signed byte each, taken as the MEAN height of the block of cells each pixel
// covers. The client turns a band back into a height and asks its own palette
// for the colour (client/src/ui/WorldThumbnail.tsx).
//
// WHY BANDS AND NOT COLOURS. The terrain palette is a RENDERING concern and
// lives in the client (terrain/bandColors.ts); the server has no business
// knowing what colour a height is, and shipping RGB would freeze today's
// palette into every stored thumbnail — recolour the game and every world in
// the list would still be wearing the old colours. A band is the same
// quantisation the renderer already works in, so a thumbnail re-colours itself
// for free.
//
// WHY A MEAN AND NOT A SAMPLE. Taking one cell per pixel is cheaper and wrong:
// at 2048² a 64px thumbnail would keep one cell in 1024, and regular terrain
// turns into a moiré grid that looks like a bug in the world rather than in
// the sampler. Averaging costs one pass over the heightmap — a few tens of
// milliseconds, paid once per snapshot — and makes the shape read.
//
// WHY IT IS STORED RATHER THAN COMPUTED ON DEMAND. The listing is opened by a
// human waiting for it, and computing thumbnails there would mean decoding
// every world's heightmap on every open — 8 MB for a 2048² world. Written at
// snapshot time the heightmap is already in memory, so the marginal cost is
// the averaging pass alone.

import { MAX_HEIGHT, MIN_HEIGHT, WORLD_THUMBNAIL_SIZE, bandOf } from '@terrace/shared';

/**
 * Bounds a band value into a signed byte.
 *
 * The real range is set by the height limits — at BAND_HEIGHT 16 that is
 * bandOf(MIN_HEIGHT)..bandOf(MAX_HEIGHT), measured as −69..64 across every
 * world in this repo, comfortably inside a byte. The clamp is here anyway
 * because the limits are constants somebody may move, and a silent wrap would
 * turn a deep trench into a mountain in the one artefact whose whole job is
 * to look like the world.
 */
const MIN_BAND = -128;
const MAX_BAND = 127;

/** Bytes a thumbnail occupies, and what a reader should expect to find. */
export const THUMBNAIL_BYTES = WORLD_THUMBNAIL_SIZE * WORLD_THUMBNAIL_SIZE;

/**
 * Downsamples a heightmap to a thumbnail's worth of band numbers.
 *
 * `cells` is row-major, `worldSize` cells to a side — the same layout every
 * other consumer of a heightmap assumes. Worlds smaller than the thumbnail
 * grid are handled by the block loop degenerating to one cell per pixel with
 * repeats, which is the honest answer for a world with fewer cells than the
 * picture has pixels.
 */
export function buildThumbnail(cells: Int16Array, worldSize: number): Buffer {
  if (worldSize <= 0) throw new RangeError(`worldSize must be positive, got ${worldSize}`);
  if (cells.length !== worldSize * worldSize) {
    throw new RangeError(
      `heightmap has ${cells.length} cells, expected ${worldSize * worldSize} for a ${worldSize}² world`,
    );
  }

  const out = Buffer.alloc(THUMBNAIL_BYTES);
  const step = worldSize / WORLD_THUMBNAIL_SIZE;

  for (let ty = 0; ty < WORLD_THUMBNAIL_SIZE; ty++) {
    // Block bounds are derived from the pixel index on BOTH edges rather than
    // by adding `step` to the start, so rounding cannot leave a seam of cells
    // belonging to no pixel (or to two).
    const y0 = Math.min(worldSize - 1, Math.floor(ty * step));
    const y1 = Math.max(y0 + 1, Math.min(worldSize, Math.floor((ty + 1) * step)));

    for (let tx = 0; tx < WORLD_THUMBNAIL_SIZE; tx++) {
      const x0 = Math.min(worldSize - 1, Math.floor(tx * step));
      const x1 = Math.max(x0 + 1, Math.min(worldSize, Math.floor((tx + 1) * step)));

      let total = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * worldSize;
        for (let x = x0; x < x1; x++) {
          total += cells[row + x];
          count++;
        }
      }

      const mean = total / count;
      const band = bandOf(mean < MIN_HEIGHT ? MIN_HEIGHT : mean > MAX_HEIGHT ? MAX_HEIGHT : mean);
      const clamped = band < MIN_BAND ? MIN_BAND : band > MAX_BAND ? MAX_BAND : band;
      // writeInt8 rather than an assignment: Buffer entries are unsigned, and
      // a negative band (every cell below sea level) must survive the round
      // trip as a negative.
      out.writeInt8(clamped, ty * WORLD_THUMBNAIL_SIZE + tx);
    }
  }

  return out;
}
