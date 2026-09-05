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
 * The bright progression I – vi – IV – V in OPEN voicing: root, fifth, third
 * an octave up (owner 2026-09-05, "exploring the cosmos"). Chords whose top
 * would reach the melody's register drop an octave, so the bass walks.
 */
const BRIGHT_PROGRESSION: readonly (readonly number[])[] = [
  [0, 7, 16], // I
  [-3, 4, 12], // vi
  [5, 12, 21], // IV
  [-5, 2, 11], // V
];

/**
 * The overcast progression i – VI – III – VII (aeolian), same open voicing and
 * the same root, so the switch at a chord boundary is colour, not key.
 */
const OVERCAST_PROGRESSION: readonly (readonly number[])[] = [
  [0, 7, 15], // i
  [-4, 3, 12], // VI
  [3, 10, 19], // III
  [-2, 5, 14], // VII
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
 * music is behind the rain" without muting the pad's fundamentals (the lowest
 * open-voicing tone is 82 Hz, far below even the closed cutoff).
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
 * Semitones above the root where the melody's range starts. Two octaves keeps
 * it clear of the open voicings (which top out at +21).
 */
const MELODY_BASE_OFFSET_SEMITONES = 2 * OCTAVE_SEMITONES;

/** Octaves the melody ranges over. Two, so a phrase can leap and fall. */
const MELODY_RANGE_OCTAVES = 2;

/**
 * How far full daylight skews note picks upward: the pick is raised to the
 * power (1 - skew·daylight), so noon leans high and night sits low, both
 * still spanning the whole range. 0.5 is a lean, not a transposition.
 */
const MELODY_BRIGHT_SKEW = 0.5;

/** Quietest melody note, as a fraction of the loudest. Velocity variety. */
const MELODY_MIN_VELOCITY = 0.55;

/**
 * Density multiplier for off-beat subdivisions. 0.55 makes the beat the place
 * notes usually land and the off-beat the exception, which gives the line a
 * pulse without a rhythm section.
 */
export const MELODY_OFFBEAT_DENSITY_FACTOR = 0.55;

/** Peak gain of the tension drone, relative to the composer's own output. */
const DRONE_MAX_GAIN = 0.18;

/** Result of reading a mood: everything the synthesis needs, and nothing else. */
export interface MoodParameters {
  /** Cutoff of the one mood-driven low-pass, in hertz. */
  readonly filterCutoffHz: number;
  /** Probability in [0, 1] that any one melody subdivision sounds a note. */
  readonly melodyDensity: number;
  /** Semitones added to every melody note. */
  readonly melodyOffsetSemitones: number;
  /** Exponent applied to the pick draw; below 1 leans the melody high. */
  readonly melodyPickExponent: number;
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
    melodyOffsetSemitones: MELODY_BASE_OFFSET_SEMITONES,
    melodyPickExponent: 1 - MELODY_BRIGHT_SKEW * daylight,
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

/** One melody note: pitch and how hard it is struck. */
export interface MelodyEvent {
  readonly note: number;
  /** 0..1 gain multiplier for the pluck. */
  readonly velocity: number;
}

/**
 * The melody event for a draw `pick` in [0, 1). Pentatonic over two octaves,
 * so no draw clashes with the chord under it; a pick that repeats `previous`
 * steps one degree instead, so the line always moves. The fraction left over
 * after choosing the degree is the velocity — still exactly one draw.
 */
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
    // Index is clamped into range above; the fallback only guards a non-finite
    // pick, which would otherwise hand Web Audio a NaN frequency.
    const degree = scale[degreeIndex % scale.length] ?? 0;
    return ROOT_MIDI_NOTE + parameters.melodyOffsetSemitones + octave * OCTAVE_SEMITONES + degree;
  };

  if (previous !== null && noteAt(index) === previous) {
    index = index < degrees - 1 ? index + 1 : index - 1;
  }
  return { note: noteAt(index), velocity };
}
