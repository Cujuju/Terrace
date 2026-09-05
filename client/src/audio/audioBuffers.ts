// The decoded-asset cache: one fetch and one `decodeAudioData` per URL for the
// life of the page, shared by every plugin.
//
// ITS OWN MODULE because it is the one piece of this directory that has no
// opinion about audio at all — it is a promise cache keyed by URL — and because
// "is this buffer ready?" is the question `playSfx` and `preload` are built
// around, so it deserves a name rather than being two lines inside a closure.

/** A URL-keyed store of decoded buffers and the decodes still in flight. */
export interface AudioBufferCache {
  /**
   * The decoded buffer for this URL, fetching and decoding it if nobody has
   * yet. Concurrent askers get the SAME promise rather than racing a second
   * fetch. Rejects if the asset cannot be fetched or decoded.
   */
  get(url: string): Promise<AudioBuffer>;
  /**
   * The in-flight-or-finished promise for this URL, or undefined if nothing has
   * asked for it yet — WITHOUT starting a decode.
   *
   * This is what makes `playSfx` able to answer "is this ready?" without
   * committing to play whatever arrives: a one-shot whose buffer is not here is
   * dropped, because a clap that arrives whenever the network finished is worse
   * than no clap (see PluginAudio.playSfx).
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
          // A FAILED DECODE IS NOT CACHED: the next caller gets a fresh attempt
          // rather than a permanently poisoned URL. A resolved one is kept
          // forever, because a decoded buffer is exactly what a cache is for.
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

/**
 * A failed load costs one plugin its sound and nothing else — the same
 * containment every plugin-facing seam in plugins/host.ts gives. Logged rather
 * than swallowed: a 404 on an asset is a real defect, and the alternative to a
 * line here is silence nobody can explain.
 */
export function reportAssetFailure(url: string, error: unknown): void {
  console.error(`[terrace] audio asset failed to load: ${url}`, error);
}
