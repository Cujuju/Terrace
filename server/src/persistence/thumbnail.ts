import { MAX_HEIGHT, MIN_HEIGHT, WORLD_THUMBNAIL_SIZE, bandOf } from '@terrace/shared';

const MIN_BAND = -128;
const MAX_BAND = 127;

export const THUMBNAIL_BYTES = WORLD_THUMBNAIL_SIZE * WORLD_THUMBNAIL_SIZE;

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
      out.writeInt8(clamped, ty * WORLD_THUMBNAIL_SIZE + tx);
    }
  }

  return out;
}
