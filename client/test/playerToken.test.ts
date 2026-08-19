// Contract tests for the durable per-browser identity token (issue #17):
// generated once, persisted, reused — and degrades gracefully with no
// localStorage at all, exactly like state/controlPrefs.ts (see that file's
// own test for the established pattern this one follows).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'terrace.playerToken.v1';

/** Minimal in-memory localStorage; installed before each fresh import. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** A fresh module instance, so the internal module-scope cache never leaks between tests. */
async function freshModule(initial?: Record<string, string>): Promise<{
  getOrCreatePlayerToken: () => string;
  storage: Storage;
}> {
  vi.resetModules();
  const storage = fakeStorage(initial);
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  const mod = await import('../src/state/playerToken.ts');
  return { getOrCreatePlayerToken: mod.getOrCreatePlayerToken, storage };
}

beforeEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('getOrCreatePlayerToken', () => {
  it('generates a fresh token and persists it when none is stored', async () => {
    const { getOrCreatePlayerToken, storage } = await freshModule();

    const token = getOrCreatePlayerToken();

    expect(token.length).toBeGreaterThan(0);
    expect(storage.getItem(STORAGE_KEY)).toBe(token);
  });

  it('reuses the SAME token across repeated calls in one session', async () => {
    const { getOrCreatePlayerToken } = await freshModule();
    expect(getOrCreatePlayerToken()).toBe(getOrCreatePlayerToken());
  });

  it('reads back an already-stored token instead of generating a new one', async () => {
    const existing = 'existing-token-value';
    const { getOrCreatePlayerToken, storage } = await freshModule({ [STORAGE_KEY]: existing });

    expect(getOrCreatePlayerToken()).toBe(existing);
    expect(storage.getItem(STORAGE_KEY)).toBe(existing); // unchanged, not overwritten
  });

  it('two fresh module instances (i.e. two browsers with empty storage) generate DIFFERENT tokens', async () => {
    // `globalThis.localStorage` is ONE shared binding in this process (there
    // is only ever one real localStorage in an actual browser), so the first
    // token must be read out BEFORE the second freshModule() call swaps that
    // binding to a different backing store — reading both after both swaps
    // would have both calls observe whichever storage happened to be current
    // at CALL time, not at each module's own import time, and is not a bug
    // this module has: it deliberately reads localStorage lazily, on every
    // call, rather than caching a stale reference (see readStoredToken).
    const first = await freshModule();
    const firstToken = first.getOrCreatePlayerToken();

    const second = await freshModule();
    const secondToken = second.getOrCreatePlayerToken();

    expect(firstToken).not.toBe(secondToken);
  });

  it('degrades to a session-only in-memory token when localStorage does not exist at all', async () => {
    vi.resetModules();
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const mod = await import('../src/state/playerToken.ts');

    const token = mod.getOrCreatePlayerToken();
    expect(token.length).toBeGreaterThan(0);
    // Still stable within the session even though nothing was ever stored.
    expect(mod.getOrCreatePlayerToken()).toBe(token);
  });

  it('degrades gracefully when localStorage throws on access (private-mode Safari)', async () => {
    vi.resetModules();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;

    const mod = await import('../src/state/playerToken.ts');
    expect(() => mod.getOrCreatePlayerToken()).not.toThrow();
    expect(mod.getOrCreatePlayerToken().length).toBeGreaterThan(0);
  });
});

describe('insecure-context fallback (no crypto.randomUUID)', () => {
  it('mints a valid v4 UUID from getRandomValues alone', async () => {
    // http:// LAN origins have crypto but NOT crypto.randomUUID (secure-context
    // API) — the exact environment of phone/LAN dev testing. Simulate it.
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });
    try {
      vi.resetModules();
      const mod = await import('../src/state/playerToken.ts');
      const token = mod.getOrCreatePlayerToken();
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // Stable across calls, like the primary path.
      expect(mod.getOrCreatePlayerToken()).toBe(token);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
