import { Audio, PositionalAudio } from 'three';
import { CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE } from '../config.ts';
import type { MusicGenerator, MusicOutlet, SfxOptions } from '../plugins/types.ts';
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

export const MAX_SFX_VOICES = 32;

export const SFX_REFERENCE_DISTANCE_WORLD_UNITS = CAMERA_MIN_DISTANCE;

export const SFX_MAX_DISTANCE_WORLD_UNITS = CAMERA_MAX_DISTANCE;

const SFX_ROLLOFF_FACTOR = 1;

const SFX_PANNING_MODEL: PanningModelType = 'equalpower';

const DEFAULT_SFX_GAIN = 1;

const AMBIENCE_FADE_SECONDS = 1.5;

const MUSIC_CROSSFADE_SECONDS = 2;

const MUSIC_TRACK_GAIN = 1;

const FADE_STOP_SLACK_SECONDS = 0.1;

const MILLISECONDS_PER_SECOND = 1000;

const NO_FADE_SECONDS = 0;

type MusicSource = { readonly kind: 'url'; readonly url: string } | { readonly kind: 'generator' };

export interface AmbienceLayer {
  weight: number;
  audio: Audio | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  decoding: boolean;
  lastLoggedWeight: number;
}

export interface AudioVoices {
  voiceCount(): number;
  playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void;
  retargetAmbience(layer: AmbienceLayer): void;
  beginAmbience(url: string, layer: AmbienceLayer): void;
  releaseAmbience(layer: AmbienceLayer): void;
  setMusic(url: string | null): void;
  setMusicGenerator(start: ((outlet: MusicOutlet) => MusicGenerator) | null): void;
  releaseMusic(): void;
  musicUrl(): string | null;
  stopAll(): void;
}

