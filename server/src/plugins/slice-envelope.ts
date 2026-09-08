export const LEGACY_SLICE_VERSION = 1;

export interface SliceEnvelope {
  readonly v: number;
  readonly data: unknown;
}

export interface StoredSlice {
  readonly version: number;
  readonly data: unknown;
  readonly enveloped: boolean;
}

function isSliceVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= LEGACY_SLICE_VERSION;
}

export function wrapSlice(version: number, data: unknown): SliceEnvelope {
  return { v: version, data };
}

export function readSlice(stored: unknown): StoredSlice {
  if (typeof stored === 'object' && stored !== null) {
    const candidate = stored as Record<string, unknown>;
    if (
      Object.hasOwn(candidate, 'v') &&
      Object.hasOwn(candidate, 'data') &&
      isSliceVersion(candidate.v)
    ) {
      return { version: candidate.v as number, data: candidate.data, enveloped: true };
    }
  }
  return { version: LEGACY_SLICE_VERSION, data: stored, enveloped: false };
}
