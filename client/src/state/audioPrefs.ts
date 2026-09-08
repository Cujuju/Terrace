import { createSignal } from 'solid-js';

export const DEFAULT_MASTER_VOLUME = 0.8;

export const DEFAULT_MUTED = false;

export type AudioBusName = 'sfx' | 'ambience' | 'music';

export const AUDIO_BUS_NAMES: readonly AudioBusName[] = ['sfx', 'ambience', 'music'];

export const AUDIO_BUS_LABEL: Readonly<Record<AudioBusName, string>> = {
  sfx: 'Effects',
  ambience: 'Ambience',
  music: 'Music',
};

export const DEFAULT_SFX_LEVEL = 1;
export const DEFAULT_AMBIENCE_LEVEL = 1;
export const DEFAULT_MUSIC_LEVEL = 1;

const DEFAULT_BUS_LEVELS: Readonly<Record<AudioBusName, number>> = {
  sfx: DEFAULT_SFX_LEVEL,
  ambience: DEFAULT_AMBIENCE_LEVEL,
  music: DEFAULT_MUSIC_LEVEL,
};

export const MIN_MASTER_VOLUME = 0;
export const MAX_MASTER_VOLUME = 1;

const STORAGE_KEY = 'terrace.audioPrefs.v2';

interface StoredAudioPrefs {
  readonly volume: number;
  readonly muted: boolean;
  readonly buses: Readonly<Record<AudioBusName, number>>;
}

function isValidVolume(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_MASTER_VOLUME &&
    value <= MAX_MASTER_VOLUME
  );
}

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
    return fallback;
  }
}

const initial = loadPrefs();

const [masterVolume, setMasterVolumeSignal] = createSignal<number>(initial.volume);
const [audioMuted, setAudioMutedSignal] = createSignal<boolean>(initial.muted);

const busSignals: Readonly<Record<AudioBusName, ReturnType<typeof createSignal<number>>>> = {
  sfx: createSignal<number>(initial.buses.sfx),
  ambience: createSignal<number>(initial.buses.ambience),
  music: createSignal<number>(initial.buses.music),
};

export { masterVolume, audioMuted };

export function busLevel(bus: AudioBusName): number {
  return busSignals[bus][0]();
}

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
  }
}

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

export function effectiveMasterGain(): number {
  return audioMuted() ? MIN_MASTER_VOLUME : masterVolume();
}

export function effectiveBusGain(bus: AudioBusName): number {
  return busLevel(bus);
}
