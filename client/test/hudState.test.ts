// Contract tests for HUD-state persistence (state/hudState.ts): every choice
// the player makes in the HUD must come back after a reload, and no stored
// value — however mangled — may be able to leave the HUD in a state it has no
// button for (a radius with no picker entry, a tool the server would reject).
//
// The module holds signals and touches localStorage at import time, so every
// test imports a fresh copy via vi.resetModules() against its own storage stub
// — the same idiom as controlPrefs.test.ts, and the only way to exercise "what
// a page reload sees". The node environment has no localStorage at all; the
// module must degrade to defaults there too (last describe).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
} from '@terrace/shared';

type HudState = typeof import('../src/state/hudState.ts');

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

const HUD_KEY = 'terrace.hudState.v1';

async function freshHud(initial?: Record<string, string>): Promise<{
  hud: HudState;
  storage: Storage;
}> {
  vi.resetModules();
  const storage = fakeStorage(initial);
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  const hud = await import('../src/state/hudState.ts');
  return { hud, storage };
}

/** Re-imports the module against the same storage: what a reload sees. */
async function reload(storage: Storage): Promise<HudState> {
  vi.resetModules();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  return await import('../src/state/hudState.ts');
}

/** The stored payload, parsed — for asserting on what write-through wrote. */
function storedState(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(HUD_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

beforeEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('defaults', () => {
  it('starts on the wire defaults with nothing stored', async () => {
    const { hud, storage } = await freshHud();
    expect(hud.brushRadius()).toBe(MIN_BRUSH_RADIUS);
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.brushProfile()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.profile);
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    // Reading defaults must not write anything: an untouched HUD leaves no
    // entry behind, so a later schema version has nothing stale to trip on.
    expect(storage.getItem(HUD_KEY)).toBeNull();
  });

  it('exposes the same defaults it falls back to', async () => {
    const { hud } = await freshHud();
    expect(hud.DEFAULT_HUD_STATE).toEqual({
      brushRadius: MIN_BRUSH_RADIUS,
      brushTool: WIRE_DEFAULT_SCULPT_OPTIONS.tool,
      brushProfile: WIRE_DEFAULT_SCULPT_OPTIONS.profile,
      sculptMode: 'raise',
      showControls: false,
    });
  });
});

describe('round-trip through storage', () => {
  it('restores every field at once after a reload', async () => {
    const first = await freshHud();
    first.hud.setBrushRadius(MAX_BRUSH_RADIUS);
    first.hud.setBrushTool('smooth');
    first.hud.setBrushProfile('hard');
    first.hud.setSculptMode('lower');
    first.hud.setShowControls(true);

    const second = await reload(first.storage);
    expect(second.brushRadius()).toBe(MAX_BRUSH_RADIUS);
    expect(second.brushTool()).toBe('smooth');
    expect(second.brushProfile()).toBe('hard');
    expect(second.sculptMode()).toBe('lower');
    expect(second.showControls()).toBe(true);
  });

  it('round-trips every selectable radius', async () => {
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      const first = await freshHud();
      first.hud.setBrushRadius(radius);
      const second = await reload(first.storage);
      expect(second.brushRadius()).toBe(radius);
    }
  });

  it('round-trips both tools and both profiles', async () => {
    for (const tool of ['stamp', 'smooth'] as const) {
      for (const profile of ['soft', 'hard'] as const) {
        const first = await freshHud();
        first.hud.setBrushTool(tool);
        first.hud.setBrushProfile(profile);
        const second = await reload(first.storage);
        expect(second.brushTool()).toBe(tool);
        expect(second.brushProfile()).toBe(profile);
      }
    }
  });

  it('round-trips both sculpt modes', async () => {
    for (const mode of ['raise', 'lower'] as const) {
      const first = await freshHud();
      first.hud.setSculptMode(mode);
      const second = await reload(first.storage);
      expect(second.sculptMode()).toBe(mode);
    }
  });

  it('round-trips the Controls panel in both states', async () => {
    for (const open of [true, false]) {
      const first = await freshHud();
      // Toggle away from the default and back where needed, so the `false`
      // case proves a deliberate collapse is stored, not just never written.
      first.hud.setShowControls(true);
      first.hud.setShowControls(open);
      const second = await reload(first.storage);
      expect(second.showControls()).toBe(open);
    }
  });
});

