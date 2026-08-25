// The flora sim, driven through the REAL plugin host and the REAL intent
// pipeline — no stub for either.
//
// These are CONTRACT tests: each one names a rule the plugin promises (only
// green ground, only stable ground, only unlocked ground, never denser than the
// cap, felled by any sculpt, survives a restart) and asserts it against the
// mechanism rather than against a call site.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MIN_HEIGHT,
  SEA_LEVEL,
  cellsAcross,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import {
  CROP_PLOT_CLUSTER_CELL_SPAN,
  CROP_PLOT_MAX_REACH_CELLS,
  CROP_PLOT_TREAD_RING_CELLS,
  CROP_STALKS_PER_PLOT,
  CROP_STALK_HEIGHT_SPREAD,
  CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  CROP_STALK_OFFSET_IN_CLUSTER_SPANS,
  cropStalkVariation,
  CROP_SCALE_MAX,
  CROP_SCALE_MIN,
  cropVariation,
  FLORA_CHANGES_MESSAGE,
  FLORA_CROPS_MESSAGE,
  FLORA_CROP_CAP,
  FLORA_CROP_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  FLORA_TREE_CAP,
  parseCropCells,
  parseTreeCells,
  type CropCell,
  type TreeCell,
} from '../protocol.ts';
import {
  FLORA_MAX_BAND,
  FLORA_MIN_BAND,
  isGreenBand,
  isPlantableCell,
  type FloraWorld,
} from '../server/bands.ts';
import { CROP_SURVEY_INTERVAL_SECONDS, CropField } from '../server/crops.ts';
import { isFarmlandCell, isFarmlandPlot, type FarmlandWorld } from '@terrace/shared';
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
  currentCropField,
  currentForest,
  plugin as floraPlugin,
  resetFloraState,
  standingCrops,
  standingTrees,
} from '../server/index.ts';
import { FLORA_SLICE_VERSION, loadForestSlice, saveForest } from '../server/persistence.ts';
import { FLORA_STABILITY_SECONDS, StabilityMap } from '../server/stability.ts';
import {
  loadStructuresBridge,
  resetStructuresBridge,
  setStructuresModuleLoader,
  structuresBridgeReady,
} from '../server/structures-bridge.ts';
import { worldWithTerrain } from './support/world.ts';

/**
 * 64² WORLD UNITS — small enough to survey thousands of times a suite, and big
 * enough to hold a forest at the shipped density. Counted in world units rather
 * than cells because that density is: FLORA_CELLS_PER_TREE is a tree per eight
 * square world units, so a 64-CELL world after the 2026-08-21 re-sample would
 * be sixteen world units of ground and hold almost no trees at all.
 */
const WORLD_SIZE = cellsAcross(64);

/** Host tick period, matching the shipped TICK_HZ of 10. */
const DT = 0.1;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

/** Namespaced message types, as they appear on the RecordingSink. */
const FOREST_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_FOREST_MESSAGE}`;
const CHANGES_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CHANGES_MESSAGE}`;
const CROPS_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CROPS_MESSAGE}`;
const CROP_CHANGES_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CROP_CHANGES_MESSAGE}`;

/**
 * Bands laid out in vertical stripes, one band per 8-column stripe, cycling 0…7.
 * Every band this plugin cares about is present, and each is a solid block big
 * enough to hold a stand of trees.
 */
