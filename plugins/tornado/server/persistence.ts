import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { tornadoes } from './sim.ts';

export const TORNADO_SLICE_VERSION = 1;

let restoredThisCreate = false;

export function saveTornadoes(): unknown {
  return tornadoes.snapshot();
}

export function loadTornadoes(data: unknown): void {
  restoredThisCreate = true;
  tornadoes.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  tornadoes.restore(snapshot);
}

// Restore runs before create: a create that saw no load starts from an empty
// roster, not the last world's.
export function takeRestoredThisCreate(): boolean {
  const restored = restoredThisCreate;
  restoredThisCreate = false;
  return restored;
}
