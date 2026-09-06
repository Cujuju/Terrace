// Stamps every console line this process writes with the local time.
//
// INSTALLS ON IMPORT, and is imported for that side effect alone — exactly like
// ./quiet-boot.ts beside it, and for a reason that is easy to get wrong: ES
// module imports are HOISTED. A call placed in the importer's body runs only
// after every module it imports has already been evaluated, so any line a
// dependency logs while loading would go out unstamped. Doing the work at this
// module's top level, and importing it second, is what actually makes it first.
//
// WHY THE CONSOLE AND NOT ./log.ts (owner, 2026-09-06: "so I can see when events
// occurred"). Two families of code write to this stream. Core goes through
// log.ts's `[terrace]` helpers; every PLUGIN calls console.* directly with its
// own `[name]` prefix, deliberately — plugins/kit/bridge.ts says so at its own
// console.warn, because a plugin must not have to import the server's logger.
// Stamping log.ts would therefore have stamped core's lines and missed
// `[saucers] a fly-by of 4 saucers came in over the map`, which is precisely the
// kind of line a timestamp is wanted for.
//
// A timestamp is a property of the OUTPUT STREAM, not of each call site. There
// is one stream, so there is one place to stamp it, and no present or future
// caller — core, plugin, or a dependency — has to remember anything.
//
// WHAT IT DOES NOT DO: stamp each line of a multi-line argument. A stack trace
// gets one stamp, at its first line, because that is where the event happened
// and stamping the interior of one message would make it harder to read, not
// easier.

/** Local `HH:MM:SS.mmm`. Fixed width, so the lines stay in a column. */
function stamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Set `TERRACE_LOG_TIMESTAMPS=0` to turn this off — for a supervisor that adds
 * its own (`docker compose logs -t`, journald), where two stamps per line is
 * worse than none.
 */
const DISABLE_ENV = 'TERRACE_LOG_TIMESTAMPS';

/** The console methods that reach the log. `table`/`dir` format their own. */
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

let installed = false;

/**
 * Exported for the one caller that may want it explicitly — a test, or an entry
 * point that is not ./index.ts. Idempotent, so importing this module and then
 * calling it is harmless.
 */
export function installLogTimestamps(): void {
  // Idempotent: a second import must not wrap the wrappers and print two stamps.
  if (installed) return;
  if (process.env[DISABLE_ENV] === '0') return;
  installed = true;
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    // The stamp goes in as its OWN argument rather than concatenated onto the
    // first: console.error(message, error) must keep formatting the error, and
    // a template string would flatten it to "[object Object]".
    target[method] = (...args: unknown[]): void => {
      original.call(console, stamp(), ...args);
    };
  }
  // ANCHOR THE DAY, ONCE. Per-line stamps are time-only to keep the column
  // narrow, which is ambiguous across midnight for a server left running — one
  // dated line at boot resolves that without paying for a date on every line.
  console.log(
    `[terrace] log timestamps are local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}); ` +
      `today is ${new Date().toISOString().slice(0, 10)}`,
  );
}

// The side effect this module exists for. See the header: at top level, not in
// the importer's body, because imports are hoisted past the importer's body.
installLogTimestamps();
