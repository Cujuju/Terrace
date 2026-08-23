// THE OPERATOR GATE — the shared secret in front of every destructive
// server action.
//
// CRITICAL CODE (it is an authentication check). Extracted from
// world/rollback.ts on 2026-08-22, when world management arrived with a second
// key of its own (WORLD_ADMIN_KEY beside ROLLBACK_KEY).
//
// WHY IT WAS EXTRACTED RATHER THAN COPIED. The rollback gate was ~40 lines of
// constant-time comparison, per-connection failure counting and lockout. A
// second feature needing the same thing had exactly two options: call this, or
// grow a second copy. Two copies of an auth check is not a style problem — it
// is a guarantee that one day a fix lands in one of them, and the other
// quietly becomes the way in. The shape being duplicated WAS the missing
// contract, so the contract now exists.
//
// WHAT IT PROTECTS AGAINST, AND WHAT IT DOES NOT. v1 has no accounts (design
// §3.7), so the server cannot tell the self-hoster from anyone else holding
// the invite link. A shared secret in the environment is the only gate
// available. It is not an identity system, it does not survive a determined
// attacker who can read the operator's environment, and it is not a substitute
// for not exposing the port. It stops the casual case — a player who found the
// panel — and it makes the deliberate case slow.

/**
 * Wrong keys one connection may send before it is refused outright for
 * OPERATOR_LOCKOUT_MS.
 *
 * Five, not one: the operator is typing a secret by hand into a game HUD, and
 * locking them out on the first typo would make the feature hostile at the
 * exact moment they need it (their world is wrecked and they are in a hurry).
 * Five wrong tries then a minute's wait bounds an online guesser to 5 attempts
 * a minute per connection — far below any rate that matters against even a
 * MIN_ROLLBACK_KEY_LENGTH secret — while costing an operator with fat fingers
 * nothing.
 */
export const OPERATOR_MAX_FAILED_ATTEMPTS = 5;

/** How long a connection stays locked out after exhausting its attempts. */
export const OPERATOR_LOCKOUT_MS = 60_000;

/**
 * Why the gate said no. A subset of both RollbackRefusal and
 * WorldAdminRefusal, which is what lets one gate serve both features: each
 * caller widens this into its own refusal type without translation.
 */
export type OperatorRefusal = 'disabled' | 'badKey' | 'throttled';

/** Per-connection failed-attempt state; see OPERATOR_MAX_FAILED_ATTEMPTS. */
interface AttemptRecord {
  failures: number;
  /** Epoch ms the lockout ends, or 0 when not locked out. */
  lockedUntil: number;
}

export interface OperatorGateOptions {
  /** The configured secret, or null when this feature is switched off. */
  readonly key: string | null;
  /**
   * What this gate guards, for the log line on a failed attempt ("rollback",
   * "world management"). Never includes the key.
   */
  readonly label: string;
  /**
   * Injectable clock. Exists for the lockout tests, which must be able to
   * cross OPERATOR_LOCKOUT_MS without sleeping for a minute.
   */
  readonly now?: () => number;
  /** Where a refused attempt is reported. Injectable for the same reason. */
  readonly log?: (message: string) => void;
}

/**
 * Compares two secrets in time that does not depend on how far they match.
 *
 * `===` on strings short-circuits at the first differing character, which
 * leaks a prefix oracle to an attacker who can time responses. The cost of not
 * leaking it is a fixed-length loop, so there is no reason to accept the leak
 * even though a network round trip probably buries the signal in noise.
 *
 * Length is compared first and openly: the length of the key is not a secret
 * worth a branchless comparison, and every real key is the same length every
 * time anyway.
 */
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

  /**
   * Keyed by connection id, and pruned only when a connection is forgotten
   * (see forgetClient, called from the room's onLeave). Bounded by the number
   * of connected clients, so it cannot grow without bound the way a
   * key-by-address map could.
   */
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(options: OperatorGateOptions) {
    this.key = options.key;
    this.label = options.label;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((): void => {});
  }

  /** True when a key is configured; the boot log states this, not the key. */
  get enabled(): boolean {
    return this.key !== null;
  }

  /** Drops a disconnected connection's attempt record. */
  forgetClient(clientId: string): void {
    this.attempts.delete(clientId);
  }

  /**
   * The gate. Returns null when the request may proceed, or the refusal to
   * send back.
   *
   * ORDER MATTERS: `disabled` is checked before the lockout, so a self-hoster
   * who never set a key is told THAT however many times they ask, rather than
   * being throttled for failing to guess a secret that does not exist.
   */
  authorize(clientId: string, key: string): OperatorRefusal | null {
    const configured = this.key;
    if (configured === null) return 'disabled';

    const now = this.now();
    const record = this.attempts.get(clientId);
    if (record !== undefined && record.lockedUntil > now) return 'throttled';

    if (!secretsMatch(key, configured)) {
      const failures = (record?.failures ?? 0) + 1;
      const lockedUntil =
        failures >= OPERATOR_MAX_FAILED_ATTEMPTS ? now + OPERATOR_LOCKOUT_MS : 0;
      // Reset the counter as the lockout starts, so serving the lockout is a
      // clean slate rather than one attempt before being locked out again.
      this.attempts.set(clientId, {
        failures: lockedUntil > 0 ? 0 : failures,
        lockedUntil,
      });
      // Logged WITHOUT the key, and worth logging: repeated failures against a
      // configured key is the one signal a self-hoster has that someone is
      // trying to get at their world.
      this.log(`${this.label} request refused: bad operator key (attempt ${failures})`);
      return lockedUntil > 0 ? 'throttled' : 'badKey';
    }

    // A correct key clears the record entirely — the operator is who they say
    // they are, so their earlier typos are no longer evidence of anything.
    this.attempts.delete(clientId);
    return null;
  }
}
