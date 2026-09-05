// The composer's musical vocabulary: grid, key, chords, scale, and the map
// from a mood to the handful of numbers the synthesis actually reads.
//
// EVERYTHING MUSICAL LIVES HERE and nothing in this file touches Web Audio.
// That split is deliberate: the note stream is what determinism is claimed
// about (same seed + same mood timeline => same notes), so it has to be
// readable and testable-by-eye without an AudioContext in the room.
//
// THE BRIEF FOR THE MUSIC (audio-composer-p2a.md): "keep it boring and
// pleasant; this is a terraforming god-game, not a shooter." Every choice
// below is the conservative one — slow tempo, pentatonic melody, four-chord
// loop, no modulation, no rhythm section.

/**
 * Tempo. 64 BPM: a bar is 3.75 s, drifting rather than still. Owner 2026-09-05
 * asked for a little more pace than the original 56; faster starts demanding
 * attention, which a layer left on for hours must not.
 */
export const TEMPO_BEATS_PER_MINUTE = 64;

/** Seconds in one beat, derived so the tempo has exactly one definition. */
export const SECONDS_PER_BEAT = 60 / TEMPO_BEATS_PER_MINUTE;

/** Beats in a bar. 4/4 — the only metre that never sounds like a statement. */
export const BEATS_PER_BAR = 4;

/**
 * Bars a chord is held for. Two bars (7.5 s) keeps a chord change an event
 * rather than a rhythm, so the pad reads as atmosphere, not a progression.
 */
export const BARS_PER_CHORD = 2;

/** Beats a chord is held for. Derived — the chord grid is the beat grid. */
export const BEATS_PER_CHORD = BEATS_PER_BAR * BARS_PER_CHORD;

/** Seconds a chord is held for. */
export const SECONDS_PER_CHORD = BEATS_PER_CHORD * SECONDS_PER_BEAT;

/**
 * Melody events per beat. Two (eighth notes) gives the melody somewhere to sit
 * off the beat; at this tempo an eighth is ~0.47 s, enough for a note to ring.
 */
export const MELODY_SUBDIVISIONS_PER_BEAT = 2;

/** Semitones in an octave. */
export const OCTAVE_SEMITONES = 12;

/** MIDI note number of A4, the tuning reference. */
const A4_MIDI_NOTE = 69;

/** Frequency of A4 in hertz — concert pitch. */
const A4_FREQUENCY_HZ = 440;

/**
 * The key's root, as a MIDI note. 45 is A2 (110 Hz): low enough that a pad
 * built on it has body on small speakers, high enough that the chord's third
 * and fifth do not turn to mud. The key never changes at runtime — a key
 * change under a player who is mid-sculpt is exactly the "gamey" attention
 * grab the brief rules out.
 */
export const ROOT_MIDI_NOTE = 45;

/** Converts a MIDI note number to hertz (equal temperament, A4 = 440 Hz). */
export function midiToFrequency(midiNote: number): number {
  return A4_FREQUENCY_HZ * Math.pow(2, (midiNote - A4_MIDI_NOTE) / OCTAVE_SEMITONES);
}

/**
 * The bright progression, as semitone offsets from the root, one triad per
 * chord: I – vi – IV – V. The most-used loop in popular music precisely
 * because it resolves without ever surprising anyone, which is the goal.
 */
const BRIGHT_PROGRESSION: readonly (readonly number[])[] = [
  [0, 4, 7], // I
  [9, 12, 16], // vi
  [5, 9, 12], // IV
  [7, 11, 14], // V
];

/**
 * The overcast progression: i – VI – III – VII in the natural minor (aeolian).
 * Same four-chord shape and the same root, so the crossfade from BRIGHT into
 * this one at a chord boundary is a change of colour, not of key.
 */
const OVERCAST_PROGRESSION: readonly (readonly number[])[] = [
  [0, 3, 7], // i
  [8, 12, 15], // VI
  [3, 7, 10], // III
  [10, 14, 17], // VII
];

