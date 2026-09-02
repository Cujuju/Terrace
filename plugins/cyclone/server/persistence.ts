// The plugin's persistence slice: the live cyclones, the name counter and the RNG.
//
// WHY A CYCLONE IS PERSISTED AT ALL, when the sky's fronts deliberately are not.
// The sky's argument (docs/DESIGN.md's birds precedent) is that a front nobody
// was watching is not worth restoring and a fresh one arrives within a minute. A
// cyclone is the other case: it lives eight minutes, it is a NAMED event a world
// can be in the middle of, and dropping it mid-landfall would mean a server
// restart is the reliable way to make a hurricane go away. The name counter has
// to travel with it or a restarted world starts the roster again and gets two
// Hurricane Adas.
//
// THE PARSE IS THE ENGINE'S, not this file's: the kit owns the record shape, so
// it owns what a valid one looks like (server/src/plugins/kit/rotatingStorms.ts,
// `parseRotatingStormsSnapshot`). A shape that does not parse is DISCARDED WHOLE
// rather than half-applied, and what that costs is cheap — nothing permanent
// goes with it.

import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { cyclones } from './sim.ts';

/** Bumped when `save`'s shape changes in a way `load` cannot read blind. */
export const CYCLONE_SLICE_VERSION = 1;

export function saveCyclones(): unknown {
  return cyclones.snapshot();
}

/**
 * Restores what `save` produced. `fromVersion` is unread: 1 is the only version
 * there has ever been, and the host parks anything higher before this is called
 * (server/src/plugins/slice-envelope.ts).
 */
export function loadCyclones(data: unknown): void {
  // REPLACE, NEVER ADD: a load runs on a live world for a rollback
  // (server/src/plugins/types.ts, PersistenceSlice), so whatever is in the air
  // now is gone whether or not the slice below turns out to be readable. An
  // unreadable one therefore leaves an EMPTY sky, not the old one.
  cyclones.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  cyclones.restore(snapshot);
}
