// The client's ONE audio graph: context, listener, buses, voices, and the
// per-plugin handles that are the only way into it (contract:
// client/src/plugins/types.ts's PluginAudio; design: .claude/plans/audio-host.md §2).
//
//   plugin voices ──► bus gain (sfx | ambience | music) ──► master ──► limiter ──► destination
//                              ▲                               ▲
//         audioPrefs, one level per bus ┘   audioPrefs (volume × mute) ┘
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
// FRAME BUDGET (140 fps ≈ 7 ms, docs/DESIGN.md): nothing in this file runs per
// frame. Web Audio schedules, ramps and mixes on its own thread; our JS cost is
// building a handful of nodes at trigger time and, for a repeated ambience call
// at an unchanged weight, one float comparison.

import { Audio, AudioListener, Group, PositionalAudio } from 'three';
import { createEffect, createRoot } from 'solid-js';
import { CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE } from '../config.ts';
import {
  AUDIO_BUS_NAMES,
  effectiveBusGain,
  effectiveMasterGain,
  type AudioBusName,
} from '../state/audioPrefs.ts';
import type { PluginAudio, SfxOptions } from '../plugins/types.ts';
import type { Viewport } from '../render/scene.ts';

// ── Named constants ──────────────────────────────────────────────────────────

// The bus names themselves live in state/audioPrefs.ts, imported above — see
// that module's AudioBusName for why the declaration sits at the end this
// module imports rather than at the end that builds the nodes. A plugin never
// names a bus at all; the method it calls picks one.

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

/**
 * How long the master takes to reach a new volume, in seconds.
 *
 * 50 ms: long enough that dragging the slider is a smooth level change rather
 * than a staircase of clicks (a stepped gain is an instantaneous discontinuity
 * in the waveform, which is audible as a tick), short enough that a player who
 * hits mute hears silence and not a fade. Below about 10 ms the ramp stops
 * being long enough to remove the discontinuity, which is the whole point of it.
 */
const MASTER_RAMP_SECONDS = 0.05;

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
 * A gain of exactly zero is illegal in an exponential ramp and inaudible in a
 * linear one, and Web Audio's `setTargetAtTime` approaches its target
 * asymptotically. All three fades here are therefore LINEAR ramps to a real
 * zero, and this is the value "silent" means.
 */
const SILENT_GAIN = 0;

/** Full level for a bus or a master that is not being attenuated. */
const UNITY_GAIN = 1;

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
 * Dev switches, read from the page URL — the same convention
 * client/src/perfProbe.ts:45 uses for `?perfprobe=<scenario>`: a module-level
 * flag name, and any non-empty value turns it on.
 *
 * `?audioDebug=1` logs every call with its bus, gain, position and the live
 * voice count. `?audioMusic=<url>` makes CORE the music claimant and puts that
 * URL on the music bus, so the music path is exercised in a build where no
 * plugin claims music yet (plan §2.4 — there is no music consumer in phase 1).
 *
 * ZERO-COST WHEN OFF: both are read once at module load, and every debug site
 * is behind `if (!AUDIO_DEBUG)`.
 */
const AUDIO_DEBUG_QUERY_FLAG = 'audioDebug';
const AUDIO_MUSIC_QUERY_FLAG = 'audioMusic';

function queryFlag(name: string): string | null {
  // `location` is absent in a non-DOM test run; the switches are a browser
  // affordance and their absence means "off", never a throw.
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get(name);
  return raw === null || raw === '' ? null : raw;
}

const AUDIO_DEBUG = queryFlag(AUDIO_DEBUG_QUERY_FLAG) !== null;

/**
 * How much an ambience weight must move before `?audioDebug=1` logs it again.
 *
 * A TWENTIETH. `ambience` is contracted to be called every frame, and a weight
 * that drifts continuously (rain does) would otherwise put a line in the
 * console at frame rate and bury the very fade it is there to show. Twenty
 * lines across a full fade in and a full fade out is a readable trace of one.
 * Starts, releases and reaching an exact 0 or 1 are logged whatever this says.
 */
const AUDIO_DEBUG_WEIGHT_STEP = 0.05;

