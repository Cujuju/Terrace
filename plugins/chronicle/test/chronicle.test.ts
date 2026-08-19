// The chronicle, driven through the REAL plugin host. CONTRACT tests: each
// names a promise the plugin makes — what earns a line and what never does,
// determinism of names and text, the fog rule (no coordinates on the wire),
// day-scoped repeat suppression, world-firsts that survive a snapshot, the
// eviction cap, and the copied race derivation staying in lockstep with
// structures' via the same golden vectors structures pins.

import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import {
  CHRONICLE_MAX_ENTRIES,
  CHRONICLE_PLUGIN_NAME,
  parseEntries,
  type ChronicleEntry,
} from '../protocol.ts';
import { placeName } from '../server/names.ts';
import { settlementRace } from '../server/races.ts';
import {
  CHRONICLE_CALAMITY_MIN_HOMES,
  STRUCTURE_TIER_NAMES,
  parseStructuresChanges,
} from '../server/saga.ts';
import {
  CHRONICLE_SECONDS_PER_DAY,
  GENESIS_TEXT,
  chronicleEntries,
  plugin as chroniclePlugin,
  resetChronicleState,
} from '../server/index.ts';

const WORLD_SIZE = 128;
const DT = 0.1;
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

const LOG_TYPE = `${CHRONICLE_PLUGIN_NAME}:log`;
const APPEND_TYPE = `${CHRONICLE_PLUGIN_NAME}:append`;

interface Harness {
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function boot(restore?: unknown): Harness {
  resetChronicleState();
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [chroniclePlugin].map(asLoadedPlugin));
  if (restore !== undefined) host.restorePersistence({ [CHRONICLE_PLUGIN_NAME]: restore });
  host.worldCreate();
  return { host, sink };
}

/** Simulated days passing, at the shipped fixed tick. */
function advanceDays(harness: Harness, days: number): void {
  const seconds = days * CHRONICLE_SECONDS_PER_DAY;
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

/** All entry texts currently in the log. */
function texts(): string[] {
  return chronicleEntries().map((entry) => entry.text);
}

/** Cells inside chunk (cx, cy), offset by `i` along x. */
function cellIn(cx: number, cy: number, i = 0): { x: number; y: number } {
  return { x: cx * CHUNK_SIZE + i, y: cy * CHUNK_SIZE };
}

beforeEach(() => {
  resetChronicleState();
});

describe('genesis', () => {
  it('a fresh world opens its saga; a restored world does not repeat it', () => {
    boot();
    expect(texts()).toEqual([GENESIS_TEXT]);

    const restored = boot({
      v: 1,
      simMillis: 0,
      entries: [{ d: 0, t: GENESIS_TEXT }],
      tierFirsts: [],
      monsterKinds: [],
      toldDay: -1,
      toldToday: [],
    });
    expect(texts()).toEqual([GENESIS_TEXT]);
    expect(restored.sink.ofType(APPEND_TYPE)).toHaveLength(0);
  });
});

describe('structures events', () => {
  it('a seed placement is chronicled with its people and its place — once a day per place', () => {
    const harness = boot();
    const anchor = cellIn(2, 3);
    const race = settlementRace(anchor.x, anchor.y) === 'rudy' ? 'Rudy' : 'Uno';
    const payload = { cause: 'generation', seeded: [anchor], upgraded: [], died: [] };

    harness.host.notifyWorldEvent('structures:changes', payload);
    harness.host.notifyWorldEvent('structures:changes', payload); // same day: suppressed
    expect(texts()).toEqual([
      GENESIS_TEXT,
      `${race} settlers pitched a new camp at ${placeName(2, 3)}.`,
    ]);

    advanceDays(harness, 1);
    harness.host.notifyWorldEvent('structures:changes', payload); // next day: history again
    expect(texts()).toHaveLength(3);
  });

  it('the world’s first of each tier above camp is chronicled exactly once, in tier order', () => {
    const harness = boot();
    const where = cellIn(1, 1);
    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [],
      // Deliberately out of order, with a duplicate and a camp (tier 0).
      upgraded: [
        { ...where, tier: 2 },
        { ...cellIn(1, 1, 3), tier: 1 },
        { ...cellIn(1, 1, 5), tier: 2 },
        { ...cellIn(1, 1, 7), tier: 0 },
      ],
      died: [],
    });

    const sagaTexts = texts().slice(1);
    expect(sagaTexts).toHaveLength(2);
    expect(sagaTexts[0]).toContain(`world's first ${STRUCTURE_TIER_NAMES[1]}`);
    expect(sagaTexts[1]).toContain(`world's first ${STRUCTURE_TIER_NAMES[2]}`);

    // Once EVER: the same tiers again — even tomorrow — add nothing.
    advanceDays(harness, 1);
    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [],
      upgraded: [{ ...where, tier: 2 }],
      died: [],
    });
    expect(texts()).toHaveLength(3);
  });

  it('loss below the calamity threshold is routine churn; at it, a calamity — and a sculpt is a hand', () => {
    const harness = boot();
    const below = Array.from({ length: CHRONICLE_CALAMITY_MIN_HOMES - 1 }, (_, i) =>
      cellIn(0, 1, i),
    );
    harness.host.notifyWorldEvent('structures:changes', { cause: 'generation', died: below });
    expect(texts()).toEqual([GENESIS_TEXT]);

    const lost = Array.from({ length: CHRONICLE_CALAMITY_MIN_HOMES }, (_, i) => cellIn(0, 1, i));
    harness.host.notifyWorldEvent('structures:changes', { cause: 'generation', died: lost });
    expect(texts()[1]).toContain('Ruin took');
    expect(texts()[1]).toContain(placeName(0, 1));

    // The same place cannot be ruined twice in one day, but a HAND is its own story.
    harness.host.notifyWorldEvent('structures:changes', { cause: 'generation', died: lost });
    expect(texts()).toHaveLength(2);
    harness.host.notifyWorldEvent('structures:changes', { cause: 'sculpt', died: lost });
    expect(texts()[2]).toContain("The god's hand unmade");
  });

  it('a chunk group is one district, so one line is one people (contract with races.ts)', () => {
    // The claim the calamity line rests on: CHUNK_SIZE === district size.
    const lost = Array.from({ length: CHRONICLE_CALAMITY_MIN_HOMES }, (_, i) => cellIn(4, 4, i));
    const races = new Set(lost.map((cell) => settlementRace(cell.x, cell.y)));
    expect(races.size).toBe(1);
  });
});

