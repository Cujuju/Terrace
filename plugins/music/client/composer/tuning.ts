// Every number the owner tunes by ear, in one place, so the score can be
// retuned live from the HUD (GH #325) without a rebuild.
//
// WHAT BELONGS HERE. A constant that is a SOUND-DESIGN choice — a level, a
// tempo, an envelope length, a cutoff. What does NOT belong here is anything
// structural: the progressions, the scales, the key, the metre, the scheduler's
// lookahead. Those are the score's identity, not its balance.
//
// TWO WAYS A DIAL LANDS. Levels and cutoffs are AudioParams the engine glides,
// so they are heard on everything already sounding, at once. Everything else
// (detune, envelopes, densities, tempo) is read when the next event is
// SCHEDULED, so it is heard from the next note — and tempo only from the next
// chord boundary, so the grid never tears. See composer.ts.

/**
 * The dials. Every field is a number, so the panel, the persistence and the
 * clamp table are each written once over `keyof ComposerTuning`.
 */
export interface ComposerTuning {
  /** Beats per minute of the whole grid. */
  readonly tempoBpm: number;
  /** Peak gain of one chord tone (all its detuned voices together). */
  readonly padToneGain: number;
  /** Detune spread of the outer pad voices, in cents. */
  readonly padDetuneCents: number;
  /** Pad attack, in seconds. */
  readonly padAttackSeconds: number;
  /** Pad release, in seconds; begins as the next chord's attack does. */
  readonly padReleaseSeconds: number;
  /** Shimmer level as a fraction of its chord tone's gain. */
  readonly shimmerGainFraction: number;
  /** Peak gain of a melody note at velocity 1. */
  readonly pluckPeakGain: number;
  /** Total life of a melody note, in seconds — attack plus decay. */
  readonly pluckDurationSeconds: number;
  /** Multiplies the mood-derived melody density, before its ceiling. */
  readonly melodyDensityScale: number;
  /** Density multiplier for off-beat subdivisions. */
  readonly offbeatDensityFactor: number;
  /** Lowest the mood filter closes to, in hertz. */
  readonly filterNightCutoffHz: number;
  /** Highest the mood filter opens to, in hertz. */
  readonly filterDayCutoffHz: number;
}

/**
 * The score as the owner left it (main 242d60d). Each value keeps the
 * justification it had in theory.ts or voices.ts, which no longer own it.
 */
export const DEFAULT_TUNING: ComposerTuning = {
  /** A bar is 3.75 s, drifting rather than still. Owner 2026-09-05 asked for a
   * little more pace than the original 56; faster demands attention, which a
   * layer left on for hours must not. */
  tempoBpm: 64,

  /** Owner 2026-09-05 took the pad from 0.09 to 0.055, then 20 % lower again;
   * three tones sum to 0.132. */
  padToneGain: 0.044,

  /** About a 0.4 % pitch offset: at 110 Hz that beats a little under once a
   * second — movement without vibrato. Past ~15 cents it sounds out of tune. */
  padDetuneCents: 7,

  /** 3 s over a 7.5 s chord means a chord is never "struck" — the strongest
   * reason the pad reads as weather, not a keyboard. */
  padAttackSeconds: 3,

  /** Slightly longer than the attack, so the outgoing chord is still under the
   * incoming one when that one arrives. */
  padReleaseSeconds: 3.5,

  /** Heard as air on the pad, not as a second voice (owner 2026-09-05). */
  shimmerGainFraction: 0.3,

  /** Well above the pad's per-tone level so single notes read as foreground.
   * Sine carries less energy than triangle, hence 0.18 and not 0.16. */
  pluckPeakGain: 0.18,

  /** ~7 eighths: each note hangs and fades like a distant point of light. */
  pluckDurationSeconds: 3.2,

  /** Unity — the mood's own day/tension density curve, unscaled. The dial
   * thins or thickens the melody without touching that curve. */
  melodyDensityScale: 1,

  /** Makes the beat the place notes usually land and the off-beat the
   * exception, which gives the line a pulse without a rhythm section. */
  offbeatDensityFactor: 0.55,

  /** Deep night, heavy weather. */
  filterNightCutoffHz: 380,

  /** Clear noon. Leaves the melody's upper octave (~1.2 kHz) untouched — air,
   * the "open sky" half of the cosmic brief (owner 2026-09-05). */
  filterDayCutoffHz: 2800,
};

// HEADROOM, over the dial ranges in tuning-state.ts's DIALS table. The sums
// below are what reaches the composer's own output gain, BEFORE OUTPUT_LEVEL
// (0.85, composer.ts). Both progressions are 3-note chords and two chords
// overlap during a crossfade, so a pad term is bounded by 3 tones x 2 chords.
// A melody note decays exponentially from its peak to SILENT_GAIN over
// pluckDurationSeconds, so notes one subdivision apart sum to a geometric
// series of ratio q = (SILENT_GAIN / pluckPeakGain) ^ (subdivision / duration).
//
//                        DEFAULTS                       ALL DIALS AT MAXIMUM
//   pad       3 x 0.044 x 1.143 = 0.151     3 x 0.12 x 2       = 0.720
//   shimmer   0.30 x 0.151      = 0.045     1.00 x 0.720       = 0.720
//   drone     DRONE_MAX_GAIN    = 0.180     (not a dial)       = 0.180
//   melody    0.18 / (1 - 0.334)= 0.270     0.40 / (1 - 0.649) = 1.141
//   TOTAL                         0.646                          2.761
//   x OUTPUT_LEVEL                0.549                          2.347
//   (1.143 = the exact overlap of a 3 s attack against a 3.5 s release; the
//    maxima use the bound 2, since no attack/release pair in range exceeds it)
//
// ANY ONE DIAL AT ITS MAXIMUM, THE REST AT DEFAULT, STAYS UNDER 1.0. Every
// term is monotonic in its own dial, and the worst single dial is padToneGain:
// 0.412 pad + 0.123 shimmer + 0.180 drone + 0.270 melody = 0.985. (Next worst:
// pluckPeakGain 0.945, pluckDurationSeconds 0.782, padReleaseSeconds 0.729.)
//
// ALL DIALS AT MAXIMUM TOGETHER CLIPS, and that is a named residual rather than
// an oversight: these dials exist so the owner can push the score well past
// where it sits, and clipping is the audible signal to back one off. Capping
// the ranges at a headroom-safe ~1.2x the defaults would make the panel
// useless for the job it was asked to do, and a limiter would both colour the
// sound and break the offline render digest determinism is verified with.
