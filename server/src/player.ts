// The Player object. Deliberately minimal and account-free (design §3.7:
// accounts are deferred and will arrive as an auth plugin, not as core). The
// shape must stay stable enough that such a plugin can attach identity later
// without core changes — hence `id` is an opaque string, not a database key.

/** Maximum accepted display-name length, in code points. */
export const MAX_PLAYER_NAME_LENGTH = 24;

/** Fallback name prefix when a client joins without a usable display name. */
const ANONYMOUS_NAME_PREFIX = 'Player-';

/** Space (0x20) — the first printable ASCII code point. Below it are C0 controls. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/** DEL (0x7f) — printable-range outlier that is still a control character. */
const DELETE_CODE_POINT = 0x7f;

export interface Player {
  /** Opaque per-connection id. Currently the Colyseus sessionId. */
  readonly id: string;
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