describe('relic and monster events', () => {
  it('a collection is always saga; malformed payloads never are', () => {
    const harness = boot();
    harness.host.notifyWorldEvent('relics:collected', {
      label: "Titan's Hand",
      player: 'Cuju',
      x: 10,
      y: 12,
    });
    expect(texts()[1]).toBe("Cuju took up the Titan's Hand.");

    harness.host.notifyWorldEvent('relics:collected', { label: '', player: 'x', x: 0, y: 0 });
    harness.host.notifyWorldEvent('relics:collected', 'nonsense');
    harness.host.notifyWorldEvent('structures:changes', { cause: 'weather' });
    expect(texts()).toHaveLength(2);
  });

  it('the first of a kind is a world event; a return is not a first; a departure closes the tale', () => {
    const harness = boot();
    const shore = cellIn(3, 0);
    harness.host.notifyWorldEvent('monsters:arrived', { kind: 'yeti', ...shore });
    expect(texts()[1]).toBe(
      `The first yeti in all the world was seen near ${placeName(3, 0)}.`,
    );

    harness.host.notifyWorldEvent('monsters:departed', { kind: 'yeti', ...shore });
    expect(texts()[2]).toBe('The yeti was driven from the world.');

    advanceDays(harness, 1);
    harness.host.notifyWorldEvent('monsters:arrived', { kind: 'yeti', ...shore });
    expect(texts()[3]).toBe(`A yeti returned to the lands near ${placeName(3, 0)}.`);
  });
});

describe('the wire', () => {
  it('a joining player gets the whole scroll, alone; a new line is broadcast to everyone', () => {
    const harness = boot();
    harness.host.playerJoined(PLAYER);

    const logs = harness.sink.ofType(LOG_TYPE);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.target).toBe(PLAYER.id);
    expect(parseEntries(logs[0]?.payload)).toEqual([{ day: 0, text: GENESIS_TEXT }]);

    harness.host.notifyWorldEvent('relics:collected', { label: 'Quake', player: 'A', x: 1, y: 1 });
    const appends = harness.sink.ofType(APPEND_TYPE);
    expect(appends.at(-1)?.target).toBe('broadcast');
    expect(parseEntries(appends.at(-1)?.payload)).toEqual([{ day: 0, text: 'A took up the Quake.' }]);
  });

  it('no entry ever carries a coordinate — places travel as names (the fog rule)', () => {
    const harness = boot();
    const far = cellIn(5, 7, 9);
    harness.host.notifyWorldEvent('monsters:arrived', { kind: 'kraken', ...far });
    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [cellIn(6, 6)],
      upgraded: [],
      died: [],
    });
    // Counts are the only digits a line may carry; cell coordinates here are
    // all ≥ 80, so any two-digit run would be a leak.
    for (const text of texts()) expect(text).not.toMatch(/\d\d/);
  });
});

