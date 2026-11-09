import { createPrng } from './prng.ts';
import {
  BEATS_PER_CHORD,
  chordNotes,
  melodyEvent,
  MELODY_SUBDIVISIONS_PER_BEAT,
  moodParameters,
  ROOT_MIDI_NOTE,
  secondsPerBeat,
  secondsPerChord,
  type ComposerMood,
  type MoodParameters,
} from './theory.ts';
import { DEFAULT_TUNING, type ComposerTuning } from './tuning.ts';
import {
  createVoicePool,
  schedulePadChord,
  schedulePluck,
  SILENT_GAIN,
  startDrone,
} from './voices.ts';

const START_FADE_SECONDS = 0.4;
const OUTPUT_LEVEL = 0.85;
const MOOD_GLIDE_TIME_CONSTANT_SECONDS = 1.5;
const FILTER_RESONANCE_Q = 0.7;
export const TEARDOWN_SLACK_SECONDS = 0.1;
const MELODY_RANDOM_DRAWS_PER_SUBDIVISION = 2;

function usableTempoBpm(tempoBpm: number): number {
  return Number.isFinite(tempoBpm) && tempoBpm > 0 ? tempoBpm : DEFAULT_TUNING.tempoBpm;
}

export function createEngine(
  context: BaseAudioContext,
  destination: AudioNode,
  seed: number,
  initialMood: ComposerMood,
  initialTuning: ComposerTuning,
) {
  const prng = createPrng(seed);
  const pool = createVoicePool();

  const outputGain = context.createGain();
  outputGain.connect(destination);

  const moodFilter = context.createBiquadFilter();
  moodFilter.type = 'lowpass';
  moodFilter.Q.value = FILTER_RESONANCE_Q;
  moodFilter.connect(outputGain);

  let mood: ComposerMood = initialMood;
  let tuning: ComposerTuning = initialTuning;

  const padBus = context.createGain();
  const shimmerBus = context.createGain();
  const melodyBus = context.createGain();
  for (const bus of [padBus, shimmerBus, melodyBus]) bus.connect(moodFilter);

  const shimmerBusGain = (of: ComposerTuning): number =>
    of.padToneGain * of.shimmerGainFraction;

  let droneGain: GainNode | null = null;
  let startTime = 0;
  let nextBeatIndex = 0;
  let nextChordIndex = 0;
  let activeTempoBpm = usableTempoBpm(initialTuning.tempoBpm);
  let tempoAnchorTime = 0;
  let pendingTempoBpm: number | null = null;
  let activeMinor = false;
  let previousMelodyNote: number | null = null;

  const applyMoodParameters = (
    parameters: MoodParameters,
    atTime: number,
    glide: boolean,
  ): void => {
    if (glide) {
      moodFilter.frequency.setTargetAtTime(
        parameters.filterCutoffHz,
        atTime,
        MOOD_GLIDE_TIME_CONSTANT_SECONDS,
      );
      droneGain?.gain.setTargetAtTime(
        parameters.droneGain,
        atTime,
        MOOD_GLIDE_TIME_CONSTANT_SECONDS,
      );
      return;
    }
    moodFilter.frequency.setValueAtTime(parameters.filterCutoffHz, atTime);
    droneGain?.gain.setValueAtTime(parameters.droneGain, atTime);
  };

  const applyBusGains = (atTime: number, glide: boolean): void => {
    const levels: readonly (readonly [GainNode, number])[] = [
      [padBus, tuning.padToneGain],
      [shimmerBus, shimmerBusGain(tuning)],
      [melodyBus, tuning.pluckPeakGain],
    ];
    for (const [bus, level] of levels) {
      if (glide) bus.gain.setTargetAtTime(level, atTime, MOOD_GLIDE_TIME_CONSTANT_SECONDS);
      else bus.gain.setValueAtTime(level, atTime);
    }
  };

  return {
    setMood(next: ComposerMood, atTime: number): void {
      mood = next;
      applyMoodParameters(moodParameters(mood, tuning), atTime, true);
    },

    setTuning(next: ComposerTuning, atTime: number): void {
      tuning = next;
      applyBusGains(atTime, true);
      applyMoodParameters(moodParameters(mood, tuning), atTime, true);
      const wanted = usableTempoBpm(next.tempoBpm);
      pendingTempoBpm = wanted === activeTempoBpm ? null : wanted;
    },

    begin(atTime: number): void {
      startTime = atTime;
      tempoAnchorTime = atTime;
      outputGain.gain.setValueAtTime(0, atTime);
      outputGain.gain.linearRampToValueAtTime(OUTPUT_LEVEL, atTime + START_FADE_SECONDS);
      droneGain = startDrone(context, pool, moodFilter, ROOT_MIDI_NOTE, atTime);
      applyBusGains(atTime, false);
      applyMoodParameters(moodParameters(mood, tuning), atTime, false);
    },

    pumpUntil(horizon: number, earliestTime = 0): void {
      const parameters = moodParameters(mood, tuning);
      for (;;) {
        let beatSeconds = secondsPerBeat(activeTempoBpm);
        const lastSubdivisionOffsetSeconds = beatSeconds *
          (MELODY_SUBDIVISIONS_PER_BEAT - 1) / MELODY_SUBDIVISIONS_PER_BEAT;
        const longestVoiceSeconds = Math.max(
          secondsPerChord(activeTempoBpm) + tuning.padReleaseSeconds,
          tuning.pluckDurationSeconds + lastSubdivisionOffsetSeconds,
        );
        let firstRelevantBeat = Math.max(nextBeatIndex,
          Math.ceil((earliestTime - longestVoiceSeconds - startTime) / beatSeconds));
        if (pendingTempoBpm !== null) {
          const tempoBoundary = Math.ceil(nextBeatIndex / BEATS_PER_CHORD) * BEATS_PER_CHORD;
          firstRelevantBeat = Math.min(firstRelevantBeat, tempoBoundary);
        }
        if (firstRelevantBeat > nextBeatIndex) {
          // Unheard beats advance the score and PRNG without allocating voices.
          const skippedChords = Math.ceil(firstRelevantBeat / BEATS_PER_CHORD) -
            Math.ceil(nextBeatIndex / BEATS_PER_CHORD);
          nextChordIndex += skippedChords;
          if (skippedChords > 0) activeMinor = parameters.minor;
          prng.skip((firstRelevantBeat - nextBeatIndex) * MELODY_SUBDIVISIONS_PER_BEAT *
            MELODY_RANDOM_DRAWS_PER_SUBDIVISION);
          nextBeatIndex = firstRelevantBeat;
        }
        const beatTime = startTime + nextBeatIndex * beatSeconds;
        if (beatTime >= horizon) return;

        if (nextBeatIndex % BEATS_PER_CHORD === 0 && pendingTempoBpm !== null) {
          activeTempoBpm = pendingTempoBpm;
          pendingTempoBpm = null;
          startTime = beatTime;
          nextBeatIndex = 0;
          tempoAnchorTime = beatTime;
          beatSeconds = secondsPerBeat(activeTempoBpm);
        }

        const beatIndex = nextBeatIndex;
        nextBeatIndex += 1;

        if (beatIndex % BEATS_PER_CHORD === 0) {
          activeMinor = parameters.minor;
          const chordIndex = nextChordIndex;
          nextChordIndex += 1;
          schedulePadChord(
            context,
            pool,
            padBus,
            shimmerBus,
            chordNotes(chordIndex, activeMinor),
            beatTime,
            {
              holdSeconds: secondsPerChord(activeTempoBpm),
              attackSeconds: tuning.padAttackSeconds,
              releaseSeconds: tuning.padReleaseSeconds,
              detuneCents: tuning.padDetuneCents,
            },
          );
        }

        const melodyParameters: MoodParameters = { ...parameters, minor: activeMinor };
        const subdivisionSeconds = beatSeconds / MELODY_SUBDIVISIONS_PER_BEAT;
        const silentFloorGain =
          tuning.pluckPeakGain > 0 ? SILENT_GAIN / tuning.pluckPeakGain : SILENT_GAIN;
        for (let sub = 0; sub < MELODY_SUBDIVISIONS_PER_BEAT; sub += 1) {
          const gate = prng.next();
          const pick = prng.next();
          const density =
            melodyParameters.melodyDensity * (sub === 0 ? 1 : tuning.offbeatDensityFactor);
          if (gate >= density) continue;
          const noteTime = beatTime + sub * subdivisionSeconds;
          if (noteTime + tuning.pluckDurationSeconds <= earliestTime) continue;
          const event = melodyEvent(pick, melodyParameters, previousMelodyNote);
          previousMelodyNote = event.note;
          schedulePluck(
            context,
            pool,
            melodyBus,
            event.note,
            event.velocity,
            noteTime,
            { durationSeconds: tuning.pluckDurationSeconds, silentFloorGain },
          );
        }
      }
    },

    end(atTime: number, fadeSeconds: number): number {
      const fadeEnd = atTime + Math.max(fadeSeconds, 0);
      outputGain.gain.cancelScheduledValues(atTime);
      outputGain.gain.setValueAtTime(outputGain.gain.value, atTime);
      outputGain.gain.linearRampToValueAtTime(0, fadeEnd);
      const stopTime = fadeEnd + TEARDOWN_SLACK_SECONDS;
      pool.stopAll(stopTime);
      return stopTime;
    },

    dispose(): void {
      for (const bus of [padBus, shimmerBus, melodyBus]) bus.disconnect();
      moodFilter.disconnect();
      outputGain.disconnect();
    },

    liveNodeCount: (): number => pool.liveNodeCount(),
    activeTempoBpm: (): number => activeTempoBpm,
    tempoAnchorTime: (): number => tempoAnchorTime,
    pendingTempoBpm: (): number | null => pendingTempoBpm,
  };
}
