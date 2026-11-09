interface Disposable {
  dispose(): void;
}

/** Pending assets belong to a mount until attach explicitly takes ownership. */
export function createPreloadAssets<T extends Disposable>() {
  const pending = new WeakMap<AbortSignal, { asset: T; cancel: () => void }>();

  function discard(signal: AbortSignal): void {
    const entry = pending.get(signal);
    if (entry === undefined) return;
    pending.delete(signal);
    signal.removeEventListener('abort', entry.cancel);
    entry.asset.dispose();
  }

  return {
    async load(signal: AbortSignal, acquire: () => Promise<T>): Promise<void> {
      if (signal.aborted) return;
      const asset = await acquire();
      if (signal.aborted) { asset.dispose(); return; }
      discard(signal);
      const cancel = () => discard(signal);
      pending.set(signal, { asset, cancel });
      signal.addEventListener('abort', cancel, { once: true });
    },
    take(signal: AbortSignal): T | undefined {
      const entry = pending.get(signal);
      if (entry === undefined) return undefined;
      pending.delete(signal);
      signal.removeEventListener('abort', entry.cancel);
      return entry.asset;
    },
    discard,
  };
}
