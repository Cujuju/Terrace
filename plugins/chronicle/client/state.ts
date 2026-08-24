// The chronicle's replicated client state: the scroll itself and whether the
// reader is open. Solid signals so the panel and the overlay are live views.

import { createSignal } from 'solid-js';
import type { ChronicleEntry } from '../protocol.ts';

const [entriesSignal, setEntriesSignal] = createSignal<readonly ChronicleEntry[]>([]);

/** The whole known scroll, oldest first — exactly as the server keeps it. */
export const entries = entriesSignal;

/** `chronicle:log` — the join snapshot replaces everything. */
export function replaceEntries(next: readonly ChronicleEntry[]): void {
  setEntriesSignal(next);
}

/** `chronicle:append` — new lines arrive at the end. */
export function appendEntries(added: readonly ChronicleEntry[]): void {
  if (added.length === 0) return;
  setEntriesSignal((current) => [...current, ...added]);
}

const [genesisDaySignal, setGenesisDaySignal] = createSignal(0);

/**
 * The calendar day this world's day 0 fell on — the offset that turns an
 * entry's world-age day into the day its WEEKDAY comes from (protocol.ts).
 *
 * Zero until the server says otherwise, which is the pre-anchoring answer and
 * the only honest default: a world whose genesis IS the calendar's day 0 needs
 * no offset, and every heading rendered before the first payload arrives is
 * rendered from an empty scroll anyway.
 */
export const genesisDay = genesisDaySignal;

/** `chronicle:log`/`chronicle:append` — the offset the server sent with them. */
export function setGenesisDay(day: number): void {
  setGenesisDaySignal(day);
}

const [openSignal, setOpenSignal] = createSignal(false);

/** Whether the full-scroll reader overlay is up. */
export const readerOpen = openSignal;
export const setReaderOpen = setOpenSignal;

/** Test seam. */
export function resetChronicleClientState(): void {
  setEntriesSignal([]);
  setGenesisDaySignal(0);
  setOpenSignal(false);
}
