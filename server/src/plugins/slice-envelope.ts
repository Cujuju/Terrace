// THE SNAPSHOT SLICE ENVELOPE: `{ v, data }`, owned by the host.
//
// WHY THE HOST OWNS THE VERSION. Before this, a plugin slice was stored as
// whatever `save()` returned and handed back with one argument and no version.
// Nine of sixteen plugins have a slice; six had invented a version field of
// their own and three had none at all, so those three literally could not tell
// an old slice from a new one — and none of them could tell a slice written by
// a NEWER build, which is exactly what an update or a rollback of code
// produces. Research: docs/plans/plugin-hot-unload.md §1.5, §3.3.
//
// THE LEGACY READ PATH IS NOT OPTIONAL — it is 100 % of the bytes on every
// world file that exists. A value that is not an envelope is read as version 1
// and handed to `load(data, 1)`; the host rewrites it in envelope form on the
// next save. Without this rule, unwrapping a raw value yields `v === undefined`
// and `data === undefined`, `load(undefined, undefined)` runs, and every plugin
// comes up EMPTY on the first boot after the change — breaching the persistence
// promise ("restart; the world comes back from SQLite intact") and DESIGN's "nothing
// deletes a world implicitly".
//
// It is PERMANENT, not a one-boot migration: `restore_points` rows hold old
// `plugin_slices` bytes forever (persistence/snapshot-store.ts), so a rollback
// to a point written before this change reads through this same rule for as
// long as that point exists. There is no rewrite pass over history and there
// must not be one — a restore point is a record of a moment, and rewriting its
// bytes to a shape the moment did not have is falsifying it.
//
// AN ENVELOPE IS RECOGNISED BY BOTH KEYS, NOT BY `v` ALONE. Six plugins already
// carry a version INSIDE their data — chronicle writes `{ v: 2, entries, … }` —
// so `v` on its own does not distinguish an envelope from one of those. No
// plugin's save value has a top-level `data` key (verified across all nine), so
// requiring both is unambiguous today and stays unambiguous as long as the
// envelope is the only thing that pairs them.

/**
 * The version a value with no envelope is read as.
 *
 * ONE, because "before versions existed" is the first version by definition:
 * every plugin's pre-envelope format is its v1 as far as the host is concerned,
 * and a plugin whose own format was further along than that says so in its own
 * data and reads it there (see PersistenceSlice.load).
 */
export const LEGACY_SLICE_VERSION = 1;

/** What the host stores for one plugin. */
export interface SliceEnvelope {
  /** The version `data` was written under; integer ≥ 1. */
  readonly v: number;
  readonly data: unknown;
}

/** What a stored value turned out to be. */
export interface StoredSlice {
  /** The version the bytes were written under. */
  readonly version: number;
  /** The plugin's own save value. */
  readonly data: unknown;
  /** False when the value was pre-envelope and read through the legacy rule. */
  readonly enveloped: boolean;
}

/** Whether a version off disk is one a plugin could have written. */
function isSliceVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= LEGACY_SLICE_VERSION;
}

/** Wraps one plugin's save value for storage. */
export function wrapSlice(version: number, data: unknown): SliceEnvelope {
  return { v: version, data };
}

/**
 * Reads a stored slice value, envelope or not. Never throws and never returns
 * `data: undefined` for a value that had content — see this file's header for
 * why that second guarantee is the load-bearing one.
 */
export function readSlice(stored: unknown): StoredSlice {
  if (typeof stored === 'object' && stored !== null) {
    const candidate = stored as Record<string, unknown>;
    if (
      Object.hasOwn(candidate, 'v') &&
      Object.hasOwn(candidate, 'data') &&
      isSliceVersion(candidate.v)
    ) {
      return { version: candidate.v as number, data: candidate.data, enveloped: true };
    }
  }
  return { version: LEGACY_SLICE_VERSION, data: stored, enveloped: false };
}
