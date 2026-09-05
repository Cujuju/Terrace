// The three voice kinds; plugins and claims are ./audioEngine.ts.
//
// What separates them is how they are bounded and faded:
//
//   one-shot  — capped pool, oldest stolen, no fade, may be positional
//   ambience  — one loop per (owner, url), slow fade to a weight, never positional
//   music     — one loop for the whole client, crossfaded

import { Audio, PositionalAudio } from 'three';
import { CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE } from '../config.ts';
import type { SfxOptions } from '../plugins/types.ts';
import type { AudioBufferCache } from './audioBuffers.ts';
import { reportAssetFailure } from './audioBuffers.ts';
import type { AudioDebugLog } from './audioDebug.ts';
import {
  clampGain,
  rampGain,
  routeToBus,
  SILENT_GAIN,
  type AnyAudio,
  type AudioGraph,
} from './audioGraph.ts';

// ── One-shots ────────────────────────────────────────────────────────────────

/**
 * A ceiling, not a measurement: past ~32 a listener resolves nothing more, so
 * reaching it is a bug whose failure should be bounded.
 */
export const MAX_SFX_VOICES = 32;

/** Full level at the closest the camera can orbit. Derived, so FOV carries it. */
export const SFX_REFERENCE_DISTANCE_WORLD_UNITS = CAMERA_MIN_DISTANCE;

/** The farthest the camera can pull back; nothing is heard from beyond it. */
export const SFX_MAX_DISTANCE_WORLD_UNITS = CAMERA_MAX_DISTANCE;

/** The physical inverse-distance law; anything else is a sound-design cheat. */
const SFX_ROLLOFF_FACTOR = 1;

/**
 * NOT three's HRTF default: it models cues relative to a head, and an orbit
 * camera is not one. Cheaper, and left/right is the usable cue.
 */
const SFX_PANNING_MODEL: PanningModelType = 'equalpower';

/** A one-shot's level relative to its bus when the caller says nothing. */
const DEFAULT_SFX_GAIN = 1;

// ── Fades ────────────────────────────────────────────────────────────────────

/**
 * Slow on purpose: a rain loop that snapped on as the camera crossed a disc
 * edge would announce the disc.
 */
const AMBIENCE_FADE_SECONDS = 1.5;

/** Long enough that two tracks read as one becoming another. */
const MUSIC_CROSSFADE_SECONDS = 2;

/** Not a knob: the player's control over music is the bus, and one thing
 * should be decided by one number. */
const MUSIC_TRACK_GAIN = 1;

/**
 * The stop runs on a main-thread timer, the fade on the audio thread; the
 * clocks differ. Slack means a late frame cuts silence, not a click.
 */
const FADE_STOP_SLACK_SECONDS = 0.1;

/**
 * One owner's ambience layer for one URL. Owned by audioEngine.ts, mutated
 * here: it exists before there is a voice, which appears when the decode lands.
 */
export interface AmbienceLayer {
  /** The weight last asked for; the per-frame short-circuit compares this. */
  weight: number;
  /** Null while decoding, or after a fade-out released it. */
  audio: Audio | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** So a per-frame call kicks off exactly one decode. */
  decoding: boolean;
  /** Debug only — thins a per-frame drift to AUDIO_DEBUG_WEIGHT_STEP. */
  lastLoggedWeight: number;
}

export interface AudioVoices {
  /** Live one-shot count — what the voice cap is measured against. */
  voiceCount(): number;
  /** Fires a one-shot from an already-decoded buffer. */
  playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void;
  /** Fades to the layer's current weight; schedules release at silence. */
  retargetAmbience(layer: AmbienceLayer): void;
  /** Decodes and starts a layer that wants to be heard and has no voice. */
  beginAmbience(url: string, layer: AmbienceLayer): void;
  /** Stops and detaches a layer's voice now, cancelling any pending stop. */
  releaseAmbience(layer: AmbienceLayer): void;
  /** Crossfades the music bus to `url`, or to silence for null. */
  setMusic(url: string | null): void;
  /** The URL the music bus is on, so a repeat call short-circuits. */
  musicUrl(): string | null;
  /** Stops every voice of every kind — the engine's teardown. */
  stopAll(): void;
}

