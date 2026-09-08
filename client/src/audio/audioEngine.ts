import { createAudioBufferCache, reportAssetFailure } from './audioBuffers.ts';
import {
  AUDIO_DEBUG,
  AUDIO_DEBUG_WEIGHT_STEP,
  AUDIO_MUSIC_URL,
  createAudioDebugLog,
  DEV_MUSIC_CLAIMANT,
} from './audioDebug.ts';
import {
  buildAudioGraph,
  clampGain,
  disposeAudioGraph,
  followAudioPrefs,
  SILENT_GAIN,
  UNITY_GAIN,
} from './audioGraph.ts';
import { createAudioVoices, type AmbienceLayer, type AudioVoices } from './audioVoices.ts';
import type { MusicGenerator, MusicOutlet, PluginAudio, SfxOptions } from '../plugins/types.ts';
import type { Viewport } from '../render/scene.ts';

interface PluginAudioState {
  readonly name: string;
  readonly ambience: Map<string, AmbienceLayer>;
  released: boolean;
}

export interface AudioEngine {
  unlock(): void;
  forPlugin(name: string): { readonly audio: PluginAudio; readonly release: () => void };
  dispose(): void;
}

export function createAudioEngine(viewport: Viewport): AudioEngine {
  const graph = buildAudioGraph(viewport);
  if (graph === null) return createSilentAudioEngine();
  const active = graph;

  const buffers = createAudioBufferCache(active.context);

  let voices: AudioVoices | undefined;
  const debugLog = createAudioDebugLog(active, () => voices?.voiceCount() ?? 0);
  voices = createAudioVoices({ graph: active, buffers, debugLog });
  const activeVoices = voices;

  const disposePrefs = followAudioPrefs(active);

  const plugins = new Map<string, PluginAudioState>();

  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  let disposed = false;

  let resuming = false;

  function unlock(): void {
    if (disposed || resuming) return;
    if (active.context.state !== 'suspended') return;
    resuming = true;
    void active.context.resume().then(
      () => {
        resuming = false;
        debugLog('unlock', { url: null, bus: null, gain: active.master.gain.value });
      },
      () => {
        resuming = false;
      },
    );
  }

  const onWindowGesture = (): void => {
    unlock();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onWindowGesture, { once: true });
    window.addEventListener('pointerdown', onWindowGesture, { once: true });
  }

  function refuseMusic(name: string): void {
    if (musicRefusals.has(name)) return;
    musicRefusals.add(name);
    console.warn(
      `music bus already claimed by "${String(musicClaimant)}"; ignoring updates from "${name}"`,
    );
  }

  function claimMusic(name: string): boolean {
    if (musicClaimant === null) musicClaimant = name;
    if (musicClaimant === name) return true;
    refuseMusic(name);
    return false;
  }

  function buildHandle(state: PluginAudioState): PluginAudio {
    return {
      preload(url: string): void {
        if (state.released) return;
        void buffers.get(url).catch((error: unknown) => {
          reportAssetFailure(url, error);
        });
        debugLog('preload', { url, bus: 'sfx', gain: null });
      },

      playSfx(url: string, opts?: SfxOptions): void {
        if (state.released) return;
        const cached = buffers.peek(url);
        if (cached === undefined) {
          void buffers.get(url).catch((error: unknown) => {
            reportAssetFailure(url, error);
          });
          debugLog('playSfx (decoding, dropped)', {
            url,
            bus: 'sfx',
            gain: clampGain(opts?.gain, UNITY_GAIN),
          });
          return;
        }
        void cached.then(
          (buffer) => {
            if (state.released) return;
            activeVoices.playSfx(url, buffer, opts);
          },
          () => {
          },
        );
      },

      ambience(url: string, weight: number): void {
        if (state.released) return;
        const target = clampGain(weight, SILENT_GAIN);
        let layer = state.ambience.get(url);
        if (layer === undefined) {
          if (target <= SILENT_GAIN) return;
          layer = {
            weight: target,
            audio: null,
            stopTimer: null,
            decoding: false,
            lastLoggedWeight: target,
          };
          debugLog('ambience (layer opened)', { url, bus: 'ambience', gain: target });
          state.ambience.set(url, layer);
        } else {
          if (layer.weight === target) return;
          layer.weight = target;
          if (
            AUDIO_DEBUG &&
            (target === SILENT_GAIN ||
              target === UNITY_GAIN ||
              Math.abs(target - layer.lastLoggedWeight) >= AUDIO_DEBUG_WEIGHT_STEP)
          ) {
            layer.lastLoggedWeight = target;
            debugLog('ambience', { url, bus: 'ambience', gain: target });
          }
        }
        if (layer.audio !== null) {
          activeVoices.retargetAmbience(layer);
          return;
        }
        if (!layer.decoding && target > SILENT_GAIN) activeVoices.beginAmbience(url, layer);
      },

      setMusic(url: string | null): void {
        if (state.released) return;
        if (!claimMusic(state.name)) return;
        activeVoices.setMusic(url);
      },

      setMusicGenerator(start: ((outlet: MusicOutlet) => MusicGenerator) | null): void {
        if (state.released) return;
        if (!claimMusic(state.name)) return;
        activeVoices.setMusicGenerator(start);
      },
    };
  }

  function releasePlugin(state: PluginAudioState): void {
    if (state.released) return;
    state.released = true;
    for (const layer of state.ambience.values()) activeVoices.releaseAmbience(layer);
    state.ambience.clear();
    if (musicClaimant === state.name) {
      musicClaimant = null;
      musicRefusals.clear();
      activeVoices.releaseMusic();
    }
    plugins.delete(state.name);
  }

  function registerPlugin(name: string): PluginAudioState {
    const state: PluginAudioState = { name, ambience: new Map(), released: false };
    plugins.set(name, state);
    return state;
  }

  if (AUDIO_MUSIC_URL !== null) {
    buildHandle(registerPlugin(DEV_MUSIC_CLAIMANT)).setMusic(AUDIO_MUSIC_URL);
  }

  return {
    unlock,

    forPlugin(name: string) {
      const state = registerPlugin(name);
      return {
        audio: buildHandle(state),
        release: () => {
          releasePlugin(state);
        },
      };
    },

    dispose(): void {
      disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onWindowGesture);
        window.removeEventListener('pointerdown', onWindowGesture);
      }
      disposePrefs();
      for (const state of [...plugins.values()]) releasePlugin(state);
      activeVoices.stopAll();
      musicClaimant = null;
      musicRefusals.clear();
      buffers.clear();
      disposeAudioGraph(active);
    },
  };
}

function createSilentAudioEngine(): AudioEngine {
  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  function silentHandle(name: string): PluginAudio {
    function claim(): void {
      if (musicClaimant === null) musicClaimant = name;
      if (musicClaimant === name) return;
      if (musicRefusals.has(name)) return;
      musicRefusals.add(name);
      console.warn(
        `music bus already claimed by "${String(musicClaimant)}"; ignoring updates from "${name}"`,
      );
    }
    return {
      preload(): void {
      },
      playSfx(): void {
      },
      ambience(): void {
      },
      setMusic(): void {
        claim();
      },
      setMusicGenerator(): void {
        claim();
      },
    };
  }

  return {
    unlock(): void {
    },
    forPlugin(name: string) {
      return {
        audio: silentHandle(name),
        release: (): void => {
          if (musicClaimant !== name) return;
          musicClaimant = null;
          musicRefusals.clear();
        },
      };
    },
    dispose(): void {
      musicClaimant = null;
      musicRefusals.clear();
    },
  };
}
