// The one answer to "is the brush refused, and is it red this frame".
// Shared by the brush outline and the lit lip so the two never drift apart.

/** Refused colour. Matches the mana gauge's DENIED_MID; core cannot import a plugin. */
export const DENIED_COLOR = 0xd9584a;

/** Red, gap, red — then red until released. REDS counts onsets; gaps are one fewer. */
const DENIED_BLINK_RED_MS = 100;
const DENIED_BLINK_GAP_MS = 100;
const DENIED_BLINK_PERIOD_MS = DENIED_BLINK_RED_MS + DENIED_BLINK_GAP_MS;
const DENIED_BLINK_REDS = 2;

export interface DenialCue {
  /** Safe to ask repeatedly in a frame; that is what keeps consumers in step. */
  isRed(): boolean;
}

/** `refused` is live state, not an event: true until the button comes up. */
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
