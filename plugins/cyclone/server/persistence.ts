import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { cyclones } from './sim.ts';

export const CYCLONE_SLICE_VERSION = 1;

export function saveCyclones(): unknown {
  return cyclones.snapshot();
}

export function loadCyclones(data: unknown): void {
  cyclones.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  cyclones.restore(snapshot);
}