describe('persistence and the cap', () => {
  it('the saga, the clock, and every "first" survive a snapshot round-trip', () => {
    const harness = boot();
    advanceDays(harness, 2);
    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [],
      upgraded: [{ ...cellIn(1, 2), tier: 1 }],
      died: [],
    });
    harness.host.notifyWorldEvent('monsters:arrived', { kind: 'yeti', ...cellIn(2, 2) });
    const saved = harness.host.collectPersistence()[CHRONICLE_PLUGIN_NAME];
    const before = [...chronicleEntries()];

    const restored = boot(saved);
    expect(chronicleEntries()).toEqual(before);

    // Firsts stay first: the same tier and the same kind add nothing after restore.
    advanceDays(restored, 1);
    restored.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [],
      upgraded: [{ ...cellIn(3, 3), tier: 1 }],
      died: [],
    });
    restored.host.notifyWorldEvent('monsters:arrived', { kind: 'yeti', ...cellIn(2, 2) });
    const after = texts();
    expect(after.filter((t) => t.includes("world's first")).length).toBe(1);
    expect(after.filter((t) => t.includes('first yeti')).length).toBe(1);

    // Day stamps advanced with the restored clock: the new arrival is day 3.
    const last = chronicleEntries().at(-1) as ChronicleEntry;
    expect(last.day).toBe(3);
  });

  it('an unknown slice version is ignored, not misread', () => {
    boot({ v: 999, entries: [{ d: 0, t: 'from the future' }] });
    expect(texts()).toEqual([GENESIS_TEXT]);
  });

  it('the scroll is capped; the oldest pages crumble first', () => {
    const harness = boot();
    for (let i = 0; i < CHRONICLE_MAX_ENTRIES + 10; i++) {
      harness.host.notifyWorldEvent('relics:collected', {
        label: 'Quake',
        player: `p${String(i).replace(/\d/g, (d) => 'abcdefghij'[Number(d)] ?? 'x')}`,
        x: 1,
        y: 1,
      });
    }
    expect(chronicleEntries()).toHaveLength(CHRONICLE_MAX_ENTRIES);
    expect(texts()[0]).not.toBe(GENESIS_TEXT);
  });
});

describe('determinism', () => {
  it('place names are pure functions of the chunk', () => {
    expect(placeName(2, 3)).toBe(placeName(2, 3));
    expect(placeName(0, 0)).toMatch(/^[A-Z][a-z]+$/);
    // Not a constant function: some spread across chunks.
    const names = new Set(
      Array.from({ length: 16 }, (_, i) => placeName(i % 4, Math.floor(i / 4))),
    );
    expect(names.size).toBeGreaterThan(1);
  });

  it('the race copy matches structures’ derivation on the shared golden vectors', () => {
    // The same six cells plugins/structures/test pins (pilgrims contract,
    // 2026-08-19). If either copy drifts, one of the two suites fails.
    expect(settlementRace(0, 0)).toBe('rudy');
    expect(settlementRace(8, 12)).toBe('rudy');
    expect(settlementRace(16, 16)).toBe('uno');
    expect(settlementRace(100, 100)).toBe('uno');
    expect(settlementRace(255, 17)).toBe('uno');
    expect(settlementRace(511, 511)).toBe('rudy');
  });

  it('parsers refuse the shapes the saga must never act on', () => {
    expect(parseStructuresChanges(null)).toBeNull();
    expect(parseStructuresChanges({ cause: 'generation', died: [{ x: 0.5, y: 0 }] })).toBeNull();
    expect(parseStructuresChanges({ cause: 'generation', upgraded: [{ x: 0, y: 0, tier: -1 }] })).toBeNull();
    // Absent lists are empty lists (the sculpt emission carries only `died`).
    expect(parseStructuresChanges({ cause: 'sculpt', died: [] })).toEqual({
      cause: 'sculpt',
      seeded: [],
      upgraded: [],
      died: [],
    });
  });
});
