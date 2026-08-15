// The flora sim, driven through the REAL plugin host and the REAL intent
// pipeline — no stub for either.
//
// These are CONTRACT tests: each one names a rule the plugin promises (only
// green ground, only stable ground, only unlocked ground, never denser than the
// cap, felled by any sculpt, survives a restart) and asserts it against the
// mechanism rather than against a call site.

import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, MAX_BRUSH_RADIUS, MIN_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  FLORA_TREE_CAP,
  parseTreeCells,
} from '../protocol.ts';
import {
  FLORA_MAX_BAND,
  FLORA_MIN_BAND,
  isGreenBand,
  isPlantableCell,
  type FloraWorld,
} from '../server/bands.ts';
import {
  FLORA_CELLS_PER_TREE,
  FLORA_MAX_SPROUTS_PER_SURVEY,
  FLORA_MEAN_SPROUT_WAIT_SECONDS,
  FLORA_MIN_TREE_SPACING_CELLS,
  FLORA_SURVEY_INTERVAL_SECONDS,
  Forest,
  createFloraRng,
  sproutCount,
  treeTargetFor,
  type FloraRng,
} from '../server/forest.ts';
import {
  FLORA_KEEPALIVE_SECONDS,
  currentForest,
  plugin as floraPlugin,
  resetFloraState,
  standingTrees,
} from '../server/index.ts';
import { FLORA_SLICE_VERSION, loadForestSlice, saveForest } from '../server/persistence.ts';
import { FLORA_STABILITY_SECONDS, StabilityMap } from '../server/stability.ts';
import { worldWithTerrain } from './support/world.ts';

/** 64² cells = 4×4 chunks — small enough to survey thousands of times a suite. */
const WORLD_SIZE = 64;

/** Host tick period, matching the shipped TICK_HZ of 10. */
const DT = 0.1;

const PLAYER: Player = { id: 'session-1', name: 'Tester' };

/** Namespaced message types, as they appear on the RecordingSink. */
const FOREST_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_FOREST_MESSAGE}`;
const CHANGES_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CHANGES_MESSAGE}`;

/**
 * Bands laid out in vertical stripes, one band per 8-column stripe, cycling 0…7.
 * Every band this plugin cares about is present, and each is a solid block big
 * enough to hold a stand of trees.
 */
const STRIPE_WIDTH = 8;
const STRIPE_BANDS = 8;

function stripedHeight(x: number, _y: number): number {
  return (Math.floor(x / STRIPE_WIDTH) % STRIPE_BANDS) * BAND_HEIGHT;
}

/** A column that is squarely inside the given band's stripe. */
function columnInBand(band: number): number {
  return band * STRIPE_WIDTH + Math.floor(STRIPE_WIDTH / 2);
}

/** Green cells in the striped world: three stripes, full height. */
const GREEN_CELLS = (FLORA_MAX_BAND - FLORA_MIN_BAND + 1) * STRIPE_WIDTH * WORLD_SIZE;

const LOCKED_CHUNK_ROW = 0;
function isChunkLocked(_cx: number, cy: number): boolean {
  return cy === LOCKED_CHUNK_ROW;
}

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** Boots the plugin, through the real host, onto an already-built world. */
function bootOn(world: World, restore?: unknown): Harness {
  resetFloraState();

  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [floraPlugin].map(asLoadedPlugin));
  // The real boot order: persistence first, then world create (server/src/index.ts).
  if (restore !== undefined) host.restorePersistence({ [FLORA_PLUGIN_NAME]: restore });
  host.worldCreate();

  return { world, host, sink };
}

function boot(locked: (cx: number, cy: number) => boolean = isChunkLocked): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, stripedHeight, locked));
}

function join(harness: Harness): void {
  harness.world.addPlayer(PLAYER);
  harness.host.playerJoined(PLAYER);
}