const STRIPE_WIDTH = cellsAcross(8);
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
  // Fog of war (issue #18): grant PLAYER's own token every chunk this
  // world's union mask already has unlocked, BEFORE playerJoined fires the
  // plugin's onPlayerJoin — the same order the real join path seeds a
  // token's starter square in. Every existing "the joining player gets the
  // whole forest" assertion below assumes this player can see everything
  // boot() unlocked, exactly as it did before per-player masks existed.
  grantTokenEveryUnlockedChunk(harness.world, PLAYER.token);
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
    expect(expected).toBe(20);
    expect(sproutCount(deficit, fixedRng(0.99))).toBe(20);
    expect(sproutCount(deficit, fixedRng(0))).toBe(20);
  });

  it('rounds a fractional expectation stochastically', () => {
    // Deficit 3 → expectation 0.5: never a whole tree, so the fractional draw is
    // the only thing that can produce one.
    expect(sproutCount(3, fixedRng(0.4))).toBe(1);
    expect(sproutCount(3, fixedRng(0.6))).toBe(0);
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
    //
    // This test counts SURVEYS via the wire, so it needs a connected, fully
    // visible player (issue #18 fog of war: broadcastVisible correctly sends
    // nothing to nobody, and this suite's default boot() joins no one) —
    // otherwise a sweep that legitimately grew something would still leave
    // zero messages to count.
    join(harness);
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

  /**
   * Simulating 105 seconds of world synchronously, on a 256-cell board, to get
   * trees to grow. Measured at ~11s of wall clock — over vitest's 10s default,
   * which this hook has been close to for a while and crossed on 2026-08-23
   * when the crop survey's per-cell predicate grew a tread ring
   * (shared/farmland.ts's isFarmlandPlot). The extra work is real but small
   * where it actually runs: ~2.7× the survey's per-cell cost, which crops.ts's
   * own measurement puts at well under a millisecond per tick on a 512² board.
   * It is only visible here because this fixture pays a hundred seconds of it
   * up front, for trees, which have nothing to do with crops.
   */
  const FELLING_FIXTURE_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 20);
    expect(standingTrees().length).toBeGreaterThan(0);
  }, FELLING_FIXTURE_TIMEOUT_MS);

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

