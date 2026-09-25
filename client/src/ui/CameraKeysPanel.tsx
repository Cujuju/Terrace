import { For, createSignal, onCleanup, type JSX } from 'solid-js';
import {
  CAMERA_KEY_ACTIONS,
  RESERVED_KEY_CODES,
  applyCameraKeyPreset,
  cameraKeys,
  setCameraKey,
  type CameraKeyAction,
  type CameraKeySlot,
} from '../state/cameraKeyPrefs.ts';

const ACTION_LABEL: Record<CameraKeyAction, string> = {
  panForward: 'Pan forward',
  panBack: 'Pan back',
  panLeft: 'Pan left',
  panRight: 'Pan right',
  rotateLeft: 'Rotate left',
  rotateRight: 'Rotate right',
  tiltUp: 'Tilt up',
  tiltDown: 'Tilt down',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
};

const SLOTS: readonly CameraKeySlot[] = [0, 1];
const SLOT_NAME: Record<CameraKeySlot, string> = { 0: 'primary', 1: 'alternate' };

const CLEAR_KEY_CODE = 'Backspace';
const CANCEL_KEY_CODE = 'Escape';
/** Modifiers carry the sculpt chords, so they never drive the camera. */
const MODIFIER_KEYS: readonly string[] = ['Shift', 'Control', 'Alt', 'Meta'];

const NAMED_KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Equal: '=',
  Minus: '-',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Del',
  Insert: 'Ins',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
};

/** A physical key code as the key it names on a US layout. */
function keyLabel(code: string | null): string {
  if (code === null) return '—';
  const named = NAMED_KEY_LABEL[code];
  if (named !== undefined) return named;
  if (code.startsWith('Key')) return code.slice('Key'.length);
  if (code.startsWith('Digit')) return code.slice('Digit'.length);
  if (code.startsWith('Numpad')) return `Num ${code.slice('Numpad'.length)}`;
  return code;
}

interface Armed {
  readonly action: CameraKeyAction;
  readonly slot: CameraKeySlot;
}

export function CameraKeysPanel(): JSX.Element {
  const [armed, setArmed] = createSignal<Armed | null>(null);

  // Window capture runs before the settings Escape handler and the key camera.
  const onKeyDownCapture = (event: KeyboardEvent): void => {
    const target = armed();
    if (target === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === CANCEL_KEY_CODE) {
      setArmed(null);
      return;
    }
    if (RESERVED_KEY_CODES.includes(event.code) || MODIFIER_KEYS.includes(event.key)) return;
    setCameraKey(target.action, target.slot, event.code === CLEAR_KEY_CODE ? null : event.code);
    setArmed(null);
  };
  window.addEventListener('keydown', onKeyDownCapture, { capture: true });
  onCleanup(() => window.removeEventListener('keydown', onKeyDownCapture, { capture: true }));

  const isArmed = (action: CameraKeyAction, slot: CameraKeySlot): boolean => {
    const a = armed();
    return a !== null && a.action === action && a.slot === slot;
  };

  return (
    <div class="camera-keys-panel">
      <For each={CAMERA_KEY_ACTIONS}>
        {(action) => (
          <div class="hud-row controls-row">
            <span class="controls-label">{ACTION_LABEL[action]}</span>
            <For each={SLOTS}>
              {(slot) => (
                <button
                  type="button"
                  class="controls-select camera-key"
                  classList={{ 'camera-key-armed': isArmed(action, slot) }}
                  aria-label={`${ACTION_LABEL[action]}: ${SLOT_NAME[slot]} key`}
                  title="Click, then press a key. Backspace clears, Esc cancels."
                  onClick={() => setArmed(isArmed(action, slot) ? null : { action, slot })}
                >
                  {isArmed(action, slot) ? '…' : keyLabel(cameraKeys()[action][slot])}
                </button>
              )}
            </For>
          </div>
        )}
      </For>
      <div class="hud-row controls-row">
        <span class="controls-label">Key layout</span>
        <button
          type="button"
          class="controls-reset"
          title="WASD pans, Q/E rotate, R/F zoom, T/G tilt; arrows and nav keys as alternates"
          onClick={() => applyCameraKeyPreset('rightHand')}
        >
          Right hand
        </button>
        <button
          type="button"
          class="controls-reset"
          title="IJKL pans, U/O rotate, Y/H zoom, P/; tilt; numpad as alternates"
          onClick={() => applyCameraKeyPreset('leftHand')}
        >
          Left hand
        </button>
      </div>
    </div>
  );
}
