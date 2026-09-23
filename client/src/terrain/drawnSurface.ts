import {
  DRAWN_FILTER_DENOM, DRAWN_FILTER_REACH, binomialDrawnSample,
  type DrawnFieldSource, type DrawnSurfaceField,
} from '@terrace/shared';
import { isCellReceived, sampleRenderBandHeight, sampleRenderHeight, type TerrainMirror } from './mirror.ts';

const fields = new WeakMap<TerrainMirror, DrawnSurfaceField>();
const MAX_CACHED_SAMPLES = 32_768;

/** Bounded cache, invalidated by every authoritative/predicted write or receipt. */
export function drawnSurface(mirror: TerrainMirror): DrawnSurfaceField | undefined {
  if (mirror.surfaceMode !== 'binomial') return undefined;
  let field = fields.get(mirror);
  if (field) return field;
  const cache = new Map<number, number>();
  let revision = mirror.surfaceRevision;
  const source: DrawnFieldSource = {
    size: mirror.map.size,
    sample: (x, y, band) => band === null
      ? sampleRenderHeight(mirror, x, y) : sampleRenderBandHeight(mirror, x, y, band),
    available: (x, y) => isCellReceived(mirror, x, y),
  };
  field = {
    scale: DRAWN_FILTER_DENOM,
    reach: DRAWN_FILTER_REACH,
    sample(x, y, band) {
      // Unmanaged mirrors (fixtures/tools) may mutate map.cells directly.
      if (mirror.surfaceRevision === undefined) return binomialDrawnSample(source, x, y, band);
      if (revision !== mirror.surfaceRevision) {
        cache.clear();
        revision = mirror.surfaceRevision;
      }
      x = Math.max(0, Math.min(source.size - 1, x));
      y = Math.max(0, Math.min(source.size - 1, y));
      // Null and signed band IDs use disjoint integer keys.
      const slot = band === null ? 0 : band >= 0 ? 2 * band + 1 : -2 * band;
      const key = slot * source.size * source.size + y * source.size + x;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const value = binomialDrawnSample(source, x, y, band);
      if (cache.size >= MAX_CACHED_SAMPLES) cache.clear();
      cache.set(key, value);
      return value;
    },
  };
  fields.set(mirror, field);
  return field;
}
