import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { tornadoes } from './sim.ts';

export const TORNADO_SLICE_VERSION = 1;

export function saveTornadoes(): unknown {
  return tornadoes.snapshot();
}

export function loadTornadoes(data: unknown): void {
  tornadoes.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  tornadoes.restore(snapshot);
}