describe('structure occupancy — buildings always win', () => {
  // Structures is never installed in this harness (only floraPlugin is), so
  // every event below is fed straight through PluginHost.notifyWorldEvent —
  // exactly the seam chronicle's own suite uses for the same reason (a
  // plugin builds and tests with every other plugin deleted).

  afterEach(() => {
    resetStructuresBridge();
  });

  it('fells a tree the instant its cell is named seeded, and broadcasts it', () => {
    const harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 20);
    const victim = standingTrees()[0];
    expect(victim).toBeDefined();
    harness.sink.clear();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [{ x: victim.x, y: victim.y, tier: 0 }],
      upgraded: [],
      died: [],
    });

    expect(currentForest().has(victim.x, victim.y)).toBe(false);
    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const felled = parseTreeCells((changes[0].payload as { felled: number[] }).felled) ?? [];
    expect(felled).toContainEqual({ x: victim.x, y: victim.y });
  });

  it('fells a tree the instant its cell is named upgraded, and broadcasts it', () => {
    const harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 20);
    const victim = standingTrees()[0];
    expect(victim).toBeDefined();
    harness.sink.clear();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [],
      upgraded: [{ x: victim.x, y: victim.y, tier: 1 }],
      died: [],
    });

    expect(currentForest().has(victim.x, victim.y)).toBe(false);
    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const felled = parseTreeCells((changes[0].payload as { felled: number[] }).felled) ?? [];
    expect(felled).toContainEqual({ x: victim.x, y: victim.y });
  });

  it('does not replant when a structure dies — recolonization is left to ordinary growth', () => {
    const harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 20);
    const victim = standingTrees()[0];
    expect(victim).toBeDefined();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [{ x: victim.x, y: victim.y, tier: 0 }],
      upgraded: [],
      died: [],
    });
    expect(currentForest().has(victim.x, victim.y)).toBe(false);
    harness.sink.clear();

    // The same cell reported dead. Nothing here should plant a tree back —
    // there is no code path in onWorldEvent that even reads `died`.
    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      died: [{ x: victim.x, y: victim.y }],
    });

    expect(currentForest().has(victim.x, victim.y)).toBe(false);
    expect(harness.sink.ofType(CHANGES_WIRE_TYPE)).toHaveLength(0);
  });

  it('clears a pre-existing overlap on the first completed survey after the structures bridge resolves', async () => {
    const harness = boot(() => false);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 10);
    const victim = standingTrees()[0];
    expect(victim).toBeDefined();

    // Simulates a building that already stood over this tree before flora
    // ever checked — boot() started the real (default) loader, which never
    // resolves inside a synchronous test body; resetStructuresBridge discards
    // it so this fake loader is the one the next call resolves against.
    resetStructuresBridge();
    setStructuresModuleLoader(() =>
      Promise.resolve({ standingStructures: () => [{ x: victim.x, y: victim.y }] }),
    );
    void loadStructuresBridge();
    await structuresBridgeReady();

    // The cull phase only runs on the tick that completes a sweep — the same
    // shape as "fells restored trees that no longer stand on green ground"
    // in the persistence suite.
    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS + DT);
    expect(currentForest().has(victim.x, victim.y)).toBe(false);
  });

  it('is deterministic: the same growth, event and occupancy history produces the same forest twice', () => {
    function run(): TreeCell[] {
      const harness = boot(() => false);
      join(harness);
      advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 15);
      const trees = standingTrees();
      expect(trees.length).toBeGreaterThan(1);

      harness.host.notifyWorldEvent('structures:changes', {
        cause: 'generation',
        seeded: [{ x: trees[0].x, y: trees[0].y, tier: 0 }],
        upgraded: [{ x: trees[1].x, y: trees[1].y, tier: 1 }],
        died: [],
      });
      advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * 10);
      return [...standingTrees()];
    }

    // The bridge never resolves inside either synchronous run (see the
    // reconciliation test's comment above), so both runs see an identical,
    // permanently-empty occupied set — this asserts the ordinary growth and
    // event-felling paths are themselves deterministic, the same property
    // every other terrain-adjacent system in this codebase is held to.
    const first = run();
    const second = run();
    expect(second).toEqual(first);
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
    // Some real content to repair: an empty forest's keepalive is legitimately
    // silent under fog of war (issue #18) — a recipient whose own visible
    // subset is empty is sent nothing at all (FLORA_SKIP_EMPTY), same as a
    // delta would be, so this test needs standing trees to prove the keepalive
    // actually carries them.
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 5);
    expect(standingTrees().length).toBeGreaterThan(0);
    harness.sink.clear();

    advance(harness, FLORA_KEEPALIVE_SECONDS + 1);
    const snapshots = harness.sink.ofType(FOREST_WIRE_TYPE);
    expect(snapshots.length).toBeGreaterThan(0);
    // Fog of war (issue #18): the fan-out is per connected player now, never
    // a single shared broadcast — with exactly one player joined here that
    // is still exactly one message, addressed to them.
    expect(snapshots[0].target).toBe(PLAYER.id);
    // Non-empty and real content, not just a message: growth keeps happening
    // during the keepalive window too, so this is a floor, not an equality.
    const cells = parseTreeCells((snapshots[0].payload as { trees: number[] }).trees) ?? [];
    expect(cells.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FOG OF WAR (issue #18). First: two players get different subsets of the
  // SAME forest through the real broadcastVisible path. Second: the targeted
  // refresh — a chunk with trees already in it must reach a player who just
  // earned it, not wait out FLORA_KEEPALIVE_SECONDS.
  // ──────────────────────────────────────────────────────────────────────────
  it('sends each connected player only the trees inside their own unlocked view', () => {
    const harness = boot(() => false);
    join(harness);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 5);
    expect(standingTrees().length).toBeGreaterThan(0);

    // A second connection whose token has never unlocked anything of its own.
    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);

    harness.sink.clear();
    advance(harness, FLORA_KEEPALIVE_SECONDS + 1);

    const forPlayer = harness.sink
      .ofType(FOREST_WIRE_TYPE)
      .filter((m) => m.target === PLAYER.id);
    const forOutsider = harness.sink
      .ofType(FOREST_WIRE_TYPE)
      .filter((m) => m.target === outsider.id);

    // PLAYER's token was granted the whole unlocked world (join()), so their
    // keepalive carries real content — growth keeps happening during the
    // keepalive window too, so this is a floor, not an equality (the same
    // reasoning as the plain keepalive test above).
    expect(forPlayer.length).toBeGreaterThan(0);
    const playerCells = parseTreeCells((forPlayer[0].payload as { trees: number[] }).trees) ?? [];
    expect(playerCells.length).toBeGreaterThan(0);

    // The outsider's token has unlocked nothing: skipEmpty means their
    // keepalive is silent rather than an empty message, which is the
    // documented, safe disappearance-semantics choice for content that never
    // moves once placed (FLORA_SKIP_EMPTY).
    expect(forOutsider).toHaveLength(0);
  });

  it('pushes a targeted refresh when a player creeps into a chunk that already has trees', () => {
    const harness = boot(() => false);
    advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * 5);
    const victim = standingTrees()[0];
    expect(victim).toBeDefined();
    const cx = Math.floor(victim.x / CHUNK_SIZE);
    const cy = Math.floor(victim.y / CHUNK_SIZE);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider); // nothing to send yet — empty mask
    harness.sink.clear();

    // No reveal plugin is installed in this harness, so drive the same two
    // steps WorldApi.unlockChunkForToken performs for any real caller: the
    // World mutation (+ its own core chunkUnlock send), then the plugin
    // fan-out it triggers (world-api.ts's unlockChunkForToken wrapper).
    expect(harness.world.unlockChunkForToken(outsider.token, cx, cy)).toBe(true);
    harness.host.notifyChunkUnlockedForToken(outsider.token, cx, cy);

    const changes = harness.sink
      .ofType(CHANGES_WIRE_TYPE)
      .filter((m) => m.target === outsider.id);
    expect(changes).toHaveLength(1);
    const grown = parseTreeCells((changes[0].payload as { grown: number[] }).grown) ?? [];
    expect(grown).toContainEqual({ x: victim.x, y: victim.y });
    const felled = parseTreeCells((changes[0].payload as { felled: number[] }).felled) ?? [];
    expect(felled).toHaveLength(0);
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

