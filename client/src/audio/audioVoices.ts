// The three kinds of voice: one-shots, ambience loops and the music track.
//
// Everything here takes a graph (./audioGraph.ts) and a buffer cache
// (./audioBuffers.ts) and makes sound with them. It knows nothing about
// plugins, claims or the plugin contract — ./audioEngine.ts owns all of that
// and calls in here. What separates the three kinds is entirely how they are
// bounded and faded, which is why the constants sit beside them:
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
 * Most one-shot voices alive at once, across every plugin.
 *
 * THIRTY-TWO. It is not a measurement of anything — it is a ceiling chosen so
 * that the worst case is bounded rather than tuned so the common case fits.
 * The common case is one or two: a thunderclap, a splash. Thirty-two
 * simultaneous distinct one-shots is already past what a listener can resolve
 * as separate events, so a plugin that reaches this cap has a bug, and the
 * failure mode for that bug should be "you hear the most recent claps" and not
 * "the audio thread is building a hundred panners". Safari's HRTF panner is
 * costlier than Chrome's (plan §5, unverified on our targets); a hard cap is
 * what makes that a bounded difference instead of an open one.
 */
export const MAX_SFX_VOICES = 32;

/**
 * Distance at which a positional voice is at full level, in WORLD UNITS.
 *
 * DERIVED FROM THE CAMERA, not chosen: CAMERA_MIN_DISTANCE (config.ts) is the
 * closest the orbit camera can ever get to its target, so it is the closest a
 * listener can ever be to a sound on the ground. Making that the reference
 * distance says "as near as you can get is as loud as it gets", which is the
 * only definition of full level that does not depend on a number someone
 * picked. Change the FOV or the closest-zoom framing and this follows.
 */
export const SFX_REFERENCE_DISTANCE_WORLD_UNITS = CAMERA_MIN_DISTANCE;

/**
 * Distance past which a positional voice stops getting quieter, in WORLD UNITS.
 *
 * DERIVED THE SAME WAY: CAMERA_MAX_DISTANCE is the farthest the camera can pull
 * back, so nothing can be heard from farther away than this and there is no
 * attenuation past it left to model. With the 'inverse' model below, a sound at
 * this distance is already ~1/70 of reference level — inaudible — so the clamp
 * is a formality that keeps the curve from being evaluated into the far field.
 */
export const SFX_MAX_DISTANCE_WORLD_UNITS = CAMERA_MAX_DISTANCE;

/**
 * How fast level falls between the two distances above.
 *
 * ONE, the physical inverse-distance law, because this world is at human scale
 * and has no reason to be otherwise. A larger value is a fog-of-sound cheat and
 * a smaller one flattens distance out of the mix; both are sound-design
 * decisions and neither belongs in the host.
 */
const SFX_ROLLOFF_FACTOR = 1;

/**
 * The panning model for positional voices.
 *
 * 'equalpower', NOT three's 'HRTF' default. HRTF convolves every voice against
 * a head-related transfer function to produce binaural cues — where a sound is
 * relative to YOUR EARS. This world is seen from an orbit camera outside it, so
 * those cues describe the ears of a viewpoint that is not a head and is usually
 * looking down at the scene from a hundred units up; the cue a player can
 * actually use is left/right and near/far, which is exactly what equal-power
 * panning gives, for a fraction of the per-voice cost at up to MAX_SFX_VOICES.
 */
const SFX_PANNING_MODEL: PanningModelType = 'equalpower';

/** A one-shot's level relative to its bus when the caller says nothing. */
const DEFAULT_SFX_GAIN = 1;

// ── Fades ────────────────────────────────────────────────────────────────────

/**
 * How long an ambience layer takes to reach a new weight, in seconds.
 *
 * 1.5 s: ambience is WEATHER — a rain front slides over the camera and the
 * sound of it should arrive the way the cloud does. It is the one fade here
 * that is deliberately slow enough to be noticed as a fade, because a rain loop
 * that snapped on when the camera crossed a disc edge would announce the disc.
 */
const AMBIENCE_FADE_SECONDS = 1.5;

