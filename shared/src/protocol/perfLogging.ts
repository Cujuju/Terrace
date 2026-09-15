/** Operator switch for the server's timestamped stall log and the client's hitch log. */
export interface PerfLoggingRequestMessage {
  type: 'perfLogging';
  enabled: boolean;
}

export const PERF_LOGGING_MESSAGE_TYPE: PerfLoggingRequestMessage['type'] = 'perfLogging';

export function validatePerfLoggingRequest(msg: unknown): PerfLoggingRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== PERF_LOGGING_MESSAGE_TYPE) return null;
  if (typeof m.enabled !== 'boolean') return null;
  return { type: PERF_LOGGING_MESSAGE_TYPE, enabled: m.enabled };
}

/** The server's stored choice; clients adopt it on join and after any change. */
export interface PerfLoggingStateMessage {
  type: 'perfLoggingState';
  enabled: boolean;
}

export const PERF_LOGGING_STATE_MESSAGE_TYPE: PerfLoggingStateMessage['type'] =
  'perfLoggingState';

/** One client frame hitch, relayed so the server's perf log holds both sides. */
export interface PerfHitchMessage {
  type: 'perfHitch';
  intervalMs: number;
  typicalMs: number;
}

export const PERF_HITCH_MESSAGE_TYPE: PerfHitchMessage['type'] = 'perfHitch';

const MAX_PERF_HITCH_MS = 60_000;

function isHitchMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PERF_HITCH_MS;
}

export function validatePerfHitch(msg: unknown): PerfHitchMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== PERF_HITCH_MESSAGE_TYPE) return null;
  if (!isHitchMs(m.intervalMs) || !isHitchMs(m.typicalMs)) return null;
  return { type: PERF_HITCH_MESSAGE_TYPE, intervalMs: m.intervalMs, typicalMs: m.typicalMs };
}