/** Chords in a progression loop. Both progressions are this long by design. */
export const CHORDS_PER_LOOP = BRIGHT_PROGRESSION.length;

/** Major pentatonic, in semitones from the root — the bright melody scale. */
const BRIGHT_SCALE_SEMITONES: readonly number[] = [0, 2, 4, 7, 9];

/** Minor pentatonic, in semitones from the root — the overcast melody scale. */
const OVERCAST_SCALE_SEMITONES: readonly number[] = [0, 3, 5, 7, 10];

/** The mood the composer is currently aiming at. */
export interface ComposerMood {
  /** 0..1, 0 = midnight, 0.5 = noon (same convention as daynight's phase). */
  readonly dayPhase: number;
  /** 0..1 how much weather is over the listener (rain/storm weight). */
  readonly weather: number;
  /** 0..1 danger (monsters near, volcano erupting); phase 2b decides the source. */
  readonly tension: number;
}

/**
 * Weather at or above this leans the music minor. A threshold rather than a
 * blend because mode is DISCRETE — there is no half-minor chord — and it is
 * only ever read at a chord boundary, so the change lands on the grid.
 * 0.35 is "a front is overhead", not "a cloud went past".
 */
const MINOR_LEAN_WEATHER_THRESHOLD = 0.35;

/** Lowest the mood filter ever closes to, in hertz: deep night, heavy weather. */
const FILTER_NIGHT_CUTOFF_HZ = 380;

/** Highest the mood filter opens to, in hertz: clear noon. 2800 leaves the
 * melody's upper octave (~1.2 kHz) untouched — air, the "open sky" half of the
 * cosmic brief (owner 2026-09-05). */
const FILTER_DAY_CUTOFF_HZ = 2800;

/**
 * Fraction of the cutoff that full weather removes. 0.45 is audible as "the
 * music is behind the rain" without muting the pad's fundamental (the lowest
 * chord tone here is 110 Hz, far below even the closed cutoff).
 */
const FILTER_WEATHER_CLOSE_FRACTION = 0.45;

/** Melody note probability per subdivision at deep night: barely there. */
const MELODY_NIGHT_DENSITY = 0.08;

/** Melody note probability per subdivision at noon. ~1 note per 1.6 s. */
const MELODY_DAY_DENSITY = 0.3;

/** Extra note probability at full tension — agitation, not a drum fill. */
const MELODY_TENSION_DENSITY = 0.18;

/**
 * Hard ceiling on note probability per subdivision. Above ~0.5 the melody
 * stops being sparse and starts being a line, and plucked voices begin to
 * stack faster than they decay (see PLUCK_DURATION_SECONDS in voices.ts).
 */
const MELODY_MAX_DENSITY = 0.5;

/**
 * Semitones above the root that the melody's lowest octave sits at. Two
 * octaves keeps it clear of the pad's triad (which spans the root to +17).
 */
const MELODY_BASE_OFFSET_SEMITONES = 2 * OCTAVE_SEMITONES;

/**
 * Daylight at or above which the melody may take the upper octave. 0.6 is
 * mid-morning onwards, so the octave lift reads as "the day opened up".
 */
const MELODY_BRIGHT_OCTAVE_THRESHOLD = 0.6;

/** Peak gain of the tension drone, relative to the composer's own output. */
const DRONE_MAX_GAIN = 0.18;

/** Result of reading a mood: everything the synthesis needs, and nothing else. */
export interface MoodParameters {
  /** Cutoff of the one mood-driven low-pass, in hertz. */
  readonly filterCutoffHz: number;
  /** Probability in [0, 1] that any one melody subdivision sounds a note. */
  readonly melodyDensity: number;
  /** Semitones added to every melody note (the octave lift). */
  readonly melodyOffsetSemitones: number;
  /** Gain of the low tension drone in [0, DRONE_MAX_GAIN]. */
  readonly droneGain: number;
  /** Whether chords and melody take their minor forms. */
  readonly minor: boolean;
}