describe('write-through', () => {
  it('each setter writes the whole record under the one key', async () => {
    const { hud, storage } = await freshHud();
    hud.setBrushRadius(MAX_BRUSH_RADIUS);
    expect(storedState(storage)['brushRadius']).toBe(MAX_BRUSH_RADIUS);

    hud.setBrushTool('smooth');
    expect(storedState(storage)['brushTool']).toBe('smooth');
    // The earlier field is still there — a later write must not drop it.
    expect(storedState(storage)['brushRadius']).toBe(MAX_BRUSH_RADIUS);

    hud.setBrushProfile('hard');
    hud.setSculptMode('lower');
    hud.setShowControls(true);
    expect(storedState(storage)).toEqual({
      brushRadius: MAX_BRUSH_RADIUS,
      brushTool: 'smooth',
      brushProfile: 'hard',
      sculptMode: 'lower',
      showControls: true,
    });
    // One entry, not five.
    expect(storage.length).toBe(1);
  });

  it('a setter called with the value it already has writes nothing', async () => {
    // Load-bearing for setSculptMode: sculptInput calls it on every emitted
    // intent (hold-repeat timer) and every modifier event, nearly always with
    // the current value. Without this guard that is a synchronous storage
    // write per sculpt tick.
    const { hud, storage } = await freshHud();
    let writes = 0;
    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      writes++;
      realSetItem(k, v);
    };

    hud.setSculptMode('raise'); // already 'raise'
    hud.setBrushRadius(MIN_BRUSH_RADIUS); // already the default
    hud.setShowControls(false);
    expect(writes).toBe(0);

    hud.setSculptMode('lower');
    expect(writes).toBe(1);
    hud.setSculptMode('lower');
    expect(writes).toBe(1);
  });
});

describe('fallback on corrupt storage', () => {
  it('falls back to all defaults on junk JSON or a non-object', async () => {
    for (const bad of ['not json', '42', 'null', '"stamp"', '[]']) {
      const { hud } = await freshHud({ [HUD_KEY]: bad });
      expect(hud.brushRadius()).toBe(MIN_BRUSH_RADIUS);
      expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
      expect(hud.brushProfile()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.profile);
      expect(hud.sculptMode()).toBe('raise');
      expect(hud.showControls()).toBe(false);
    }
  });

  it('an out-of-range or non-integer radius falls back, keeping its neighbours', async () => {
    for (const bad of [99, 0, -1, 2.5, Number.NaN, '3', null]) {
      const { hud } = await freshHud({
        [HUD_KEY]: JSON.stringify({
          brushRadius: bad,
          brushTool: 'smooth',
          brushProfile: 'hard',
          sculptMode: 'lower',
          showControls: true,
        }),
      });
      expect(hud.brushRadius()).toBe(MIN_BRUSH_RADIUS);
      // Per-field fallback: one bad field costs exactly itself.
      expect(hud.brushTool()).toBe('smooth');
      expect(hud.brushProfile()).toBe('hard');
      expect(hud.sculptMode()).toBe('lower');
      expect(hud.showControls()).toBe(true);
    }
  });

  it('an unknown tool or profile falls back to the wire default', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({
        brushRadius: MAX_BRUSH_RADIUS,
        brushTool: 'erode', // never existed
        brushProfile: 7, // wrong type entirely
        sculptMode: 'lower',
        showControls: true,
      }),
    });
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.brushProfile()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.profile);
    expect(hud.brushRadius()).toBe(MAX_BRUSH_RADIUS);
    expect(hud.sculptMode()).toBe('lower');
  });

  it('an unknown sculpt mode or non-boolean panel flag falls back', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({
        brushRadius: MAX_BRUSH_RADIUS,
        sculptMode: 'flatten',
        showControls: 'yes',
      }),
    });
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    expect(hud.brushRadius()).toBe(MAX_BRUSH_RADIUS);
  });

  it('a payload missing fields restores the ones it has (older build)', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({ brushRadius: MAX_BRUSH_RADIUS }),
    });
    expect(hud.brushRadius()).toBe(MAX_BRUSH_RADIUS);
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.showControls()).toBe(false);
  });

  it('parseHudState is the whole contract, storage aside', async () => {
    const { hud } = await freshHud();
    expect(hud.parseHudState(null)).toEqual(hud.DEFAULT_HUD_STATE);
    expect(hud.parseHudState('{')).toEqual(hud.DEFAULT_HUD_STATE);
    expect(
      hud.parseHudState(
        JSON.stringify({
          brushRadius: MAX_BRUSH_RADIUS,
          brushTool: 'smooth',
          brushProfile: 'hard',
          sculptMode: 'lower',
          showControls: true,
        }),
      ),
    ).toEqual({
      brushRadius: MAX_BRUSH_RADIUS,
      brushTool: 'smooth',
      brushProfile: 'hard',
      sculptMode: 'lower',
      showControls: true,
    });
  });
});