/**
 * The name core claims the music bus under when `?audioMusic=` is set.
 *
 * PARENTHESISED so it cannot collide with a real plugin name (a plugin name is
 * a wire namespace and those are bare identifiers) and so a refusal warning
 * naming it reads as what it is: the dev switch is holding the bus, not another
 * plugin.
 */
const DEV_MUSIC_CLAIMANT = '(dev:audioMusic)';

/** Name of the core-owned Group positional voices are parented into. */
const POSITIONAL_VOICE_GROUP_NAME = 'core:audio-voices';

// ── The graph ────────────────────────────────────────────────────────────────

/**
 * Everything that cannot exist before the browser has let us have an
 * AudioContext. Null until `unlock()`, which is why every public method here
 * starts by asking whether it is there.
 */
interface AudioGraph {
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

/** One plugin's ambience layer for one URL — see `PluginAudio.ambience`. */
interface AmbienceLayer {
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

/** One plugin's whole audio state, released together when it detaches. */
interface PluginAudioState {
  readonly name: string;
  /** Keyed by URL — the (plugin, url) identity `ambience` promises. */
  readonly ambience: Map<string, AmbienceLayer>;
  released: boolean;
}

export interface AudioEngine {
  /**
   * Starts (or resumes) the context. Idempotent and cheap after the first
   * success, so the host may call it from every canvas press.
   *
   * MUST BE CALLED FROM A USER GESTURE. Browsers refuse to start an
   * AudioContext otherwise, and that refusal is the NORMAL state of a page
   * before its first click — not an error, and never logged as one.
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
  /**
   * BUILT EAGERLY, at engine construction, and null only where Web Audio does
   * not exist at all.
   *
   * WHY NOT LAZILY AT THE FIRST GESTURE, which is what this did first. A
   * browser refuses to START an AudioContext before a gesture; it does not
   * refuse to CREATE one — `new AudioContext()` is legal at any time and simply
   * begins in the 'suspended' state, which is the whole reason `resume()`
   * exists. Building lazily bought nothing and cost the thing that mattered:
   * with no context there is no `decodeAudioData`, so no asset could be decoded
   * until the player clicked, and the first event of every kind was therefore
   * silent (see `preload` on PluginAudio). Eager construction means a plugin's
   * `preload` in attach has a context to decode into, and by the first click
   * the buffers are ready.
   *
   * NOTHING IS AUDIBLE BEFORE THE GESTURE either way. A suspended context's
   * clock does not advance and its output is not connected to anything the
   * player can hear; voices started against it are scheduled and become audible
   * when `unlock()` resumes it. That is what replaced the pending-request
   * bookkeeping this file used to carry.
   */
  let graph: AudioGraph | null = buildGraphSafely();

  /**
   * Per-URL decode, shared by every plugin: ONE fetch and ONE decodeAudioData
   * per URL for the life of the page, and concurrent askers await the same
   * promise rather than racing a second fetch. A rejected entry is DELETED so a
   * transient network failure can be retried by the next caller; a resolved one
   * is kept forever, because a decoded buffer is exactly what a cache is for.
   */
  const decoded = new Map<string, Promise<AudioBuffer>>();

  /**
   * EITHER KIND OF VOICE. three types `PositionalAudio` as `Audio<PannerNode>`
   * (its `getOutput()` is the panner, three/src/audio/PositionalAudio.js:84),
   * so the one type that holds both is the generic's own upper bound. Only
   * `.gain` — a plain GainNode on both — is touched through it.
   */
  type AnyAudio = Audio<AudioNode>;

  /**
   * Live one-shots, in START ORDER — push appends, so index 0 is the oldest
   * and the steal below needs no timestamp to find it. Bounded by
   * MAX_SFX_VOICES.
   */
  const sfxVoices: AnyAudio[] = [];

  /** Every plugin's state, by plugin name. */
  const plugins = new Map<string, PluginAudioState>();

  /**
   * Who owns the music bus, or null while nobody does — the same
   * single-claimant shape as plugins/host.ts:302's skyRigClaimant, with the
   * same once-per-loser refusal set below, and for the same reason: this may be
   * driven from a loop and a per-call warning would bury the console.
   */
  let musicClaimant: string | null = null;
  const musicRefusals = new Set<string>();

