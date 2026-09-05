// The composer's synthesis: the three kinds of voice, and the pool that
// guarantees every node one of them creates is stopped and disconnected.
//
// WHY A POOL AT ALL. A generative score runs for the whole session, so a voice
// that is merely silent — envelope at zero, oscillator still running — is a
// leak measured in hours: Web Audio keeps rendering it, and a node that is
// still connected is never collected. Every voice here is therefore adopted by
// the pool, which releases it from the source's own `ended` event. That is the
// only release path: nothing in this file relies on a timer to clean up.
//
// WHY NOTHING HERE READS A MOOD OR A TUNING. Voices take frequencies, times,
// and the handful of shape numbers their caller passes. The mood lives in
// theory.ts and the dials in tuning.ts; the engine applies both, either as a
// scheduling choice (which note, how often) or as one glided AudioParam (the
// filter, the buses, the drone). Keeping them out of here is what makes the
// note stream auditable.
//
// WHY NO VOICE CARRIES ITS OWN LEVEL ANY MORE. A level baked into an envelope
// is frozen the moment the note is scheduled, so moving a gain dial would only
// be heard on notes not yet written — up to a chord and a half later. Every
// envelope here therefore peaks at UNITY (a pluck, at its velocity) and the
// engine's pad/shimmer/melody bus gains carry the level, glided, so a dial is
// heard on everything already sounding.

import { midiToFrequency } from './theory.ts';

/** Oscillators stacked per chord tone in the pad. Three is the classic
 * "supersaw" minimum: one at pitch and one either side, which gives the slow
 * beating that reads as warmth. A fourth is inaudible against three and costs
 * a third more oscillators for every chord tone. */
const PAD_VOICES_PER_TONE = 3;

/** Pad waveform. A sawtooth has every harmonic, which is what gives the mood
 * low-pass something to actually remove; a sine or triangle would leave the
 * filter sweep nearly inaudible. */
const PAD_WAVEFORM: OscillatorType = 'sawtooth';

/** Peak of a pad tone's — and its shimmer's — envelope. Unity: the level is on
 * the engine's pad and shimmer buses (see this file's header). */
const ENVELOPE_PEAK_GAIN = 1;

/** Shimmer waveform. Sine an octave up: a clean halo on each chord tone. */
const SHIMMER_WAVEFORM: OscillatorType = 'sine';

/** Shimmer pitch above its chord tone, in semitones: one octave. */
const SHIMMER_OCTAVE_SEMITONES = 12;

/** Shimmer detune, in cents. 4 cents against the tone's octave beats slowly
 * — the glisten — without reading as out of tune. */
const SHIMMER_DETUNE_CENTS = 4;

/** Melody waveform. Sine: no harmonics, so a note is a point of light over the
 * pad rather than an instrument — the "stars" half of the cosmic brief
 * (owner 2026-09-05; was triangle). */
const PLUCK_WAVEFORM: OscillatorType = 'sine';

/** Melody attack, in seconds. 12 ms is fast enough to read as a pluck and slow
 * enough to avoid the click a step change in gain would produce. */
const PLUCK_ATTACK_SECONDS = 0.012;

/** Gain a decaying note is ramped to before it is stopped, measured AFTER its
 * bus. Exponential ramps cannot reach zero, so they aim here: -80 dB,
 * inaudible, and the node is stopped immediately after. */
export const SILENT_GAIN = 0.0001;

/** Drone waveform. A sine has no harmonics to muddy the pad's low end — the
 * drone is meant to be felt under the music, not heard as a part. */
const DRONE_WAVEFORM: OscillatorType = 'sine';

/** Semitones below the key's root that the drone's lower voice sits at. An
 * octave down puts it at 55 Hz, under the whole arrangement. */
const DRONE_OCTAVE_DROP_SEMITONES = 12;

/** Semitones above the drone's lower voice for its upper voice: a perfect
 * fifth, the one interval that thickens a drone without implying major or
 * minor — so the drone stays valid across both progressions. */
const DRONE_FIFTH_SEMITONES = 7;

/** Slack between a voice's last audible sample and its `stop()`, in seconds.
 * Web Audio automation and the stop time are both on the audio clock, so a
 * common value would be exact; 50 ms of slack costs nothing and removes any
 * dependence on that exactness across implementations. */