/** Advances the sim by `seconds` of simulated time at the shipped tick rate. */
function advance(harness: Harness, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

/** The World as the plugin's own predicates want it (World calls it `size`). */
function floraView(world: World): FloraWorld {
  return {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    heightAt: (x, y) => world.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

/** A generator that always returns the same number — for the density maths. */
function fixedRng(value: number): FloraRng {
  return { next: () => value, state: () => 0 };
}

describe('band eligibility', () => {
  it('accepts exactly the palette\'s green bands', () => {
    for (let band = -4; band <= 9; band++) {
      const expected = band >= FLORA_MIN_BAND && band <= FLORA_MAX_BAND;
      expect(isGreenBand(band * BAND_HEIGHT)).toBe(expected);
      // Anywhere inside the band, not just on its floor.
      expect(isGreenBand(band * BAND_HEIGHT + BAND_HEIGHT - 1)).toBe(expected);
    }
  });

  it('never accepts a water cell — the band floor is above sea level', () => {
    // The green test carries no isWater branch on purpose (see bands.ts); this
    // is the assertion that makes its absence safe.
    for (let h = MIN_HEIGHT; h <= SEA_LEVEL; h += 17) {
      expect(isGreenBand(h)).toBe(false);
    }
    expect(isGreenBand(SEA_LEVEL)).toBe(false);
  });

  it('refuses cells outside the world and inside locked chunks', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight, isChunkLocked));
    const green = columnInBand(FLORA_MIN_BAND);

    // Row 0 is inside the locked chunk row; row CHUNK_SIZE is not.
    expect(isPlantableCell(world, green, 0)).toBe(false);
    expect(isPlantableCell(world, green, CHUNK_SIZE)).toBe(true);

    expect(isPlantableCell(world, -1, CHUNK_SIZE)).toBe(false);
    expect(isPlantableCell(world, WORLD_SIZE, CHUNK_SIZE)).toBe(false);
    expect(isPlantableCell(world, green, WORLD_SIZE)).toBe(false);
  });

  it('refuses sand, soil and rock', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight));
    for (const band of [0, 1, 2, 6, 7]) {
      expect(isPlantableCell(world, columnInBand(band), CHUNK_SIZE)).toBe(false);
    }
    for (let band = FLORA_MIN_BAND; band <= FLORA_MAX_BAND; band++) {
      expect(isPlantableCell(world, columnInBand(band), CHUNK_SIZE)).toBe(true);
    }
  });
});

describe('stability tracking', () => {
  it('holds a fresh world stable from simulated second zero', () => {
    const stability = new StabilityMap(WORLD_SIZE);
    expect(stability.isStable(3, 4, 0)).toBe(false);
    expect(stability.isStable(3, 4, FLORA_STABILITY_SECONDS - 1)).toBe(false);
    expect(stability.isStable(3, 4, FLORA_STABILITY_SECONDS)).toBe(true);
  });

  it('restarts the window on every change', () => {
    const stability = new StabilityMap(WORLD_SIZE);
    const changedAt = 1000;
    stability.markChanged(3, 4, changedAt);

    expect(stability.isStable(3, 4, changedAt + FLORA_STABILITY_SECONDS - 1)).toBe(false);
    expect(stability.isStable(3, 4, changedAt + FLORA_STABILITY_SECONDS)).toBe(true);
    // Its neighbour was never touched, so it is unaffected.
    expect(stability.isStable(4, 4, changedAt + 1)).toBe(true);
  });

  it('ignores cells outside the world instead of throwing', () => {
    const stability = new StabilityMap(WORLD_SIZE);
    expect(() => stability.markChanged(-1, 0, 5)).not.toThrow();
    expect(() => stability.markChanged(WORLD_SIZE, WORLD_SIZE, 5)).not.toThrow();
    expect(stability.isStable(-1, 0, 5)).toBe(false);
  });

  it('is reset by a real sculpt, through the real pipeline', () => {
    const harness = boot(() => false);
    const x = columnInBand(FLORA_MIN_BAND);
    const y = CHUNK_SIZE * 2;

    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS);
    const treesBefore = standingTrees().length;
    expect(treesBefore).toBeGreaterThan(0);

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x, y, radius: MAX_BRUSH_RADIUS, dir: 1 },
    );

    // Nothing may grow in the disturbed area again until a fresh full window has
    // passed; two surveys later is far too soon.
    //
    // The assertion is scoped to the cells the brush CERTAINLY changed — the
    // 3×3 around the centre, where a soft falloff is at its strongest. The rim
    // of a radius-4 disc is deliberately excluded: a soft profile's outermost
    // ring can round to no change at all, so a tree appearing there would be
    // correct behaviour and asserting against it would be asserting a flake.
    const CERTAINLY_CHANGED_REACH = 1;
    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * 2);
    const grownNearby = standingTrees().filter(
      (tree) =>
        Math.abs(tree.x - x) <= CERTAINLY_CHANGED_REACH &&
        Math.abs(tree.y - y) <= CERTAINLY_CHANGED_REACH,
    );
    expect(grownNearby).toHaveLength(0);
  });
});

