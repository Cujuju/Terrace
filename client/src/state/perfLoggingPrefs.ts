import type { PerfLoggingStateMessage } from '@terrace/shared';
import { persistedChoice } from './persistedChoice.ts';

export type PerfLoggingChoice = 'on' | 'off';

const PERF_LOGGING_CHOICES: readonly PerfLoggingChoice[] = ['on', 'off'];

const DEFAULT_PERF_LOGGING: PerfLoggingChoice = 'on';

const PERF_LOGGING_STORAGE_KEY = 'terrace.perfLogging.v1';

const [perfLoggingChoice, setPerfLoggingChoice] = persistedChoice<PerfLoggingChoice>(
  PERF_LOGGING_STORAGE_KEY,
  PERF_LOGGING_CHOICES,
  DEFAULT_PERF_LOGGING,
);

/** One switch for both sides; the server's stored value wins whenever it speaks. */
export const perfLoggingEnabled = (): boolean => perfLoggingChoice() === 'on';

export function applyServerPerfLogging(message: PerfLoggingStateMessage): void {
  setPerfLoggingChoice(message.enabled ? 'on' : 'off');
}

export interface PerfLoggingSender {
  setEnabled(enabled: boolean): void;
  reportHitch(intervalMs: number, typicalMs: number): void;
}

let sender: PerfLoggingSender | null = null;

export function bindPerfLoggingSender(next: PerfLoggingSender): void {
  sender = next;
}

export function setPerfLogging(enabled: boolean): void {
  setPerfLoggingChoice(enabled ? 'on' : 'off');
  sender?.setEnabled(enabled);
}

export function reportHitch(intervalMs: number, typicalMs: number): void {
  sender?.reportHitch(intervalMs, typicalMs);
}
