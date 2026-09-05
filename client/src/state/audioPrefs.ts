// The player's audio preferences: a master volume, a mute, and one level per bus.
//
// SHAPED EXACTLY LIKE controlPrefs.ts, deliberately — module-scope Solid
// signals, a versioned localStorage key, every read of storage wrapped so a
// private-mode browser degrades to session-only defaults. These are
// presentation preferences, so like the control bindings they live client-side
// only and nothing here is ever sent to the server.
//
// WHY THERE IS A UI FOR THIS AT ALL. A world that makes sound with no way to
// silence it is user-hostile. A master volume and a mute is the minimum that is
// not. The three PER-BUS levels beside it are the owner's 2026-09-04 amendment
// to plan §7 (which had defaulted to master + mute only): they answer the
// second question a player actually has — "the thunder is too loud against
// everything else" — which a master cannot answer at all.
//
// Signals live at module scope for the same reason as hudState.ts and
// controlPrefs.ts: the imperative audio engine (client/src/audio/audioEngine.ts)
// reads them outside any reactive root, and Solid components must call the
// exported accessor at point of use.

import { createSignal } from 'solid-js';

/**
 * Master volume out of the box, as a linear gain multiplier in [0, 1].
 *
 * 0.8 RATHER THAN 1.0: the buses feed a single master into the destination
 * with no limiter behind it, so leaving the default at unity would put a
 * thunderclap and a rain loop and a music track on top of each other at full
 * scale and clip. A fifth of headroom costs a barely audible amount of level
 * and means the first sound a new player hears cannot be the sound of the
 * output stage running out of room. (Plan §2.3, owner default.)
 */
export const DEFAULT_MASTER_VOLUME = 0.8;

/** Sound is ON out of the box; a player who wants silence says so. */
export const DEFAULT_MUTED = false;

/**
 * THE THREE BUSES, named once here rather than in the audio engine.
 *
 * The engine is the thing that BUILDS a bus, so at first glance the names
 * belong to it — but the engine imports this module (it follows these prefs)
 * and not the other way round, and now that there is a stored level per bus the
 * set of buses is part of the PREF MODEL: the loader below has to validate a
 * value for each one. Two declarations of the same three strings, one on each
 * side of that import, is the duplication that eventually disagrees. So the
 * names live at the end that is imported and audio/audioEngine.ts imports them
 * back — the same "put the shared declaration on the side of the boundary every
 * reader can reach" move plugins/types.ts makes for SkyRigState.
 */
export type AudioBusName = 'sfx' | 'ambience' | 'music';

export const AUDIO_BUS_NAMES: readonly AudioBusName[] = ['sfx', 'ambience', 'music'];

/**
 * What each bus is called in the settings popup. Beside the names rather than
 * in the component, so adding a bus is one edit here and none in the UI.
 */
export const AUDIO_BUS_LABEL: Readonly<Record<AudioBusName, string>> = {
  sfx: 'Effects',
  ambience: 'Ambience',
  music: 'Music',
};

/**
 * Each bus's level out of the box, as a linear multiplier applied BEFORE the
 * master.
 *
 * ALL 1.0 — full, and one named constant each rather than one shared literal,
 * because these are three independent mix decisions that merely happen to start
 * at the same value, and a future retune of one must not silently retune the
 * others. Unity is the honest default: a bus that attenuated out of the box
 * would be a mix decision the player never made and cannot see, and assets are
 * authored (or, for now, generated) at the level they are meant to play at. The
 * player's own headroom lives in the master, whose default is 0.8 above.
 */
export const DEFAULT_SFX_LEVEL = 1;
export const DEFAULT_AMBIENCE_LEVEL = 1;
export const DEFAULT_MUSIC_LEVEL = 1;

const DEFAULT_BUS_LEVELS: Readonly<Record<AudioBusName, number>> = {
  sfx: DEFAULT_SFX_LEVEL,
  ambience: DEFAULT_AMBIENCE_LEVEL,
  music: DEFAULT_MUSIC_LEVEL,
};

/**
 * The lowest and highest level any slider or stored value here may take —
 * master and buses alike, because they are all linear gain multipliers into the
 * same kind of node and a second range would be a second thing to keep in step.
 */
export const MIN_MASTER_VOLUME = 0;
export const MAX_MASTER_VOLUME = 1;

/**
 * Versioned exactly like controlPrefs.ts's keys: a stored value whose SHAPE
 * changes gets a new key rather than a migration, so an old browser's leftover
 * value can never be half-read into a new model.
 */
const STORAGE_KEY = 'terrace.audioPrefs.v2';

/**
 * What is written to (and read back from) localStorage under STORAGE_KEY.
 *
 * v2 ADDS `buses`. The key was bumped rather than the loader taught to fill in
 * a missing field, which is the stance STORAGE_KEY's own comment states. The
 * cost is that a player who had already moved the master slider goes back to
 * 0.8 once — acceptable for a preference one drag restores, and cheaper than a
 * migration path that would have to stay correct forever.
 */
interface StoredAudioPrefs {
  readonly volume: number;
  readonly muted: boolean;
  readonly buses: Readonly<Record<AudioBusName, number>>;
}

/**
 * A stored level is trusted only if it is a real number IN RANGE — an
 * out-of-range or NaN value would be written straight into a GainNode, where
 * NaN silences the whole graph with no error anyone would see.
 */
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
    // WHOLE, not per field: a stored object missing one bus was written by a
    // build this one does not understand, and half-trusting it is how a pref
    // model acquires a shape nobody declared.
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
    // Storage unavailable (private mode, disabled) — session-only defaults,
    // the same degradation controlPrefs.ts takes.
    return fallback;
  }
}

const initial = loadPrefs();

const [masterVolume, setMasterVolumeSignal] = createSignal<number>(initial.volume);
const [audioMuted, setAudioMutedSignal] = createSignal<boolean>(initial.muted);

/**
 * ONE SIGNAL PER BUS, not one signal holding a record of three.
 *
 * The engine ramps each bus's GainNode from its own effect, and a single record
 * signal would make every one of those effects re-run — and re-ramp a node
 * whose level had not moved — whenever any one slider was dragged. Three
 * signals mean moving the music slider touches the music bus and nothing else.
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

/**
 * Clamps a level into range at the DOOR rather than at the GainNode: a slider
 * is not the only possible caller, and a value that could reach the audio graph
 * out of range is a value that will one day be NaN there.
 */
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
 * The one number the audio engine's master gain follows — volume AND mute
 * collapsed into a single linear gain.
 *
 * AS A FUNCTION OF THE TWO SIGNALS rather than a third stored value, so the
 * mute state cannot drift out of step with the slider: muting does not forget
 * the volume, and unmuting restores exactly the level that was there.
 */
export function effectiveMasterGain(): number {
  return audioMuted() ? MIN_MASTER_VOLUME : masterVolume();
}

/**
 * The one number a bus's gain follows.
 *
 * MUTE IS THE MASTER'S BUSINESS AND NOT A BUS'S. A bus level is the player's
 * MIX — how loud thunder is against rain — and it has to survive a mute and
 * come back unchanged, exactly as the master's own level does. So this is the
 * bus level and nothing else; silence is applied once, downstream, by
 * `effectiveMasterGain` above. A trivial wrapper today, and deliberately the
 * seam where anything bus-specific (a ducking rule, a solo) would go, so the
 * engine never grows a second opinion about what a bus's gain is.
 */
export function effectiveBusGain(bus: AudioBusName): number {
  return busLevel(bus);
}
