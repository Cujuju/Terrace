// Master volume, mute, and one level per bus. Shaped like controlPrefs.ts:
// module-scope Solid signals, versioned localStorage key, every storage read
// wrapped so a private-mode browser degrades to session-only defaults.
//
// Module scope because the imperative audio engine reads these outside any
// reactive root; components must call the accessor at point of use.

import { createSignal } from 'solid-js';

/** Headroom, so stacked sounds do not reach the ceiling on their own. */
export const DEFAULT_MASTER_VOLUME = 0.8;

/** Sound is ON out of the box; a player who wants silence says so. */
export const DEFAULT_MUTED = false;

/**
 * NAMED HERE, not in the engine that builds them: the engine imports this and
 * not the reverse, and the loader must validate a level per bus.
 */
export type AudioBusName = 'sfx' | 'ambience' | 'music';

export const AUDIO_BUS_NAMES: readonly AudioBusName[] = ['sfx', 'ambience', 'music'];

/** Beside the names, so adding a bus is one edit here and none in the UI. */
export const AUDIO_BUS_LABEL: Readonly<Record<AudioBusName, string>> = {
  sfx: 'Effects',
  ambience: 'Ambience',
  music: 'Music',
};

/**
 * One constant each, not one literal: three independent decisions that happen
 * to start equal. Unity, since an attenuated default is an unseen mix choice.
 */
export const DEFAULT_SFX_LEVEL = 1;
export const DEFAULT_AMBIENCE_LEVEL = 1;
export const DEFAULT_MUSIC_LEVEL = 1;

const DEFAULT_BUS_LEVELS: Readonly<Record<AudioBusName, number>> = {
  sfx: DEFAULT_SFX_LEVEL,
  ambience: DEFAULT_AMBIENCE_LEVEL,
  music: DEFAULT_MUSIC_LEVEL,
};

/** One range for master and buses alike; a second would drift out of step. */
export const MIN_MASTER_VOLUME = 0;
export const MAX_MASTER_VOLUME = 1;

/** Versioned like controlPrefs.ts: a shape change gets a new key, not a migration. */
const STORAGE_KEY = 'terrace.audioPrefs.v2';

/** v2 added `buses`; a v1 value is discarded, costing one slider drag. */
interface StoredAudioPrefs {
  readonly volume: number;
  readonly muted: boolean;
  readonly buses: Readonly<Record<AudioBusName, number>>;
}

/** NaN in a GainNode silences the whole graph with no error anyone sees. */
function isValidVolume(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_MASTER_VOLUME &&
    value <= MAX_MASTER_VOLUME
  );
}

/** Reads stored prefs; any malformed or partial value falls back whole. */
function loadPrefs(): StoredAudioPrefs {
  const fallback: StoredAudioPrefs = {
    volume: DEFAULT_MASTER_VOLUME,
    muted: DEFAULT_MUTED,
    buses: DEFAULT_BUS_LEVELS,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as { volume?: unknown; muted?: unknown; buses?: unknown };
    if (!isValidVolume(record.volume)) return fallback;
    if (typeof record.muted !== 'boolean') return fallback;
    // Whole, not per field: a partial value came from a build we do not know.
    if (typeof record.buses !== 'object' || record.buses === null) return fallback;
    const stored = record.buses as Record<string, unknown>;
    if (!AUDIO_BUS_NAMES.every((bus) => isValidVolume(stored[bus]))) return fallback;
    return {
      volume: record.volume,
      muted: record.muted,
      buses: {
        sfx: stored.sfx as number,
        ambience: stored.ambience as number,
        music: stored.music as number,
      },
    };
  } catch {
    // Storage unavailable (private mode) — session-only defaults.
    return fallback;
  }
}

const initial = loadPrefs();

const [masterVolume, setMasterVolumeSignal] = createSignal<number>(initial.volume);
const [audioMuted, setAudioMutedSignal] = createSignal<boolean>(initial.muted);

/**
 * ONE SIGNAL PER BUS: a single record signal would re-run every bus's effect,
 * re-ramping nodes that had not moved, on every drag of any one slider.
 */
const busSignals: Readonly<Record<AudioBusName, ReturnType<typeof createSignal<number>>>> = {
  sfx: createSignal<number>(initial.buses.sfx),
  ambience: createSignal<number>(initial.buses.ambience),
  music: createSignal<number>(initial.buses.music),
};

export { masterVolume, audioMuted };

/** This bus's level, 0..1. Reactive — call it at the point of use. */
export function busLevel(bus: AudioBusName): number {
  return busSignals[bus][0]();
}

/** Persists everything; best effort, exactly like controlPrefs.ts. */
function persist(): void {
  try {
    const value: StoredAudioPrefs = {
      volume: masterVolume(),
      muted: audioMuted(),
      buses: {
        sfx: busLevel('sfx'),
        ambience: busLevel('ambience'),
        music: busLevel('music'),
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Best effort; the in-memory prefs still apply for this session.
  }
}

/** Clamped at the door: a slider is not the only possible caller. */
function clampLevel(value: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_MASTER_VOLUME, Math.max(MIN_MASTER_VOLUME, value))
    : fallback;
}

export function setMasterVolume(volume: number): void {
  setMasterVolumeSignal(clampLevel(volume, DEFAULT_MASTER_VOLUME));
  persist();
}

export function setBusLevel(bus: AudioBusName, level: number): void {
  busSignals[bus][1](clampLevel(level, DEFAULT_BUS_LEVELS[bus]));
  persist();
}

export function setAudioMuted(muted: boolean): void {
  setAudioMutedSignal(muted);
  persist();
}

/**
 * Derived from the two signals rather than stored, so mute cannot drift from
 * the slider: unmuting restores exactly the level that was there.
 */
export function effectiveMasterGain(): number {
  return audioMuted() ? MIN_MASTER_VOLUME : masterVolume();
}

/**
 * MUTE IS THE MASTER'S BUSINESS: a bus level is the mix and must survive one.
 * Trivial today, and the seam where ducking or solo would go.
 */
export function effectiveBusGain(bus: AudioBusName): number {
  return busLevel(bus);
}
