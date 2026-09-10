import { createSignal } from 'solid-js';
import { resetFrameRatePrefs } from './frameRatePrefs.ts';
import { resetFrontierMistPrefs } from './frontierMistPrefs.ts';
import { resetLayerEdgePrefs } from './layerEdgePrefs.ts';
import { resetVoidPrefs } from './voidPrefs.ts';

export type MouseButtonName = 'left' | 'middle' | 'right';
export type BindingModifier = 'none' | 'shift' | 'ctrl' | 'alt';

export type SculptAction = 'raise' | 'lower';
export type CameraAction = 'orbit' | 'pan';
export type ControlAction = SculptAction | CameraAction;

export interface ControlBinding {
  readonly button: MouseButtonName;
  readonly modifier: BindingModifier;
}

export type ControlBindings = Readonly<Record<ControlAction, ControlBinding>>;

export const ACTION_PRECEDENCE: readonly ControlAction[] = [
  'raise',
  'lower',
  'orbit',
  'pan',
];

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
  }
}

export function resetBindings(): void {
  setControlBindingsSignal(DEFAULT_BINDINGS);
  setTwoFingerGestureSignal(DEFAULT_TWO_FINGER_GESTURE);
  setWheelBehaviourSignal(DEFAULT_WHEEL_BEHAVIOUR);
  resetVoidPrefs();
  resetFrontierMistPrefs();
  resetLayerEdgePrefs();
  resetFrameRatePrefs();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TOUCH_STORAGE_KEY);
    localStorage.removeItem(WHEEL_STORAGE_KEY);
  } catch {
  }
}

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
  }
}

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
  }
}

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
