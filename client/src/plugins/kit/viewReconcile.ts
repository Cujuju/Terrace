// Keeping a map of scene views in step with a map of ids.
//
// EVERY PLUGIN THAT DRAWS A LIST HAS THIS FUNCTION. weather, storms, monsters
// and wildlife each wrote their own: walk the sampled ids, build a view for one
// that appeared, then walk the views and drop one whose id has gone. The
// bookkeeping is identical every time; what differs is what a view IS and — in
// one documented case — which half runs first.
//
// WHAT DID NOT MOVE. Building and tearing down a view is the plugin's business
// entirely: acquiring from a pool, adding to a container, pushing a retiring
// light onto a fade list. This owns only the two loops and the map.

/** What a plugin does with the ids that appeared, vanished, or changed body. */
export interface ViewReconcileSpec<T, V> {
  /**
   * Which loop runs first.
   *
   * 'release-first' matters where views are POOLED: one broadcast can retire a
   * thing and introduce another that wants exactly the same rig, and acquiring
   * first makes the newcomer build one while the rig it could have reused is
   * still a frame away from the free list — a needless buffer and, for a shader
   * material, a needless recompile.
   *
   * 'acquire-first' (the default) is for the plugins whose teardown is ordinary
   * and whose release path reads state the acquire loop may have written.
   */
  readonly order?: 'acquire-first' | 'release-first';
  /** Builds the view for an id that has just appeared. */
  acquire(id: number, item: T): V;
  /** Retires the view of an id that is no longer listed. */
  release(id: number, view: V): void;
  /**
   * A LIVE ID WHOSE VIEW NO LONGER FITS ITS ITEM — return the replacement, or
   * null to keep the one that is there. Absent when a plugin's views never need
   * rebuilding, which is most of them.
   */
  replace?(id: number, item: T, view: V): V | null;
}

/**
 * Reconciles `views` against `sampled`, in place.
 *
 * `views` is the plugin's own map and stays its own: this only adds the entries
 * `acquire` returned and deletes the ones it released, so a plugin can keep
 * whatever else it likes in the value.
 */
export function reconcileById<T, V>(
  sampled: ReadonlyMap<number, T>,
  views: Map<number, V>,
  spec: ViewReconcileSpec<T, V>,
): void {
  const releaseVanished = (): void => {
    for (const [id, view] of views) {
      if (sampled.has(id)) continue;
      spec.release(id, view);
      views.delete(id);
    }
  };

  const acquireAppeared = (): void => {
    for (const [id, item] of sampled) {
      const existing = views.get(id);
      if (existing !== undefined) {
        const replacement = spec.replace?.(id, item, existing) ?? null;
        if (replacement !== null) views.set(id, replacement);
        continue;
      }
      views.set(id, spec.acquire(id, item));
    }
  };

  if (spec.order === 'release-first') {
    releaseVanished();
    acquireAppeared();
    return;
  }
  acquireAppeared();
  releaseVanished();
}
