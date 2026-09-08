import { createSignal, type Accessor } from 'solid-js';

export function persistedChoice<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): [Accessor<T>, (value: T) => void] {
  const load = (): T => {
    try {
      const raw = localStorage.getItem(storageKey);
      return allowed.includes(raw as T) ? (raw as T) : fallback;
    } catch {
      return fallback;
    }
  };

  const [value, setValue] = createSignal<T>(load());

  const set = (next: T): void => {
    setValue(() => next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
    }
  };

  return [value, set];
}

export function clearPersistedChoice(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
  }
}
