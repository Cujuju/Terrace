import { createSignal } from 'solid-js';
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

/** The client's own hitch log; applies immediately. */
export const perfLoggingEnabled = (): boolean => perfLoggingChoice() === 'on';

export interface ServerPerfLogging {
  readonly enabled: boolean;
  readonly live: boolean;
}

const [serverPerfLogging, setServerPerfLogging] = createSignal<ServerPerfLogging | null>(null);

export { serverPerfLogging };

export function applyServerPerfLogging(message: PerfLoggingStateMessage): void {
  setServerPerfLogging({ enabled: message.enabled, live: message.live });
}

/** The stored server choice differs from what the running server uses. */
export const serverPerfLoggingNeedsRestart = (): boolean => {
  const state = serverPerfLogging();
  return state !== null && state.enabled !== state.live;
};

let sendToServer: ((enabled: boolean) => void) | null = null;

export function bindPerfLoggingSender(send: (enabled: boolean) => void): void {
  sendToServer = send;
}

/** One switch for both halves: the client applies now, the server stores it for its next boot. */
export function setPerfLogging(enabled: boolean): void {
  setPerfLoggingChoice(enabled ? 'on' : 'off');
  sendToServer?.(enabled);
}
