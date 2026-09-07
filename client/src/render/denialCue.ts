// THE ONE ANSWER TO "IS THE BRUSH REFUSED RIGHT NOW, AND IS IT RED THIS FRAME".
//
// A client plugin can veto a sculpt before it is sent (main.tsx's `send` →
// ClientPluginHost.allowLocalIntent — out of mana, today). The veto ends the
// stroke while the button is still down (input/sculptInput.ts's
// `releaseStroke`), and the player is told so by everything that draws their
// aim turning red: the brush outline and its mark (render/brushPreview.ts) and
// the lit lip a drag would move (render/layerEdgeOverlay.ts).
//
// THOSE ARE TWO MODULES DRAWING ONE EVENT, which is why the colour and the
// phase live here and not in either of them. Each computing its own blink off
// its own clock would be two answers to "what colour is the aim", and they
// would drift apart by however much their frame hooks differ — the brush going
// red a beat before the lip, on every refusal.
//
// Owner, 2026-09-06: "change the brush color from what it is now to red, flash
// it twice"; then, correcting a first cut that let the red expire on a timer,
// "red, white, red, stay red until mouse release — if it just goes back to the
// normal color and they can't draw, they have no idea what's going on"; then
// "we are changing the brush, but we are not changing the intent line".

/**
 * The refused colour — every cue that draws the player's aim, while the aim is
 * dead.
 *
 * THE SAME RED THE MANA GAUGE FLASHES (DENIED_MID in
 * plugins/mana/client/ManaGauge.tsx). One refusal, cues at opposite corners of
 * the screen; a different red would read as two unrelated things going wrong
 * at once. Restated rather than imported because core must not import a
 * plugin — the whole reason this cue is driven by the interceptor chain's
 * verdict and not by the mana plugin's own denial signal.
 */
export const DENIED_COLOR = 0xd9584a;

/**
 * THE OPENING BLINK: red, back to the ordinary colour, red — and from there
 * red for as long as the refusal stands.
 *
 * `DENIED_BLINK_REDS` counts the RED ONSETS, so the gaps between them number
 * one fewer and the last onset is the one that never ends. Written as onsets
 * because that is what the eye counts and what the owner asked for; a gap
 * count would have to be read as "two flashes" by subtracting one.
 *
 * The red and the gap are equal so the blink reads as a blink rather than as a
 * colour change with a stutter in it, and their sum is a third of the mana
 * gauge's own DENIAL_FLASH_MS (600 ms) — the two cues start together, and the
 * gauge is still flashing while the aim settles into its hold.
 */
const DENIED_BLINK_RED_MS = 100;
const DENIED_BLINK_GAP_MS = 100;
const DENIED_BLINK_PERIOD_MS = DENIED_BLINK_RED_MS + DENIED_BLINK_GAP_MS;
const DENIED_BLINK_REDS = 2;

export interface DenialCue {
  /**
   * Is the aim drawn in DENIED_COLOR this frame? False whenever the brush is
   * not refused; while it is, false only during the opening blink's gaps.
   *
   * Safe to ask more than once a frame — every consumer asks for itself, which
   * is what keeps them in step — and cheap: one clock read and two compares.
   */
  isRed(): boolean;
}

/**
 * `refused` is the live state, not an event: true from the veto until the
 * button comes up (input/sculptInput.ts's `refusedHold`).
 *
 * AN ACCESSOR, NOT A START CALL AND A STOP CALL. The state belongs to whoever
 * owns the pointer; a cue told about it twice is a second copy of it that can
 * be left switched on. Read on the frame that draws, so it cannot disagree
 * with the input layer for longer than a frame — and there is no timer to keep
 * firing after the thing it was drawing is gone.
 */
export function createDenialCue(refused: () => boolean): DenialCue {
  /**
   * When the CURRENT refusal began, on the same monotonic clock its phase is
   * measured against, or −∞ while there is none. Stamped on the rising edge of
   * `refused` rather than by a call the veto makes, so the start time cannot
   * describe a different refusal from the one being drawn.
   */
  let sinceMs = Number.NEGATIVE_INFINITY;
  /**
   * The blink window: after it, elapsed time has left the last gap for good
   * and every later frame is red. That is the hold.
   */
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
