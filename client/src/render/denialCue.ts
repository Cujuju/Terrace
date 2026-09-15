export const DENIED_COLOR = 0xd9584a;

/** Offline brush tint: grey, and never red while offline. */
export const OFFLINE_COLOR = 0x9aa09b;

/** Ghost (unpredicted) brush tint: hollow outline at reduced opacity. */
export const GHOST_OPACITY_SCALE = 0.5;

/** How long one cue blink stays lit. Every blinking cue shares this on-phase. */
export const CUE_BLINK_ON_MS = 100;

const DENIED_BLINK_RED_MS = CUE_BLINK_ON_MS;
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
 * Extra accessors default to false, so a host that cues only refusals keeps
 * compiling; main.tsx wires all four off the input and prediction stores.
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
  /** The flat cue's held half: a posture the aim is stuck in, e.g. a frozen drag descent. */
  readonly flat?: () => boolean;
  /** The flat cue's blinked half: a counter of posture refusals that sent nothing. */
  readonly flatBlinks?: () => number;
}

/**
 * Turns a blink COUNTER into the level a renderer can read: every increment
 * lights the cue for one blink. Late increments extend the lit window rather
 * than queueing, so a burst of refusals reads as one steady mark.
 */
export function createBlinkFlash(count: () => number): () => boolean {
  let seen = count();
  let litUntilMs = Number.NEGATIVE_INFINITY;
  return (): boolean => {
    const at = count();
    const now = performance.now();
    if (at !== seen) {
      seen = at;
      litUntilMs = now + CUE_BLINK_ON_MS;
    }
    return now < litUntilMs;
  };
}

export function createDenialCue(
  refused: () => boolean,
  options: DenialCueOptions = {},
): DenialCue {
  const offline = options.offline ?? (() => false);
  const ghost = options.ghost ?? (() => false);
  const flatHold = options.flat ?? (() => false);
  const flatFlash =
    options.flatBlinks === undefined ? null : createBlinkFlash(options.flatBlinks);
  // The flash is polled first on purpose: behind a held posture, `||` would
  // skip it and the blink would fire late, when the hold lifts.
  const flat =
    flatFlash === null
      ? flatHold
      : (): boolean => {
          const blinked = flatFlash();
          return blinked || flatHold();
        };
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