  /** The track playing now, and the URL it came from (null = bus empty). */
  let musicVoice: Audio | null = null;
  let musicUrl: string | null = null;

  // ── Debug ──────────────────────────────────────────────────────────────────

  function debugLog(call: string, fields: Record<string, unknown>): void {
    if (!AUDIO_DEBUG) return;
    // THE LIVE GAIN OF THE BUS THIS CALL IS ON. Between the voice's own gain
    // (already in `fields`) and the master below, this is the only other factor
    // in how loud the call ends up — so with all three on the line the trace
    // explains a level completely instead of leaving one term out.
    const bus = fields.bus;
    const busGain =
      graph === null || typeof bus !== 'string' || !(bus in graph.buses)
        ? null
        : graph.buses[bus as AudioBusName].gain.value;
    console.log('[terrace audio]', call, {
      ...fields,
      busGain,
      // HOW MUCH THE LIMITER IS TAKING OFF RIGHT NOW, in dB (always ≤ 0). It
      // reads 0 while the limiter is transparent, which is the state it is
      // supposed to be in — so a non-zero value here is the trace saying the
      // output actually reached the ceiling, and is the only way to tell that
      // from outside.
      limiterReductionDb: graph === null ? null : graph.limiter.reduction,
      sfxVoices: sfxVoices.length,
      // THE MASTER'S LIVE VALUE, on every line. It is the answer to the first
      // question anyone debugging silence asks — the player's own volume and
      // mute reach the graph through exactly this number (see the prefs effect
      // below) — and a trace that showed every voice's gain but not the one
      // they all pass through would answer every question but that one.
      master: graph === null ? null : graph.master.gain.value,
      contextState: graph === null ? 'locked' : graph.context.state,
    });
  }

  // ── Gain helpers ───────────────────────────────────────────────────────────

  /**
   * Ramps a gain LINEARLY to `target` over `seconds`.
   *
   * `cancelScheduledValues` + `setValueAtTime(currentValue)` first, because a
   * ramp started while another is still running otherwise interpolates from the
   * OLD ramp's endpoint rather than from where the signal actually is — which
   * is a jump, i.e. a click. Retargeting mid-fade is the normal case here
   * (`ambience` is called every frame), so this is the common path, not an edge.
   */
  function rampGain(param: AudioParam, target: number, seconds: number, context: AudioContext): void {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
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

  /** Clamps a caller-supplied relative level into [SILENT_GAIN, UNITY_GAIN]. */
  function clampGain(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(UNITY_GAIN, Math.max(SILENT_GAIN, value));
  }

  // ── Buffer decoding ────────────────────────────────────────────────────────

  function bufferFor(url: string, context: AudioContext): Promise<AudioBuffer> {
    const existing = decoded.get(url);
    if (existing !== undefined) return existing;
    const promise = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`audio asset ${url} responded ${String(response.status)}`);
        }
        return context.decodeAudioData(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        // A failed decode is not cached: the next caller gets a fresh attempt
        // rather than a permanently poisoned URL.
        decoded.delete(url);
        throw error;
      });
    decoded.set(url, promise);
    return promise;
  }

  /**
   * A failed load costs this plugin its sound and nothing else — the same
   * containment every plugin-facing seam in plugins/host.ts gives. Logged once
   * per failure rather than swallowed: a 404 on an asset is a real defect, and
   * the alternative to a line here is silence nobody can explain.
   */
  function reportAssetFailure(url: string, error: unknown): void {
    console.error(`[terrace] audio asset failed to load: ${url}`, error);
  }

  // ── The graph ──────────────────────────────────────────────────────────────

