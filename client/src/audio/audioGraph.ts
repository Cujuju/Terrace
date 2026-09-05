// The audio GRAPH: the context, the listener, the buses, the master and the
// limiter — the fixed plumbing every voice is plugged into, and the player's
// prefs that drive its gains.
//
//   plugin voices ──► bus gain (sfx | ambience | music) ──► master ──► limiter ──► destination
//                              ▲                               ▲
//         audioPrefs, one level per bus ┘   audioPrefs (volume × mute) ┘
//
// Nothing here knows what a plugin is or what a one-shot is. It builds the
// nodes, keeps their gains following the prefs, and offers the two operations
// every voice kind needs on them (`rampGain`, `routeToBus`). ./audioVoices.ts
// makes sounds with it; ./audioEngine.ts decides who is allowed to.

import { Audio, AudioListener, Group } from 'three';
import { createEffect, createRoot } from 'solid-js';
import {
  AUDIO_BUS_NAMES,
  effectiveBusGain,
  effectiveMasterGain,
  type AudioBusName,
} from '../state/audioPrefs.ts';
import type { Viewport } from '../render/scene.ts';

// The bus names themselves live in state/audioPrefs.ts, imported above — see
// that module's AudioBusName for why the declaration sits at the end this
// module imports rather than at the end that builds the nodes. A plugin never
// names a bus at all; the method it calls picks one.

/**
 * EITHER KIND OF VOICE. three types `PositionalAudio` as `Audio<PannerNode>`
 * (its `getOutput()` is the panner, three/src/audio/PositionalAudio.js:84), so
 * the one type that holds both is the generic's own upper bound. Only `.gain` —
 * a plain GainNode on both — is touched through it.
 */
export type AnyAudio = Audio<AudioNode>;

/**
 * A gain of exactly zero is illegal in an exponential ramp and inaudible in a
 * linear one, and Web Audio's `setTargetAtTime` approaches its target
 * asymptotically. Every fade in this directory is therefore a LINEAR ramp to a
 * real zero, and this is the value "silent" means.
 */
export const SILENT_GAIN = 0;

/** Full level for a bus or a master that is not being attenuated. */
export const UNITY_GAIN = 1;

/**
 * How long the master or a bus takes to reach a new level, in seconds.
 *
 * 50 ms: long enough that dragging a slider is a smooth level change rather
 * than a staircase of clicks (a stepped gain is an instantaneous discontinuity
 * in the waveform, which is audible as a tick), short enough that a player who
 * hits mute hears silence and not a fade. Below about 10 ms the ramp stops
 * being long enough to remove the discontinuity, which is the whole point of it.
 */
export const MASTER_RAMP_SECONDS = 0.05;

// ── The limiter ──────────────────────────────────────────────────────────────
//
// A safety limiter sits between the master and the destination. It is BELT AND
// SUSPENDERS, not a mix tool: DEFAULT_MASTER_VOLUME's 0.8 of headroom is the
// belt, and it is a convention that a player can now undo — the master and the
// three bus sliders all go to 1.0 — so it cannot be the only thing standing
// between MAX_SFX_VOICES stacked thunderclaps and a clipped output stage.
// Digital clipping is not a soft failure; it is a buzz over everything, and it
// happens exactly when the world is at its most dramatic.
//
// Every constant below is chosen so the limiter is INAUDIBLE until the ceiling
// and then holds it — never so that it shapes the ordinary mix.

/**
 * Where the limiter starts working, in dBFS.
 *
 * −2: a hair under the 0 dBFS ceiling. One voice cannot reach it in the shipped
 * mix (the generated placeholders peak at 0.7 of full scale, i.e. −3.1 dBFS,
 * and the master's default takes another 1.9 dB off), so nothing a single sound
 * does is touched. Two or three full-scale sounds landing together do reach it,
 * which is the case this exists for.
 */
const LIMITER_THRESHOLD_DB = -2;

/**
 * How gradually it engages around the threshold, in dB.
 *
 * ZERO — a hard knee. A soft knee starts attenuating BELOW the threshold, which
 * is compression: it would quietly reshape the dynamics of every loud moment,
 * which is a mix decision and not this node's job. A limiter should do nothing
 * at all until the ceiling.
 */
const LIMITER_KNEE_DB = 0;

