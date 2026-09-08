export interface ViewReconcileSpec<T, V> {
  readonly order?: 'acquire-first' | 'release-first';
  acquire(id: number, item: T): V;
  release(id: number, view: V): void;
  replace?(id: number, item: T, view: V): V | null;
}

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
