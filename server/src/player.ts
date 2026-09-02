// The Player object. Deliberately minimal and account-free (design doc:
// accounts are deferred and will arrive as an auth plugin, not as core). The
// shape must stay stable enough that such a plugin can attach identity later
// without core changes — hence `id` is an opaque string, not a database key.
//
// TOKEN vs ID (added 2026-08-19, issue #17 — per-player territory). `id` stays
// the Colyseus sessionId: a CONNECTION identifier, gone the instant a socket
// drops and reused for nothing else. `token` is a DURABLE identity the client
// generates once (crypto.randomUUID(), persisted in its own localStorage) and
// resends on every join — the thing per-player unlock masks are actually keyed
// by (see World.unlockChunkForToken), so a reconnect with the same token gets
// the same territory back even though it lands on a brand-new sessionId. This
// is deliberately still pre-auth and auth-plugin-compatible: a client-generated token
// proves nothing about who is holding it, exactly like today's opaque
// sessionId proves nothing — it is a stronger LOCAL-BROWSER identity, not an
// account, and an auth plugin can still slot in ahead of it later without
// changing this shape.

/** Maximum accepted display-name length, in code points. */
export const MAX_PLAYER_NAME_LENGTH = 24;

/** Fallback name prefix when a client joins without a usable display name. */
const ANONYMOUS_NAME_PREFIX = 'Player-';

/** Space (0x20) — the first printable ASCII code point. Below it are C0 controls. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/** DEL (0x7f) — printable-range outlier that is still a control character. */
const DELETE_CODE_POINT = 0x7f;

/**
 * Maximum accepted token length. A `crypto.randomUUID()` token is 36
 * characters; this is generous headroom for a future non-UUID token format
 * (e.g. a longer opaque id) without inviting a client to hand the server an
 * unbounded string it would otherwise store, index, and persist forever.
 */
export const MAX_PLAYER_TOKEN_LENGTH = 64;

/**
 * A token's accepted charset: ASCII letters, digits, dash, underscore. Covers
 * a UUID's hex-and-dashes shape with room for other reasonable opaque-id
 * schemes, while excluding anything that could carry meaning in a log line,
 * a SQL LIKE pattern, or a future URL — this string round-trips through
 * SQLite TEXT columns and JSON with no escaping to get wrong.
 */
const PLAYER_TOKEN_CHARSET_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Prefix for the fallback identity handed to a connection whose token was
 * missing or unusable. `:` is outside PLAYER_TOKEN_CHARSET_PATTERN, so no
 * value that ever PASSED sanitization can collide with a fallback token —
 * the two token spaces are disjoint by construction, not by convention.
 */
const SESSION_SCOPED_TOKEN_PREFIX = 'session:';

export interface Player {
  /** Opaque per-connection id. Currently the Colyseus sessionId. */
  readonly id: string;
  /**
   * Durable per-player identity (see the file header). Always populated —
   * sanitizePlayerToken degrades a missing or malformed value to a
   * session-scoped fallback rather than leaving this empty, so every Player
   * has a token to key an unlock mask by.
   */
  readonly token: string;
  /** Display name; already sanitized (see sanitizePlayerName). */
  readonly name: string;
}

/**
 * Drops control characters. They are stripped from display names because they
 * would otherwise corrupt self-hosters' log output and client-side text
 * rendering. Iterating by code point (not code unit) keeps surrogate pairs —
 * emoji names survive intact.
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) continue;
    out += char;
  }
  return out;
}

/**
 * Sanitizes an untrusted display name from a join option.
 *
 * UNTRUSTED INPUT: this string is echoed to other clients and handed to
 * plugins, so it is length-capped and stripped of control characters. Anything
 * unusable degrades to a deterministic anonymous name rather than being
 * rejected — a bad name must never block a join.
 */
export function sanitizePlayerName(raw: unknown, sessionId: string): string {
  if (typeof raw !== 'string') return ANONYMOUS_NAME_PREFIX + sessionId;
  const cleaned = stripControlCharacters(raw).trim();
  if (cleaned.length === 0) return ANONYMOUS_NAME_PREFIX + sessionId;
  // Cap by code point, not UTF-16 code unit: slice() cuts code units, which
  // can land inside a surrogate pair (e.g. an emoji) and leave a lone,
  // unpaired surrogate in the stored/broadcast name.
  return Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('');
}

/**
 * Sanitizes an untrusted durable-identity token from a join option (issue
 * #17). Mirrors sanitizePlayerName's shape exactly: UNTRUSTED INPUT, checked
 * against a length cap and (here, additionally) a fixed charset, and ANYTHING
 * unusable degrades to a deterministic per-connection fallback rather than
 * being rejected — a bad token must never block a join, exactly like a bad
 * name never does.
 *
 * "Degrades to a session-scoped identity" (the owner's own phrase for this,
 * issue #17) means precisely this fallback: a client that sent no token, an
 * empty one, one over MAX_PLAYER_TOKEN_LENGTH, or one outside the accepted
 * charset gets an identity good for exactly this connection and no other —
 * it will not reconnect into the same per-player unlock mask, which is the
 * honest consequence of not having presented a real one.
 */
export function sanitizePlayerToken(raw: unknown, sessionId: string): string {
  if (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= MAX_PLAYER_TOKEN_LENGTH &&
    PLAYER_TOKEN_CHARSET_PATTERN.test(raw)
  ) {
    return raw;
  }
  return SESSION_SCOPED_TOKEN_PREFIX + sessionId;
}
