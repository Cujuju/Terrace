// The plugin's persistence slice: the live storms, the name counter and the RNG.
//
// WHY A STORM IS PERSISTED AT ALL, when weather's fronts deliberately are not.
// Weather's argument (docs/DESIGN.md's birds precedent) is that a front nobody
// was watching is not worth restoring and a fresh one arrives within a minute.
// A cyclone is the other case: it lives eight minutes, it is a NAMED event a
// world can be in the middle of, and dropping it mid-landfall would mean a
// server restart is the reliable way to make a hurricane go away. The name
// counter has to travel with it or a restarted world starts the roster again
// and gets two Hurricane Adas.
//
// STRUCTURAL VALIDATION ON LOAD, exactly as every other plugin's slice does:
// the saved blob comes from a database file that may predate this code, so a
// shape that does not parse is DISCARDED WHOLE rather than half-applied.
//
// WHAT DISCARDING COSTS HERE, stated rather than assumed: the world loses
// whatever storms were in the air and starts naming from Ada again. That is
// cheap — nothing permanent is lost, because the only permanent thing a storm
// does is a surge that has already been sculpted into the heightmap and is
// saved by core, not by this slice. So this parse can afford to be total: the
// first bad field abandons the whole load.

import { STORM_KINDS, type StormKind } from '../protocol.ts';
import {
  resetStorms,
  restoreStorms,
  stormSnapshot,
  type Storm,
  type StormSnapshot,
} from './storms.ts';

/** Bumped when `save`'s shape changes in a way `load` cannot read blind. */
export const STORMS_SLICE_VERSION = 1;

export function saveStorms(): unknown {
  return stormSnapshot();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStorm(value: unknown): Storm | null {
  if (typeof value !== 'object' || value === null) return null;
  const {
    id,
    kind,
    x,
    y,
    radius,
    heading,
    peakIntensity,
    envelope,
    retiring,
    lifeSeconds,
    name,
    landfallReported,
    damageDebtSeconds,
    surgeDebtSeconds,
  } = value as Record<string, unknown>;

  if (!Number.isInteger(id)) return null;
  if (typeof kind !== 'string' || !STORM_KINDS.includes(kind as StormKind)) return null;
  for (const number of [x, y, radius, heading, peakIntensity, envelope, lifeSeconds]) {
    if (!isFiniteNumber(number)) return null;
  }
  if (!isFiniteNumber(damageDebtSeconds) || damageDebtSeconds < 0) return null;
  // Absent in slices written before the surge debt was persisted (2026-08-28);
  // a missing debt is a debt of zero, not a corrupt storm.
  const surgeDebt = surgeDebtSeconds === undefined ? 0 : surgeDebtSeconds;
  if (!isFiniteNumber(surgeDebt) || surgeDebt < 0) return null;
  if (typeof retiring !== 'boolean' || typeof landfallReported !== 'boolean') return null;
  if (name !== undefined && typeof name !== 'string') return null;

  return {
    id: id as number,
    kind: kind as StormKind,
    x: x as number,
    y: y as number,
    radius: radius as number,
    heading: heading as number,
    peakIntensity: peakIntensity as number,
    envelope: envelope as number,
    retiring: retiring as boolean,
    lifeSeconds: lifeSeconds as number,
    ...(typeof name === 'string' ? { name } : {}),
    landfallReported: landfallReported as boolean,
    damageDebtSeconds: damageDebtSeconds as number,
    surgeDebtSeconds: surgeDebt,
  };
}

/**
 * Restores what `save` produced. `fromVersion` is unread: 1 is the only version
 * there has ever been, and the host parks anything higher before this is called
 * (server/src/plugins/slice-envelope.ts).
 */
export function loadStorms(data: unknown): void {
  // REPLACE, NEVER ADD: a load runs on a live world for a rollback
  // (server/src/plugins/types.ts, PersistenceSlice), so whatever is in the air
  // now is gone whether or not the slice below turns out to be readable. Every
  // early return after this line therefore leaves an EMPTY sky, not the old one
  // (review 2026-08-28).
  resetStorms();
  if (typeof data !== 'object' || data === null) return;
  const { nextStormId, namedCycloneCount, rngState, storms } = data as Record<string, unknown>;
  if (!Number.isInteger(nextStormId) || !Number.isInteger(namedCycloneCount)) return;
  if (!Number.isInteger(rngState)) return;
  if (!Array.isArray(storms)) return;

  const parsed: Storm[] = [];
  for (const value of storms) {
    const storm = parseStorm(value);
    if (storm === null) return;
    parsed.push(storm);
  }

  const snapshot: StormSnapshot = {
    nextStormId: nextStormId as number,
    namedCycloneCount: namedCycloneCount as number,
    rngState: rngState as number,
    storms: parsed,
  };
  restoreStorms(snapshot);
}
