// Minimal structured-ish logging. Deliberately not a dependency: self-hosters
// read these lines in `docker compose logs`, so the format is plain text with a
// stable `[terrace]` prefix that is easy to grep and easy to filter out.

const PREFIX = '[terrace]';

export function logInfo(message: string): void {
  console.log(`${PREFIX} ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`${PREFIX} WARN ${message}`);
}

export function logError(message: string, cause?: unknown): void {
  if (cause === undefined) {
    console.error(`${PREFIX} ERROR ${message}`);
    return;
  }
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  console.error(`${PREFIX} ERROR ${message}: ${detail}`);
}
