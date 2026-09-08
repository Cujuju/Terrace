import { Audio, AudioListener, Group } from 'three';
import { createEffect, createRoot } from 'solid-js';
import {
  AUDIO_BUS_NAMES,
  effectiveBusGain,
  effectiveMasterGain,
  type AudioBusName,
} from '../state/audioPrefs.ts';
import type { Viewport } from '../render/scene.ts';

export type AnyAudio = Audio<AudioNode>;

export const SILENT_GAIN = 0;

export const UNITY_GAIN = 1;

export const MASTER_RAMP_SECONDS = 0.05;

const LIMITER_THRESHOLD_DB = -2;

const LIMITER_KNEE_DB = 0;

const LIMITER_RATIO = 20;

const LIMITER_ATTACK_SECONDS = 0.003;

const LIMITER_RELEASE_SECONDS = 0.25;

const POSITIONAL_VOICE_GROUP_NAME = 'core:audio-voices';

export interface AudioGraph {
  readonly context: AudioContext;
  readonly listener: AudioListener;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly buses: Readonly<Record<AudioBusName, GainNode>>;
  readonly positionalRoot: Group;
}

export function buildAudioGraph(viewport: Viewport): AudioGraph | null {
  let listener: AudioListener;
  try {
    listener = new AudioListener();
  } catch (error) {
    console.warn('[terrace] audio unavailable; the world will be silent', error);
    return null;
  }
  const context = listener.context;

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
    bus.gain.value = effectiveBusGain(name);
    bus.connect(master);
    buses[name] = bus;
  }

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
  void graph.context.close().catch(() => {
  });
}

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
  voice.gain.disconnect();
  voice.gain.connect(graph.buses[bus]);
}

export function clampGain(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(UNITY_GAIN, Math.max(SILENT_GAIN, value));
}
