import { createSignal, For, Show, type JSX } from "solid-js";
import {
  DIALS,
  MUSIC_TUNING_FIELDS,
  musicTuning,
  resetMusicTuning,
  setMusicTuningField,
  type Dial,
  type MusicTuningField,
} from "./tuning-state.ts";

const PERCENT_DECIMAL_SHIFT = 2;

const PERCENT_SCALE = 10 ** PERCENT_DECIMAL_SHIFT;

const UNIT_SUFFIX: Readonly<Record<Dial["unit"], string>> = {
  bpm: " bpm",
  "¢": "¢",
  s: " s",
  Hz: " Hz",
  "×": "×",
  "%": "%",
};

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function readoutOf(dial: Dial, value: number): string {
  const percent = dial.unit === "%";
  const shown = percent ? value * PERCENT_SCALE : value;
  const decimals = percent
    ? Math.max(0, decimalsOf(dial.step) - PERCENT_DECIMAL_SHIFT)
    : decimalsOf(dial.step);
  return `${shown.toFixed(decimals)}${UNIT_SUFFIX[dial.unit]}`;
}

function DialRow(props: { field: MusicTuningField }): JSX.Element {
  const dial = (): Dial => DIALS[props.field];
  const value = (): number => musicTuning()[props.field];
  return (
    <div class="hud-row controls-row audio-row">
      <span class="controls-label" title={dial().title}>
        {dial().label}
      </span>
      <input
        type="range"
        class="audio-slider"
        aria-label={dial().label}
        title={dial().title}
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

const [expanded, setExpanded] = createSignal(false);

export function MusicTuningPanel(): JSX.Element {
  return (
    <div class="audio-panel">
      {}
      <button
        type="button"
        class="panel-header hud-row controls-row audio-row"
        aria-expanded={expanded()}
        title={expanded() ? "Hide the music dials." : "Show the music dials."}
        onClick={() => setExpanded(!expanded())}
      >
        <span class="controls-label">Music</span>
        <span class="panel-chevron">{expanded() ? "▴" : "▾"}</span>
      </button>

      <Show when={expanded()}>
        <For each={MUSIC_TUNING_FIELDS}>
          {(field) => <DialRow field={field} />}
        </For>

        <button
          type="button"
          class="controls-reset"
          title="Puts every dial in this block back to the score as it shipped."
          onClick={resetMusicTuning}
        >
          Reset music
        </button>
      </Show>
    </div>
  );
}
