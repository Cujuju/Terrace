import { restoreVolcanoes, volcanoSnapshot, type Vent, type VolcanoSnapshot } from './vents.ts';
import { parseRecordArray } from '@terrace/shared';

export const VOLCANOES_SLICE_VERSION = 1;

export function saveVolcanoes(): unknown {
  return volcanoSnapshot();
}

function parseVent(value: unknown): Vent | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, phaseSeconds, coneBands } = value as Record<string, unknown>;
  if (!Number.isInteger(id) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (!Number.isInteger(coneBands)) return null;
  if (typeof phaseSeconds !== 'number' || !Number.isFinite(phaseSeconds)) return null;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    erupting: false,
    phaseSeconds: phaseSeconds as number,
    coneBands: coneBands as number,
  };
}

function parsePendingConeSculpt(
  value: unknown,
): { x: number; y: number; radius: number; amount: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, radius, amount } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (!Number.isInteger(radius) || !Number.isInteger(amount)) return null;
  return {
    x: x as number,
    y: y as number,
    radius: radius as number,
    amount: amount as number,
  };
}

function parseLavaCell(value: unknown): { x: number; y: number; ageSeconds: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, ageSeconds } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return null;
  }
  return { x: x as number, y: y as number, ageSeconds: ageSeconds as number };
}

export function loadVolcanoes(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const { seeded, nextVentId, rngState, vents, lava, pendingConeSculpts } = data as Record<
    string,
    unknown
  >;
  if (typeof seeded !== 'boolean') return;
  if (!Number.isInteger(nextVentId) || !Number.isInteger(rngState)) return;
  const parsedVents = parseRecordArray(vents, parseVent);
  if (parsedVents === null) return;

  const parsedLava = parseRecordArray(lava, parseLavaCell);
  if (parsedLava === null) return;

  let parsedPending: Array<{ x: number; y: number; radius: number; amount: number }> = [];
  if (pendingConeSculpts !== undefined) {
    const steps = parseRecordArray(pendingConeSculpts, parsePendingConeSculpt);
    if (steps === null) return;
    parsedPending = steps;
  }

  const snapshot: VolcanoSnapshot = {
    seeded,
    nextVentId: nextVentId as number,
    rngState: rngState as number,
    vents: parsedVents,
    lava: parsedLava,
    pendingConeSculpts: parsedPending,
  };
  restoreVolcanoes(snapshot);
}
