// The audio ENGINE: who is allowed to make a sound, and what happens when they
// stop existing (contract: client/src/plugins/types.ts's PluginAudio; design:
// .claude/plans/audio-host.md §2).
//
// This file owns the POLICY. The plumbing is ./audioGraph.ts, the decoding is
// ./audioBuffers.ts, the sound-making is ./audioVoices.ts and the dev switches
// are ./audioDebug.ts; what is here is the per-plugin handle, the music bus's
// single-claimant rule, the autoplay unlock and the teardown.
//
// WHY CORE OWNS ALL OF IT. A browser caps how many AudioContexts a page may
// hold, the listener has to track the ONE camera, and the player's master
// volume has to be able to silence everything — three facts that each say the
// graph has exactly one owner. Plugins ask; core decides.
//
// WHY THREE'S WRAPPERS AND NOT A NEW DEPENDENCY. three is already here, and
// AudioListener/PositionalAudio are exactly the two pieces that are annoying to
// write by hand: the listener's pose is updated from the camera's world matrix
// inside updateMatrixWorld (three/src/audio/AudioListener.js:175) and a
// PositionalAudio's panner from its own (PositionalAudio.js:217-245), so
// tracking costs no per-frame JS of ours at all. Howler/Tone would have brought
// a SECOND graph owner for the one part we need core to own (plan §4).
//
// FRAME BUDGET (140 fps ≈ 7 ms, docs/DESIGN.md): nothing in this directory runs
// per frame. Web Audio schedules, ramps and mixes on its own thread; our JS
// cost is building a handful of nodes at trigger time and, for a repeated
// ambience call at an unchanged weight, one float comparison.

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
   * Resumes the context, which browsers only allow from a user gesture.
   * Idempotent and cheap once running, so the host may call it from every
   * canvas press. A refusal is the NORMAL state of a page before its first
   * click — not an error, and never logged as one.
   */
  unlock(): void;
  /**
   * This plugin's handle and the release the host wires into its teardown.
   * `release` is idempotent (the host's `undo` list may run it after a plugin
   * already cleaned up — see plugins/host.ts:250).
   */
  forPlugin(name: string): { readonly audio: PluginAudio; readonly release: () => void };
  dispose(): void;
}

