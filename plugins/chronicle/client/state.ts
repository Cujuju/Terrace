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

const [openSignal, setOpenSignal] = createSignal(false);

/** Whether the full-scroll reader overlay is up. */
export const readerOpen = openSignal;
export const setReaderOpen = setOpenSignal;

/** Test seam. */
export function resetChronicleClientState(): void {
  setEntriesSignal([]);
  setOpenSignal(false);
}
