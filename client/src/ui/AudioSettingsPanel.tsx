// The audio block in the settings popup: master + mute, then one level per bus.
//
// SOLID REACTIVITY: accessors are called at the point of use, never stored in a
// component-body const (project rule).
//
// BESIDE ControlsPanel, not inside it: that panel's reset button promises to
// reset "every setting on this panel", and audio is not a control binding.

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

/** About the smallest step audible on a linear gain control. */
const VOLUME_STEP = 0.01;

/** 0..1 → the whole-percent readout beside each slider. */
const PERCENT_SCALE = 100;

function percentLabel(level: number): string {
  return `${String(Math.round(level * PERCENT_SCALE))}%`;
}

/** Takes ACCESSORS: a value read in the parent body would freeze (project rule). */
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
          // Dragging the master while muted would change nothing audible. The
          // bus sliders do NOT unmute: the mix is adjustable while silent.
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

      {/* Levels BEFORE the master: "thunder against rain", not "how loud". */}
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