/**
 * Input-to-output ratio above the threshold.
 *
 * 20:1, which is Web Audio's maximum and the number that makes this a LIMITER
 * rather than a compressor: 10 dB of overshoot comes out as 0.5 dB. Anything
 * lower would let a big enough stack through to clip anyway, which would leave
 * the node costing CPU without closing the failure it was added for.
 */
const LIMITER_RATIO = 20;

/**
 * How fast it clamps an overshoot, in seconds.
 *
 * 3 ms. Fast enough to catch the leading edge of a thunderclap before it clips,
 * and deliberately no faster: an attack shorter than one cycle of the signal
 * tracks the WAVEFORM instead of its envelope, which is audible as distortion
 * on low frequencies — and low frequency is most of what thunder is. 3 ms is
 * about one cycle at 300 Hz.
 */
const LIMITER_ATTACK_SECONDS = 0.003;

/**
 * How fast it lets go again, in seconds.
 *
 * 250 ms. Long enough that a burst of strikes does not pump — the gain settling
 * back up between claps a quarter-second apart would be heard as the world
 * breathing — and short enough that the mix is back to full before the next
 * weather event a second or more later.
 */
const LIMITER_RELEASE_SECONDS = 0.25;

/** Name of the core-owned Group positional voices are parented into. */
const POSITIONAL_VOICE_GROUP_NAME = 'core:audio-voices';

/**
 * The whole fixed graph. Built once, at engine construction — see
 * `buildAudioGraph` for why that is legal before a user gesture.
 */
export interface AudioGraph {
  readonly context: AudioContext;
  readonly listener: AudioListener;
  readonly master: GainNode;
  /** The safety limiter between the master and the destination — see above. */
  readonly limiter: DynamicsCompressorNode;
  readonly buses: Readonly<Record<AudioBusName, GainNode>>;
  /**
   * Where positional voices hang, in the SCENE and not in any plugin's layer.
   *
   * NOT THE PLUGIN'S LAYER, deliberately. A layer is emptied and removed when
   * its plugin unmounts (plugins/host.ts:922) and is the plugin's to clear at
   * will; a voice parented there would be silenced by a redraw. It also has to
   * be in the scene at all, because a PositionalAudio's panner is only moved by
   * its own updateMatrixWorld (three/src/audio/PositionalAudio.js:217), which
   * only runs for an object the renderer walks.
   */
  readonly positionalRoot: Group;
}

/**
 * Builds the graph, or returns null where Web Audio does not exist at all.
 *
 * CALLED EAGERLY, before any user gesture, and that is deliberate and legal. A
 * browser refuses to START an AudioContext before a gesture; it does not refuse
 * to CREATE one — `new AudioContext()` begins in the 'suspended' state, which
 * is the whole reason `resume()` exists. Building lazily at the first click
 * bought nothing and cost the thing that mattered: with no context there is no
 * `decodeAudioData`, so no asset could be decoded until the player clicked and
 * the first sound of every kind was therefore dropped (see `preload` on
 * PluginAudio). Nothing is audible before the gesture either way — a suspended
 * context's clock does not advance.
 */
export function buildAudioGraph(viewport: Viewport): AudioGraph | null {
  // three's AudioListener constructs the page's AudioContext for us
  // (three/src/audio/AudioListener.js) — one context, and the one the listener
  // and every panner already agree on.
  let listener: AudioListener;
  try {
    listener = new AudioListener();
  } catch (error) {
    // No Web Audio at all (an ancient browser, a hardened profile). The world
    // is simply silent; nothing else about it changes.
    console.warn('[terrace] audio unavailable; the world will be silent', error);
    return null;
  }
  const context = listener.context;

  // MASTER → LIMITER → DESTINATION, bypassing listener.gain. three wires every
  // voice's own gain to listener.getInput() (Audio.js:65) and the listener's
  // gain to the destination (AudioListener.js:50); every voice is rerouted off
  // that default and onto its bus by `routeToBus` below, so the listener's gain
  // would otherwise be a node with nothing connected to it pretending to be the
  // master. There is exactly one master and it is this one.
  //
  // THE LIMITER IS LAST, after the master rather than before it, because it
  // guards the OUTPUT: a player who pulls the master down must be able to bring
  // the signal back under the ceiling by doing so, and a limiter ahead of the
  // master could not be turned off that way.
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
    // FROM THE PREF, not from unity. The player's stored mix was loaded at
    // module init; starting every bus at 1 and waiting for the effects in
    // `followAudioPrefs` to ramp it would play the first moments at the wrong
    // level — the same reason `master.gain.value` is seeded above.
    bus.gain.value = effectiveBusGain(name);
    bus.connect(master);
    buses[name] = bus;
  }

  // ON THE CAMERA: three updates the listener's position and orientation from
  // its parent's world matrix in updateMatrixWorld
  // (three/src/audio/AudioListener.js:175), so the ears follow the camera for
  // no per-frame JS of ours.
  viewport.camera.add(listener);

  const positionalRoot = new Group();
  positionalRoot.name = POSITIONAL_VOICE_GROUP_NAME;
  viewport.scene.add(positionalRoot);

  return { context, listener, master, limiter, buses, positionalRoot };
}

