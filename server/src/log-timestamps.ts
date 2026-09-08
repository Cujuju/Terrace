function stamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

const DISABLE_ENV = 'TERRACE_LOG_TIMESTAMPS';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

let installed = false;

export function installLogTimestamps(): void {
  if (installed) return;
  if (process.env[DISABLE_ENV] === '0') return;
  installed = true;
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]): void => {
      original.call(console, stamp(), ...args);
    };
  }
  console.log(
    `[terrace] log timestamps are local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}); ` +
      `today is ${new Date().toISOString().slice(0, 10)}`,
  );
}

installLogTimestamps();