describe('density maths', () => {
  it('derives the target from the stable green area, and caps it', () => {
    expect(treeTargetFor(0)).toBe(0);
    expect(treeTargetFor(FLORA_CELLS_PER_TREE - 1)).toBe(0);
    expect(treeTargetFor(FLORA_CELLS_PER_TREE * 40)).toBe(40);
    expect(treeTargetFor(FLORA_CELLS_PER_TREE * (FLORA_TREE_CAP + 500))).toBe(FLORA_TREE_CAP);
  });

  it('spreads a deficit over time instead of filling it at once', () => {
    // Expected arrivals per survey are deficit × interval / mean wait.
    const deficit = 120;
    const expected = deficit * (FLORA_SURVEY_INTERVAL_SECONDS / FLORA_MEAN_SPROUT_WAIT_SECONDS);
    expect(expected).toBe(10);
    expect(sproutCount(deficit, fixedRng(0.99))).toBe(10);
    expect(sproutCount(deficit, fixedRng(0))).toBe(10);
  });

  it('rounds a fractional expectation stochastically', () => {
    // Deficit 6 → expectation 0.5: never a whole tree, so the fractional draw is
    // the only thing that can produce one.
    expect(sproutCount(6, fixedRng(0.4))).toBe(1);
    expect(sproutCount(6, fixedRng(0.6))).toBe(0);
  });

  it('never exceeds the per-survey ceiling or the deficit', () => {
    expect(sproutCount(FLORA_TREE_CAP, fixedRng(0))).toBe(FLORA_MAX_SPROUTS_PER_SURVEY);
    expect(sproutCount(1, fixedRng(0))).toBe(1);
    expect(sproutCount(0, fixedRng(0))).toBe(0);
    expect(sproutCount(-5, fixedRng(0))).toBe(0);
  });

  it('keeps trees apart by the spacing rule', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight));
    const stability = new StabilityMap(WORLD_SIZE);
    const forest = new Forest();
    const rng = createFloraRng(1);

    // Well past the stability window, and enough surveys to saturate.
    for (let n = 0; n < 400; n++) {
      forest.survey(world, stability, FLORA_STABILITY_SECONDS + n * FLORA_SURVEY_INTERVAL_SECONDS, rng);
    }
    expect(forest.count).toBeGreaterThan(0);

    const reach = FLORA_MIN_TREE_SPACING_CELLS - 1;
    for (const tree of forest.cells()) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx === 0 && dy === 0) continue;
          expect(forest.has(tree.x + dx, tree.y + dy)).toBe(false);
        }
      }
    }
  });

  it('settles at the density the constants describe and stops', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight));
    const stability = new StabilityMap(WORLD_SIZE);
    const forest = new Forest();
    const rng = createFloraRng(2);

    const target = treeTargetFor(GREEN_CELLS);
    for (let n = 0; n < 600; n++) {
      forest.survey(world, stability, FLORA_STABILITY_SECONDS + n * FLORA_SURVEY_INTERVAL_SECONDS, rng);
      expect(forest.count).toBeLessThanOrEqual(target);
    }
    // The spacing rule can leave the last few slots unfillable, so this asserts
    // "most of the way there and no further", not an exact count.
    expect(forest.count).toBeGreaterThan(target / 2);
  });
});

