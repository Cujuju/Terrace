// URL-keyed decode cache, shared by every plugin.

/** A URL-keyed store of decoded buffers and the decodes still in flight. */
export interface AudioBufferCache {
  /** Decoded buffer for this URL; concurrent askers share one fetch. */
  get(url: string): Promise<AudioBuffer>;
  /**
   * The promise for this URL if one exists, WITHOUT starting a decode — how
   * `playSfx` can drop a not-yet-ready one-shot instead of playing it late.
   */
  peek(url: string): Promise<AudioBuffer> | undefined;
  clear(): void;
}

export function createAudioBufferCache(context: AudioContext): AudioBufferCache {
  const decoded = new Map<string, Promise<AudioBuffer>>();

  return {
    get(url: string): Promise<AudioBuffer> {
      const existing = decoded.get(url);
      if (existing !== undefined) return existing;
      const promise = fetch(url)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`audio asset ${url} responded ${String(response.status)}`);
          }
          return context.decodeAudioData(await response.arrayBuffer());
        })
        .catch((error: unknown) => {
          // Not cached, so a transient network failure can be retried.
          decoded.delete(url);
          throw error;
        });
      decoded.set(url, promise);
      return promise;
    },

    peek(url: string): Promise<AudioBuffer> | undefined {
      return decoded.get(url);
    },

    clear(): void {
      decoded.clear();
    },
  };
}

/** Logged, not thrown: a 404 costs one plugin its sound, nothing more. */
export function reportAssetFailure(url: string, error: unknown): void {
  console.error(`[terrace] audio asset failed to load: ${url}`, error);
}