describe('storage that throws', () => {
  it('survives a getItem that throws (blocked storage) and a full setItem', async () => {
    vi.resetModules();
    const hostile = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    (globalThis as { localStorage?: Storage }).localStorage = hostile;

    const hud: HudState = await import('../src/state/hudState.ts');
    expect(hud.brushRadius()).toBe(MIN_BRUSH_RADIUS);
    // A quota-exceeded write must not break the live HUD.
    hud.setBrushRadius(MAX_BRUSH_RADIUS);
    expect(hud.brushRadius()).toBe(MAX_BRUSH_RADIUS);
  });
});

describe('no localStorage at all', () => {
  it('runs on in-memory defaults (private mode, node)', async () => {
    vi.resetModules();
    // beforeEach already deleted the stub; import with nothing installed.
    const hud: HudState = await import('../src/state/hudState.ts');
    expect(hud.brushRadius()).toBe(MIN_BRUSH_RADIUS);
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    // Setting anything with no storage at all must not throw.
    hud.setBrushRadius(MAX_BRUSH_RADIUS);
    hud.setBrushTool('smooth');
    hud.setSculptMode('lower');
    hud.setShowControls(true);
    expect(hud.brushRadius()).toBe(MAX_BRUSH_RADIUS);
    expect(hud.brushTool()).toBe('smooth');
    expect(hud.sculptMode()).toBe('lower');
    expect(hud.showControls()).toBe(true);
  });
});

describe('sculptDirection', () => {
  it('maps the mode to the wire dir', async () => {
    const { hud } = await freshHud();
    expect(hud.sculptDirection('raise')).toBe(1);
    expect(hud.sculptDirection('lower')).toBe(-1);
  });
});

// World identity (name + difficulty) is SERVER-derived: it arrives on every
// join snapshot, so it is normalised at the setter and never persisted.
describe('world identity', () => {
  it('starts unknown and takes what the snapshot stated', async () => {
    const { hud } = await freshHud();
    expect(hud.worldIdentity()).toEqual({ name: null, difficulty: null });

    hud.setWorldIdentity({ name: 'Gloamwatch Fells', difficulty: 37 });
    expect(hud.worldIdentity()).toEqual({ name: 'Gloamwatch Fells', difficulty: 37 });
  });

  it('treats a blank or unusable field as unknown rather than as a value', async () => {
    const { hud } = await freshHud();
    // What an older server — which sends neither field — looks like once the
    // snapshot handler has mapped its undefineds to null.
    hud.setWorldIdentity({ name: null, difficulty: null });
    expect(hud.worldIdentity()).toEqual({ name: null, difficulty: null });

    hud.setWorldIdentity({ name: '   ', difficulty: Number.NaN });
    expect(hud.worldIdentity()).toEqual({ name: null, difficulty: null });
  });

  it('trims the name and rounds the rating — the HUD prints both verbatim', async () => {
    const { hud } = await freshHud();
    hud.setWorldIdentity({ name: ' Emberfall ', difficulty: 37.4 });
    expect(hud.worldIdentity()).toEqual({ name: 'Emberfall', difficulty: 37 });
  });

  it('is never written to storage', async () => {
    const { hud, storage } = await freshHud();
    hud.setWorldIdentity({ name: 'Emberfall', difficulty: 50 });
    expect(storage.getItem(HUD_KEY) ?? '').not.toContain('Emberfall');
  });
});