// Card 28, "Terrace Farming". The farmland PREDICATE itself is tested at its
// contract layer in shared/test/farmland.test.ts — it lives in @terrace/shared
// (one implementation, two consumers), so the cross-plugin fixture that used to
// sit here pinning two independent copies to agree no longer has two copies to
// pin. What remains below is flora's OWN half: the crop survey built on it.

describe('crops (card 28) — the CropField survey', () => {
  const CROP_LAND_BAND = 3;
  const CROP_DEEP = SEA_LEVEL - BAND_HEIGHT;

  /** A single coastline: column 0 is deep water, every other column is flat dry land. Column 1 alone touches it. */
  function coastalHeight(x: number, _y: number): number {
    return x === 0 ? CROP_DEEP : CROP_LAND_BAND * BAND_HEIGHT;
  }

  function coastalWorld(): World {
    return worldWithTerrain(WORLD_SIZE, coastalHeight);
  }

  /** Ground truth: every cell with room for a whole plot, via the SAME predicate the survey itself calls. */
  function expectedPlots(world: FarmlandWorld, size: number): Set<string> {
    const expected = new Set<string>();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFarmlandPlot(world, x, y, CROP_PLOT_TREAD_RING_CELLS)) expected.add(`${x},${y}`);
      }
    }
    return expected;
  }

  const NEVER_OCCUPIED = (): boolean => false;

  it('finds exactly the cells with room for a plot — column 2, one cell BACK from the lip the point test accepts', () => {
    const world = coastalWorld();
    const view = floraView(world);
    const expected = expectedPlots(view, WORLD_SIZE);
    // Column 1 is farmland by the point test but is the terrace LIP: a plot
    // there hangs over the drop (see shared/src/farmland.ts's isFarmlandPlot).
    // Crops therefore stand on column 2, losing the two rows whose own tread
    // would run off the top and bottom of the world.
    expect(isFarmlandCell(view, 1, 10)).toBe(true);
    expect(expected.has('1,10')).toBe(false);
    expect(expected.has('2,10')).toBe(true);
    expect(expected.size).toBe(WORLD_SIZE - 2); // every row except y=0 and y=WORLD_SIZE-1

    const field = new CropField();
    const result = field.survey(view, NEVER_OCCUPIED);
    const found = new Set(field.cells().map((c) => `${c.x},${c.y}`));
    expect(found).toEqual(expected);
    expect(result.sprouted).toHaveLength(expected.size);
    expect(result.withered).toHaveLength(0);
  });

  it('an amortised sweep spread over many partial-budget calls finds the identical set a single full survey() does', () => {
    const world = coastalWorld();
    const view = floraView(world);

    const oneShot = new CropField();
    oneShot.survey(view, NEVER_OCCUPIED);
    const expected = new Set(oneShot.cells().map((c) => `${c.x},${c.y}`));

    const amortised = new CropField();
    const totalChunks = view.chunksPerEdge * view.chunksPerEdge;
    let outcome = null;
    // One chunk at a time — the most fragmented budget this API allows.
    for (let i = 0; i < totalChunks && outcome === null; i++) {
      outcome = amortised.advance(view, NEVER_OCCUPIED, 1);
    }
    expect(outcome).not.toBeNull();
    const found = new Set(amortised.cells().map((c) => `${c.x},${c.y}`));
    expect(found).toEqual(expected);
  });

  it('is deterministic: two independent surveys of the same terrain produce byte-identical crop sets', () => {
    // The whole justification for persisting nothing (crops.ts's header): a
    // restart re-derives the SAME set from the SAME heightmap.
    const view = floraView(coastalWorld());
    const first = new CropField();
    first.survey(view, NEVER_OCCUPIED);
    const second = new CropField();
    second.survey(view, NEVER_OCCUPIED);
    expect(second.cells()).toEqual(first.cells());
  });

  it('buildings always win: an occupied farmland cell never shows a crop', () => {
    const view = floraView(coastalWorld());
    const occupied = (x: number, y: number): boolean => x === 2 && y === 5;
    const field = new CropField();
    field.survey(view, occupied);
    expect(field.has(2, 5)).toBe(false);
    expect(field.has(2, 6)).toBe(true); // an ordinary, unoccupied plot cell next door still shows one
  });

  it('reactToEdit withers the crop on its own edited cell immediately, and reports null for a cell with none', () => {
    const view = floraView(coastalWorld());
    const field = new CropField();
    field.survey(view, NEVER_OCCUPIED);
    expect(field.has(2, 5)).toBe(true);

    expect(field.reactToEdit(2, 5)).toEqual({ x: 2, y: 5 });
    expect(field.has(2, 5)).toBe(false);
    expect(field.reactToEdit(2, 5)).toBeNull(); // already gone
  });

  it('never exceeds FLORA_CROP_CAP, even when far more farmland exists', () => {
    // Water STRIPES four rows apart, so every band of land is three rows
    // deep: the middle row of each band has a full cell of tread around it
    // (isFarmlandPlot's ring) while still having water two rows away, which
    // is the shore ring. A one-row-thick comb would qualify nowhere at all
    // now that a plot needs ground on both sides of itself — the old fixture
    // tested the point predicate's reach, not the plot predicate's.
    // On a 256x256 world that is 64 qualifying rows x 254 columns ≈ 16k
    // candidate cells, comfortably over FLORA_CROP_CAP (2048).
    const combSize = 256;
    const COMB_PERIOD_ROWS = 4;
    function combHeight(x: number, y: number): number {
      if (y % COMB_PERIOD_ROWS === 0) return CROP_DEEP; // every fourth row: water
      return CROP_LAND_BAND * BAND_HEIGHT; // the three rows between: flat land
    }
    const view = floraView(worldWithTerrain(combSize, combHeight));
    const field = new CropField();
    field.survey(view, NEVER_OCCUPIED);
    expect(field.count).toBe(FLORA_CROP_CAP);
  });
});

