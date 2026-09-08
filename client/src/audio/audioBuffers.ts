export interface AudioBufferCache {
  get(url: string): Promise<AudioBuffer>;
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

export function reportAssetFailure(url: string, error: unknown): void {
  console.error(`[terrace] audio asset failed to load: ${url}`, error);
}
