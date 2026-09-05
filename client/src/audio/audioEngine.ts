// The audio POLICY: per-plugin handles, the music claim, unlock, teardown.
// Plumbing is ./audioGraph.ts, decoding ./audioBuffers.ts, sound ./audioVoices.ts.
// Contract: client/src/plugins/types.ts's PluginAudio. Design and the rejected
// alternatives: .claude/plans/audio-host.md.
//
// CORE OWNS THE WHOLE GRAPH: browsers cap AudioContexts per page, the listener
// must track one camera, the master must silence everything. One owner.
//
// Nothing in this directory runs per frame: Web Audio schedules and mixes on
// its own thread, so the 7 ms budget (docs/DESIGN.md) is untouched.

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
import type { PluginAudio, SfxOptions } from '../plugins/types.ts';
import type { Viewport } from '../render/scene.ts';

/** One plugin's whole audio state, released together when it detaches. */
interface PluginAudioState {
  readonly name: string;
  /** Keyed by URL — the (plugin, url) identity `ambience` promises. */
  readonly ambience: Map<string, AmbienceLayer>;
  released: boolean;
}

export interface AudioEngine {
  /**
   * Resumes the context, which browsers only allow from a gesture. Idempotent,
   * so the host may call it from every press. A refusal is the normal
   * pre-click state, not an error.
   */
  unlock(): void;
  /** `release` is idempotent — the host's `undo` list may run it twice. */
  forPlugin(name: string): { readonly audio: PluginAudio; readonly release: () => void };
  dispose(): void;
}

export function createAudioEngine(viewport: Viewport): AudioEngine {
  const graph = buildAudioGraph(viewport);
  // No Web Audio: degrade whole rather than null-check every voice and handle.
  if (graph === null) return createSilentAudioEngine();
  // Aliased because this compiler does not carry a const's narrowing into the
  // closures below, and this beats a `!` at thirty call sites.
  const active = graph;

  const buffers = createAudioBufferCache(active.context);

  /**
   * The logger closes over the VARIABLE, not the value, so it can report the
   * live voice count without the two modules being a construction cycle.
   */
  let voices: AudioVoices | undefined;
  const debugLog = createAudioDebugLog(active, () => voices?.voiceCount() ?? 0);
  voices = createAudioVoices({ graph: active, buffers, debugLog });
  const activeVoices = voices;

  const disposePrefs = followAudioPrefs(active);

  /** Every plugin's state, by plugin name. */
  const plugins = new Map<string, PluginAudioState>();

  /**
   * SINGLE CLAIMANT, as plugins/host.ts:302's skyRigClaimant: first caller owns
   * the bus, later ones refused ONCE — a loop would bury the console.
   */
  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  let disposed = false;

  /**
   * One press reaches `unlock` twice (canvas listener plus the window one-shot)
   * and both run before the first resume settles, so the state guard cannot
   * catch the second.
   */
  let resuming = false;

  /**
   * RESUME-ONLY: the graph exists from construction, and a voice started while
   * suspended is already scheduled. A still-refused resume is not an error.
   */
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
        // Still locked; cleared so the NEXT gesture may try again.
        resuming = false;
      },
    );
  }

  /**
   * For a KEYBOARD-FIRST player: the host's canvas pointerdown
   * (plugins/host.ts:348) never sees a press that was a keystroke.
   */
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

  /** `state` carries the identity that keys ambience and scopes the release. */
  function buildHandle(state: PluginAudioState): PluginAudio {
    return {
      preload(url: string): void {
        if (state.released) return;
        // The cache makes this idempotent for free. The catch is what keeps
        // the contract's "never throws".
        void buffers.get(url).catch((error: unknown) => {
          reportAssetFailure(url, error);
        });
        debugLog('preload', { url, bus: 'sfx', gain: null });
      },

      playSfx(url: string, opts?: SfxOptions): void {
        if (state.released) return;
        const cached = buffers.peek(url);
        if (cached === undefined) {
          // NOT DECODED YET: start the decode, play nothing. A clap whenever
          // the fetch finished is worse than none. A plugin that called
          // `preload` in attach never reaches here.
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
            /* Already reported by whoever started the decode. */
          },
        );
      },

      ambience(url: string, weight: number): void {
        if (state.released) return;
        const target = clampGain(weight, SILENT_GAIN);
        let layer = state.ambience.get(url);
        if (layer === undefined) {
          if (target <= SILENT_GAIN) return; // nothing to create and nothing to fade
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
          // The per-frame short-circuit the contract promises.
          if (layer.weight === target) return;
          layer.weight = target;
          // Thinned, but the endpoints always print: a fade trace needs them.
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
        if (musicClaimant === null) musicClaimant = state.name;
        if (musicClaimant !== state.name) {
          // Once per losing holder — plugins/host.ts:757's reasoning.
          refuseMusic(state.name);
          return;
        }
        if (activeVoices.musicUrl() === url) return; // already playing (or stopped)
        activeVoices.setMusic(url);
      },
    };
  }

  function releasePlugin(state: PluginAudioState): void {
    if (state.released) return;
    state.released = true;
    for (const layer of state.ambience.values()) activeVoices.releaseAmbience(layer);
    state.ambience.clear();
    // A DETACHED CLAIMANT FREES THE BUS — unlike the sky rig, silence is a fine
    // resting state, and a track whose owner is gone has nobody to stop it.
    if (musicClaimant === state.name) {
      musicClaimant = null;
      musicRefusals.clear();
      if (activeVoices.musicUrl() !== null) activeVoices.setMusic(null);
    }
    plugins.delete(state.name);
  }

  function registerPlugin(name: string): PluginAudioState {
    const state: PluginAudioState = { name, ambience: new Map(), released: false };
    plugins.set(name, state);
    return state;
  }

  // Core claims the bus for the dev switch, since no plugin claims music yet.
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

/**
 * IT STILL ARBITRATES: bare no-ops would make the claim depend on whether the
 * machine has an audio stack. Only silence should differ.
 */
function createSilentAudioEngine(): AudioEngine {
  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  function silentHandle(name: string): PluginAudio {
    return {
      preload(): void {
        /* nothing to decode into */
      },
      playSfx(): void {
        /* nothing to play it on */
      },
      ambience(): void {
        /* nothing to loop it on */
      },
      setMusic(): void {
        if (musicClaimant === null) musicClaimant = name;
        if (musicClaimant === name) return;
        if (musicRefusals.has(name)) return;
        musicRefusals.add(name);
        console.warn(
          `music bus already claimed by "${String(musicClaimant)}"; ignoring updates from "${name}"`,
        );
      },
    };
  }

  return {
    unlock(): void {
      /* there is nothing to resume */
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
