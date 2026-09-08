import type { ComposerTuning } from './tuning.ts';

const SECONDS_PER_MINUTE = 60;

export function secondsPerBeat(tempoBpm: number): number {
  return SECONDS_PER_MINUTE / tempoBpm;
}

export const BEATS_PER_BAR = 4;

export const BARS_PER_CHORD = 2;

export const BEATS_PER_CHORD = BEATS_PER_BAR * BARS_PER_CHORD;

export function secondsPerChord(tempoBpm: number): number {
  return BEATS_PER_CHORD * secondsPerBeat(tempoBpm);
}

export const MELODY_SUBDIVISIONS_PER_BEAT = 2;

export const OCTAVE_SEMITONES = 12;

const A4_MIDI_NOTE = 69;

const A4_FREQUENCY_HZ = 440;

export const ROOT_MIDI_NOTE = 45;

export function midiToFrequency(midiNote: number): number {
  return A4_FREQUENCY_HZ * Math.pow(2, (midiNote - A4_MIDI_NOTE) / OCTAVE_SEMITONES);
}

const BRIGHT_PROGRESSION: readonly (readonly number[])[] = [
  [0, 7, 16],
  [-3, 4, 12],
  [5, 12, 21],
  [-5, 2, 11],
];

const OVERCAST_PROGRESSION: readonly (readonly number[])[] = [
  [0, 7, 15],
  [-4, 3, 12],
  [3, 10, 19],
  [-2, 5, 14],
];

export const CHORDS_PER_LOOP = BRIGHT_PROGRESSION.length;

const BRIGHT_SCALE_SEMITONES: readonly number[] = [0, 2, 4, 7, 9];

const OVERCAST_SCALE_SEMITONES: readonly number[] = [0, 3, 5, 7, 10];

export interface ComposerMood {
  readonly dayPhase: number;
  readonly weather: number;
  readonly tension: number;
}

const MINOR_LEAN_WEATHER_THRESHOLD = 0.35;

const FILTER_WEATHER_CLOSE_FRACTION = 0.45;

const MELODY_NIGHT_DENSITY = 0.08;

const MELODY_DAY_DENSITY = 0.3;

const MELODY_TENSION_DENSITY = 0.18;

const MELODY_MAX_DENSITY = 0.5;

const MELODY_BASE_OFFSET_SEMITONES = 2 * OCTAVE_SEMITONES;

const MELODY_RANGE_OCTAVES = 2;

const MELODY_BRIGHT_SKEW = 0.5;

const MELODY_MIN_VELOCITY = 0.55;

const DRONE_MAX_GAIN = 0.18;

export interface MoodParameters {
  readonly filterCutoffHz: number;
  readonly melodyDensity: number;
  readonly melodyOffsetSemitones: number;
  readonly melodyPickExponent: number;
  readonly droneGain: number;
  readonly minor: boolean;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function daylightFromPhase(dayPhase: number): number {
  return (1 - Math.cos(2 * Math.PI * clampUnit(dayPhase))) / 2;
}

export function moodParameters(mood: ComposerMood, tuning: ComposerTuning): MoodParameters {
  const daylight = daylightFromPhase(mood.dayPhase);
  const weather = clampUnit(mood.weather);
  const tension = clampUnit(mood.tension);

  const openCutoffHz =
    tuning.filterNightCutoffHz +
    (tuning.filterDayCutoffHz - tuning.filterNightCutoffHz) * daylight;
  const density =
    (MELODY_NIGHT_DENSITY +
      (MELODY_DAY_DENSITY - MELODY_NIGHT_DENSITY) * daylight +
      MELODY_TENSION_DENSITY * tension) *
    tuning.melodyDensityScale;

  return {
    filterCutoffHz: openCutoffHz * (1 - FILTER_WEATHER_CLOSE_FRACTION * weather),
    melodyDensity: Math.min(density, MELODY_MAX_DENSITY),
    melodyOffsetSemitones: MELODY_BASE_OFFSET_SEMITONES,
    melodyPickExponent: 1 - MELODY_BRIGHT_SKEW * daylight,
    droneGain: DRONE_MAX_GAIN * tension,
    minor: weather >= MINOR_LEAN_WEATHER_THRESHOLD,
  };
}

export function chordNotes(chordIndex: number, minor: boolean): readonly number[] {
  const progression = minor ? OVERCAST_PROGRESSION : BRIGHT_PROGRESSION;
  const chord = progression[((chordIndex % CHORDS_PER_LOOP) + CHORDS_PER_LOOP) % CHORDS_PER_LOOP];
  if (chord === undefined) return [];
  return chord.map((semitones) => ROOT_MIDI_NOTE + semitones);
}

export interface MelodyEvent {
  readonly note: number;
  readonly velocity: number;
}

export function melodyEvent(
  pick: number,
  parameters: MoodParameters,
  previous: number | null,
): MelodyEvent {
  const scale = parameters.minor ? OVERCAST_SCALE_SEMITONES : BRIGHT_SCALE_SEMITONES;
  const degrees = scale.length * MELODY_RANGE_OCTAVES;
  const skewed = Number.isFinite(pick) ? Math.pow(clampUnit(pick), parameters.melodyPickExponent) : 0;
  const scaled = skewed * degrees;
  let index = Math.min(degrees - 1, Math.floor(scaled));
  const velocity = MELODY_MIN_VELOCITY + (1 - MELODY_MIN_VELOCITY) * (scaled - Math.floor(scaled));

  const noteAt = (degreeIndex: number): number => {
    const octave = Math.floor(degreeIndex / scale.length);
    const degree = scale[degreeIndex % scale.length] ?? 0;
    return ROOT_MIDI_NOTE + parameters.melodyOffsetSemitones + octave * OCTAVE_SEMITONES + degree;
  };

  if (previous !== null && noteAt(index) === previous) {
    index = index < degrees - 1 ? index + 1 : index - 1;
  }
  return { note: noteAt(index), velocity };
}
