export const DENIED_COLOR = 0xd9584a;

const DENIED_BLINK_RED_MS = 100;
const DENIED_BLINK_GAP_MS = 100;
const DENIED_BLINK_PERIOD_MS = DENIED_BLINK_RED_MS + DENIED_BLINK_GAP_MS;
const DENIED_BLINK_REDS = 2;

export interface DenialCue {
  isRed(): boolean;
}

export function createDenialCue(refused: () => boolean): DenialCue {
  let sinceMs = Number.NEGATIVE_INFINITY;
  const blinkMs = (DENIED_BLINK_REDS - 1) * DENIED_BLINK_PERIOD_MS;
  return {
    isRed(): boolean {
      if (!refused()) {
        sinceMs = Number.NEGATIVE_INFINITY;
        return false;
      }
      const at = performance.now();
      if (sinceMs === Number.NEGATIVE_INFINITY) sinceMs = at;
      const elapsed = at - sinceMs;
      if (elapsed >= blinkMs) return true;
      return elapsed % DENIED_BLINK_PERIOD_MS < DENIED_BLINK_RED_MS;
    },
  };
}
