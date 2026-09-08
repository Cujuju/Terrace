export const MAX_PLAYER_NAME_LENGTH = 24;

const ANONYMOUS_NAME_PREFIX = 'Player-';

const FIRST_PRINTABLE_CODE_POINT = 0x20;

const DELETE_CODE_POINT = 0x7f;

export const MAX_PLAYER_TOKEN_LENGTH = 64;

const PLAYER_TOKEN_CHARSET_PATTERN = /^[A-Za-z0-9_-]+$/;

const SESSION_SCOPED_TOKEN_PREFIX = 'session:';

export interface Player {
  readonly id: string;
  readonly token: string;
  readonly name: string;
}

function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) continue;
    out += char;
  }
  return out;
}

export function sanitizePlayerName(raw: unknown, sessionId: string): string {
  if (typeof raw !== 'string') return ANONYMOUS_NAME_PREFIX + sessionId;
  const cleaned = stripControlCharacters(raw).trim();
  if (cleaned.length === 0) return ANONYMOUS_NAME_PREFIX + sessionId;
  return Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('');
}

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
