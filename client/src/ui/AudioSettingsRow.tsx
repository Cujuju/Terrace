// The one audio row in the settings popup: master volume and mute.
//
// SOLID REACTIVITY: reactive values are read by calling their accessor at the
// point of use, never stored in a component-body const (project rule) — the
// same discipline ControlsPanel.tsx states in its own header.
//
// ITS OWN COMPONENT rather than a row inside ControlsPanel, because that panel
// is the CONTROL BINDINGS editor and its "Reset to defaults" button promises to
// reset "every setting on this panel". Audio is not a control binding and must
// not be swept up by that button, so it sits beside the panel in the popup
// rather than inside it.
//
// No new visual language: `.hud-row`, `.controls-row` and `.controls-label` are
// the popup's existing vocabulary (ui/hud.css); the slider and the mute button
// add two small rules there and nothing else.

import type { JSX } from 'solid-js';
import {
  MAX_MASTER_VOLUME,
  MIN_MASTER_VOLUME,
  audioMuted,
  masterVolume,
  setAudioMuted,
  setMasterVolume,
} from '../state/audioPrefs.ts';

/**
 * Slider granularity, as a fraction of full scale.
 *
 * A HUNDREDTH: the smallest step a listener can pick out on a linear gain
 * control is around a percent of full scale, and a finer step only makes the
 * keyboard arrow keys take longer to cross the range.
 */
const VOLUME_STEP = 0.01;

/** 0..1 → the whole-percent label beside the slider. */
const PERCENT_SCALE = 100;

export function AudioSettingsRow(): JSX.Element {
  return (
    <div class="hud-row controls-row audio-row">
      <span class="controls-label">Volume</span>
      <input
        type="range"
        class="audio-slider"
        aria-label="Master volume"
        title="How loud the world is. Mute silences it without forgetting this level."
        min={MIN_MASTER_VOLUME}
        max={MAX_MASTER_VOLUME}
        step={VOLUME_STEP}
        value={masterVolume()}
        // Muting does not move the slider — it remembers the level so unmuting
        // restores exactly it (state/audioPrefs.ts's effectiveMasterGain) — but
        // dragging the slider while muted would otherwise change nothing
        // audible, so it also unmutes.
        onInput={(e) => {
          setMasterVolume(e.currentTarget.valueAsNumber);
          if (audioMuted()) setAudioMuted(false);
        }}
      />
      <button
        type="button"
        class="controls-reset audio-mute"
        aria-pressed={audioMuted()}
        title={
          audioMuted()
            ? 'Sound is off. Turn it back on at the volume the slider still shows.'
            : 'Silence everything without losing the volume you set.'
        }
        onClick={() => {
          setAudioMuted(!audioMuted());
        }}
      >
        {audioMuted() ? 'Muted' : `${String(Math.round(masterVolume() * PERCENT_SCALE))}%`}
      </button>
    </div>
  );
}
