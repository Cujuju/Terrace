// The audio graph: context, listener, buses, master, limiter, and the prefs
// effects that drive their gains.
//
//   voices ──► bus gain (sfx | ambience | music) ──► master ──► limiter ──► destination

import { Audio, AudioListener, Group } from 'three';
import { createEffect, createRoot } from 'solid-js';
import {
  AUDIO_BUS_NAMES,
  effectiveBusGain,
  effectiveMasterGain,
  type AudioBusName,
} from '../state/audioPrefs.ts';
import type { Viewport } from '../render/scene.ts';

/** three types PositionalAudio as `Audio<PannerNode>`; this holds both kinds. */
export type AnyAudio = Audio<AudioNode>;

/** Every fade here is a linear ramp to a real zero, and this is that zero. */
export const SILENT_GAIN = 0;

export const UNITY_GAIN = 1;

/** Removes the click a stepped gain makes; too short to hear as a fade. */
export const MASTER_RAMP_SECONDS = 0.05;

// A SAFETY limiter, not a mix tool: the master's 0.8 headroom is a default the
// player can undo.
//
// Values below are chosen to be inaudible until the ceiling, then hold it.

/** −2 dBFS: under the ceiling, above anything one voice can reach. */
const LIMITER_THRESHOLD_DB = -2;

/** Hard knee. A soft knee attenuates below threshold — that is compression. */
const LIMITER_KNEE_DB = 0;

/** 20:1, Web Audio's maximum, which is what makes this a limiter. */
const LIMITER_RATIO = 20;

/** 3 ms ≈ one cycle at 300 Hz; faster tracks the waveform and distorts bass. */
const LIMITER_ATTACK_SECONDS = 0.003;

/** 250 ms: long enough not to pump between claps a quarter-second apart. */
const LIMITER_RELEASE_SECONDS = 0.25;

const POSITIONAL_VOICE_GROUP_NAME = 'core:audio-voices';

export interface AudioGraph {
  readonly context: AudioContext;
  readonly listener: AudioListener;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly buses: Readonly<Record<AudioBusName, GainNode>>;
  /**
   * In the SCENE — never a plugin layer, cleared on unmount
   * (plugins/host.ts:922), and never outside it, since a panner only moves in
   * updateMatrixWorld (PositionalAudio.js:217).
   */
  readonly positionalRoot: Group;
}

/**
 * CALLED EAGERLY. A browser refuses to START a context without a gesture, not
 * to CREATE one: `new AudioContext()` begins suspended.
 *
 * Lazily meant no `decodeAudioData` until the first click, so the first sound
 * of every kind was dropped. Nothing is audible before the gesture either way.
 */
export function buildAudioGraph(viewport: Viewport): AudioGraph | null {
  let listener: AudioListener;
  try {
    listener = new AudioListener();
  } catch (error) {
    console.warn('[terrace] audio unavailable; the world will be silent', error);
    return null;
  }
  const context = listener.context;

  // Master → limiter → destination, bypassing listener.gain: `routeToBus`
  // reroutes every voice off three's default (Audio.js:65) onto its bus.
  //
  // The limiter is LAST, so pulling the master down still lowers the output.
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = LIMITER_THRESHOLD_DB;
  limiter.knee.value = LIMITER_KNEE_DB;
  limiter.ratio.value = LIMITER_RATIO;
  limiter.attack.value = LIMITER_ATTACK_SECONDS;
  limiter.release.value = LIMITER_RELEASE_SECONDS;
  limiter.connect(context.destination);

  const master = context.createGain();
  master.gain.value = effectiveMasterGain();
  master.connect(limiter);

  const buses = {} as Record<AudioBusName, GainNode>;
  for (const name of AUDIO_BUS_NAMES) {
    const bus = context.createGain();
    // Seeded from the pref, not unity: waiting for the effects to ramp would
    // play the first moments at the wrong level.
    bus.gain.value = effectiveBusGain(name);
    bus.connect(master);
    buses[name] = bus;
  }

  // three updates the listener from its parent's world matrix
  // (AudioListener.js:175), so the ears follow the camera for no per-frame JS.
  viewport.camera.add(listener);

  const positionalRoot = new Group();
  positionalRoot.name = POSITIONAL_VOICE_GROUP_NAME;
  viewport.scene.add(positionalRoot);

  return { context, listener, master, limiter, buses, positionalRoot };
}

export function disposeAudioGraph(graph: AudioGraph): void {
  graph.positionalRoot.removeFromParent();
  graph.listener.removeFromParent();
  graph.master.disconnect();
  graph.limiter.disconnect();
  // Closed because it owns a hardware output stream.
  void graph.context.close().catch(() => {
    /* Already closed, or closing is unsupported. */
  });
}

/**
 * ONE EFFECT PER GAIN: an effect re-runs when any signal it read changes, so
 * one effect would re-ramp four nodes per slider drag. Returns its dispose.
 */
export function followAudioPrefs(graph: AudioGraph): () => void {
  return createRoot((disposeRoot) => {
    createEffect(() => {
      rampGain(graph.master.gain, effectiveMasterGain(), MASTER_RAMP_SECONDS, graph.context);
    });
    for (const name of AUDIO_BUS_NAMES) {
      createEffect(() => {
        rampGain(graph.buses[name].gain, effectiveBusGain(name), MASTER_RAMP_SECONDS, graph.context);
      });
    }
    return disposeRoot;
  });
}

/**
 * Cancel-and-reseat first: a ramp started mid-ramp would interpolate from the
 * old endpoint, not from where the signal is — a click.
 *
 * Retargeting mid-fade is the common path here, not an edge.
 */
export function rampGain(
  param: AudioParam,
  target: number,
  seconds: number,
  context: AudioContext,
): void {
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

export function routeToBus(voice: AnyAudio, bus: AudioBusName, graph: AudioGraph): void {
  // Argument-less disconnect drops three's own wiring to listener.getInput()
  // without coupling us to which node that was.
  voice.gain.disconnect();
  voice.gain.connect(graph.buses[bus]);
}

export function clampGain(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(UNITY_GAIN, Math.max(SILENT_GAIN, value));
}
