// MAX_SAFE_INTEGER is an exhausted counter, never an issued identity.
export const EXHAUSTED_IDENTITY = Number.MAX_SAFE_INTEGER;

export function isAllocatableIdentity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < EXHAUSTED_IDENTITY;
}

export function isIdentityCounter(value: unknown): value is number {
  return value === EXHAUSTED_IDENTITY || isAllocatableIdentity(value);
}

export function incrementIdentity(value: number): number {
  if (!isAllocatableIdentity(value)) throw new Error('wildlife: identity space exhausted or invalid');
  return value + 1;
}
