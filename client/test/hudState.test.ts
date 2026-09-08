import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BRUSH_RADIUS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
} from '@terrace/shared';

const DEFAULT_RADIUS = WORLD_UNIT_CELLS;

const LADDER = [1, 2, 3, 4, 5, 6, 7, 8];

const TOP_RADIUS = 8;

const DEFAULT_PROFILE = 'hard';

type HudState = typeof import('../src/state/hudState.ts');

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

const HUD_KEY = 'terrace.hudState.v2';

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

async function reload(storage: Storage): Promise<HudState> {
  vi.resetModules();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  return await import('../src/state/hudState.ts');
}

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
    expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.brushProfile()).toBe(DEFAULT_PROFILE);
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    expect(storage.getItem(HUD_KEY)).toBeNull();
  });

  it('exposes the same defaults it falls back to', async () => {
    const { hud } = await freshHud();
    expect(hud.DEFAULT_HUD_STATE).toEqual({
      brushRadius: DEFAULT_RADIUS,
      brushTool: WIRE_DEFAULT_SCULPT_OPTIONS.tool,
      brushProfile: DEFAULT_PROFILE,
      sculptMode: 'raise',
      showControls: false,
      panelOpen: true,
    });
  });
});

describe('round-trip through storage', () => {
  it('restores every field at once after a reload', async () => {
    const first = await freshHud();
    first.hud.setBrushRadius(TOP_RADIUS);
    first.hud.setBrushTool('smooth');
    first.hud.setBrushProfile('hard');
    first.hud.setSculptMode('lower');
    first.hud.setShowControls(true);

    const second = await reload(first.storage);
    expect(second.brushRadius()).toBe(TOP_RADIUS);
    expect(second.brushTool()).toBe('smooth');
    expect(second.brushProfile()).toBe('hard');
    expect(second.sculptMode()).toBe('lower');
    expect(second.showControls()).toBe(true);
  });

  it('round-trips every selectable radius', async () => {
    for (const radius of LADDER) {
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
      first.hud.setShowControls(true);
      first.hud.setShowControls(open);
      const second = await reload(first.storage);
      expect(second.showControls()).toBe(open);
    }
  });

  it('round-trips the whole tools panel in both states', async () => {
    for (const open of [true, false]) {
      const first = await freshHud();
      first.hud.setPanelOpen(!open);
      first.hud.setPanelOpen(open);
      const second = await reload(first.storage);
      expect(second.panelOpen()).toBe(open);
    }
  });
});

