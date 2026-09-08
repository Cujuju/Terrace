const STORAGE_KEY = 'terrace.playerToken.v1';

let cachedToken: string | null = null;

function readStoredToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
  }
}

function mintToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