export function createAudioVoices(deps: {
  readonly graph: AudioGraph;
  readonly buffers: AudioBufferCache;
  readonly debugLog: AudioDebugLog;
}): AudioVoices {
  const { graph, buffers, debugLog } = deps;

  /** In START ORDER, so index 0 is the oldest and the steal needs no clock. */
  const sfxVoices: AnyAudio[] = [];

  /** The track playing now, and the URL it came from (null = bus empty). */
  let musicVoice: Audio | null = null;
  let currentMusicUrl: string | null = null;

  /** Drops a finished or stolen one-shot from the pool and the scene. */
  function retireSfx(voice: AnyAudio): void {
    const index = sfxVoices.indexOf(voice);
    if (index !== -1) sfxVoices.splice(index, 1);
    if (voice.isPlaying) voice.stop();
    voice.removeFromParent();
  }

  /**
   * Zero rather than a throw: a delay is an arrival time, "in the past" means
   * "now", and a plugin's bad divide must not take the frame down.
   */
  function delaySecondsOf(opts: SfxOptions | undefined): number {
    const requested = opts?.delaySeconds;
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return 0;
    return requested;
  }

  function releaseAmbience(layer: AmbienceLayer): void {
    if (layer.stopTimer !== null) {
      clearTimeout(layer.stopTimer);
      layer.stopTimer = null;
    }
    const voice = layer.audio;
    if (voice === null) return;
    layer.audio = null;
    if (voice.isPlaying) voice.stop();
    voice.gain.disconnect();
  }

  function retargetAmbience(layer: AmbienceLayer): void {
    const voice = layer.audio;
    if (voice === null) return;
    // A layer on its way out and asked back must not be stopped by the old timer.
    if (layer.stopTimer !== null) {
      clearTimeout(layer.stopTimer);
      layer.stopTimer = null;
    }
    rampGain(voice.gain.gain, layer.weight, AMBIENCE_FADE_SECONDS, graph.context);
    if (layer.weight > SILENT_GAIN) return;
    // Faded to silence: release after the fade, so it holds nothing.
    layer.stopTimer = setTimeout(
      () => {
        layer.stopTimer = null;
        releaseAmbience(layer);
      },
      (AMBIENCE_FADE_SECONDS + FADE_STOP_SLACK_SECONDS) * 1000,
    );
  }

  function beginAmbience(url: string, layer: AmbienceLayer): void {
    layer.decoding = true;
    void buffers.get(url).then(
      (buffer) => {
        layer.decoding = false;
        // Anything may have changed while the decode was in flight.
        if (layer.audio !== null || layer.weight <= SILENT_GAIN) return;
        const voice = new Audio(graph.listener);
        routeToBus(voice, 'ambience', graph);
        voice.setBuffer(buffer);
        voice.setLoop(true);
        // From silence always; the ramp is what brings it in.
        voice.gain.gain.value = SILENT_GAIN;
        voice.play();
        layer.audio = voice;
        retargetAmbience(layer);
      },
      (error: unknown) => {
        layer.decoding = false;
        reportAssetFailure(url, error);
      },
    );
  }

  // Plain functions, not methods: nothing here may depend on `this`.
  return {
    voiceCount(): number {
      return sfxVoices.length;
    },

    releaseAmbience,
    retargetAmbience,
    beginAmbience,

    playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void {
      // OLDEST STOLEN, bounding live voices rather than node objects: three
      // builds a fresh source per play() (Audio.js:329), so reusing the
      // wrapper would only force slots to match positioning.
      while (sfxVoices.length >= MAX_SFX_VOICES) retireSfx(sfxVoices[0]);

      const at = opts?.at;
      let voice: AnyAudio;
      if (at === undefined) {
        voice = new Audio(graph.listener);
      } else {
        const positional = new PositionalAudio(graph.listener);
        positional.panner.panningModel = SFX_PANNING_MODEL;
        // The only model whose two distances mean what their names say.
        positional.setDistanceModel('inverse');
        positional.setRefDistance(SFX_REFERENCE_DISTANCE_WORLD_UNITS);
        positional.setMaxDistance(SFX_MAX_DISTANCE_WORLD_UNITS);
        positional.setRolloffFactor(SFX_ROLLOFF_FACTOR);
        // Copied, not held: the caller may pass a scratch object.
        positional.position.set(at.x, at.y, at.z);
        graph.positionalRoot.add(positional);
        voice = positional;
      }

      routeToBus(voice, 'sfx', graph);
      voice.setBuffer(buffer);
      const gain = clampGain(opts?.gain, DEFAULT_SFX_GAIN);
      voice.setVolume(gain);
      const rate = opts?.playbackRate;
      if (rate !== undefined && Number.isFinite(rate) && rate > 0) voice.setPlaybackRate(rate);
      // SCHEDULED, NOT TIMED: three's play(delay) passes
      // currentTime + delay to source.start() (Audio.js:329-338), so a delayed
      // voice costs what an undelayed one does — no timer, no frame callback.
      const delay = delaySecondsOf(opts);
      // Chained, not replaced: three's own handler clears isPlaying first.
      const threeOnEnded = voice.onEnded.bind(voice);
      voice.onEnded = (): void => {
        threeOnEnded();
        retireSfx(voice);
      };
      voice.play(delay);
      // PUSHED AT CREATION so a scheduled voice counts against the cap from
      // now: counting only audible ones could be walked past by scheduling.
      sfxVoices.push(voice);

      // After the push, so the logged count includes this voice.
      debugLog('playSfx', {
        url,
        bus: 'sfx',
        gain,
        at: at === undefined ? null : { x: at.x, y: at.y, z: at.z },
        playbackRate: rate ?? 1,
        delaySeconds: delay,
      });
    },

    musicUrl(): string | null {
      return currentMusicUrl;
    },

    setMusic(url: string | null): void {
      const outgoing = musicVoice;
      if (outgoing !== null) {
        rampGain(outgoing.gain.gain, SILENT_GAIN, MUSIC_CROSSFADE_SECONDS, graph.context);
        setTimeout(
          () => {
            if (outgoing.isPlaying) outgoing.stop();
            outgoing.gain.disconnect();
          },
          (MUSIC_CROSSFADE_SECONDS + FADE_STOP_SLACK_SECONDS) * 1000,
        );
      }
      musicVoice = null;
      currentMusicUrl = url;
      if (url === null) {
        debugLog('setMusic', { url: null, bus: 'music', gain: SILENT_GAIN });
        return;
      }
      void buffers.get(url).then(
        (buffer) => {
          // The claimant may have changed its mind while this decoded.
          if (currentMusicUrl !== url) return;
          const voice = new Audio(graph.listener);
          routeToBus(voice, 'music', graph);
          voice.setBuffer(buffer);
          voice.setLoop(true);
          voice.gain.gain.value = SILENT_GAIN;
          voice.play();
          rampGain(voice.gain.gain, MUSIC_TRACK_GAIN, MUSIC_CROSSFADE_SECONDS, graph.context);
          musicVoice = voice;
          debugLog('setMusic', { url, bus: 'music', gain: MUSIC_TRACK_GAIN });
        },
        (error: unknown) => {
          reportAssetFailure(url, error);
        },
      );
    },

    stopAll(): void {
      for (const voice of [...sfxVoices]) retireSfx(voice);
      if (musicVoice !== null) {
        if (musicVoice.isPlaying) musicVoice.stop();
        musicVoice.gain.disconnect();
        musicVoice = null;
      }
      currentMusicUrl = null;
    },
  };
}