/**
 * Takes the graph out of the scene and closes its context. Everything a voice
 * owns must already have been stopped — this is the plumbing's own teardown.
 */
export function disposeAudioGraph(graph: AudioGraph): void {
  graph.positionalRoot.removeFromParent();
  graph.listener.removeFromParent();
  graph.master.disconnect();
  graph.limiter.disconnect();
  // The context itself is closed: it owns a hardware output stream, and a
  // client torn down without closing it would leave that stream open for the
  // life of the tab.
  void graph.context.close().catch(() => {
    /* Already closed, or closing is unsupported; nothing to do either way. */
  });
}

/**
 * Keeps the master's gain and each bus's gain following the player's prefs.
 * Returns the dispose for the subscriptions.
 *
 * DRIVEN BY SOLID EFFECTS IN THEIR OWN ROOT. The prefs are module-scope signals
 * (state/audioPrefs.ts, the controlPrefs.ts shape) and this is imperative code
 * outside any component, so `createRoot` is how an imperative owner subscribes
 * to them — one mechanism for both readers rather than a second callback list
 * bolted onto the prefs module for us.
 *
 * ONE EFFECT PER GAIN, not one effect writing four. An effect re-runs when ANY
 * signal it read changes, so a single effect reading all four prefs would
 * re-ramp all four nodes on every drag of any one slider — four scheduled ramps
 * where one was asked for, and three of them on nodes that had not moved.
 * Paired with one signal per bus in audioPrefs.ts, moving the music slider
 * touches the music bus and nothing else.
 */
export function followAudioPrefs(graph: AudioGraph): () => void {
  return createRoot((disposeRoot) => {
    createEffect(() => {
      // READ REACTIVELY, EVERY RUN — never captured into a const outside the
      // effect, which would freeze it (project rule).
      rampGain(graph.master.gain, effectiveMasterGain(), MASTER_RAMP_SECONDS, graph.context);
    });
    for (const name of AUDIO_BUS_NAMES) {
      createEffect(() => {
        // THE SAME RAMP THE MASTER GETS. A bus is the same kind of node
        // carrying the same kind of number, and a stepped gain clicks wherever
        // it is applied — there is no reason for a second fade length here.
        rampGain(graph.buses[name].gain, effectiveBusGain(name), MASTER_RAMP_SECONDS, graph.context);
      });
    }
    return disposeRoot;
  });
}

/**
 * Ramps a gain LINEARLY to `target` over `seconds`.
 *
 * `cancelScheduledValues` + `setValueAtTime(currentValue)` first, because a
 * ramp started while another is still running otherwise interpolates from the
 * OLD ramp's endpoint rather than from where the signal actually is — which is
 * a jump, i.e. a click. Retargeting mid-fade is the normal case here
 * (`ambience` is called every frame), so this is the common path, not an edge.
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

/** Routes a three Audio's own gain off the listener and onto its bus. */
export function routeToBus(voice: AnyAudio, bus: AudioBusName, graph: AudioGraph): void {
  // `disconnect()` with no argument drops every output — here exactly the one
  // three made to listener.getInput() in the constructor (Audio.js:65). Doing
  // it by argument would couple us to which node that was.
  voice.gain.disconnect();
  voice.gain.connect(graph.buses[bus]);
}

/** Clamps a caller-supplied relative level into [SILENT_GAIN, UNITY_GAIN]. */
export function clampGain(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(UNITY_GAIN, Math.max(SILENT_GAIN, value));
}
