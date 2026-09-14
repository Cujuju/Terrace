export const DENIED_COLOR = 0xd9584a;

/** Offline brush tint: grey, and never red while offline. */
export const OFFLINE_COLOR = 0x9aa09b;

/** Ghost (unpredicted) brush tint: hollow outline at reduced opacity. */
export const GHOST_OPACITY_SCALE = 0.5;

const DENIED_BLINK_RED_MS = 100;
const DENIED_BLINK_GAP_MS = 100;
const DENIED_BLINK_PERIOD_MS = DENIED_BLINK_RED_MS + DENIED_BLINK_GAP_MS;
const DENIED_BLINK_REDS = 2;

/**
 * The four brush-preview cue states (lane C vocabulary, lane E rendering).
 *
 * - refused: the stroke was refused (red blink via isRed()).
 * - offline: no connection; the brush renders grey/hollow and never red.
 * - ghost: the stroke cannot be predicted; the brush renders hollow/dimmed.
 * - flat: posture flat-mark; the brush renders the crosshair mark only.
 *
 * Extra accessors default to false so existing wiring
 * (`createDenialCue(() => sculptInput.refusedHold())`) keeps compiling; the
 * merge agent reconciles the accessor names against lane C.
 */
export interface DenialCue {
  isRed(): boolean;
  refusedHold(): boolean;
  offline(): boolean;
  ghost(): boolean;
  flat(): boolean;
}

export interface DenialCueOptions {
  readonly offline?: () => boolean;
  readonly ghost?: () => boolean;
  readonly flat?: () => boolean;
}

export function createDenialCue(
  refused: () => boolean,
  options: DenialCueOptions = {},
): DenialCue {
  const offline = options.offline ?? (() => false);
  const ghost = options.ghost ?? (() => false);
  const flat = options.flat ?? (() => false);
  let sinceMs = Number.NEGATIVE_INFINITY;
  const blinkMs = (DENIED_BLINK_REDS - 1) * DENIED_BLINK_PERIOD_MS;
  return {
    refusedHold: refused,
    offline,
    ghost,
    flat,
    isRed(): boolean {
      // Offline never renders red, even while a refused hold is latched.
      if (offline() || !refused()) {
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
