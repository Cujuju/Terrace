import { createSignal } from 'solid-js';

export type CameraKeyAction =
  | 'panForward'
  | 'panBack'
  | 'panLeft'
  | 'panRight'
  | 'rotateLeft'
  | 'rotateRight'
  | 'tiltUp'
  | 'tiltDown'
  | 'zoomIn'
  | 'zoomOut';

export const CAMERA_KEY_ACTIONS: readonly CameraKeyAction[] = [
  'panForward',
  'panBack',
  'panLeft',
  'panRight',
  'rotateLeft',
  'rotateRight',
  'tiltUp',
  'tiltDown',
  'zoomIn',
  'zoomOut',
];

/** Primary and alternate key per action, as `KeyboardEvent.code` (physical key). */
export type CameraKeySlots = readonly [string | null, string | null];
export type CameraKeySlot = 0 | 1;
export type CameraKeyBindings = Readonly<Record<CameraKeyAction, CameraKeySlots>>;

/** Keys other features own: Backquote opens perf, Escape closes panels and cancels a rebind. */
export const RESERVED_KEY_CODES: readonly string[] = ['Backquote', 'Escape'];

export type CameraKeyPreset = 'rightHand' | 'leftHand';

/** Alternates sit on the arrow cluster and nav keys, under the other hand. */
export const CAMERA_KEY_PRESETS: Readonly<Record<CameraKeyPreset, CameraKeyBindings>> = {
  rightHand: {
    panForward: ['KeyW', 'ArrowUp'],
    panBack: ['KeyS', 'ArrowDown'],
    panLeft: ['KeyA', 'ArrowLeft'],
    panRight: ['KeyD', 'ArrowRight'],
    rotateLeft: ['KeyQ', 'Delete'],
    rotateRight: ['KeyE', 'PageDown'],
    tiltUp: ['KeyT', 'Home'],
    tiltDown: ['KeyG', 'End'],
    zoomIn: ['KeyR', 'Equal'],
    zoomOut: ['KeyF', 'Minus'],
  },
  leftHand: {
    panForward: ['KeyI', 'Numpad8'],
    panBack: ['KeyK', 'Numpad5'],
    panLeft: ['KeyJ', 'Numpad4'],
    panRight: ['KeyL', 'Numpad6'],
    rotateLeft: ['KeyU', 'Numpad7'],
    rotateRight: ['KeyO', 'Numpad9'],
    tiltUp: ['KeyP', 'NumpadDivide'],
    tiltDown: ['Semicolon', 'NumpadMultiply'],
    zoomIn: ['KeyY', 'NumpadAdd'],
    zoomOut: ['KeyH', 'NumpadSubtract'],
  },
};

export const DEFAULT_CAMERA_KEY_PRESET: CameraKeyPreset = 'rightHand';

const STORAGE_KEY = 'terrace.cameraKeys.v1';

const isSlot = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && !RESERVED_KEY_CODES.includes(value));

function loadCameraKeys(): CameraKeyBindings {
  const fallback = CAMERA_KEY_PRESETS[DEFAULT_CAMERA_KEY_PRESET];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    // Invalid rows fall back individually; a duplicated code then keeps its first owner.
    const seen = new Set<string>();
    const out = {} as Record<CameraKeyAction, CameraKeySlots>;
    for (const action of CAMERA_KEY_ACTIONS) {
      const row = record[action];
      const slots: CameraKeySlots =
        Array.isArray(row) && row.length === 2 && isSlot(row[0]) && isSlot(row[1])
          ? [row[0], row[1]]
          : fallback[action];
      const keep = (code: string | null): string | null => {
        if (code === null || seen.has(code)) return null;
        seen.add(code);
        return code;
      };
      out[action] = [keep(slots[0]), keep(slots[1])];
    }
    return out;
  } catch {
    return fallback;
  }
}

const [cameraKeys, setCameraKeysSignal] = createSignal<CameraKeyBindings>(loadCameraKeys());

export { cameraKeys };

function store(next: CameraKeyBindings): void {
  setCameraKeysSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
  }
}

/**
 * Binds `code` to one slot. A code drives at most one action, so any other
 * slot holding it is cleared. Reserved codes are refused.
 */
export function setCameraKey(
  action: CameraKeyAction,
  slot: CameraKeySlot,
  code: string | null,
): void {
  if (code !== null && RESERVED_KEY_CODES.includes(code)) return;
  const current = cameraKeys();
  const next = {} as Record<CameraKeyAction, CameraKeySlots>;
  for (const a of CAMERA_KEY_ACTIONS) {
    const [first, second] = current[a];
    next[a] = [first === code ? null : first, second === code ? null : second];
  }
  const row = next[action];
  next[action] = slot === 0 ? [code, row[1]] : [row[0], code];
  store(next);
}

export function applyCameraKeyPreset(preset: CameraKeyPreset): void {
  store(CAMERA_KEY_PRESETS[preset]);
}

export function resetCameraKeyPrefs(): void {
  setCameraKeysSignal(CAMERA_KEY_PRESETS[DEFAULT_CAMERA_KEY_PRESET]);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

export function cameraKeyAction(code: string): CameraKeyAction | null {
  const bindings = cameraKeys();
  for (const action of CAMERA_KEY_ACTIONS) {
    const [first, second] = bindings[action];
    if (first === code || second === code) return action;
  }
  return null;
}
