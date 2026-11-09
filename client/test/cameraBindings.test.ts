import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOUSE, PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bindCameraControls } from '../src/input/cameraBindings.ts';
import { controlBindings, setBinding } from '../src/state/controlPrefs.ts';

const original = structuredClone(controlBindings());
afterEach(() => { setBinding('orbit', original.orbit); setBinding('pan', original.pan); vi.unstubAllGlobals(); });

describe('configured camera verbs through native OrbitControls (#542)', () => {
  for (const modifier of ['shift', 'ctrl', 'none'] as const) {
    for (const verb of ['orbit', 'pan'] as const) {
      it(`${modifier}+right remains ${verb}`, () => {
        setBinding('orbit', { button: 'right', modifier: verb === 'orbit' ? modifier : 'alt' });
        setBinding('pan', { button: 'right', modifier: verb === 'pan' ? modifier : 'alt' });
        const listeners = new Map<string, EventListener>();
        const doc = { addEventListener: () => {}, removeEventListener: () => {} };
        vi.stubGlobal('window', doc);
        vi.stubGlobal('document', doc);
        const canvas = {
          ownerDocument: doc,
          addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
          removeEventListener: () => {},
        } as unknown as HTMLCanvasElement;
        const controls = new OrbitControls(new PerspectiveCamera());
        const binding = bindCameraControls(canvas, controls);
        const event = { button: 2, shiftKey: modifier === 'shift', ctrlKey: modifier === 'ctrl',
          altKey: false, metaKey: false, clientX: 10, clientY: 10 };
        listeners.get('pointerdown')!(event as unknown as Event);
        // Native _onMouseDown provides an independent check of the effective verb.
        const native = controls as unknown as { _onMouseDown(event: object): void; state: number };
        native._onMouseDown(event);
        const expected = new OrbitControls(new PerspectiveCamera());
        expected.mouseButtons.RIGHT = verb === 'orbit' ? MOUSE.ROTATE : MOUSE.PAN;
        const nativeExpected = expected as unknown as typeof native;
        nativeExpected._onMouseDown({ ...event, shiftKey: false, ctrlKey: false });
        expect(native.state).toBe(nativeExpected.state);
        binding.dispose();
      });
    }
  }
});
