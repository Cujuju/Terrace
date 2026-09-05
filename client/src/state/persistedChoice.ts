// ONE PLAYER PREFERENCE THAT IS A CHOICE FROM A FIXED SET.
//
// state/controlPrefs.ts grew three near-identical copies of the same twelve
// lines — a versioned localStorage key, a module-scope signal seeded from
// storage, a setter that writes both, and a try/catch around every storage
// call because storage throws outright in a locked-down browser rather than
// returning null. Each copy also had to remember to VALIDATE what came back:
// stored JSON is user-editable and survives a release that removed an option,
// so an unvalidated read can hand the rest of the app a value its own union
// type says is impossible.
//
// This is that shape as a contract instead of a pattern to re-type. A caller
// declares the allowed values once and gets an accessor and a setter; there is
// no way to reach the storage key without going through the validation, which
// is what makes "a stale or hand-edited value falls back to the default" true
// by construction rather than by each caller remembering.
//
// STRING CHOICES ONLY, DELIBERATELY. The three prefs in controlPrefs.ts that
// this could serve store objects (a binding is a button plus a modifier), and
// generalising to arbitrary shapes would put a schema validator in here.
// Everything this helper does correctly — the membership test IS the
// validation — depends on the value being one of a short list of strings.
//
// STORED BARE, NOT WRAPPED IN JSON. The value is written as itself, so the
// stored form is `wheel`, not `{"style":"wheel"}`. Nothing needs parsing, and
// a corrupt entry cannot throw on read — it simply fails the membership test.

import { createSignal, type Accessor } from 'solid-js';

/**
 * Backs a single string-choice preference with localStorage.
 *
 * @param storageKey Versioned key, e.g. `terrace.celestialVoid.v1`. Bump the
 *   version suffix when the meaning of the stored values changes; a key that
 *   no longer exists reads as absent, so old entries retire themselves.
 * @param allowed Every value the caller accepts. Membership in this list is
 *   the whole of the validation, so it must be exhaustive.
 * @param fallback Used when nothing is stored, when storage is unavailable,
 *   and when the stored value is not in `allowed`.
 * @returns The reactive accessor and the setter that persists.
 */
export function persistedChoice<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): [Accessor<T>, (value: T) => void] {
  const load = (): T => {
    try {
      const raw = localStorage.getItem(storageKey);
      // The cast is checked on the very next line; `includes` on a
      // `readonly T[]` will not accept a plain string without it.
      return allowed.includes(raw as T) ? (raw as T) : fallback;
    } catch {
      // Storage unavailable (private mode, site data blocked) — the default
      // applies for this session, exactly as for the control prefs.
      return fallback;
    }
  };

  const [value, setValue] = createSignal<T>(load());

  const set = (next: T): void => {
    setValue(() => next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Best effort; the in-memory choice still applies for this session.
    }
  };

  return [value, set];
}

/**
 * Forgets a persisted choice's stored value. Separate from the pair above
 * because resetting is a panel-wide action (ui/ControlsPanel.tsx's "Reset to
 * defaults"), not something an individual pref module drives; the pref module
 * pairs this with putting its own signal back to the default.
 */
export function clearPersistedChoice(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Ignore, as above.
  }
}