describe('growth', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('grows nothing until the stability window has passed', () => {
    advance(harness, FLORA_STABILITY_SECONDS - FLORA_SURVEY_INTERVAL_SECONDS * 2);
    expect(standingTrees()).toHaveLength(0);

    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * 4);
    expect(standingTrees().length).toBeGreaterThan(0);
  });

  it('fills a meadow gradually rather than all at once', () => {
    // One sweep past the window, so exactly ONE fully-eligible survey has
    // completed. (The sweep that finishes AT the window scanned most of its
    // chunks before it elapsed, so it finds almost nothing — the survey is
    // rolling, not instantaneous. See Forest.advanceSurvey.)
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS + 1);
    const firstSurvey = standingTrees().length;
    expect(firstSurvey).toBeGreaterThan(0);
    expect(firstSurvey).toBeLessThanOrEqual(FLORA_MAX_SPROUTS_PER_SURVEY);

    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * 10);
    expect(standingTrees().length).toBeGreaterThan(firstSurvey);
  });

  it('completes one survey per interval whatever the world size', () => {
    // THE AMORTISATION CONTRACT. The sweep is spread over ticks (see
    // Forest.advanceSurvey), and the thing that must not change is its PERIOD:
    // every growth rate in this plugin is expressed per survey interval, so a
    // small world sweeping faster than a large one would silently grow its
    // forest several times too fast. (It did: the first cut of the budget
    // rounded up to whole chunks and this 64² world swept every 1.6 s.)
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS);
    harness.sink.clear();

    const window = FLORA_SURVEY_INTERVAL_SECONDS * 12;
    advance(harness, window);
    const sweeps = harness.sink.ofType(CHANGES_WIRE_TYPE).length;
    const expected = window / FLORA_SURVEY_INTERVAL_SECONDS;

    // A sweep that grows nothing sends nothing, so this is a bound, not an
    // equality — but the failure it guards (three sweeps where there should be
    // one) is nowhere near it.
    expect(sweeps).toBeLessThanOrEqual(expected);
    expect(sweeps).toBeGreaterThanOrEqual(expected - 2);
  });

  it('only ever plants on unlocked green ground', () => {
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 40);
    const world = floraView(harness.world);
    expect(standingTrees().length).toBeGreaterThan(0);

    for (const tree of standingTrees()) {
      expect(isPlantableCell(world, tree.x, tree.y)).toBe(true);
      expect(harness.world.isCellUnlocked(tree.x, tree.y)).toBe(true);
      // Nothing in the locked chunk row, which is the anti-leak rule: an
      // unfiltered broadcast can only ever mention revealed territory.
      expect(tree.y).toBeGreaterThanOrEqual(CHUNK_SIZE);
    }
  });
});

describe('felling', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 20);
    expect(standingTrees().length).toBeGreaterThan(0);
  });

  it('removes a tree the moment its cell is sculpted, and broadcasts it', () => {
    const victim = standingTrees()[0];
    harness.sink.clear();

    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: MAX_BRUSH_RADIUS, dir: 1 },
    );
    expect(outcome.applied).toBe(true);

    expect(currentForest().has(victim.x, victim.y)).toBe(false);

    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const felled = parseTreeCells((changes[0].payload as { felled: number[] }).felled) ?? [];
    expect(felled).toContainEqual({ x: victim.x, y: victim.y });
    // A fell message carries removals only — it is a delta, not a redraw.
    const grown = parseTreeCells((changes[0].payload as { grown: number[] }).grown) ?? [];
    expect(grown).toHaveLength(0);
  });

  it('fells every tree the diff touched, not just the one under the brush', () => {
    // A max-radius smooth brush changes a disc of cells plus its relaxation
    // spill; every tree inside it must go, or trees are left standing on ground
    // that moved under them.
    const victim = standingTrees()[0];
    const before = new Set(standingTrees().map((tree) => `${tree.x},${tree.y}`));

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: MAX_BRUSH_RADIUS, dir: -1 },
    );

    const after = new Set(standingTrees().map((tree) => `${tree.x},${tree.y}`));
    expect(after.size).toBeLessThan(before.size);
    for (const tree of standingTrees()) {
      // Everything still standing is still on ground that can hold it.
      expect(isPlantableCell(floraView(harness.world), tree.x, tree.y)).toBe(true);
    }
  });
});

describe('broadcast model', () => {
  it('sends the whole forest to a joining player, and only to them', () => {
    const harness = boot(() => false);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 5);
    harness.sink.clear();

    join(harness);

    const snapshots = harness.sink.ofType(FOREST_WIRE_TYPE);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].target).toBe(PLAYER.id);
    const cells = parseTreeCells((snapshots[0].payload as { trees: number[] }).trees) ?? [];
    expect(cells).toHaveLength(standingTrees().length);
  });

  it('sends growth as a delta, and says nothing when nothing changed', () => {
    const harness = boot(() => false);
    join(harness);

    // Before the stability window nothing can grow, so nothing may be sent.
    advance(harness, FLORA_STABILITY_SECONDS - FLORA_SURVEY_INTERVAL_SECONDS * 2);
    expect(harness.sink.ofType(CHANGES_WIRE_TYPE)).toHaveLength(0);

    harness.sink.clear();
    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * 4);
    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);

    const grown = parseTreeCells((changes[0].payload as { grown: number[] }).grown) ?? [];
    expect(grown.length).toBeGreaterThan(0);
    expect(grown.length).toBeLessThanOrEqual(FLORA_MAX_SPROUTS_PER_SURVEY);

    // THE DELTA CONTRACT: across every message, each tree was announced exactly
    // once. A full-state stream would announce the whole forest every time and
    // this sum would be several times the standing count.
    let announced = 0;
    for (const message of changes) {
      announced += (parseTreeCells((message.payload as { grown: number[] }).grown) ?? []).length;
    }
    expect(announced).toBe(standingTrees().length);
    expect(changes.length).toBeGreaterThan(1);
  });

  it('repairs a drifted client with a keepalive snapshot', () => {
    const harness = boot(() => false);
    join(harness);
    harness.sink.clear();

    advance(harness, FLORA_KEEPALIVE_SECONDS + 1);
    const snapshots = harness.sink.ofType(FOREST_WIRE_TYPE);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0].target).toBe('broadcast');
  });
});

