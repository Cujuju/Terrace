// The music block in the settings popup: one slider per composer dial, so the
// owner can tune the score by ear while it plays (GH #325).
//
// SOLID REACTIVITY: accessors are called at the point of use, never stored in a
// component-body const (project rule). `musicTuning()` is read inside each
// row's own accessor, so moving one dial re-renders one readout.
//
// UNDER AudioSettingsPanel, not inside it: that panel is core's, and the sound
// these dials shape belongs to this plugin. It reuses core's audio row classes
// so the two blocks read as one column of sliders.

import { For, type JSX } from 'solid-js';
import {
  DIALS,
  MUSIC_TUNING_FIELDS,
  musicTuning,
  resetMusicTuning,
  setMusicTuningField,
  type Dial,
  type MusicTuningField,
} from './tuning-state.ts';

/** Places multiplying by a hundred moves the decimal point — so a percent
 * readout needs exactly this many fewer decimals than its step. */
const PERCENT_DECIMAL_SHIFT = 2;

/** Gains are stored 0..1 and read as percent, like core's audio rows. */
const PERCENT_SCALE = 10 ** PERCENT_DECIMAL_SHIFT;

/** A word-unit takes a space before it, a symbol does not. */
const UNIT_SUFFIX: Readonly<Record<Dial['unit'], string>> = {
  bpm: ' bpm',
  '¢': '¢',
  s: ' s',
  Hz: ' Hz',
  '×': '×',
  '%': '%',
};

/** Decimals in a readout, taken from its own step so no dial can show a
 * precision its slider cannot reach. */
function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** `0.044` at step 0.001 as a percent reads `4.4%`; `64` at step 1, `64 bpm`. */
function readoutOf(dial: Dial, value: number): string {
  const percent = dial.unit === '%';
  const shown = percent ? value * PERCENT_SCALE : value;
  const decimals = percent
    ? Math.max(0, decimalsOf(dial.step) - PERCENT_DECIMAL_SHIFT)
    : decimalsOf(dial.step);
  return `${shown.toFixed(decimals)}${UNIT_SUFFIX[dial.unit]}`;
}

/** Takes the FIELD, not a value: a value read in the parent body would freeze. */
function DialRow(props: { field: MusicTuningField }): JSX.Element {
  const dial = (): Dial => DIALS[props.field];
  const value = (): number => musicTuning()[props.field];
  return (
    <div class="hud-row controls-row audio-row">
      <span class="controls-label">{dial().label}</span>
      <input
        type="range"
        class="audio-slider"
        aria-label={dial().label}
        min={dial().min}
        max={dial().max}
        step={dial().step}
        value={value()}
        onInput={(e) => {
          setMusicTuningField(props.field, e.currentTarget.valueAsNumber);
        }}
      />
      <span class="audio-readout">{readoutOf(dial(), value())}</span>
    </div>
  );
}

export function MusicTuningPanel(): JSX.Element {
  return (
    <div class="audio-panel">
      {/* A label row with no control: the block needs a name, because "Pad" and
          "Melody" mean nothing under the bus levels above them. */}
      <div class="hud-row controls-row audio-row">
        <span class="controls-label">Music</span>
      </div>

      <For each={MUSIC_TUNING_FIELDS}>{(field) => <DialRow field={field} />}</For>

      <button
        type="button"
        class="controls-reset"
        title="Puts every dial in this block back to the score as it shipped."
        onClick={resetMusicTuning}
      >
        Reset music
      </button>
    </div>
  );
}