describe('crops through the real host (card 28)', () => {
  const CROP_LAND_BAND = 3;
  const CROP_DEEP = SEA_LEVEL - BAND_HEIGHT;

  function coastalHeight(x: number, _y: number): number {
    return x === 0 ? CROP_DEEP : CROP_LAND_BAND * BAND_HEIGHT;
  }

  function bootCoastal(): Harness {
    return bootOn(worldWithTerrain(WORLD_SIZE, coastalHeight, () => false));
  }

  it('sprouts on its own survey cadence and broadcasts the sprouts as a delta', () => {
    const harness = bootCoastal();
    join(harness);
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);

    expect(standingCrops().length).toBeGreaterThan(0);
    const changes = harness.sink.ofType(CROP_CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const sprouted =
      parseCropCells((changes[0].payload as { sprouted: number[] }).sprouted) ?? [];
    expect(sprouted.length).toBeGreaterThan(0);
  });

  it('withers a crop the instant its OWN cell is sculpted', () => {
    const harness = bootCoastal();
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);
    const victim = standingCrops()[0];
    expect(victim).toBeDefined();

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: 1, dir: 1 },
    );

    expect(currentCropField().has(victim.x, victim.y)).toBe(false);
  });

  it('a NEIGHBOUR-only edit (filling in the water that made a cell farmland) is caught by the next periodic survey, not instantly — the named, accepted residual', () => {
    const harness = bootCoastal();
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);
    // Column 2 is where a plot stands: column 1 is the terrace lip, which has
    // no room for the model (shared/src/farmland.ts's isFarmlandPlot).
    const victim = standingCrops().find((c) => c.x === 2) as CropCell;
    expect(victim).toBeDefined();

    // Raise the water column (x=0) up to the land band — the victim's shore
    // ring no longer reaches water, so it should stop qualifying, but NOT this
    // tick: the edit is two cells away and reactToEdit only sees its own cell.
    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: 0, y: victim.y, radius: 1, dir: 1, tool: 'stamp' },
    );
    // Still standing immediately after the neighbour-only edit.
    expect(currentCropField().has(victim.x, victim.y)).toBe(true);
  });

  it('withers instantly when a structure seeds or upgrades on its cell (buildings always win)', () => {
    const harness = bootCoastal();
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);
    const victim = standingCrops()[0];
    expect(victim).toBeDefined();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [{ x: victim.x, y: victim.y, tier: 0 }],
      upgraded: [],
      died: [],
    });

    expect(currentCropField().has(victim.x, victim.y)).toBe(false);
  });

  it('sends the whole crop field to a joining player, filtered to their own unlocked view', () => {
    const locked = (cx: number, cy: number): boolean => cy >= WORLD_SIZE / CHUNK_SIZE / 2;
    const harness = bootOn(worldWithTerrain(WORLD_SIZE, coastalHeight, locked));
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);
    expect(standingCrops().length).toBeGreaterThan(0);

    join(harness);
    const snapshots = harness.sink.ofType(CROPS_WIRE_TYPE).filter((m) => m.target === PLAYER.id);
    expect(snapshots.length).toBeGreaterThan(0);
    const cells = parseCropCells((snapshots[0].payload as { crops: number[] }).crops) ?? [];
    for (const cell of cells) expect(cell.y).toBeLessThan(WORLD_SIZE / 2);
  });

  it('is NOT persisted: a restart with no restore payload recomputes the identical crop set from terrain alone', () => {
    const first = bootCoastal();
    advance(first, CROP_SURVEY_INTERVAL_SECONDS + DT);
    const before = new Set(standingCrops().map((c) => `${c.x},${c.y}`));
    expect(before.size).toBeGreaterThan(0);

    const slice = first.host.collectPersistence()[FLORA_PLUGIN_NAME];
    // The slice this plugin actually persists carries no crop data at all —
    // the explicit contract crops.ts's header states.
    expect(slice).not.toHaveProperty('crops');

    // A fresh boot of the SAME terrain, restoring that (crop-free) slice —
    // crops must repopulate from the survey alone, not from persistence.
    const second = bootOn(worldWithTerrain(WORLD_SIZE, coastalHeight, () => false), slice);
    expect(standingCrops()).toHaveLength(0); // nothing yet — no survey has run
    advance(second, CROP_SURVEY_INTERVAL_SECONDS + DT);
    const after = new Set(standingCrops().map((c) => `${c.x},${c.y}`));
    expect(after).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PLOT FOOTPRINT CONTRACT (protocol.ts, owner 2026-08-23)
//
// These test the RULE, not the number: "a plot never reaches past the cell it
// stands on", which is why plots sitting one per cell can never overlap. That
// a plot also never stands on ground SMALLER than itself is a separate rule
// with a separate owner — isFarmlandPlot's tread ring in shared/farmland.ts —
// because a farmland cell turned out not to guarantee a cell of ground.
// Written against the derivation so that changing the model's size cannot
// quietly break either property: the assertions are geometric, and none of
// them names a literal bed width.
// ─────────────────────────────────────────────────────────────────────────────

describe('crop plot footprint (card 28)', () => {
  /**
   * How far the plot's furthest point sits from its own centre, in cells, at a
   * given scale roll. The cluster occupies a SQUARE the yaw roll may turn to
   * any angle, so its reach is that square's circumradius — half its diagonal
   * — never half its edge.
   */
  function reachAtScale(scale: number): number {
    return (CROP_PLOT_CLUSTER_CELL_SPAN * scale * Math.SQRT2) / 2;
  }

  it('never reaches past half a cell, at the LARGEST scale roll and the worst yaw', () => {
    expect(reachAtScale(CROP_SCALE_MAX)).toBeLessThanOrEqual(CROP_PLOT_MAX_REACH_CELLS);
  });

  it('two plots on adjacent cells cannot overlap — the owner rule, as geometry', () => {
    // Adjacent cells are one cell apart centre to centre; two plots overlap
    // exactly when their reaches sum to more than that distance. Diagonal
    // neighbours are further apart (√2 cells) and so are covered a fortiori.
    const worstCase = reachAtScale(CROP_SCALE_MAX) * 2;
    expect(worstCase).toBeLessThanOrEqual(1);
  });

  it('fills its cell rather than shrinking away from it — a field reads as a field, not as dots', () => {
    // The other half of the rule: "only next to each other" is a floor as well
    // as a ceiling, or a run of farmland cells draws as scattered dots. The
    // floor with no arbitrary number in it: even the SMALLEST scale roll must
    // cover more than half its cell edge, so the bare gap between two
    // neighbouring plots is always narrower than the plots themselves.
    const smallestSpanInCells = CROP_PLOT_CLUSTER_CELL_SPAN * CROP_SCALE_MIN;
    expect(smallestSpanInCells).toBeGreaterThan(1 - smallestSpanInCells);
  });

  it('every scale roll the hash can produce obeys the bound', () => {
    // Not just the endpoints: cropVariation's scale comes from a byte, so walk
    // the whole reachable set rather than trusting the interpolation.
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        expect(reachAtScale(cropVariation(x, y).scale)).toBeLessThanOrEqual(
          CROP_PLOT_MAX_REACH_CELLS,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-STALK VARIATION (owner, 2026-08-24: "so it looks more organic")
//
// The properties a field's look actually rests on, not the numbers: every
// stalk of a plot differs from its siblings, no stalk leaves the plot, and the
// whole thing is reproducible so two players see the same field.
// ─────────────────────────────────────────────────────────────────────────────

describe('per-stalk variation (card 28)', () => {
  const STALK_INDICES = Array.from({ length: CROP_STALKS_PER_PLOT }, (_, i) => i);

  it('gives the four stalks of one plot four different rolls', () => {
    // The whole point: four identical stalks on lattice points read as copies.
    const rolls = STALK_INDICES.map((i) => cropStalkVariation(7, 11, i));
    expect(new Set(rolls.map((r) => r.yaw)).size).toBe(CROP_STALKS_PER_PLOT);
    expect(new Set(rolls.map((r) => r.height)).size).toBe(CROP_STALKS_PER_PLOT);
  });

  it('gives neighbouring plots different clumps', () => {
    // A field is many plots; if the roll ignored the cell, every plot would be
    // the same clump repeated and the grid would come straight back.
    const here = cropStalkVariation(7, 11, 0);
    expect(cropStalkVariation(8, 11, 0).yaw).not.toBe(here.yaw);
    expect(cropStalkVariation(7, 12, 0).yaw).not.toBe(here.yaw);
  });

  it('is deterministic — the same cell and index roll identically every call', () => {
    // Two players looking at the same field must see the same field; this is
    // also what lets the preview harness pin a cell and get a stable capture.
    for (const i of STALK_INDICES) {
      const first = cropStalkVariation(7, 11, i);
      for (let n = 0; n < 50; n++) expect(cropStalkVariation(7, 11, i)).toEqual(first);
    }
  });

  it('keeps every roll inside its declared bounds, over a whole board of cells', () => {
    // The bounds are not decorative: wheatVariants.ts asserts each variant's
    // reach against the plot using exactly CROP_STALK_JITTER_IN_CLUSTER_SPANS
    // as the worst-case wander, so a roll outside it would put wheat off its
    // own plot without tripping that guard.
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) {
        for (const i of STALK_INDICES) {
          const roll = cropStalkVariation(x, y, i);
          expect(roll.yaw).toBeGreaterThanOrEqual(0);
          expect(roll.yaw).toBeLessThan(Math.PI * 2);
          expect(Math.abs(roll.height - 1)).toBeLessThanOrEqual(CROP_STALK_HEIGHT_SPREAD);
          expect(Math.abs(roll.jitterX)).toBeLessThanOrEqual(CROP_STALK_JITTER_IN_CLUSTER_SPANS);
          expect(Math.abs(roll.jitterZ)).toBeLessThanOrEqual(CROP_STALK_JITTER_IN_CLUSTER_SPANS);
        }
      }
    }
  });

  it('plants every stalk, at its worst wander, inside the plot it belongs to', () => {
    // The planted corner alone, before any plant is put on it: offset plus
    // wander, on the diagonal, must still leave room inside half the span.
    const plantedCorner =
      (CROP_STALK_OFFSET_IN_CLUSTER_SPANS + CROP_STALK_JITTER_IN_CLUSTER_SPANS) *
      CROP_PLOT_CLUSTER_CELL_SPAN *
      Math.SQRT2;
    expect(plantedCorner).toBeLessThan(CROP_PLOT_CLUSTER_CELL_SPAN / 2);
  });
});
