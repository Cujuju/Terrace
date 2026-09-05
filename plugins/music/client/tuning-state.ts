// The music plugin's own persisted prefs: the composer dials the owner turns
// from the settings popup (GH #325).
//
// SHAPED LIKE client/src/state/audioPrefs.ts — module-scope Solid signal,
// versioned localStorage key, every storage access wrapped so a private-mode
// browser degrades to session-only defaults. Module scope for the same reason
// too: the plugin's imperative half pushes these into the composer from outside
// any reactive root, and the panel calls the accessor at its point of use.

import { createSignal } from 'solid-js';
import { DEFAULT_TUNING, type ComposerTuning } from './composer/tuning.ts';

/** A dial is exactly a tuning field; DIALS below is keyed by the interface, so
 * a new field cannot ship without a range, a label and a slider. */
export type MusicTuningField = keyof ComposerTuning;

/** The order the panel lays the dials out: the pad, then its shimmer, then the
 * melody, then the two filter ends. */
export const MUSIC_TUNING_FIELDS: readonly MusicTuningField[] = [
  'tempoBpm',
  'padToneGain',
  'padDetuneCents',
  'padAttackSeconds',
  'padReleaseSeconds',
  'shimmerGainFraction',
  'pluckPeakGain',
  'pluckDurationSeconds',
  'melodyDensityScale',
  'offbeatDensityFactor',
  'filterNightCutoffHz',
  'filterDayCutoffHz',
];

/** How a readout is spelled. '%' is the only one that scales the value. */
export type DialUnit = 'bpm' | '¢' | 's' | 'Hz' | '×' | '%';

/** One slider: its words and its range. Also the clamp the loader validates
 * against, so a dial's range has exactly one definition. */
export interface Dial {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: DialUnit;
}

/**
 * The ranges, each chosen so the DEFAULT sits inside it with room either way
 * and neither end is a setting nobody would ever want. See tuning.ts's headroom
 * note: any one of these at its maximum, with the rest at default, stays under
 * unity; all of them at once does not, deliberately.
 */
export const DIALS: Readonly<Record<MusicTuningField, Dial>> = {
  /** 40 is a heartbeat, 96 is walking pace; past 96 the pad's attack no longer
   * covers a chord and the score starts asking for attention. */
  tempoBpm: { label: 'Tempo', min: 40, max: 96, step: 1, unit: 'bpm' },

  /** 0 mutes the pad; 0.12 is the loudest the three tones can sum to and still
   * leave the melody room. Step 0.001 — 0.1 % is about the smallest audible. */
  padToneGain: { label: 'Pad', min: 0, max: 0.12, step: 0.001, unit: '%' },

  /** 0 is a bare unison; past 20 cents three voices read as out of tune rather
   * than as one warm one. Half-cent steps: the beating is what is heard. */
  padDetuneCents: { label: 'Pad detune', min: 0, max: 20, step: 0.5, unit: '¢' },

  /** 0.2 s is a struck keyboard, 6 s is nearly a whole chord fading in. Below
   * 0.2 s a sawtooth chord clicks. */
  padAttackSeconds: { label: 'Pad attack', min: 0.2, max: 6, step: 0.1, unit: 's' },

  /** 0.2 s cuts each chord off, 8 s holds it under two chords after it. Wider
   * than the attack because a long tail is the more useful direction. */
  padReleaseSeconds: { label: 'Pad release', min: 0.2, max: 8, step: 0.1, unit: 's' },

  /** 0 removes the halo, 1 makes it as loud as the tone under it — the point at
   * which it stops being air and becomes a second voice. */
  shimmerGainFraction: { label: 'Shimmer', min: 0, max: 1, step: 0.01, unit: '%' },

  /** 0 mutes the melody; 0.4 is where overlapping notes alone approach unity
   * (tuning.ts). Step 0.005 keeps a fine hand near the default 0.18. */
  pluckPeakGain: { label: 'Melody', min: 0, max: 0.4, step: 0.005, unit: '%' },

  /** 0.5 s is a true pluck, 6 s is a note that rings past its neighbours. Past
   * 6 s notes stack faster than they decay at any density. */
  pluckDurationSeconds: { label: 'Melody tail', min: 0.5, max: 6, step: 0.1, unit: 's' },

  /** 0 silences the melody without touching its level, 2 doubles the mood's own
   * density — the ceiling in theory.ts still caps what that can reach. */
  melodyDensityScale: { label: 'Melody density', min: 0, max: 2, step: 0.05, unit: '×' },

  /** 0 puts every note on a beat, 1 makes off-beats as likely as beats — the
   * two ends of "does this line have a pulse". */
  offbeatDensityFactor: { label: 'Off-beat', min: 0, max: 1, step: 0.05, unit: '×' },

  /** 100 Hz leaves only the drone and the pad's fundamentals, 1500 Hz is barely
   * a night at all. Must stay under the day end to mean anything. */
  filterNightCutoffHz: { label: 'Night cutoff', min: 100, max: 1500, step: 10, unit: 'Hz' },

  /** 500 Hz is permanently overcast, 6000 Hz is the sawtooth pad unfiltered.
   * 50 Hz steps: at this end a 10 Hz move is inaudible. */
  filterDayCutoffHz: { label: 'Day cutoff', min: 500, max: 6000, step: 50, unit: 'Hz' },
};

/** Versioned like audioPrefs.ts: a shape change gets a new key, not a migration. */
const STORAGE_KEY = 'terrace.musicTuning.v1';

/** Clamps one field into its dial's range; anything non-finite takes the
 * default, so a NaN can never reach an AudioParam. */
function clampField(field: MusicTuningField, value: unknown): number {
  const dial = DIALS[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TUNING[field];
  return Math.min(dial.max, Math.max(dial.min, value));
}

/**
 * Reads the stored tuning. PER FIELD, not whole-record like audioPrefs.ts: with
 * twelve dials, one unreadable field should cost one dial, not eleven good ones
 * — and a value stored before a dial's range narrowed is clamped, not thrown.
 */
function loadTuning(): ComposerTuning {
  const stored = ((): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return parsed as Record<string, unknown>;
    } catch {
      // Storage unavailable (private mode) — session-only defaults.
      return {};
    }
  })();

  // From the defaults outward, so the result is total whatever storage held.
  let loaded: ComposerTuning = DEFAULT_TUNING;
  for (const field of MUSIC_TUNING_FIELDS) {
    loaded = { ...loaded, [field]: clampField(field, stored[field]) };
  }
  return loaded;
}

const [musicTuning, setMusicTuningSignal] = createSignal<ComposerTuning>(loadTuning());

export { musicTuning };

/** Persists the whole tuning; best effort, exactly like audioPrefs.ts. */
function persist(tuning: ComposerTuning): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch {
    // Best effort; the in-memory tuning still applies for this session.
  }
}

/** Sets one dial. Clamped at the door — a slider is not the only caller. */
export function setMusicTuningField(field: MusicTuningField, value: number): void {
  const next: ComposerTuning = { ...musicTuning(), [field]: clampField(field, value) };
  setMusicTuningSignal(next);
  persist(next);
}

/** Puts every dial back to the score as it shipped. */
export function resetMusicTuning(): void {
  setMusicTuningSignal(DEFAULT_TUNING);
  persist(DEFAULT_TUNING);
}