/**
 * How long the music bus takes to cross from one track to the next, in seconds.
 *
 * 2 s, the longest fade here: a music change is a change of scene, and the two
 * tracks overlapping for a couple of seconds is what makes it read as one piece
 * of music becoming another rather than as one stopping and another starting.
 */
const MUSIC_CROSSFADE_SECONDS = 2;

/**
 * Level a music track plays at relative to its bus.
 *
 * ONE, and it stays a HOST constant rather than becoming a knob: the player's
 * control over music is the music BUS (state/audioPrefs.ts's
 * DEFAULT_MUSIC_LEVEL, its own slider in the settings popup), and a second
 * multiplier in front of it would mean two numbers deciding one thing. A track
 * plays at the level it was authored at; how loud that is against the rest of
 * the world is the bus's business.
 */
const MUSIC_TRACK_GAIN = 1;

/**
 * Extra seconds to hold a faded-out voice before stopping it.
 *
 * The stop is scheduled off a `setTimeout` on the MAIN thread while the fade
 * runs on the AUDIO thread, and the two clocks are not the same one. A tenth of
 * a second of slack means a main thread that ran a frame late cuts a voice that
 * is already at zero rather than one that is still audible — the failure mode
 * being avoided is a click, and the cost of avoiding it is a silent voice
 * living 100 ms longer than it had to.
 */
const FADE_STOP_SLACK_SECONDS = 0.1;

/**
 * One owner's ambience layer for one URL.
 *
 * OWNED BY THE CALLER (audioEngine.ts keeps one map of these per plugin,
 * keyed by URL — the (plugin, url) identity `ambience` promises) and MUTATED
 * here. It is a record rather than a class because the engine has to be able to
 * make one before this module has anything to attach to it: the weight is
 * remembered from the first call, and the voice appears when the decode lands.
 */
export interface AmbienceLayer {
  /** The weight the caller last asked for; the short-circuit compares this. */
  weight: number;
  /** Null while the buffer is still decoding, or after a fade-out released it. */
  audio: Audio | null;
  /** Pending `setTimeout` that stops a faded-out voice; null when none. */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** True once a decode has been kicked off, so a per-frame call kicks one once. */
  decoding: boolean;
  /**
   * The weight `?audioDebug=1` last printed, so a per-frame drift is thinned to
   * AUDIO_DEBUG_WEIGHT_STEP. Maintained only when the switch is on.
   */
  lastLoggedWeight: number;
}

export interface AudioVoices {
  /** Live one-shot count — what the voice cap is measured against. */
  voiceCount(): number;
  /** Fires a one-shot from an already-decoded buffer. */
  playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void;
  /**
   * Fades a layer's live voice to its current `weight`, and schedules its
   * release if that weight is silence. No-op for a layer with no voice yet.
   */
  retargetAmbience(layer: AmbienceLayer): void;
  /** Decodes and starts a layer that wants to be heard and has no voice. */
  beginAmbience(url: string, layer: AmbienceLayer): void;
  /** Stops and detaches a layer's voice now, cancelling any pending stop. */
  releaseAmbience(layer: AmbienceLayer): void;
  /** Crossfades the music bus to `url`, or to silence for null. */
  setMusic(url: string | null): void;
  /** The URL the music bus is on, so a repeat call can be short-circuited. */
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