export function createAudioVoices(deps: {
  readonly graph: AudioGraph;
  readonly buffers: AudioBufferCache;
  readonly debugLog: AudioDebugLog;
}): AudioVoices {
  const { graph, buffers, debugLog } = deps;

  const sfxVoices: AnyAudio[] = [];

  let currentMusicSource: MusicSource | null = null;

  let musicVoice: Audio | null = null;

  let musicGenerator: MusicGenerator | null = null;
  let musicLane: GainNode | null = null;

  function retireSfx(voice: AnyAudio): void {
    const index = sfxVoices.indexOf(voice);
    if (index !== -1) sfxVoices.splice(index, 1);
    if (voice.isPlaying) voice.stop();
    voice.removeFromParent();
  }

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
    if (layer.stopTimer !== null) {
      clearTimeout(layer.stopTimer);
      layer.stopTimer = null;
    }
    rampGain(voice.gain.gain, layer.weight, AMBIENCE_FADE_SECONDS, graph.context);
    if (layer.weight > SILENT_GAIN) return;
    layer.stopTimer = setTimeout(
      () => {
        layer.stopTimer = null;
        releaseAmbience(layer);
      },
      (AMBIENCE_FADE_SECONDS + FADE_STOP_SLACK_SECONDS) * MILLISECONDS_PER_SECOND,
    );
  }

  function beginAmbience(url: string, layer: AmbienceLayer): void {
    layer.decoding = true;
    void buffers.get(url).then(
      (buffer) => {
        layer.decoding = false;
        if (layer.audio !== null || layer.weight <= SILENT_GAIN) return;
        const voice = new Audio(graph.listener);
        routeToBus(voice, 'ambience', graph);
        voice.setBuffer(buffer);
        voice.setLoop(true);
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

  function releaseMusic(): void {
    const outgoing = musicVoice;
    musicVoice = null;
    if (outgoing !== null) {
      rampGain(outgoing.gain.gain, SILENT_GAIN, MUSIC_CROSSFADE_SECONDS, graph.context);
      setTimeout(
        () => {
          if (outgoing.isPlaying) outgoing.stop();
          outgoing.gain.disconnect();
        },
        (MUSIC_CROSSFADE_SECONDS + FADE_STOP_SLACK_SECONDS) * MILLISECONDS_PER_SECOND,
      );
    }

    const generator = musicGenerator;
    const lane = musicLane;
    musicGenerator = null;
    musicLane = null;
    currentMusicSource = null;
    if (lane === null) return;
    rampGain(lane.gain, SILENT_GAIN, MUSIC_CROSSFADE_SECONDS, graph.context);
    generator?.stop(MUSIC_CROSSFADE_SECONDS);
    setTimeout(
      () => {
        lane.disconnect();
      },
      (MUSIC_CROSSFADE_SECONDS + FADE_STOP_SLACK_SECONDS) * MILLISECONDS_PER_SECOND,
    );
  }

  return {
    voiceCount(): number {
      return sfxVoices.length;
    },

    releaseAmbience,
    retargetAmbience,
    beginAmbience,

    playSfx(url: string, buffer: AudioBuffer, opts: SfxOptions | undefined): void {
      while (sfxVoices.length >= MAX_SFX_VOICES) retireSfx(sfxVoices[0]);

      const at = opts?.at;
      let voice: AnyAudio;
      if (at === undefined) {
        voice = new Audio(graph.listener);
      } else {
        const positional = new PositionalAudio(graph.listener);
        positional.panner.panningModel = SFX_PANNING_MODEL;
        positional.setDistanceModel('inverse');
        positional.setRefDistance(SFX_REFERENCE_DISTANCE_WORLD_UNITS);
        positional.setMaxDistance(SFX_MAX_DISTANCE_WORLD_UNITS);
        positional.setRolloffFactor(SFX_ROLLOFF_FACTOR);
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
      const delay = delaySecondsOf(opts);
      const threeOnEnded = voice.onEnded.bind(voice);
      voice.onEnded = (): void => {
        threeOnEnded();
        retireSfx(voice);
      };
      voice.play(delay);
      sfxVoices.push(voice);

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
      return currentMusicSource !== null && currentMusicSource.kind === 'url'
        ? currentMusicSource.url
        : null;
    },

    releaseMusic,

    setMusic(url: string | null): void {
      if (url === null && currentMusicSource === null) return;
      if (currentMusicSource?.kind === 'url' && currentMusicSource.url === url) return;
      releaseMusic();
      if (url === null) {
        debugLog('setMusic', { url: null, bus: 'music', gain: SILENT_GAIN });
        return;
      }
      currentMusicSource = { kind: 'url', url };
      void buffers.get(url).then(
        (buffer) => {
          const source = currentMusicSource;
          if (source === null || source.kind !== 'url' || source.url !== url) return;
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

    setMusicGenerator(start: ((outlet: MusicOutlet) => MusicGenerator) | null): void {
      if (start === null && currentMusicSource === null) return;
      releaseMusic();
      if (start === null) {
        debugLog('setMusicGenerator', { url: null, bus: 'music', gain: SILENT_GAIN });
        return;
      }
      const lane = graph.context.createGain();
      lane.gain.value = SILENT_GAIN;
      lane.connect(graph.buses.music);
      try {
        musicGenerator = start({ context: graph.context, destination: lane });
      } catch (error) {
        lane.disconnect();
        console.error('[terrace audio] music generator threw in start', error);
        return;
      }
      musicLane = lane;
      currentMusicSource = { kind: 'generator' };
      rampGain(lane.gain, MUSIC_TRACK_GAIN, MUSIC_CROSSFADE_SECONDS, graph.context);
      debugLog('setMusicGenerator', { url: null, bus: 'music', gain: MUSIC_TRACK_GAIN });
    },

    stopAll(): void {
      for (const voice of [...sfxVoices]) retireSfx(voice);
      if (musicVoice !== null) {
        if (musicVoice.isPlaying) musicVoice.stop();
        musicVoice.gain.disconnect();
        musicVoice = null;
      }
      musicGenerator?.stop(NO_FADE_SECONDS);
      musicGenerator = null;
      musicLane?.disconnect();
      musicLane = null;
      currentMusicSource = null;
    },
  };
}
