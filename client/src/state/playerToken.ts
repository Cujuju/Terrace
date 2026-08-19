// Durable per-browser player identity (design decision, issue #17 — per-player
// territory: "client generates an opaque token, persisted in localStorage,
// sent in join options"). This is what per-player unlock masks are keyed by
// server-side — see server/src/world/world.ts's per-token masks and
// server/src/player.ts's sanitizePlayerToken, which is the server-side
// counterpart of the sanitizing this module does NOT need to do (a token this
// module itself minted is trusted; sanitizePlayerToken exists for the server
// to distrust every OTHER byte that arrives claiming to be one).
//
// Generated ONCE per browser and reused forever after: the whole point is
// that closing the tab and coming back must land on the SAME identity, so a
// per-connection id (like the Colyseus sessionId this token rides alongside
// on the server, see player.ts) would defeat the feature entirely.

/** Versioned localStorage key, same convention as state/hudState.ts and state/controlPrefs.ts. */
const STORAGE_KEY = 'terrace.playerToken.v1';

/**
 * Module-scope cache so a dropped-then-restored connection within the same
 * page load always resends the IDENTICAL token without re-touching
 * localStorage — only a fresh page load (a genuinely new tab/profile, or
 * storage having been cleared in between) re-reads it.
 */
let cachedToken: string | null = null;

/**
 * Best-effort localStorage read. Private-mode Safari and disabled storage
 * both throw on ANY access (not just .setItem), and a non-browser context —
 * this module's own test run included, client tests execute in a plain Node
 * environment (design §8, client/vite.config.ts) with no `localStorage`
 * global at all — must degrade to "no persisted token" rather than throw.
 */
function readStoredToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Mirrors readStoredToken's degrade-don't-throw policy for the write side. */
function writeStoredToken(token: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Best effort, same as every other localStorage write in this codebase
    // (see state/controlPrefs.ts): the in-memory token still works for this
    // session, it simply will not survive a reload.
  }
}

/**
 * Mints a fresh v4 UUID. `crypto.randomUUID()` when it exists — but that API
 * is SECURE-CONTEXT-ONLY (https or localhost; verified against the WebCrypto
 * spec and reproduced live), so a LAN-served dev page (http://192.168.x.x:5173,
 * the normal phone-testing path) does not have it and calling it threw,
 * silently killing the join and pinning the client at "Offline" while
 * localhost worked. `crypto.getRandomValues` has no such restriction, so the
 * fallback assembles the same RFC 4122 v4 shape from it byte for byte.
 */
function mintToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 §4.4: version nibble = 4, variant top bits = 10.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Returns this browser's durable player token, generating and persisting one
 * on first call. See mintToken for why generation must not assume a secure
 * context.
 */
export function getOrCreatePlayerToken(): string {
  if (cachedToken !== null) return cachedToken;

  const stored = readStoredToken();
  if (stored !== null && stored.length > 0) {
    cachedToken = stored;
    return cachedToken;
  }

  const fresh = mintToken();
  writeStoredToken(fresh);
  cachedToken = fresh;
  return fresh;
}
