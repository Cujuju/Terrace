// Contract tests for the control-binding resolver (state/controlPrefs.ts):
// resolvePress is the single authority on "who owns this press" for BOTH the
// sculpt brush and the camera, so its precedence and modifier semantics are
// the contract under test — not the UI that edits the bindings.
//
// The module holds signals and touches localStorage at import time, so every
// test imports a fresh copy via vi.resetModules() against its own storage
// stub. The node environment has no localStorage at all; the module must
// degrade to defaults in that case too (last test).

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Prefs = typeof import('../src/state/controlPrefs.ts');

/** Minimal in-memory localStorage; installed before each fresh import. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const BINDINGS_KEY = 'terrace.controlBindings.v1';
const TOUCH_KEY = 'terrace.touchControls.v1';
const WHEEL_KEY = 'terrace.wheelControls.v1';

async function freshPrefs(initial?: Record<string, string>): Promise<{
  prefs: Prefs;
  storage: Storage;
}> {
  vi.resetModules();
  const storage = fakeStorage(initial);
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  const prefs = await import('../src/state/controlPrefs.ts');
  return { prefs, storage };
}

const NO_MODS = { shiftKey: false, ctrlKey: false, altKey: false };
const SHIFT = { shiftKey: true, ctrlKey: false, altKey: false };
const CTRL = { shiftKey: false, ctrlKey: true, altKey: false };

beforeEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('modifierOf', () => {
  it('maps no keys to none and a single key to itself', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.modifierOf(NO_MODS)).toBe('none');
    expect(prefs.modifierOf(SHIFT)).toBe('shift');
    expect(prefs.modifierOf(CTRL)).toBe('ctrl');
    expect(prefs.modifierOf({ shiftKey: false, ctrlKey: false, altKey: true })).toBe('alt');
  });

  it('treats a chord of two or more modifiers as matching nothing', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.modifierOf({ shiftKey: true, ctrlKey: true, altKey: false })).toBeNull();
    expect(prefs.modifierOf({ shiftKey: true, ctrlKey: true, altKey: true })).toBeNull();
  });
});

describe('buttonName', () => {
  it('maps the three standard buttons and rejects everything else', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.buttonName(0)).toBe('left');
    expect(prefs.buttonName(1)).toBe('middle');
    expect(prefs.buttonName(2)).toBe('right');
    expect(prefs.buttonName(3)).toBeNull(); // browser back button
    expect(prefs.buttonName(-1)).toBeNull();
  });
});

describe('resolvePress with default bindings', () => {
  it('resolves the Phase 1 scheme exactly', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.resolvePress(0, NO_MODS)).toBe('raise');
    expect(prefs.resolvePress(0, SHIFT)).toBe('lower');
    expect(prefs.resolvePress(2, NO_MODS)).toBe('orbit');
    expect(prefs.resolvePress(1, NO_MODS)).toBe('pan');
  });

  it('returns null for unbound combinations — the press must be inert', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.resolvePress(2, SHIFT)).toBeNull();
    expect(prefs.resolvePress(0, CTRL)).toBeNull();
    expect(prefs.resolvePress(0, { shiftKey: true, ctrlKey: true, altKey: false })).toBeNull();
    expect(prefs.resolvePress(4, NO_MODS)).toBeNull();
  });
});

describe('rebinding and precedence', () => {
  it('a rebound action resolves on its new binding and not its old one', async () => {
    const { prefs } = await freshPrefs();
    prefs.setBinding('orbit', { button: 'left', modifier: 'ctrl' });
    expect(prefs.resolvePress(0, CTRL)).toBe('orbit');
    expect(prefs.resolvePress(2, NO_MODS)).toBeNull(); // right button now unbound
  });

  it('on a duplicate binding the earlier action in ACTION_PRECEDENCE wins', async () => {
    const { prefs } = await freshPrefs();
    prefs.setBinding('orbit', { button: 'left', modifier: 'none' }); // same as raise
    expect(prefs.resolvePress(0, NO_MODS)).toBe('raise');
    expect(prefs.shadowedActions(prefs.controlBindings())).toEqual(['orbit']);
  });

  it('reports no shadowed actions for the defaults', async () => {
    const { prefs } = await freshPrefs();
    expect(prefs.shadowedActions(prefs.DEFAULT_BINDINGS)).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips bindings, the touch gesture and wheel behaviour through storage', async () => {
    const first = await freshPrefs();
    first.prefs.setBinding('raise', { button: 'right', modifier: 'none' });
    first.prefs.setTwoFingerGesture('orbit');
    first.prefs.setWheelBehaviour('pan');

    // Same storage, fresh module: what a page reload sees.
    vi.resetModules();
    (globalThis as { localStorage?: Storage }).localStorage = first.storage;
    const second: Prefs = await import('../src/state/controlPrefs.ts');
    expect(second.controlBindings().raise).toEqual({ button: 'right', modifier: 'none' });
    expect(second.twoFingerGesture()).toBe('orbit');
    expect(second.wheelBehaviour()).toBe('pan');
  });

  it('defaults wheel behaviour to auto and keeps its own storage key', async () => {
    const { prefs, storage } = await freshPrefs();
    expect(prefs.wheelBehaviour()).toBe('auto');
    expect(prefs.DEFAULT_WHEEL_BEHAVIOUR).toBe('auto');
    // Editing one preference must not disturb the other two.
    prefs.setWheelBehaviour('zoom');
    expect(storage.getItem(WHEEL_KEY)).toBe(JSON.stringify({ wheel: 'zoom' }));
    expect(storage.getItem(BINDINGS_KEY)).toBeNull();
    expect(storage.getItem(TOUCH_KEY)).toBeNull();
  });

  it('falls back to auto on a corrupt or unknown stored wheel behaviour', async () => {
    for (const bad of [
      'not json',
      '42',
      'null',
      '{}',
      JSON.stringify({ wheel: 'dolly' }), // not one of the three modes
      JSON.stringify({ wheel: 7 }),
    ]) {
      const { prefs } = await freshPrefs({ [WHEEL_KEY]: bad });
      expect(prefs.wheelBehaviour()).toBe('auto');
    }
  });

  it('falls back whole to defaults on malformed or partial stored data', async () => {
    for (const bad of [
      'not json',
      '42',
      '{}',
      JSON.stringify({ raise: { button: 'left', modifier: 'none' } }), // partial
      JSON.stringify({
        raise: { button: 'left', modifier: 'none' },
        lower: { button: 'left', modifier: 'shift' },
        orbit: { button: 'trackball', modifier: 'none' }, // bad button
        pan: { button: 'middle', modifier: 'none' },
      }),
    ]) {
      const { prefs } = await freshPrefs({ [BINDINGS_KEY]: bad });
      expect(prefs.controlBindings()).toEqual(prefs.DEFAULT_BINDINGS);
    }
  });

  it('falls back to the default touch gesture on a bad stored value', async () => {
    const { prefs } = await freshPrefs({ [TOUCH_KEY]: JSON.stringify({ twoFinger: 'spin' }) });
    expect(prefs.twoFingerGesture()).toBe('pan');
  });

  it('reset restores defaults for mouse, touch AND wheel and clears storage', async () => {
    const { prefs, storage } = await freshPrefs();
    prefs.setBinding('pan', { button: 'right', modifier: 'alt' });
    prefs.setTwoFingerGesture('orbit');
    prefs.setWheelBehaviour('zoom');
    prefs.resetBindings();
    expect(prefs.controlBindings()).toEqual(prefs.DEFAULT_BINDINGS);
    expect(prefs.twoFingerGesture()).toBe('pan');
    expect(prefs.wheelBehaviour()).toBe('auto');
    expect(storage.getItem(BINDINGS_KEY)).toBeNull();
    expect(storage.getItem(TOUCH_KEY)).toBeNull();
    expect(storage.getItem(WHEEL_KEY)).toBeNull();
  });
});

describe('no localStorage at all', () => {
  it('still works with in-memory defaults (private mode, node)', async () => {
    vi.resetModules();
    // beforeEach already deleted the stub; import with nothing installed.
    const prefs: Prefs = await import('../src/state/controlPrefs.ts');
    expect(prefs.controlBindings()).toEqual(prefs.DEFAULT_BINDINGS);
    expect(prefs.wheelBehaviour()).toBe('auto');
    prefs.setBinding('raise', { button: 'middle', modifier: 'none' });
    expect(prefs.resolvePress(1, NO_MODS)).toBe('raise');
    // Setting a preference with no storage at all must not throw.
    prefs.setWheelBehaviour('pan');
    expect(prefs.wheelBehaviour()).toBe('pan');
  });
});