const VOICE_STOP_MARGIN_SECONDS = 0.05;

/** A group of nodes released together when its sources end. */
interface VoiceGroup {
  /** The oscillators; the first one's `ended` releases the whole group. */
  readonly sources: readonly OscillatorNode[];
  /** Everything else the group owns (gains), disconnected with the sources. */
  readonly others: readonly AudioNode[];
}

/** Owns every node the composer creates, and releases each one exactly once. */
export interface VoicePool {
  /** How many AudioNodes this pool currently holds. The composer's headline
   * hygiene number: it must be bounded while the music runs. */
  liveNodeCount(): number;
  /** Takes ownership of a group whose sources have already been started. */
  adopt(group: VoiceGroup): void;
  /** Stops every held source at `when` (audio clock). Releases follow from the
   * sources' own `ended` events, so this is safe to call more than once. */
  stopAll(when: number): void;
}

/** Creates an empty pool. One per composer instance. */
export function createVoicePool(): VoicePool {
  const groups = new Set<VoiceGroup>();

  const release = (group: VoiceGroup): void => {
    if (!groups.delete(group)) return;
    for (const source of group.sources) source.disconnect();
    for (const node of group.others) node.disconnect();
  };

  return {
    liveNodeCount(): number {
      let count = 0;
      for (const group of groups) count += group.sources.length + group.others.length;
      return count;
    },
    adopt(group: VoiceGroup): void {
      groups.add(group);
      const first = group.sources[0];
      if (first === undefined) {
        // A group with no source has nothing that can ever fire `ended`, so it
        // would be held forever. Nothing in this file builds one; releasing
        // immediately keeps that true even if something later does.
        release(group);
        return;
      }
      first.onended = (): void => release(group);
    },
    stopAll(when: number): void {
      for (const group of groups) {
        for (const source of group.sources) source.stop(when);
      }
    },
  };
}

/** The envelope shape of one pad chord, in seconds and audio-clock times. */
export interface PadShape {
  /** Seconds the chord is held before its release begins. */
  readonly holdSeconds: number;
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
  readonly detuneCents: number;
}

/**
 * Schedules one chord: every tone, every detuned voice, attack through
 * release. `startTime` is on the audio clock and is when the attack begins;
 * the release begins `shape.holdSeconds` later, so consecutive chords
 * crossfade. The tones go to `padDestination` and their octave shimmers to
 * `shimmerDestination`, so the two levels are separate glided bus gains.
 */
export function schedulePadChord(
  context: BaseAudioContext,
  pool: VoicePool,
  padDestination: AudioNode,
  shimmerDestination: AudioNode,
  notes: readonly number[],
  startTime: number,
  shape: PadShape,
): void {
  const releaseStart = startTime + shape.holdSeconds;
  const releaseEnd = releaseStart + shape.releaseSeconds;

  /** The tone envelope, peaking at unity — one shape, applied to two gains. */
  const applyEnvelope = (gain: GainNode): void => {
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(ENVELOPE_PEAK_GAIN, startTime + shape.attackSeconds);
    // Held explicitly at the release point: without this the ramp below would
    // interpolate from the ATTACK's end value over the whole chord, i.e. the
    // pad would start fading the instant it arrived.
    gain.gain.setValueAtTime(ENVELOPE_PEAK_GAIN, releaseStart);
    gain.gain.linearRampToValueAtTime(0, releaseEnd);
  };

  for (const note of notes) {
    const toneGain = context.createGain();
    applyEnvelope(toneGain);
    toneGain.connect(padDestination);

    const sources: OscillatorNode[] = [];
    for (let voice = 0; voice < PAD_VOICES_PER_TONE; voice += 1) {
      const oscillator = context.createOscillator();
      oscillator.type = PAD_WAVEFORM;
      oscillator.frequency.setValueAtTime(midiToFrequency(note), startTime);
      // Spread symmetrically about the pitch: for three voices that is
      // -1, 0, +1 detune steps.
      const spread = voice - (PAD_VOICES_PER_TONE - 1) / 2;
      oscillator.detune.setValueAtTime(spread * shape.detuneCents, startTime);
      oscillator.connect(toneGain);
      oscillator.start(startTime);
      oscillator.stop(releaseEnd + VOICE_STOP_MARGIN_SECONDS);
      sources.push(oscillator);
    }

    // ITS OWN ENVELOPE, not a fraction of the tone's gain: routed to the
    // shimmer bus it can no longer borrow the tone's shape, and the halo has to
    // rise and fall with the chord it belongs to.
    const shimmerGain = context.createGain();
    applyEnvelope(shimmerGain);
    shimmerGain.connect(shimmerDestination);
    const shimmer = context.createOscillator();
    shimmer.type = SHIMMER_WAVEFORM;
    shimmer.frequency.setValueAtTime(midiToFrequency(note + SHIMMER_OCTAVE_SEMITONES), startTime);
    shimmer.detune.setValueAtTime(SHIMMER_DETUNE_CENTS, startTime);
    shimmer.connect(shimmerGain);
    shimmer.start(startTime);
    shimmer.stop(releaseEnd + VOICE_STOP_MARGIN_SECONDS);
    sources.push(shimmer);
    pool.adopt({ sources, others: [toneGain, shimmerGain] });
  }
}