export function createAudioEngine(viewport: Viewport): AudioEngine {
  const graph = buildAudioGraph(viewport);
  // NO WEB AUDIO IN THIS BROWSER. Everything below assumes a graph, so rather
  // than thread a null check through every voice and every handle, the whole
  // engine degrades to one that arbitrates but makes no sound — see that
  // function's header for why the arbitration still has to happen.
  if (graph === null) return createSilentAudioEngine();
  // ALIASED after the guard. `graph` is a const and narrowed here, but a
  // narrowing does not follow a const into the closures below on this
  // compiler; a second binding that is non-null by construction is clearer
  // than a `!` at every use site.
  const active = graph;

  const buffers = createAudioBufferCache(active.context);

  /**
   * Assigned on the line after the logger; the logger closes over the VARIABLE
   * rather than the value, so it can report the live voice count without the
   * two modules having to be constructed in a cycle. `activeVoices` is the
   * narrowed alias everything below uses, so no other call site pays for the
   * `undefined` this is briefly allowed to be.
   */
  let voices: AudioVoices | undefined;
  const debugLog = createAudioDebugLog(active, () => voices?.voiceCount() ?? 0);
  voices = createAudioVoices({ graph: active, buffers, debugLog });
  const activeVoices = voices;

  const disposePrefs = followAudioPrefs(active);

  /** Every plugin's state, by plugin name. */
  const plugins = new Map<string, PluginAudioState>();

  /**
   * Who owns the music bus, or null while nobody does — the same
   * single-claimant shape as plugins/host.ts:302's skyRigClaimant, with the
   * same once-per-loser refusal set beside it, and for the same reason: this
   * may be driven from a loop and a per-call warning would bury the console.
   */
  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  let disposed = false;

  /**
   * True between calling `resume()` and hearing back.
   *
   * ONE PRESS REACHES `unlock` TWICE — the host's capture-phase canvas listener
   * and this module's own one-shot `window` pointerdown both fire for it — and
   * both run before the first `resume()` settles, so the `state !==
   * 'suspended'` guard cannot catch the second. Two resumes are harmless, but
   * two "unlocked" log lines for one click are a trace that misleads its reader.
   */
  let resuming = false;

  /**
   * RESUME-ONLY. The graph exists from engine construction (see
   * `buildAudioGraph`), so there is nothing to build here and nothing to
   * replay: a voice started while the context was suspended is already
   * scheduled and simply becomes audible when the clock starts. A resume the
   * browser still refuses leaves the context suspended and is NOT an error —
   * the next gesture tries again.
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
   * One-shot window listeners so a KEYBOARD-FIRST player unlocks too: the
   * host's canvas pointerdown (plugins/host.ts:348) covers a click on the
   * world, but a player who tabs to a control and presses a key has made a
   * gesture the canvas never saw. `once` on both, and they are removed on
   * dispose as well in case neither ever fired.
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

  /**
   * Everything one holder may do, built once per holder. `state` carries the
   * identity — which is what keys ambience, arbitrates music and scopes the
   * release.
   */
  function buildHandle(state: PluginAudioState): PluginAudio {
    return {
      preload(url: string): void {
        if (state.released) return;
        // The decode cache makes this idempotent for free: a second call for
        // the same URL — from this plugin or any other — finds the in-flight
        // promise and adds nothing. The `catch` is what keeps the contract's
        // "never throws": without it a failed asset would surface as an
        // unhandled rejection in a plugin that did everything right.
        void buffers.get(url).catch((error: unknown) => {
          reportAssetFailure(url, error);
        });
        debugLog('preload', { url, bus: 'sfx', gain: null });
      },

      playSfx(url: string, opts?: SfxOptions): void {
        if (state.released) return;
        const cached = buffers.peek(url);
        if (cached === undefined) {
          // NOT DECODED YET: START THE DECODE AND PLAY NOTHING. A one-shot is a
          // moment; playing it whenever the fetch happened to finish would put
          // a thunderclap a second after its flash. The contract says so
          // (types.ts, PluginAudio.playSfx) — and a plugin that called
          // `preload` in attach does not come through here at all.
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
          // THE PER-FRAME SHORT-CIRCUIT the contract promises: one float
          // comparison and nothing else when the weight has not moved.
          if (layer.weight === target) return;
          layer.weight = target;
          // THINNED — see AUDIO_DEBUG_WEIGHT_STEP. The endpoints always print:
          // "it reached silence" and "it reached full" are the two facts a fade
          // trace has to contain.
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
          // ONCE PER LOSING HOLDER, not once per call — the same reasoning
          // plugins/host.ts:757 gives for setSkyRig: this may be driven from a
          // frame loop, and a per-call warning would bury the console.
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
    // A DETACHED CLAIMANT FREES THE MUSIC BUS — unlike the sky rig, which keeps
    // whatever look it was last given, silence is a perfectly good resting
    // state and a track whose owner is gone has nobody to stop it.
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

  // ?audioMusic=<url>: core claims the bus on behalf of a synthetic holder, so
  // the music path is exercised in a build with no music consumer (plan §2.4).
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
 * The engine for a browser with no Web Audio at all.
 *
 * IT STILL ARBITRATES. Every method being a bare no-op would be simpler, but it
 * would make the music bus's single-claimant rule depend on whether the machine
 * has an audio stack — so a plugin refused the bus on one browser would be
 * granted it on another, and the bug that eventually surfaced would be about
 * arbitration rather than about sound. Silence is the only thing that should
 * differ here.
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
