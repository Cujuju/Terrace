// chronicle — the wire contract shared by the plugin's server and client
// halves. The chronicle is a world-history log written by the systems
// themselves: other plugins emit server-side events (WorldApi.emitEvent), the
// chronicle turns the notable ones into saga lines, and clients render the
// scroll.
//
// FOG OF WAR, BY CONSTRUCTION RATHER THAN BY FILTER: an entry on the wire is
// only { day, text }, and the text names places through invented names
// (server/names.ts), never through coordinates. The saga is world lore —
// every player hears that "ruin took four homes at Harrowmere" — but nothing
// in the payload says where Harrowmere is, so the broadcast leaks nothing the
// unlock mask protects. That is why this plugin may use plain `broadcast`
// while every position-bearing plugin must use `broadcastVisible`.

export const CHRONICLE_PLUGIN_NAME = 'chronicle';

/** Full-log replace: the join snapshot (and nothing else — no keepalive). */
export const CHRONICLE_LOG_MESSAGE = 'log';

/** Additive delta: one or more entries just written. */
export const CHRONICLE_APPEND_MESSAGE = 'append';

/**
 * One saga line, stamped with the day OF THE WORLD'S LIFE it was written on —
 * 0 for the world's first day, which is what a heading renders as "Day 1".
 *
 * NOT THE CALENDAR DAY, and since the world clock was anchored to real time
 * (shared/src/calendar.ts) those are two different numbers: the calendar day
 * says which Monday it is and is shared by every world in existence, this one
 * says how old this world was. The WEEKDAY still has to come from the calendar
 * day, so every payload carrying entries also carries `genesisDay` — add it to
 * an entry's `day` and you have the calendar day back.
 */
export interface ChronicleEntry {
  readonly day: number;
  readonly text: string;
}

/**
 * Parses the `genesisDay` an entry-bearing payload carries: the calendar day
 * this world's day 0 fell on. Null when absent or malformed, which a caller
 * reads as "keep whatever offset I already had" rather than as an error —
 * losing the weekday is not worth dropping a page of history over.
 *
 * ANY INTEGER, INCLUDING A NEGATIVE ONE, unlike an entry's own day: a saga can
 * be older than the clock it now runs on (see the server's sagaGenesisMillis),
 * and `weekdayOf` is total over negative days by construction. Rejecting the
 * sign here would throw away the offset in precisely the case it corrects for.
 */
export function parseGenesisDay(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const day = (payload as { genesisDay?: unknown }).genesisDay;
  return Number.isInteger(day) ? (day as number) : null;
}

/**
 * Oldest-entry eviction cap. 512 matches STRUCTURES_CAP's scale for the same
 * kind of reason: it bounds the snapshot slice and the join payload (~60 B a
 * line, so ~30 KB worst case — comparable to flora's 18 KB ceiling) while
 * holding weeks of saga at the rates the emitting systems actually run.
 * When the cap is hit the oldest pages are dropped; the chronicle is a saga,
 * not an audit log, and a saga's early chapters passing out of memory is in
 * genre.
 */
export const CHRONICLE_MAX_ENTRIES = 512;

/** Longest text a single entry may carry on the wire (defensive parse bound). */
export const CHRONICLE_MAX_TEXT_LENGTH = 200;

/** Wire shape: entries packed lean as { d, t }. */
export interface ChronicleWireEntry {
  readonly d: number;
  readonly t: string;
}

export function packEntries(entries: readonly ChronicleEntry[]): ChronicleWireEntry[] {
  return entries.map((entry) => ({ d: entry.day, t: entry.text }));
}

/**
 * Parses a `log`/`append` payload's entry list. Null for anything malformed —
 * both halves treat the other side's payloads as untrusted structure, the
 * same defensive stance every plugin's parsers take.
 */
export function parseEntries(payload: unknown): ChronicleEntry[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return null;

  const entries: ChronicleEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { d, t } = item as { d?: unknown; t?: unknown };
    if (!Number.isInteger(d) || (d as number) < 0) return null;
    if (typeof t !== 'string' || t.length === 0 || t.length > CHRONICLE_MAX_TEXT_LENGTH) return null;
    entries.push({ day: d as number, text: t });
  }
  return entries;
}
