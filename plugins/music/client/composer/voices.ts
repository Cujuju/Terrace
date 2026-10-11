import { midiToFrequency } from './theory.ts';

const PAD_VOICES_PER_TONE = 3;

const PAD_WAVEFORM: OscillatorType = 'sawtooth';

const ENVELOPE_PEAK_GAIN = 1;

const SHIMMER_WAVEFORM: OscillatorType = 'sine';

const SHIMMER_OCTAVE_SEMITONES = 12;

const SHIMMER_DETUNE_CENTS = 4;

const PLUCK_WAVEFORM: OscillatorType = 'sine';

const PLUCK_ATTACK_SECONDS = 0.012;

export const SILENT_GAIN = 0.0001;

const DRONE_WAVEFORM: OscillatorType = 'sine';

const DRONE_OCTAVE_DROP_SEMITONES = 12;

const DRONE_FIFTH_SEMITONES = 7;

const VOICE_STOP_MARGIN_SECONDS = 0.05;

interface VoiceGroup {
  readonly sources: readonly OscillatorNode[];
  readonly others: readonly AudioNode[];
}

export interface VoicePool {
  liveNodeCount(): number;
  adopt(group: VoiceGroup): void;
  stopAll(when: number): void;
}

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

export interface PadShape {
  readonly holdSeconds: number;
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
  readonly detuneCents: number;
}

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

  const applyEnvelope = (gain: GainNode): void => {
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(ENVELOPE_PEAK_GAIN, startTime + shape.attackSeconds);
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
      const spread = voice - (PAD_VOICES_PER_TONE - 1) / 2;
      oscillator.detune.setValueAtTime(spread * shape.detuneCents, startTime);
      oscillator.connect(toneGain);
      oscillator.start(startTime);
      oscillator.stop(releaseEnd + VOICE_STOP_MARGIN_SECONDS);
      sources.push(oscillator);
    }

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

export interface PluckShape {
  readonly durationSeconds: number;
  readonly silentFloorGain: number;
}

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