  /**
   * The master's gain and each bus's gain, from the player's prefs.
   *
   * DRIVEN BY SOLID EFFECTS IN THEIR OWN ROOT. The prefs are module-scope
   * signals (state/audioPrefs.ts, the controlPrefs.ts shape) and this engine is
   * imperative code outside any component, so `createRoot` is how an imperative
   * owner subscribes to them — one mechanism for both readers rather than a
   * second callback list bolted onto the prefs module for us. The root's own
   * dispose is kept and called from `dispose()` below, so the subscriptions do
   * not outlive the engine.
   *
   * ONE EFFECT PER GAIN, not one effect writing four. An effect re-runs when
   * ANY signal it read changes, so a single effect reading all four prefs would
   * re-ramp all four nodes on every drag of any one slider — four scheduled
   * ramps where one was asked for, and three of them on nodes that had not
   * moved. Paired with one signal per bus in audioPrefs.ts, moving the music
   * slider touches the music bus and nothing else.
   */
  const disposePrefsEffect = createRoot((disposeRoot) => {
    createEffect(() => {
      // READ REACTIVELY, EVERY RUN — never captured into a const outside the
      // effect, which would freeze it (project rule).
      const gain = effectiveMasterGain();
      if (graph === null) return;
      rampGain(graph.master.gain, gain, MASTER_RAMP_SECONDS, graph.context);
    });
    for (const name of AUDIO_BUS_NAMES) {
      createEffect(() => {
        const gain = effectiveBusGain(name);
        if (graph === null) return;
        // THE SAME RAMP THE MASTER GETS. A bus is the same kind of node
        // carrying the same kind of number, and a stepped gain clicks wherever
        // it is applied — there is no reason for a second fade length here.
        rampGain(graph.buses[name].gain, gain, MASTER_RAMP_SECONDS, graph.context);
      });
    }
    return disposeRoot;
  });

  /**
   * `buildGraph` with its one failure mode handled, so the eager construction
   * above is a plain assignment. Named separately rather than inlined because a
   * `try` around an initialiser at the top of the closure would read as if
   * something routine could throw here; nothing routine can.
   */
  function buildGraphSafely(): AudioGraph | null {
    return buildGraph();
  }

  function buildGraph(): AudioGraph | null {
    // three's AudioListener constructs the page's AudioContext for us
    // (three/src/audio/AudioListener.js) — one context, and the one the
    // listener and every panner already agree on.
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

    // MASTER → LIMITER → DESTINATION, bypassing listener.gain. three wires
    // every voice's own gain to listener.getInput() (Audio.js:65) and the
    // listener's gain to the destination (AudioListener.js:50); each voice
    // below is rerouted off that default and onto its bus, so the listener's
    // gain would otherwise be a node with nothing connected to it pretending to
    // be the master. There is exactly one master and it is this one.
    //
    // THE LIMITER IS LAST, after the master rather than before it, because it
    // guards the OUTPUT: a player who pulls the master down must be able to
    // bring the signal back under the ceiling by doing so, and a limiter ahead
    // of the master could not be turned off that way.
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
      // FROM THE PREF, not from unity. The graph is built lazily at the first
      // gesture, long after the player's stored mix was loaded, so starting
      // every bus at unity and waiting for the effects above to ramp it would
      // play the first fraction of a second at the wrong level — the same
      // reason `master.gain.value` is seeded from its pref two lines up rather
      // than left at 1.
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

  /** Routes a three Audio's own gain off the listener and onto its bus. */
  function routeToBus(voice: AnyAudio, bus: AudioBusName, active: AudioGraph): void {
    // `disconnect()` with no argument drops every output — here exactly the one
    // three made to listener.getInput() in the constructor (Audio.js:65). Doing
    // it by argument would couple us to which node that was.
    voice.gain.disconnect();
    voice.gain.connect(active.buses[bus]);
  }

  // ── One-shots ──────────────────────────────────────────────────────────────

  /** Drops a finished or stolen one-shot from the pool and the scene. */
  function retireSfx(voice: AnyAudio): void {
    const index = sfxVoices.indexOf(voice);
    if (index !== -1) sfxVoices.splice(index, 1);
    if (voice.isPlaying) voice.stop();
    voice.removeFromParent();
  }

  function startSfx(
    url: string,
    buffer: AudioBuffer,
    opts: SfxOptions | undefined,
    active: AudioGraph,
  ): void {
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
      voice = new Audio(active.listener);
    } else {
      const positional = new PositionalAudio(active.listener);
      positional.panner.panningModel = SFX_PANNING_MODEL;
      // 'inverse' is the physical law and the only model whose two distances
      // mean what their names say; see the constants above for both.
      positional.setDistanceModel('inverse');
      positional.setRefDistance(SFX_REFERENCE_DISTANCE_WORLD_UNITS);
      positional.setMaxDistance(SFX_MAX_DISTANCE_WORLD_UNITS);
      positional.setRolloffFactor(SFX_ROLLOFF_FACTOR);
      // COPIED, not held: the caller may hand us a scratch object (the contract
      // says so), and `position.set` reads the three numbers here and now.
      positional.position.set(at.x, at.y, at.z);
      active.positionalRoot.add(positional);
      voice = positional;
    }

    routeToBus(voice, 'sfx', active);
    voice.setBuffer(buffer);
    const gain = clampGain(opts?.gain, DEFAULT_SFX_GAIN);
    voice.setVolume(gain);
    const rate = opts?.playbackRate;
    if (rate !== undefined && Number.isFinite(rate) && rate > 0) voice.setPlaybackRate(rate);
    // SCHEDULED, NOT TIMED. three's `play(delay)` sets
    // `_startedAt = context.currentTime + delay` and passes it to
    // `source.start()` (three/src/audio/Audio.js:329-338) — the sample-accurate
    // Web Audio scheduler on the audio thread. There is no setTimeout, no frame
    // callback and no JS running between now and the sound: a delayed voice
    // costs exactly what an undelayed one does.
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
    // count INCLUDING this voice — logging it before would always be one short
    // and the cap would look unreachable.
    debugLog('playSfx', {
      url,
      bus: 'sfx',
      gain,
      at: at === undefined ? null : { x: at.x, y: at.y, z: at.z },
      playbackRate: rate ?? 1,
      delaySeconds: delay,
    });
  }

