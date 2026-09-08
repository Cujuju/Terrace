export interface ComposerTuning {
  readonly tempoBpm: number;
  readonly padToneGain: number;
  readonly padDetuneCents: number;
  readonly padAttackSeconds: number;
  readonly padReleaseSeconds: number;
  readonly shimmerGainFraction: number;
  readonly pluckPeakGain: number;
  readonly pluckDurationSeconds: number;
  readonly melodyDensityScale: number;
  readonly offbeatDensityFactor: number;
  readonly filterNightCutoffHz: number;
  readonly filterDayCutoffHz: number;
}

export const DEFAULT_TUNING: ComposerTuning = {
  tempoBpm: 64,

  padToneGain: 0.044,

  padDetuneCents: 7,

  padAttackSeconds: 3,

  padReleaseSeconds: 3.5,

  shimmerGainFraction: 0.3,

  pluckPeakGain: 0.18,

  pluckDurationSeconds: 3.2,

  melodyDensityScale: 1,

  offbeatDensityFactor: 0.55,

  filterNightCutoffHz: 380,

  filterDayCutoffHz: 2800,
};
