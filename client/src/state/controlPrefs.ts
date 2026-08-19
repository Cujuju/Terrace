// User-configurable control bindings.
//
// One model serves both input owners: the sculpt brush (input/sculptInput.ts)
// and the camera (input/cameraBindings.ts wrapping OrbitControls). Each of the
// four actions — raise, lower, orbit, pan — is bound to a mouse button plus an
// optional modifier key. A single resolver (`resolvePress`) decides which
// action owns a given press, so the brush and the camera can never both claim
// the same drag: whoever the resolver names acts, everyone else stands down.
//
// Persistence is localStorage, per browser, versioned key. Bindings are
// presentation/input state, so they deliberately live client-side only —
// nothing here is sent to the server.
//
// Signals live at module scope for the same reason as hudState.ts: the
// imperative input layer reads them outside any reactive root, and Solid
// components must call the exported accessor at point of use.

import { createSignal } from 'solid-js';

export type MouseButtonName = 'left' | 'middle' | 'right';
/** 'none' means "no modifier held"; a binding never matches a chord of two. */
export type BindingModifier = 'none' | 'shift' | 'ctrl' | 'alt';

export type SculptAction = 'raise' | 'lower';
export type CameraAction = 'orbit' | 'pan';
export type ControlAction = SculptAction | CameraAction;

export interface ControlBinding {
  readonly button: MouseButtonName;
  readonly modifier: BindingModifier;
}

export type ControlBindings = Readonly<Record<ControlAction, ControlBinding>>;

/**
 * When two actions are given the identical binding, the earlier action in
 * this list wins every press and the later one is unreachable (the HUD warns
 * about this). Sculpt precedes camera because a sculpt press that silently
 * turned into a camera drag would edit nothing and confuse; a camera press
 * that sculpts instead is at least visibly wrong and immediately fixable.
 */
export const ACTION_PRECEDENCE: readonly ControlAction[] = [
  'raise',
  'lower',
  'orbit',
  'pan',
];

/** The Phase 1 scheme, unchanged: left sculpts, shift lowers, right orbits. */
export const DEFAULT_BINDINGS: ControlBindings = {
  raise: { button: 'left', modifier: 'none' },
  lower: { button: 'left', modifier: 'shift' },
  orbit: { button: 'right', modifier: 'none' },
  pan: { button: 'middle', modifier: 'none' },
};

const STORAGE_KEY = 'terrace.controlBindings.v1';

const BUTTON_NAMES: readonly MouseButtonName[] = ['left', 'middle', 'right'];
const MODIFIER_NAMES: readonly BindingModifier[] = [
  'none',
  'shift',
  'ctrl',
  'alt',
];

/** `PointerEvent.button` → binding button name (0 left, 1 middle, 2 right). */
export function buttonName(eventButton: number): MouseButtonName | null {
  switch (eventButton) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return null;
  }
}

export interface ModifierState {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * Collapses the modifier keys of an event to a single binding modifier.
 * Exactly one held → that modifier; none held → 'none'; a chord of two or
 * more → null, which matches no binding at all (deliberate: chords are
 * reserved, so adding a second modifier always cancels rather than surprises).
 * The meta/Windows key is ignored entirely — the OS owns it.
 */
export function modifierOf(mods: ModifierState): BindingModifier | null {
  const held = [mods.shiftKey, mods.ctrlKey, mods.altKey].filter(Boolean).length;
  if (held === 0) return 'none';
  if (held > 1) return null;
  if (mods.shiftKey) return 'shift';
  if (mods.ctrlKey) return 'ctrl';
  return 'alt';
}

function isBinding(value: unknown): value is ControlBinding {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as { button?: unknown; modifier?: unknown };
  return (
    BUTTON_NAMES.includes(b.button as MouseButtonName) &&
    MODIFIER_NAMES.includes(b.modifier as BindingModifier)
  );
}

/** Reads stored bindings; any malformed or partial value falls back whole. */
function loadBindings(): ControlBindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_BINDINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BINDINGS;
    const record = parsed as Record<string, unknown>;
    const all = ACTION_PRECEDENCE.every((action) => isBinding(record[action]));
    if (!all) return DEFAULT_BINDINGS;
    return {
      raise: record['raise'] as ControlBinding,
      lower: record['lower'] as ControlBinding,
      orbit: record['orbit'] as ControlBinding,
      pan: record['pan'] as ControlBinding,
    };
  } catch {
    // Storage unavailable (private mode, disabled) — session-only defaults.
    return DEFAULT_BINDINGS;
  }
}

const [controlBindings, setControlBindingsSignal] =
  createSignal<ControlBindings>(loadBindings());

export { controlBindings };

export function setBinding(
  action: ControlAction,
  binding: ControlBinding,
): void {
  const next: ControlBindings = { ...controlBindings(), [action]: binding };
  setControlBindingsSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best effort; the in-memory bindings still apply for this session.
  }
}

/** Resets every control preference — one button, whole scheme. */
export function resetBindings(): void {
  setControlBindingsSignal(DEFAULT_BINDINGS);
  setTwoFingerGestureSignal(DEFAULT_TWO_FINGER_GESTURE);
  setWheelBehaviourSignal(DEFAULT_WHEEL_BEHAVIOUR);
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TOUCH_STORAGE_KEY);
    localStorage.removeItem(WHEEL_STORAGE_KEY);
  } catch {
    // Ignore, as above.
  }
}