/** Clamps `value` into [0, 1]; every mood field is contractually in that range. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * How much daylight `dayPhase` means, in [0, 1]: 0 at midnight (phase 0),
 * 1 at noon (phase 0.5). A raised cosine rather than a triangle so dusk and
 * dawn glide instead of turning a corner — the filter follows this directly
 * and a corner in a cutoff is audible as a wobble.
 */
function daylightFromPhase(dayPhase: number): number {
  return (1 - Math.cos(2 * Math.PI * clampUnit(dayPhase))) / 2;
}

/** Reads a mood into the numbers the synthesis uses. Pure; no clock, no nodes. */
export function moodParameters(mood: ComposerMood): MoodParameters {
  const daylight = daylightFromPhase(mood.dayPhase);
  const weather = clampUnit(mood.weather);
  const tension = clampUnit(mood.tension);

  const openCutoffHz =
    FILTER_NIGHT_CUTOFF_HZ + (FILTER_DAY_CUTOFF_HZ - FILTER_NIGHT_CUTOFF_HZ) * daylight;
  const density =
    MELODY_NIGHT_DENSITY +
    (MELODY_DAY_DENSITY - MELODY_NIGHT_DENSITY) * daylight +
    MELODY_TENSION_DENSITY * tension;

  return {
    filterCutoffHz: openCutoffHz * (1 - FILTER_WEATHER_CLOSE_FRACTION * weather),
    melodyDensity: Math.min(density, MELODY_MAX_DENSITY),
    melodyOffsetSemitones:
      MELODY_BASE_OFFSET_SEMITONES +
      (daylight >= MELODY_BRIGHT_OCTAVE_THRESHOLD ? OCTAVE_SEMITONES : 0),
    droneGain: DRONE_MAX_GAIN * tension,
    minor: weather >= MINOR_LEAN_WEATHER_THRESHOLD,
  };
}

/**
 * The chord at `chordIndex` of the endless loop, as MIDI note numbers.
 * `minor` picks the progression; it is sampled once per chord, never mid-bar.
 */
export function chordNotes(chordIndex: number, minor: boolean): readonly number[] {
  const progression = minor ? OVERCAST_PROGRESSION : BRIGHT_PROGRESSION;
  const chord = progression[((chordIndex % CHORDS_PER_LOOP) + CHORDS_PER_LOOP) % CHORDS_PER_LOOP];
  // The double modulo is total over the integers, so this is unreachable for
  // any finite chordIndex. It is kept as the belt to CHORDS_PER_LOOP's
  // suspenders: if the two progressions ever stop being the same length, the
  // shorter one reads out of range here, and silence for one chord is a far
  // better failure than a TypeError inside the scheduler tick.
  if (chord === undefined) return [];
  return chord.map((semitones) => ROOT_MIDI_NOTE + semitones);
}

/**
 * The melody note for a draw `pick` in [0, 1), as a MIDI note number.
 * Pentatonic, so no draw can produce a note that clashes with the triad under
 * it — which is the entire reason the melody may be random at all.
 */
export function melodyNote(pick: number, parameters: MoodParameters): number {
  const scale = parameters.minor ? OVERCAST_SCALE_SEMITONES : BRIGHT_SCALE_SEMITONES;
  const index = Math.min(scale.length - 1, Math.floor(pick * scale.length));
  // `index` is clamped into range above, so the fallback is unreachable; it is
  // here so a non-finite `pick` (which would make Math.floor produce NaN)
  // degrades to the root rather than to a NaN frequency, which Web Audio
  // rejects with a thrown RangeError inside the scheduler tick.
  const degree = scale[index];
  if (degree === undefined) return ROOT_MIDI_NOTE + parameters.melodyOffsetSemitones;
  return ROOT_MIDI_NOTE + degree + parameters.melodyOffsetSemitones;
}