/** The envelope shape of one melody note, as its caller reads it off a tuning. */
export interface PluckShape {
  /** Total life of the note, in seconds — attack plus decay. */
  readonly durationSeconds: number;
  /**
   * Where the decay aims, expressed BEFORE the melody bus. Passed in rather
   * than fixed at SILENT_GAIN because an exponential ramp's curve is set by
   * its start/end RATIO: aiming at a floor scaled by the bus gain is what
   * keeps the audible tail identical whatever level the bus carries.
   */
  readonly silentFloorGain: number;
}

/**
 * Schedules one melody note at `startTime`. The envelope peaks at `velocity`
 * (in (0, 1]); the melody bus carries the level.
 */
export function schedulePluck(
  context: BaseAudioContext,
  pool: VoicePool,
  destination: AudioNode,
  note: number,
  velocity: number,
  startTime: number,
  shape: PluckShape,
): void {
  const endTime = startTime + shape.durationSeconds;

  const noteGain = context.createGain();
  noteGain.gain.setValueAtTime(shape.silentFloorGain, startTime);
  noteGain.gain.linearRampToValueAtTime(velocity, startTime + PLUCK_ATTACK_SECONDS);
  noteGain.gain.exponentialRampToValueAtTime(shape.silentFloorGain, endTime);
  noteGain.connect(destination);

  const oscillator = context.createOscillator();
  oscillator.type = PLUCK_WAVEFORM;
  oscillator.frequency.setValueAtTime(midiToFrequency(note), startTime);
  oscillator.connect(noteGain);
  oscillator.start(startTime);
  oscillator.stop(endTime + VOICE_STOP_MARGIN_SECONDS);

  pool.adopt({ sources: [oscillator], others: [noteGain] });
}

/**
 * Starts the tension drone: two sine voices an octave under the key, through a
 * gain the engine glides with `tension`. Runs for the composer's whole life —
 * it is silent at zero gain, not stopped, because starting and stopping a
 * sub-bass voice is the one thing that would click audibly.
 *
 * Returns the gain to glide. The engine stops the voices through the pool.
 */
export function startDrone(
  context: BaseAudioContext,
  pool: VoicePool,
  destination: AudioNode,
  rootMidiNote: number,
  startTime: number,
): GainNode {
  const droneGain = context.createGain();
  droneGain.gain.setValueAtTime(0, startTime);
  droneGain.connect(destination);

  const lowNote = rootMidiNote - DRONE_OCTAVE_DROP_SEMITONES;
  const sources = [lowNote, lowNote + DRONE_FIFTH_SEMITONES].map((note) => {
    const oscillator = context.createOscillator();
    oscillator.type = DRONE_WAVEFORM;
    oscillator.frequency.setValueAtTime(midiToFrequency(note), startTime);
    oscillator.connect(droneGain);
    oscillator.start(startTime);
    return oscillator;
  });

  pool.adopt({ sources, others: [droneGain] });
  return droneGain;
}
