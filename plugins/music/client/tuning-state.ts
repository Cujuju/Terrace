import { createSignal } from "solid-js";
import { DEFAULT_TUNING, type ComposerTuning } from "./composer/tuning.ts";

export type MusicTuningField = keyof ComposerTuning;

export const MUSIC_TUNING_FIELDS: readonly MusicTuningField[] = [
  "tempoBpm",
  "padToneGain",
  "padDetuneCents",
  "padAttackSeconds",
  "padReleaseSeconds",
  "shimmerGainFraction",
  "pluckPeakGain",
  "pluckDurationSeconds",
  "melodyDensityScale",
  "offbeatDensityFactor",
  "filterNightCutoffHz",
  "filterDayCutoffHz",
];

export type DialUnit = "bpm" | "¢" | "s" | "Hz" | "×" | "%";

export interface Dial {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: DialUnit;
  readonly title: string;
}

export const DIALS: Readonly<Record<MusicTuningField, Dial>> = {
  tempoBpm: {
    label: "Tempo",
    min: 40,
    max: 96,
    step: 1,
    unit: "bpm",
    title: "How fast the score moves. Chords change every eight beats.",
  },

  padToneGain: {
    label: "Pad",
    min: 0,
    max: 0.12,
    step: 0.001,
    unit: "%",
    title: "How loud the sustained synth chords are under everything.",
  },

  padDetuneCents: {
    label: "Pad detune",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "¢",
    title:
      "How far the pad's voices spread apart. More is warmer and wobblier.",
  },

  padAttackSeconds: {
    label: "Pad attack",
    min: 0.2,
    max: 6,
    step: 0.1,
    unit: "s",
    title: "How slowly each chord swells in.",
  },

  padReleaseSeconds: {
    label: "Pad release",
    min: 0.2,
    max: 8,
    step: 0.1,
    unit: "s",
    title: "How long each chord lingers after the next one begins.",
  },

  shimmerGainFraction: {
    label: "Shimmer",
    min: 0,
    max: 1,
    step: 0.01,
    unit: "%",
    title: "How much high, glassy halo rides on top of each chord.",
  },

  pluckPeakGain: {
    label: "Melody",
    min: 0,
    max: 0.4,
    step: 0.005,
    unit: "%",
    title: "How loud the single melody notes are.",
  },

  pluckDurationSeconds: {
    label: "Melody tail",
    min: 0.5,
    max: 6,
    step: 0.1,
    unit: "s",
    title: "How long each melody note rings before fading out.",
  },

  melodyDensityScale: {
    label: "Melody density",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
    title: "How often melody notes play. Time of day still shapes it.",
  },

  offbeatDensityFactor: {
    label: "Off-beat",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "×",
    title: "How often notes fall between beats. Low is steady, high is loose.",
  },

  filterNightCutoffHz: {
    label: "Night cutoff",
    min: 100,
    max: 1500,
    step: 10,
    unit: "Hz",
    title: "How dark the tone gets at midnight. Lower is more muffled.",
  },

  filterDayCutoffHz: {
    label: "Day cutoff",
    min: 500,
    max: 6000,
    step: 50,
    unit: "Hz",
    title: "How bright the tone gets at noon. Higher is more open.",
  },
};

const STORAGE_KEY = "terrace.musicTuning.v1";

function clampField(field: MusicTuningField, value: unknown): number {
  const dial = DIALS[field];
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_TUNING[field];
  return Math.min(dial.max, Math.max(dial.min, value));
}

function loadTuning(): ComposerTuning {
  const stored = ((): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  let loaded: ComposerTuning = DEFAULT_TUNING;
  for (const field of MUSIC_TUNING_FIELDS) {
    loaded = { ...loaded, [field]: clampField(field, stored[field]) };
  }
  return loaded;
}

const [musicTuning, setMusicTuningSignal] =
  createSignal<ComposerTuning>(loadTuning());

export { musicTuning };

function persist(tuning: ComposerTuning): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch {
  }
}

export function setMusicTuningField(
  field: MusicTuningField,
  value: number,
): void {
  const next: ComposerTuning = {
    ...musicTuning(),
    [field]: clampField(field, value),
  };
  setMusicTuningSignal(next);
  persist(next);
}

export function resetMusicTuning(): void {
  setMusicTuningSignal(DEFAULT_TUNING);
  persist(DEFAULT_TUNING);
}
