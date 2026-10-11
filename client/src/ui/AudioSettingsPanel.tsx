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

const VOLUME_STEP = 0.01;

const PERCENT_SCALE = 100;

function percentLabel(level: number): string {
  return `${String(Math.round(level * PERCENT_SCALE))}%`;
}

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
        title="Volume: how loud the world is"
        level={masterVolume}
        onLevel={(level) => {
          setMasterVolume(level);
          if (audioMuted()) setAudioMuted(false);
        }}
        readout={() => (
          <button
            type="button"
            class="controls-reset audio-mute"
            aria-pressed={audioMuted()}
            title={
              audioMuted()
                ? 'Unmute: sound back at this level'
                : 'Mute: silence, volume remembered'
            }
            onClick={() => {
              setAudioMuted(!audioMuted());
            }}
          >
            {audioMuted() ? 'Muted' : percentLabel(masterVolume())}
          </button>
        )}
      />

      {}
      <For each={AUDIO_BUS_NAMES}>
        {(bus) => (
          <SliderRow
            label={AUDIO_BUS_LABEL[bus]}
            title={`${AUDIO_BUS_LABEL[bus]}: its share of the volume`}
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
