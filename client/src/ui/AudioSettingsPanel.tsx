// The audio block in the settings popup: master volume + mute, then one level
// per bus.
//
// SOLID REACTIVITY: reactive values are read by calling their accessor at the
// point of use, never stored in a component-body const (project rule) — the
// same discipline ControlsPanel.tsx states in its own header.
//
// ITS OWN COMPONENT rather than rows inside ControlsPanel, because that panel
// is the CONTROL BINDINGS editor and its "Reset to defaults" button promises to
// reset "every setting on this panel". Audio is not a control binding and must
// not be swept up by that button, so this sits beside the panel in the popup
// rather than inside it.
//
// ONE ROW SHAPE FOR ALL FOUR SLIDERS. The master row and the three bus rows are
// the same control — a label, a range over the same [0, 1], a readout — so they
// are one `sliderRow` and a `For`, not four hand-written blocks. The master's
// readout doubles as the mute toggle, which is the only difference and the only
// thing written twice.
//
// No new visual language: `.hud-row`, `.controls-row` and `.controls-label` are
// the popup's existing vocabulary (ui/hud.css); the block adds a handful of
// rules there and nothing else.

import { For, type JSX } from 'solid-js';
import {
  AUDIO_BUS_LABEL,
  AUDIO_BUS_NAMES,
  MAX_MASTER_VOLUME,
  MIN_MASTER_VOLUME,
  audioMuted,
  busLevel,
  masterVolume,
  setAudioMuted,
  setBusLevel,
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

/** 0..1 → the whole-percent readout beside each slider. */
const PERCENT_SCALE = 100;

function percentLabel(level: number): string {
  return `${String(Math.round(level * PERCENT_SCALE))}%`;
}

/**
 * One slider row. Takes ACCESSORS, not values: a value read here in the parent
 * body would be read once and frozen (project rule), and props are the seam
 * Solid wraps in getters.
 */
function SliderRow(props: {
  label: string;
  title: string;
  level: () => number;
  onLevel: (level: number) => void;
  readout: () => JSX.Element;
}): JSX.Element {
  return (
    <div class="hud-row controls-row audio-row">
      <span class="controls-label">{props.label}</span>
      <input
        type="range"
        class="audio-slider"
        aria-label={props.label}
        title={props.title}
        min={MIN_MASTER_VOLUME}
        max={MAX_MASTER_VOLUME}
        step={VOLUME_STEP}
        value={props.level()}
        onInput={(e) => {
          props.onLevel(e.currentTarget.valueAsNumber);
        }}
      />
      {props.readout()}
    </div>
  );
}

export function AudioSettingsPanel(): JSX.Element {
  return (
    <div class="audio-panel">
      <SliderRow
        label="Volume"
        title="How loud the world is. Mute silences it without forgetting this level."
        level={masterVolume}
        onLevel={(level) => {
          setMasterVolume(level);
          // Dragging the master while muted would otherwise change nothing
          // audible, so it also unmutes. The bus sliders below deliberately do
          // NOT: they set the mix, which is a thing a player may well want to
          // adjust while the world is silent.
          if (audioMuted()) setAudioMuted(false);
        }}
        readout={() => (
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
            {audioMuted() ? 'Muted' : percentLabel(masterVolume())}
          </button>
        )}
      />

      {/* The mix. Each of these is a level BEFORE the master, so they answer
          "how loud is thunder against rain" and the master answers "how loud is
          all of it" — see state/audioPrefs.ts's effectiveBusGain. */}
      <For each={AUDIO_BUS_NAMES}>
        {(bus) => (
          <SliderRow
            label={AUDIO_BUS_LABEL[bus]}
            title={`How loud ${AUDIO_BUS_LABEL[bus].toLowerCase()} is against the rest of the world. The volume above scales all of it.`}
            level={() => busLevel(bus)}
            onLevel={(level) => {
              setBusLevel(bus, level);
            }}
            readout={() => <span class="audio-readout">{percentLabel(busLevel(bus))}</span>}
          />
        )}
      </For>
    </div>
  );
}
