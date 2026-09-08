export const OPERATOR_MAX_FAILED_ATTEMPTS = 5;

export const OPERATOR_LOCKOUT_MS = 60_000;

export type OperatorRefusal = 'disabled' | 'badKey' | 'throttled';

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

export interface OperatorGateOptions {
  readonly key: string | null;
  readonly label: string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

export class OperatorGate {
  private readonly key: string | null;
  private readonly label: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(options: OperatorGateOptions) {
    this.key = options.key;
    this.label = options.label;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((): void => {});
  }

  get keyed(): boolean {
    return this.key !== null;
  }

  forgetClient(clientId: string): void {
    this.attempts.delete(clientId);
  }

  authorize(clientId: string, key: string): OperatorRefusal | null {
    const configured = this.key;
    if (configured === null) return null;

    const now = this.now();
    const record = this.attempts.get(clientId);
    if (record !== undefined && record.lockedUntil > now) return 'throttled';

    if (!secretsMatch(key, configured)) {
      const failures = (record?.failures ?? 0) + 1;
      const lockedUntil =
        failures >= OPERATOR_MAX_FAILED_ATTEMPTS ? now + OPERATOR_LOCKOUT_MS : 0;
      this.attempts.set(clientId, {
        failures: lockedUntil > 0 ? 0 : failures,
        lockedUntil,
      });
      this.log(`${this.label} request refused: bad operator key (attempt ${failures})`);
      return lockedUntil > 0 ? 'throttled' : 'badKey';
    }

    this.attempts.delete(clientId);
    return null;
  }
}
