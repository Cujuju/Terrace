// The plugin's persistence slice: the live funnels, the id counter and the RNG.
//
// WHY A TORNADO IS PERSISTED AT ALL, when the sky's fronts deliberately are not.
// The sky's argument (docs/DESIGN.md's birds precedent) is that a front nobody
// was watching is not worth restoring and a fresh one arrives within a minute. A
// rotating storm is the other case: it emits events other plugins act on, and
// the engine's generator is the one sequence that explains a world — dropping it
// would mean a server restart silently re-rolls everything a bug report was
// about. A funnel lives about a minute, so what is usually restored here is an
// empty list and a generator; that is the point.
//
// THE PARSE IS THE ENGINE'S, not this file's: the kit owns the record shape, so
// it owns what a valid one looks like (server/src/plugins/kit/rotatingStorms.ts,
// `parseRotatingStormsSnapshot`). A shape that does not parse is DISCARDED WHOLE
// rather than half-applied, and what that costs is cheap — nothing permanent
// goes with it.

import { parseRotatingStormsSnapshot } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { tornadoes } from './sim.ts';

/** Bumped when `save`'s shape changes in a way `load` cannot read blind. */
export const TORNADO_SLICE_VERSION = 1;

export function saveTornadoes(): unknown {
  return tornadoes.snapshot();
}

/**
 * Restores what `save` produced. `fromVersion` is unread: 1 is the only version
 * there has ever been, and the host parks anything higher before this is called
 * (server/src/plugins/slice-envelope.ts).
 */
export function loadTornadoes(data: unknown): void {
  // REPLACE, NEVER ADD: a load runs on a live world for a rollback
  // (server/src/plugins/types.ts, PersistenceSlice), so whatever is in the air
  // now is gone whether or not the slice below turns out to be readable. An
  // unreadable one therefore leaves an EMPTY sky, not the old one.
  tornadoes.reset();
  const snapshot = parseRotatingStormsSnapshot(data);
  if (snapshot === null) return;
  tornadoes.restore(snapshot);
}