// ---------------------------------------------------------------------------
// Touch
//
// Touch has no buttons or modifiers, so it gets its own tiny scheme instead of
// the binding table: one finger always sculpts (direction = the HUD's sticky
// raise/lower mode), and the two-finger gesture always pinch-zooms while its
// drag component is configurable — pan (default, the Populous/Godus "move the
// map" instinct) or orbit.
// ---------------------------------------------------------------------------

export type TwoFingerGesture = 'pan' | 'orbit';

export const DEFAULT_TWO_FINGER_GESTURE: TwoFingerGesture = 'pan';

const TOUCH_STORAGE_KEY = 'terrace.touchControls.v1';

function loadTwoFingerGesture(): TwoFingerGesture {
  try {
    const raw = localStorage.getItem(TOUCH_STORAGE_KEY);
    if (raw === null) return DEFAULT_TWO_FINGER_GESTURE;
    const parsed: unknown = JSON.parse(raw);
    const g = (parsed as { twoFinger?: unknown } | null)?.twoFinger;
    return g === 'pan' || g === 'orbit' ? g : DEFAULT_TWO_FINGER_GESTURE;
  } catch {
    return DEFAULT_TWO_FINGER_GESTURE;
  }
}

const [twoFingerGesture, setTwoFingerGestureSignal] =
  createSignal<TwoFingerGesture>(loadTwoFingerGesture());

export { twoFingerGesture };

export function setTwoFingerGesture(gesture: TwoFingerGesture): void {
  setTwoFingerGestureSignal(gesture);
  try {
    localStorage.setItem(TOUCH_STORAGE_KEY, JSON.stringify({ twoFinger: gesture }));
  } catch {
    // Best effort; the in-memory setting still applies for this session.
  }
}

// ---------------------------------------------------------------------------
// Wheel
//
// What a scroll does, pinches aside: 'zoom' (default — owner decision
// 2026-08-19, issue #24) hands non-pinch wheels to OrbitControls' damped
// dolly, the reflex a mouse wheel trains. 'pan' translates the map instead,
// which is what a trackpad's two-finger scroll wants — dollying on it made
// the camera lurch — so laptop users flip this once in the Controls panel.
// The stored preference always wins over the default, so nobody who already
// chose a behaviour is moved by this change.
//
// A pinch always zooms in both modes: it is reported separately (ctrlKey, or
// Safari's gesture events) and needs no heuristic to recognise, so it is never
// in question.
// ---------------------------------------------------------------------------

export type WheelBehaviour = 'pan' | 'zoom';

export const DEFAULT_WHEEL_BEHAVIOUR: WheelBehaviour = 'zoom';

const WHEEL_STORAGE_KEY = 'terrace.wheelControls.v1';

function loadWheelBehaviour(): WheelBehaviour {
  try {
    const raw = localStorage.getItem(WHEEL_STORAGE_KEY);
    if (raw === null) return DEFAULT_WHEEL_BEHAVIOUR;
    const parsed: unknown = JSON.parse(raw);
    const b = (parsed as { wheel?: unknown } | null)?.wheel;
    return b === 'pan' || b === 'zoom' ? b : DEFAULT_WHEEL_BEHAVIOUR;
  } catch {
    return DEFAULT_WHEEL_BEHAVIOUR;
  }
}

const [wheelBehaviour, setWheelBehaviourSignal] = createSignal<WheelBehaviour>(
  loadWheelBehaviour(),
);

export { wheelBehaviour };

export function setWheelBehaviour(behaviour: WheelBehaviour): void {
  setWheelBehaviourSignal(behaviour);
  try {
    localStorage.setItem(WHEEL_STORAGE_KEY, JSON.stringify({ wheel: behaviour }));
  } catch {
    // Best effort; the in-memory setting still applies for this session.
  }
}

/**
 * The one authority on "who owns this press": returns the highest-precedence
 * action whose binding matches the pressed button and the exact modifier
 * state, or null when nothing matches (the press is inert).
 */
export function resolvePress(
  eventButton: number,
  mods: ModifierState,
): ControlAction | null {
  const button = buttonName(eventButton);
  const modifier = modifierOf(mods);
  if (button === null || modifier === null) return null;
  const bindings = controlBindings();
  for (const action of ACTION_PRECEDENCE) {
    const b = bindings[action];
    if (b.button === button && b.modifier === modifier) return action;
  }
  return null;
}

/**
 * Actions hidden by an identical earlier binding (see ACTION_PRECEDENCE).
 * The HUD uses this to warn; resolution itself needs no special case.
 */
export function shadowedActions(bindings: ControlBindings): ControlAction[] {
  const seen = new Map<string, ControlAction>();
  const shadowed: ControlAction[] = [];
  for (const action of ACTION_PRECEDENCE) {
    const b = bindings[action];
    const key = `${b.button}+${b.modifier}`;
    if (seen.has(key)) shadowed.push(action);
    else seen.set(key, action);
  }
  return shadowed;
}
