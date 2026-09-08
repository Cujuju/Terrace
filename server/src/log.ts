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
