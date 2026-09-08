export const CHRONICLE_PLUGIN_NAME = 'chronicle';

export const CHRONICLE_LOG_MESSAGE = 'log';

export const CHRONICLE_APPEND_MESSAGE = 'append';

export interface ChronicleEntry {
  readonly day: number;
  readonly text: string;
}

export function parseGenesisDay(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const day = (payload as { genesisDay?: unknown }).genesisDay;
  return Number.isInteger(day) ? (day as number) : null;
}

export const CHRONICLE_MAX_ENTRIES = 512;

export const CHRONICLE_MAX_TEXT_LENGTH = 200;

export interface ChronicleWireEntry {
  readonly d: number;
  readonly t: string;
}

export function packEntries(entries: readonly ChronicleEntry[]): ChronicleWireEntry[] {
  return entries.map((entry) => ({ d: entry.day, t: entry.text }));
}

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
