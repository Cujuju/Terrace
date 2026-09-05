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
// WHY NOTHING HERE READS A MOOD. Voices take frequencies and times. The mood
// lives in theory.ts and is applied by the engine either as a scheduling
// choice (which note, how often) or as one glided AudioParam (the filter, the
// drone gain). Keeping it out of here is what makes the note stream auditable.

import { midiToFrequency, SECONDS_PER_CHORD } from './theory.ts';

/** Oscillators stacked per chord tone in the pad. Three is the classic
 * "supersaw" minimum: one at pitch and one either side, which gives the slow
 * beating that reads as warmth. A fourth is inaudible against three and costs
 * a third more oscillators for every chord tone. */
const PAD_VOICES_PER_TONE = 3;

/** Detune spread of the outer pad voices, in cents. 7 cents is about a 0.4 %
 * pitch offset: at 110 Hz that beats a little under once a second, which is
 * movement without vibrato. Past ~15 cents it starts to sound out of tune. */
const PAD_DETUNE_CENTS = 7;

/** Pad waveform. A sawtooth has every harmonic, which is what gives the mood
 * low-pass something to actually remove; a sine or triangle would leave the
 * filter sweep nearly inaudible. */
const PAD_WAVEFORM: OscillatorType = 'sawtooth';

/** Peak gain of one chord tone (all detuned voices together), relative to the
 * composer's output. 0.055: owner 2026-09-05 heard the pad at 0.09 as too
 * strong under the melody; three tones now sum to 0.165, a bed, not a wall. */
const PAD_TONE_PEAK_GAIN = 0.055;

/** Shimmer waveform. Sine an octave up: a clean halo on each chord tone. */
const SHIMMER_WAVEFORM: OscillatorType = 'sine';

/** Shimmer pitch above its chord tone, in semitones: one octave. */
const SHIMMER_OCTAVE_SEMITONES = 12;

/** Shimmer level as a fraction of its tone's gain. 0.3 is heard as air on the
 * pad, not as a second voice (owner 2026-09-05). */
const SHIMMER_GAIN_FRACTION = 0.3;

/** Shimmer detune, in cents. 4 cents against the tone's octave beats slowly
 * — the glisten — without reading as out of tune. */
const SHIMMER_DETUNE_CENTS = 4;

/** Pad attack, in seconds. 3 s over a 7.5 s chord means a chord is never
 * "struck" — the strongest reason the pad reads as weather, not a keyboard. */
const PAD_ATTACK_SECONDS = 3;

/** Pad release, in seconds. Begins as the NEXT chord's attack begins, so the
 * two overlap for their whole length and the progression crossfades. 3.5 s is
 * slightly longer than the attack so the outgoing chord is still under the
 * incoming one when that one arrives. */
const PAD_RELEASE_SECONDS = 3.5;

/** Melody waveform. Sine: no harmonics, so a note is a point of light over the
 * pad rather than an instrument — the "stars" half of the cosmic brief
 * (owner 2026-09-05; was triangle). */
const PLUCK_WAVEFORM: OscillatorType = 'sine';

/** Peak gain of one melody note. Well above the pad's per-tone level so single
 * notes read as foreground; four overlapping notes plus the pad stay under
 * unity. Sine carries less energy than triangle, hence 0.18 not 0.16. */
const PLUCK_PEAK_GAIN = 0.18;

/** Melody attack, in seconds. 12 ms is fast enough to read as a pluck and slow
 * enough to avoid the click a step change in gain would produce. */
const PLUCK_ATTACK_SECONDS = 0.012;

/** Total life of a melody note, in seconds — attack plus decay. 3.2 s (~7
 * eighths) lets each note hang and fade like a distant point of light; at the
 * densest mood a note has at most six live neighbours, still under unity. */
const PLUCK_DURATION_SECONDS = 3.2;

/** Gain a decaying note is ramped to before it is stopped. Exponential ramps
 * cannot reach zero, so they aim here: -80 dB, inaudible, and the node is
 * stopped immediately after. */
const SILENT_GAIN = 0.0001;

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

/**
 * Schedules one chord: every tone, every detuned voice, attack through
 * release. `startTime` is on the audio clock and is when the attack begins;
 * the release begins one chord later, so consecutive chords crossfade.
 */
export function schedulePadChord(
  context: BaseAudioContext,
  pool: VoicePool,
  destination: AudioNode,
  notes: readonly number[],
  startTime: number,
): void {
  const releaseStart = startTime + SECONDS_PER_CHORD;
  const releaseEnd = releaseStart + PAD_RELEASE_SECONDS;

  for (const note of notes) {
    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(0, startTime);
    toneGain.gain.linearRampToValueAtTime(PAD_TONE_PEAK_GAIN, startTime + PAD_ATTACK_SECONDS);
    // Held explicitly at the release point: without this the ramp below would
    // interpolate from the ATTACK's end value over the whole chord, i.e. the
    // pad would start fading the instant it arrived.
    toneGain.gain.setValueAtTime(PAD_TONE_PEAK_GAIN, releaseStart);
    toneGain.gain.linearRampToValueAtTime(0, releaseEnd);
    toneGain.connect(destination);

    const sources: OscillatorNode[] = [];
    for (let voice = 0; voice < PAD_VOICES_PER_TONE; voice += 1) {
      const oscillator = context.createOscillator();
      oscillator.type = PAD_WAVEFORM;
      oscillator.frequency.setValueAtTime(midiToFrequency(note), startTime);
      // Spread symmetrically about the pitch: for three voices that is
      // -1, 0, +1 detune steps.
      const spread = voice - (PAD_VOICES_PER_TONE - 1) / 2;
      oscillator.detune.setValueAtTime(spread * PAD_DETUNE_CENTS, startTime);
      oscillator.connect(toneGain);
      oscillator.start(startTime);
      oscillator.stop(releaseEnd + VOICE_STOP_MARGIN_SECONDS);
      sources.push(oscillator);
    }

    const shimmerGain = context.createGain();
    shimmerGain.gain.setValueAtTime(SHIMMER_GAIN_FRACTION, startTime);
    shimmerGain.connect(toneGain);
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

/** Schedules one melody note at `startTime`; `velocity` in (0, 1] scales it. */
export function schedulePluck(
  context: BaseAudioContext,
  pool: VoicePool,
  destination: AudioNode,
  note: number,
  velocity: number,
  startTime: number,
): void {
  const endTime = startTime + PLUCK_DURATION_SECONDS;

  const noteGain = context.createGain();
  noteGain.gain.setValueAtTime(SILENT_GAIN, startTime);
  noteGain.gain.linearRampToValueAtTime(
    PLUCK_PEAK_GAIN * velocity,
    startTime + PLUCK_ATTACK_SECONDS,
  );
  noteGain.gain.exponentialRampToValueAtTime(SILENT_GAIN, endTime);
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