describe('persistence', () => {
  it('round-trips a forest across a restart', () => {
    const first = boot(() => false);
    advance(first, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 30);
    const before = standingTrees();
    expect(before.length).toBeGreaterThan(0);

    const slice = first.host.collectPersistence()[FLORA_PLUGIN_NAME];

    // A completely fresh boot of the same world, restoring that slice.
    const second = bootOn(worldWithTerrain(WORLD_SIZE, stripedHeight), slice);
    expect(standingTrees()).toEqual(before);

    // And the restored trees are broadcast to whoever joins next.
    join(second);
    const snapshots = second.sink.ofType(FOREST_WIRE_TYPE).filter((m) => m.target === PLAYER.id);
    const cells = parseTreeCells((snapshots[0].payload as { trees: number[] }).trees) ?? [];
    expect(cells).toHaveLength(before.length);
  });

  it('survives a truncated, foreign or hand-edited slice', () => {
    const rng = createFloraRng(7);
    for (const junk of [
      null,
      undefined,
      42,
      'trees',
      {},
      { version: FLORA_SLICE_VERSION + 1, trees: [1, 2] },
      { version: FLORA_SLICE_VERSION, trees: 'nope' },
    ]) {
      const restored = loadForestSlice(junk);
      expect(restored.cells).toHaveLength(0);
      expect(Number.isInteger(restored.rngState)).toBe(true);
    }

    // Individually bad entries are dropped; the good ones survive.
    const mixed = loadForestSlice({
      version: FLORA_SLICE_VERSION,
      rngState: rng.state(),
      trees: [5, 6, -1, 3, 7, 1.5, 9, 9, 9, 9],
    });
    expect(mixed.cells).toEqual([
      { x: 5, y: 6 },
      { x: 9, y: 9 },
    ]);
  });

  it('caps a slice that claims more trees than the world may hold', () => {
    const trees: number[] = [];
    for (let n = 0; n < FLORA_TREE_CAP + 100; n++) trees.push(n % 512, Math.floor(n / 512));
    const restored = loadForestSlice({ version: FLORA_SLICE_VERSION, rngState: 1, trees });
    expect(restored.cells).toHaveLength(FLORA_TREE_CAP);
  });

  it('fells restored trees that no longer stand on green ground', () => {
    // A forest saved on the striped world, restored onto a world of bare rock.
    const first = boot(() => false);
    advance(first, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 10);
    const slice = first.host.collectPersistence()[FLORA_PLUGIN_NAME];
    expect(standingTrees().length).toBeGreaterThan(0);

    const rock = bootOn(
      worldWithTerrain(WORLD_SIZE, () => (FLORA_MAX_BAND + 2) * BAND_HEIGHT),
      slice,
    );
    expect(standingTrees().length).toBeGreaterThan(0);

    // The first survey's cull sweep is what removes them.
    advance(rock, FLORA_SURVEY_INTERVAL_SECONDS + DT);
    expect(standingTrees()).toHaveLength(0);
  });

  it('writes a slice this plugin can read back verbatim', () => {
    const forest = new Forest();
    forest.plant(3, 4);
    forest.plant(40, 41);
    const rng = createFloraRng(99);
    rng.next();

    const slice = saveForest(forest, rng);
    expect(slice.version).toBe(FLORA_SLICE_VERSION);

    const restored = loadForestSlice(JSON.parse(JSON.stringify(slice)));
    expect(restored.cells).toEqual([
      { x: 3, y: 4 },
      { x: 40, y: 41 },
    ]);
    expect(restored.rngState).toBe(rng.state());
  });
});