  // ── Ambience ───────────────────────────────────────────────────────────────

  /** Stops and detaches an ambience voice, cancelling any pending stop. */
  function releaseAmbienceVoice(layer: AmbienceLayer): void {
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

  /** Fades a live ambience voice to its layer's current weight. */
  function retargetAmbience(layer: AmbienceLayer, active: AudioGraph): void {
    const voice = layer.audio;
    if (voice === null) return;
    // A retarget cancels a scheduled release: a layer that was on its way out
    // and has been asked back must not be stopped by the old timer.
    if (layer.stopTimer !== null) {
      clearTimeout(layer.stopTimer);
      layer.stopTimer = null;
    }
    rampGain(voice.gain.gain, layer.weight, AMBIENCE_FADE_SECONDS, active.context);
    if (layer.weight > SILENT_GAIN) return;
    // FADED TO SILENCE: hold the voice for the length of the fade (plus slack
    // for the main thread's clock, see FADE_STOP_SLACK_SECONDS) and then
    // release it, so an ambience that is over holds nothing.
    layer.stopTimer = setTimeout(
      () => {
        layer.stopTimer = null;
        releaseAmbienceVoice(layer);
      },
      (AMBIENCE_FADE_SECONDS + FADE_STOP_SLACK_SECONDS) * 1000,
    );
  }

  function startAmbience(layer: AmbienceLayer, buffer: AudioBuffer, active: AudioGraph): void {
    const voice = new Audio(active.listener);
    routeToBus(voice, 'ambience', active);
    voice.setBuffer(buffer);
    voice.setLoop(true);
    // FROM SILENCE, ALWAYS: the ramp below is what brings it in, so a loop
    // never begins at full level however high the weight already is.
    voice.gain.gain.value = SILENT_GAIN;
    voice.play();
    layer.audio = voice;
    retargetAmbience(layer, active);
  }

  function beginAmbience(url: string, layer: AmbienceLayer, active: AudioGraph): void {
    layer.decoding = true;
    void bufferFor(url, active.context).then(
      (buffer) => {
        layer.decoding = false;
        // Everything may have changed while the decode was in flight: the
        // plugin may have detached, the weight may be back to zero, or another
        // path may already have started the voice.
        if (graph === null || layer.audio !== null || layer.weight <= SILENT_GAIN) return;
        startAmbience(layer, buffer, graph);
      },
      (error: unknown) => {
        layer.decoding = false;
        reportAssetFailure(url, error);
      },
    );
  }

  // ── Music ──────────────────────────────────────────────────────────────────

  function crossfadeMusic(url: string | null, active: AudioGraph): void {
    const outgoing = musicVoice;
    if (outgoing !== null) {
      rampGain(outgoing.gain.gain, SILENT_GAIN, MUSIC_CROSSFADE_SECONDS, active.context);
      setTimeout(
        () => {
          if (outgoing.isPlaying) outgoing.stop();
          outgoing.gain.disconnect();
        },
        (MUSIC_CROSSFADE_SECONDS + FADE_STOP_SLACK_SECONDS) * 1000,
      );
    }
    musicVoice = null;
    musicUrl = url;
    if (url === null) {
      debugLog('setMusic', { url: null, bus: 'music', gain: SILENT_GAIN });
      return;
    }
    void bufferFor(url, active.context).then(
      (buffer) => {
        // The claimant may have asked for something else — or for nothing —
        // while this was decoding; `musicUrl` is the last word.
        if (graph === null || musicUrl !== url) return;
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
  }

  // ── Unlock ─────────────────────────────────────────────────────────────────

  /**
   * One-shot window listeners so a KEYBOARD-FIRST player unlocks too: the
   * host's canvas pointerdown (plugins/host.ts:334) covers a click on the
   * world, but a player who tabs to a control and presses a key has made a
   * gesture the canvas never saw. `once` on both, and they are removed on
   * dispose as well in case neither ever fired.
   */
  const onWindowGesture = (): void => {
    engineUnlock();
  };

  function installWindowGestureListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', onWindowGesture, { once: true });
    window.addEventListener('pointerdown', onWindowGesture, { once: true });
  }

  function removeWindowGestureListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', onWindowGesture);
    window.removeEventListener('pointerdown', onWindowGesture);
  }

  let disposed = false;

  /**
   * RESUME-ONLY. The graph exists from engine construction (see `graph`'s own
   * declaration), so there is nothing to build here and nothing to replay: a
   * voice started while the context was suspended is already scheduled and
   * simply becomes audible when the clock starts.
   *
   * Idempotent and cheap once running, so the host may call it from every
   * canvas press. A resume the browser still refuses leaves the context
   * suspended and is NOT an error — it is the normal answer to a call that did
   * not come from a gesture it accepted, and the next gesture tries again.
   */
  function engineUnlock(): void {
    if (disposed) return;
    const active = graph;
    if (active === null || active.context.state !== 'suspended') return;
    void active.context.resume().then(
      () => {
        debugLog('unlock', { url: null, bus: null, gain: active.master.gain.value });
      },
      () => {
        /* Still locked; the next gesture will try again. */
      },
    );
  }

  installWindowGestureListeners();

  // ── Per-plugin handles ─────────────────────────────────────────────────────

  /**
   * Everything one holder may do, built once per holder. `state` carries the
   * identity — which is what keys ambience, arbitrates music and scopes the
   * release.
   */
  function buildHandle(state: PluginAudioState): PluginAudio {
    return {
      preload(url: string): void {
        if (state.released || graph === null) return;
        // The decode cache makes this idempotent for free: a second call for
        // the same URL — from this plugin or any other — finds the in-flight
        // promise and adds nothing. The `catch` is what keeps the contract's
        // "never throws": without it a failed asset would surface as an
        // unhandled rejection in a plugin that did everything right.
        void bufferFor(url, graph.context).catch((error: unknown) => {
          reportAssetFailure(url, error);
        });
        debugLog('preload', { url, bus: 'sfx', gain: null });
      },

      playSfx(url: string, opts?: SfxOptions): void {
        if (state.released || graph === null) return;
        const active = graph;
        const cached = decoded.get(url);
        if (cached === undefined) {
          // NOT DECODED YET: START THE DECODE AND PLAY NOTHING. A one-shot is a
          // moment; playing it whenever the fetch happened to finish would put
          // a thunderclap a second after its flash. The contract says so
          // (types.ts, PluginAudio.playSfx) — and a plugin that called
          // `preload` in attach does not come through here at all.
          void bufferFor(url, active.context).catch((error: unknown) => {
            reportAssetFailure(url, error);
          });
          debugLog('playSfx (decoding, dropped)', { url, bus: 'sfx', gain: clampGain(opts?.gain, DEFAULT_SFX_GAIN) });
          return;
        }
        void cached.then(
          (buffer) => {
            if (state.released || graph === null) return;
            startSfx(url, buffer, opts, graph);
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
          // "it reached silence" and "it reached full" are the two facts a
          // fade trace has to contain.
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
        // Before unlock the layer is remembered and started by `unlock`; the
        // world must not be silent until the first sound request AFTER a click.
        if (graph === null) return;
        if (layer.audio !== null) {
          retargetAmbience(layer, graph);
          return;
        }
        if (!layer.decoding && target > SILENT_GAIN) beginAmbience(url, layer, graph);
      },

      setMusic(url: string | null): void {
        if (state.released) return;
        if (musicClaimant === null) musicClaimant = state.name;
        if (musicClaimant !== state.name) {
          // ONCE PER LOSING HOLDER, not once per call — the same reasoning
          // plugins/host.ts:757 gives for setSkyRig: this may be driven from a
          // frame loop, and a per-call warning would bury the console.
          if (!musicRefusals.has(state.name)) {
            musicRefusals.add(state.name);
            console.warn(
              `music bus already claimed by "${musicClaimant}"; ` +
                `ignoring updates from "${state.name}"`,
            );
          }
          return;
        }
        // No graph at all means no Web Audio in this browser; the claim stands
        // (so a second plugin is still refused, consistently) and nothing plays.
        if (graph === null) return;
        if (musicUrl === url) return; // already playing (or already stopped)
        crossfadeMusic(url, graph);
      },
    };
  }

  function releasePlugin(state: PluginAudioState): void {
    if (state.released) return;
    state.released = true;
    for (const layer of state.ambience.values()) releaseAmbienceVoice(layer);
    state.ambience.clear();
    // A DETACHED CLAIMANT FREES THE MUSIC BUS — unlike the sky rig, which
    // keeps whatever look it was last given, silence is a perfectly good
    // resting state and a track whose owner is gone has nobody to stop it.
    if (musicClaimant === state.name) {
      musicClaimant = null;
      musicRefusals.clear();
      if (graph !== null && musicUrl !== null) crossfadeMusic(null, graph);
      else musicUrl = null;
    }
    plugins.delete(state.name);
  }

  // ?audioMusic=<url>: core claims the bus on behalf of a synthetic holder, so
  // the music path is exercised in a build with no music consumer (plan §2.4).
  const devMusicUrl = queryFlag(AUDIO_MUSIC_QUERY_FLAG);
  if (devMusicUrl !== null) {
    const state: PluginAudioState = {
      name: DEV_MUSIC_CLAIMANT,
      ambience: new Map(),
      released: false,
    };
    plugins.set(state.name, state);
    buildHandle(state).setMusic(devMusicUrl);
  }

  return {
    unlock: engineUnlock,

    forPlugin(name: string) {
      const state: PluginAudioState = { name, ambience: new Map(), released: false };
      plugins.set(name, state);
      return {
        audio: buildHandle(state),
        release: () => {
          releasePlugin(state);
        },
      };
    },

    dispose(): void {
      disposed = true;
      removeWindowGestureListeners();
      disposePrefsEffect();
      for (const state of [...plugins.values()]) releasePlugin(state);
      for (const voice of [...sfxVoices]) retireSfx(voice);
      if (musicVoice !== null) {
        if (musicVoice.isPlaying) musicVoice.stop();
        musicVoice.gain.disconnect();
        musicVoice = null;
      }
      musicUrl = null;
      musicClaimant = null;
      musicRefusals.clear();
      decoded.clear();
      const active = graph;
      graph = null;
      if (active === null) return;
      active.positionalRoot.removeFromParent();
      active.listener.removeFromParent();
      active.master.disconnect();
      active.limiter.disconnect();
      // The context itself is closed: it owns a hardware output stream, and a
      // client torn down without closing it would leave that stream open for
      // the life of the tab.
      void active.context.close().catch(() => {
        /* Already closed, or closing is unsupported; nothing to do either way. */
      });
    },
  };
}