describe('write-through', () => {
  it('each setter writes the whole record under the one key', async () => {
    const { hud, storage } = await freshHud();
    hud.setBrushRadius(TOP_RADIUS);
    expect(storedState(storage)['brushRadius']).toBe(TOP_RADIUS);

    hud.setBrushTool('smooth');
    expect(storedState(storage)['brushTool']).toBe('smooth');
    expect(storedState(storage)['brushRadius']).toBe(TOP_RADIUS);

    hud.setBrushProfile('hard');
    hud.setSculptMode('lower');
    hud.setShowControls(true);
    expect(storedState(storage)).toEqual({
      brushRadius: TOP_RADIUS,
      brushTool: 'smooth',
      brushProfile: 'hard',
      sculptMode: 'lower',
      showControls: true,
      panelOpen: true,
    });
    expect(storage.length).toBe(1);
  });

  it('a setter called with the value it already has writes nothing', async () => {
    const { hud, storage } = await freshHud();
    let writes = 0;
    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      writes++;
      realSetItem(k, v);
    };

    hud.setSculptMode('raise');
    hud.setBrushRadius(DEFAULT_RADIUS);
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
      expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
      expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
      expect(hud.brushProfile()).toBe(DEFAULT_PROFILE);
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
      expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
      expect(hud.brushTool()).toBe('smooth');
      expect(hud.brushProfile()).toBe('hard');
      expect(hud.sculptMode()).toBe('lower');
      expect(hud.showControls()).toBe(true);
    }
  });

  it('an unknown tool or profile falls back to the wire default', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({
        brushRadius: TOP_RADIUS,
        brushTool: 'erode',
        brushProfile: 7,
        sculptMode: 'lower',
        showControls: true,
      }),
    });
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.brushProfile()).toBe(DEFAULT_PROFILE);
    expect(hud.brushRadius()).toBe(TOP_RADIUS);
    expect(hud.sculptMode()).toBe('lower');
  });

  it('an unknown sculpt mode or non-boolean panel flag falls back', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({
        brushRadius: TOP_RADIUS,
        sculptMode: 'flatten',
        showControls: 'yes',
      }),
    });
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    expect(hud.brushRadius()).toBe(TOP_RADIUS);
  });

  it('a payload missing fields restores the ones it has (older build)', async () => {
    const { hud } = await freshHud({
      [HUD_KEY]: JSON.stringify({ brushRadius: TOP_RADIUS }),
    });
    expect(hud.brushRadius()).toBe(TOP_RADIUS);
    expect(hud.brushTool()).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.tool);
    expect(hud.showControls()).toBe(false);
  });

  it('a stored radius the picker cannot offer falls back to the default', async () => {
    for (const offLadder of [9, 12, 15, MAX_BRUSH_RADIUS]) {
      const { hud } = await freshHud({
        [HUD_KEY]: JSON.stringify({ brushRadius: offLadder }),
      });
      expect(LADDER).not.toContain(offLadder);
      expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
    }
  });

  it('every rung of the ladder round-trips through storage', async () => {
    for (const rung of LADDER) {
      const { hud } = await freshHud({
        [HUD_KEY]: JSON.stringify({ brushRadius: rung }),
      });
      expect(hud.brushRadius()).toBe(rung);
    }
  });

  it('parseHudState is the whole contract, storage aside', async () => {
    const { hud } = await freshHud();
    expect(hud.parseHudState(null)).toEqual(hud.DEFAULT_HUD_STATE);
    expect(hud.parseHudState('{')).toEqual(hud.DEFAULT_HUD_STATE);
    expect(
      hud.parseHudState(
        JSON.stringify({
          brushRadius: TOP_RADIUS,
          brushTool: 'smooth',
          brushProfile: 'hard',
          sculptMode: 'lower',
          showControls: true,
        }),
      ),
    ).toEqual({
      brushRadius: TOP_RADIUS,
      brushTool: 'smooth',
      brushProfile: 'hard',
      sculptMode: 'lower',
      showControls: true,
      panelOpen: true,
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
    expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
    hud.setBrushRadius(TOP_RADIUS);
    expect(hud.brushRadius()).toBe(TOP_RADIUS);
  });
});

describe('no localStorage at all', () => {
  it('runs on in-memory defaults (private mode, node)', async () => {
    vi.resetModules();
    const hud: HudState = await import('../src/state/hudState.ts');
    expect(hud.brushRadius()).toBe(DEFAULT_RADIUS);
    expect(hud.sculptMode()).toBe('raise');
    expect(hud.showControls()).toBe(false);
    hud.setBrushRadius(TOP_RADIUS);
    hud.setBrushTool('smooth');
    hud.setSculptMode('lower');
    hud.setShowControls(true);
    expect(hud.brushRadius()).toBe(TOP_RADIUS);
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

describe('world identity', () => {
  it('starts unknown and takes what the snapshot stated', async () => {
    const { hud } = await freshHud();
    expect(hud.worldIdentity()).toEqual({ name: null, difficulty: null });

    hud.setWorldIdentity({ name: 'Gloamwatch Fells', difficulty: 37 });
    expect(hud.worldIdentity()).toEqual({ name: 'Gloamwatch Fells', difficulty: 37 });
  });

  it('treats a blank or unusable field as unknown rather than as a value', async () => {
    const { hud } = await freshHud();
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