  /**
   * Live one-shots, in START ORDER — push appends, so index 0 is the oldest and
   * the steal below needs no timestamp to find it. Bounded by MAX_SFX_VOICES.
   */
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
   * A caller's `delaySeconds`, sanitised to something `source.start` can take.
   *
   * NEGATIVE AND NON-FINITE BOTH BECOME ZERO rather than throwing: a delay is
   * an ARRIVAL TIME, "in the past" means "now", and `playSfx` is contracted as
   * fire-and-forget — a plugin computing a delay from a distance must not be
   * able to take the frame down with a divide that went wrong.
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
    // A retarget cancels a scheduled release: a layer that was on its way out
    // and has been asked back must not be stopped by the old timer.
    if (layer.stopTimer !== null) {
      clearTimeout(layer.stopTimer);
      layer.stopTimer = null;
    }
    rampGain(voice.gain.gain, layer.weight, AMBIENCE_FADE_SECONDS, graph.context);
    if (layer.weight > SILENT_GAIN) return;
    // FADED TO SILENCE: hold the voice for the length of the fade (plus slack
    // for the main thread's clock, see FADE_STOP_SLACK_SECONDS) and then
    // release it, so an ambience that is over holds nothing.
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
        // Everything may have changed while the decode was in flight: the
        // plugin may have detached, the weight may be back to zero, or another
        // path may already have started the voice.
        if (layer.audio !== null || layer.weight <= SILENT_GAIN) return;
        const voice = new Audio(graph.listener);
        routeToBus(voice, 'ambience', graph);
        voice.setBuffer(buffer);
        voice.setLoop(true);
        // FROM SILENCE, ALWAYS: the ramp is what brings it in, so a loop never
        // begins at full level however high the weight already is.
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

  // PLAIN FUNCTIONS, not methods on the returned object, so nothing here
  // depends on `this` — the engine holds this object for the life of the
  // client and a destructured reference must behave identically.
  return {
    voiceCount(): number {
      return sfxVoices.length;
    },

    releaseAmbience,
    retargetAmbience,
    beginAmbience,

    playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void {
      // OLDEST STOLEN. The pool bounds LIVE VOICES, not node objects: three
      // builds a fresh AudioBufferSourceNode on every play() (Audio.js:329) so
      // reusing the Audio wrapper would save an object allocation and nothing
      // else, while forcing every stolen slot to match the new request's
      // positional-ness. Stopping the oldest and taking its slot is the same
      // bound with none of that.
      while (sfxVoices.length >= MAX_SFX_VOICES) retireSfx(sfxVoices[0]);

      const at = opts?.at;
      let voice: AnyAudio;
      if (at === undefined) {
        voice = new Audio(graph.listener);
      } else {
        const positional = new PositionalAudio(graph.listener);
        positional.panner.panningModel = SFX_PANNING_MODEL;
        // 'inverse' is the physical law and the only model whose two distances
        // mean what their names say; see the constants above for both.
        positional.setDistanceModel('inverse');
        positional.setRefDistance(SFX_REFERENCE_DISTANCE_WORLD_UNITS);
        positional.setMaxDistance(SFX_MAX_DISTANCE_WORLD_UNITS);
        positional.setRolloffFactor(SFX_ROLLOFF_FACTOR);
        // COPIED, not held: the caller may hand us a scratch object (the
        // contract says so), and `position.set` reads the numbers here and now.
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
      // SCHEDULED, NOT TIMED. three's `play(delay)` sets
      // `_startedAt = context.currentTime + delay` and passes it to
      // `source.start()` (three/src/audio/Audio.js:329-338) — the
      // sample-accurate Web Audio scheduler on the audio thread. There is no
      // setTimeout, no frame callback and no JS running between now and the
      // sound: a delayed voice costs exactly what an undelayed one does.
      const delay = delaySecondsOf(opts);
      // The pool is freed by the source's own `ended`, which is the only event
      // that knows a one-shot is over — three routes it through `onEnded`
      // (Audio.js:331). Chained, not replaced: three's own handler clears
      // isPlaying, which `retireSfx` reads.
      const threeOnEnded = voice.onEnded.bind(voice);
      voice.onEnded = (): void => {
        threeOnEnded();
        retireSfx(voice);
      };
      voice.play(delay);
      // PUSHED AT CREATION, delayed or not, so a voice scheduled in the future
      // counts against MAX_SFX_VOICES from the moment it exists. It has to: a
      // cap that only counted AUDIBLE voices could be walked straight past by a
      // caller scheduling a hundred claps two seconds out, and the graph would
      // hold every one of them.
      sfxVoices.push(voice);

      // AFTER the push, so the `sfxVoices` count debugLog appends is the live
      // count INCLUDING this voice — logging it before would always be one
      // short and the cap would look unreachable.
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
          // The claimant may have asked for something else — or for nothing —
          // while this was decoding; `currentMusicUrl` is the last word.
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
