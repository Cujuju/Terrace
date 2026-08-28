// The plugin's persistence slice: the vents, the crust, and the RNG.
//
// STRUCTURAL VALIDATION ON LOAD, exactly as every other plugin's slice does:
// the saved blob comes from a database file that may predate this code, so a
// shape that does not parse is DISCARDED WHOLE rather than half-applied.
//
// WHAT DISCARDING COSTS HERE, stated rather than assumed — it is not the same
// bargain boats made. A discarded fleet rebuilds in a minute; a discarded vent
// list does NOT rebuild, because `seeded` goes with it and a world that comes
// back unseeded is re-sited from scratch, on ground that already has cones on
// it. So the parse below is deliberately total: every field of every vent and
// every cell is checked, and the first failure abandons the whole load rather
// than keeping the vents and dropping the crust. A world that fails to parse
// gets a fresh siting, which is a visible, explicable outcome; a world that
// half-loads gets two generations of mountains, which is neither.

import { restoreVolcanoes, volcanoSnapshot, type Vent, type VolcanoSnapshot } from './vents.ts';

/** Bumped when `save`'s shape changes in a way `load` cannot read blind. */
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
    // NOT read from the blob, whatever it says: an eruption does not survive a
    // restart (see vents.ts's header), and `save` already writes false.
    erupting: false,
    phaseSeconds: phaseSeconds as number,
    coneBands: coneBands as number,
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

/**
 * Restores what `save` produced. `fromVersion` is unread: 1 is the only version
 * there has ever been, and the host parks anything higher before this is called
 * (server/src/plugins/slice-envelope.ts).
 */
export function loadVolcanoes(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const { seeded, nextVentId, rngState, vents, lava } = data as Record<string, unknown>;
  if (typeof seeded !== 'boolean') return;
  if (!Number.isInteger(nextVentId) || !Number.isInteger(rngState)) return;
  if (!Array.isArray(vents) || !Array.isArray(lava)) return;

  const parsedVents: Vent[] = [];
  for (const value of vents) {
    const vent = parseVent(value);
    if (vent === null) return;
    parsedVents.push(vent);
  }

  const parsedLava: Array<{ x: number; y: number; ageSeconds: number }> = [];
  for (const value of lava) {
    const cell = parseLavaCell(value);
    if (cell === null) return;
    parsedLava.push(cell);
  }

  const snapshot: VolcanoSnapshot = {
    seeded,
    nextVentId: nextVentId as number,
    rngState: rngState as number,
    vents: parsedVents,
    lava: parsedLava,
  };
  restoreVolcanoes(snapshot);
}
