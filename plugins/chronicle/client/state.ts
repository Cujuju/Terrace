import { createSignal } from 'solid-js';
import { CHRONICLE_MAX_ENTRIES, type ChronicleEntry } from '../protocol.ts';

const [entriesSignal, setEntriesSignal] = createSignal<readonly ChronicleEntry[]>([]);

export const entries = entriesSignal;

export function replaceEntries(next: readonly ChronicleEntry[]): void {
  setEntriesSignal(next);
}

export function appendEntries(added: readonly ChronicleEntry[]): void {
  if (added.length === 0) return;
  setEntriesSignal((current) => [...current, ...added].slice(-CHRONICLE_MAX_ENTRIES));
}

const [genesisDaySignal, setGenesisDaySignal] = createSignal(0);

export const genesisDay = genesisDaySignal;

export function setGenesisDay(day: number): void {
  setGenesisDaySignal(day);
}

const [openSignal, setOpenSignal] = createSignal(false);

export const readerOpen = openSignal;
export const setReaderOpen = setOpenSignal;

export function resetChronicleClientState(): void {
  setEntriesSignal([]);
  setGenesisDaySignal(0);
  setOpenSignal(false);
}
