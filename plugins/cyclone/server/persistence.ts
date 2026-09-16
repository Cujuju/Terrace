import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { cyclones } from './sim.ts';

export const CYCLONE_SLICE_VERSION = 1;

let restoredThisCreate = false;

export function saveCyclones(): unknown {
  return cyclones.snapshot();
}

export function loadCyclones(data: unknown): void {
  restoredThisCreate = true;
  cyclones.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  cyclones.restore(snapshot);
}

// Restore runs before create: a create that saw no load starts from an empty
// roster, not the last world's.
export function takeRestoredThisCreate(): boolean {
  const restored = restoredThisCreate;
  restoredThisCreate = false;
  return restored;
}
