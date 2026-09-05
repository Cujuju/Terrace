// The player's audio preferences: one master volume and one mute.
//
// SHAPED EXACTLY LIKE controlPrefs.ts, deliberately — module-scope Solid
// signals, a versioned localStorage key, every read of storage wrapped so a
// private-mode browser degrades to session-only defaults. These are
// presentation preferences, so like the control bindings they live client-side
// only and nothing here is ever sent to the server.
//
// WHY THERE IS A UI FOR THIS AT ALL. A world that makes sound with no way to
// silence it is user-hostile. One volume and one mute is the minimum that is
// not; per-bus sliders are deliberately NOT here (audio-host plan §7, owner
// default) because the player's question is "quieter" or "off", not "less
// ambience relative to sfx".
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

/** The lowest and highest master volume the slider and storage accept. */
export const MIN_MASTER_VOLUME = 0;
export const MAX_MASTER_VOLUME = 1;

/**
 * Versioned exactly like controlPrefs.ts's keys: a stored value whose SHAPE
 * changes gets a new key rather than a migration, so an old browser's leftover
 * value can never be half-read into a new model.
 */
const STORAGE_KEY = 'terrace.audioPrefs.v1';

/** What is written to (and read back from) localStorage under STORAGE_KEY. */
interface StoredAudioPrefs {
  readonly volume: number;
  readonly muted: boolean;
}

/**
 * A stored volume is trusted only if it is a real number IN RANGE — an
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
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as { volume?: unknown; muted?: unknown };
    if (!isValidVolume(record.volume)) return fallback;
    if (typeof record.muted !== 'boolean') return fallback;
    return { volume: record.volume, muted: record.muted };
  } catch {
    // Storage unavailable (private mode, disabled) — session-only defaults,
    // the same degradation controlPrefs.ts takes.
    return fallback;
  }
}

const initial = loadPrefs();

const [masterVolume, setMasterVolumeSignal] = createSignal<number>(initial.volume);
const [audioMuted, setAudioMutedSignal] = createSignal<boolean>(initial.muted);

export { masterVolume, audioMuted };

/** Persists the current pair; best effort, exactly like controlPrefs.ts. */
function persist(): void {
  try {
    const value: StoredAudioPrefs = { volume: masterVolume(), muted: audioMuted() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Best effort; the in-memory prefs still apply for this session.
  }
}

/**
 * Sets the master volume, clamped into range at the DOOR rather than at the
 * GainNode: a slider is not the only possible caller, and a value that could
 * reach the audio graph out of range is a value that will one day be NaN there.
 */
export function setMasterVolume(volume: number): void {
  const clamped = Number.isFinite(volume)
    ? Math.min(MAX_MASTER_VOLUME, Math.max(MIN_MASTER_VOLUME, volume))
    : DEFAULT_MASTER_VOLUME;
  setMasterVolumeSignal(clamped);
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
