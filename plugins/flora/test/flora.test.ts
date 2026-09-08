import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  type RecordedMessage,
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
  worldWithSibling,
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
import { ScorchField } from '../server/scorch.ts';
import { FLORA_STABILITY_SECONDS, StabilityMap } from '../server/stability.ts';
import { loadStructuresBridge, resetStructuresBridge } from '../server/structures-bridge.ts';
import { worldWithTerrain } from './support/world.ts';

const WORLD_SIZE = cellsAcross(64);

const DT = 0.1;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

const FOREST_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_FOREST_MESSAGE}`;
const CHANGES_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CHANGES_MESSAGE}`;
const CROPS_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CROPS_MESSAGE}`;
const CROP_CHANGES_WIRE_TYPE = `${FLORA_PLUGIN_NAME}:${FLORA_CROP_CHANGES_MESSAGE}`;

const GREEN_MID_BAND = Math.floor((FLORA_MIN_BAND + FLORA_MAX_BAND) / 2);

const STRIPE_BANDS: readonly number[] = [
  FLORA_MIN_BAND - 3,
  FLORA_MIN_BAND - 2,
  FLORA_MIN_BAND - 1,
  FLORA_MIN_BAND,
  GREEN_MID_BAND,
  FLORA_MAX_BAND,
  FLORA_MAX_BAND + 1,
  FLORA_MAX_BAND + 2,
];

const STRIPE_WIDTH = Math.floor(WORLD_SIZE / STRIPE_BANDS.length);

function stripedHeight(x: number, _y: number): number {
  const stripe = Math.floor(x / STRIPE_WIDTH) % STRIPE_BANDS.length;
  return STRIPE_BANDS[stripe] * BAND_HEIGHT;
}

function columnInBand(band: number): number {
  const stripe = STRIPE_BANDS.indexOf(band);
  if (stripe < 0) throw new Error(`band ${band} is not one of the fixture world's stripes`);
  return stripe * STRIPE_WIDTH + Math.floor(STRIPE_WIDTH / 2);
}

const GREEN_STRIPE_BANDS = STRIPE_BANDS.filter((band) => isGreenBand(band * BAND_HEIGHT));
const BARE_STRIPE_BANDS = STRIPE_BANDS.filter((band) => !isGreenBand(band * BAND_HEIGHT));

const GREEN_CELLS = GREEN_STRIPE_BANDS.length * STRIPE_WIDTH * WORLD_SIZE;

const LOCKED_CHUNK_ROW = 0;
function isChunkLocked(_cx: number, cy: number): boolean {
  return cy === LOCKED_CHUNK_ROW;
}

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function bootOn(world: World, restore?: unknown): Harness {
  resetFloraState();

  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [floraPlugin].map(asLoadedPlugin));
  if (restore !== undefined) host.restorePersistence({ [FLORA_PLUGIN_NAME]: restore });
  host.worldCreate();

  return { world, host, sink };
}

function boot(locked: (cx: number, cy: number) => boolean = isChunkLocked): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, stripedHeight, locked));
}

function join(harness: Harness): void {
  harness.world.addPlayer(PLAYER);
  grantTokenEveryUnlockedChunk(harness.world, PLAYER.token);
  harness.host.playerJoined(PLAYER);
}

function advance(harness: Harness, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

function floraView(world: World): FloraWorld {
  return {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    heightAt: (x, y) => world.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

function fixedRng(value: number): FloraRng {
  return { next: () => value, state: () => 0 };
}

describe('band eligibility', () => {
  it('accepts exactly the palette\'s green bands, none of which is under water', () => {
    for (let band = FLORA_MIN_BAND - 4; band <= FLORA_MAX_BAND + 4; band++) {
      const expected = band >= FLORA_MIN_BAND && band <= FLORA_MAX_BAND;
      expect(isGreenBand(band * BAND_HEIGHT)).toBe(expected);
      expect(isGreenBand(band * BAND_HEIGHT + BAND_HEIGHT - 1)).toBe(expected);
    }

    for (let h = MIN_HEIGHT; h <= SEA_LEVEL; h += 17) {
      expect(isGreenBand(h)).toBe(false);
    }
    expect(isGreenBand(SEA_LEVEL)).toBe(false);
  });

  it('plants only inside the world, outside locked chunks, and on green ground — never sand, soil or rock', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight, isChunkLocked));
    const green = columnInBand(FLORA_MIN_BAND);

    expect(isPlantableCell(world, green, 0)).toBe(false);
    expect(isPlantableCell(world, green, CHUNK_SIZE)).toBe(true);

    expect(isPlantableCell(world, -1, CHUNK_SIZE)).toBe(false);
    expect(isPlantableCell(world, WORLD_SIZE, CHUNK_SIZE)).toBe(false);
    expect(isPlantableCell(world, green, WORLD_SIZE)).toBe(false);

    for (const band of BARE_STRIPE_BANDS) {
      expect(isPlantableCell(world, columnInBand(band), CHUNK_SIZE)).toBe(false);
    }
    for (const band of GREEN_STRIPE_BANDS) {
      expect(isPlantableCell(world, columnInBand(band), CHUNK_SIZE)).toBe(true);
    }
  });
});

describe('stability tracking', () => {
  it('opens the window at second zero, restarts it on every change, and ignores cells outside the world', () => {
    const stability = new StabilityMap(WORLD_SIZE);
    expect(stability.isStable(3, 4, 0)).toBe(false);
    expect(stability.isStable(3, 4, FLORA_STABILITY_SECONDS - 1)).toBe(false);
    expect(stability.isStable(3, 4, FLORA_STABILITY_SECONDS)).toBe(true);

    const changedAt = 1000;
    stability.markChanged(3, 4, changedAt);

    expect(stability.isStable(3, 4, changedAt + FLORA_STABILITY_SECONDS - 1)).toBe(false);
    expect(stability.isStable(3, 4, changedAt + FLORA_STABILITY_SECONDS)).toBe(true);
    expect(stability.isStable(4, 4, changedAt + 1)).toBe(true);

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

  it('spreads a deficit over time, rounds a fractional expectation stochastically, and never exceeds the ceiling or the deficit', () => {
    const deficit = 120;
    const expected = deficit * (FLORA_SURVEY_INTERVAL_SECONDS / FLORA_MEAN_SPROUT_WAIT_SECONDS);
    expect(expected).toBe(20);
    expect(sproutCount(deficit, fixedRng(0.99))).toBe(20);
    expect(sproutCount(deficit, fixedRng(0))).toBe(20);

    expect(sproutCount(3, fixedRng(0.4))).toBe(1);
    expect(sproutCount(3, fixedRng(0.6))).toBe(0);

    expect(sproutCount(FLORA_TREE_CAP, fixedRng(0))).toBe(FLORA_MAX_SPROUTS_PER_SURVEY);
    expect(sproutCount(1, fixedRng(0))).toBe(1);
    expect(sproutCount(0, fixedRng(0))).toBe(0);
    expect(sproutCount(-5, fixedRng(0))).toBe(0);
  });

  it('settles at the density the constants describe, keeps trees apart by the spacing rule, and stops', () => {
    const world = floraView(worldWithTerrain(WORLD_SIZE, stripedHeight));
    const stability = new StabilityMap(WORLD_SIZE);
    const forest = new Forest();
    const rng = createFloraRng(2);

    const target = treeTargetFor(GREEN_CELLS);
    for (let n = 0; n < 600; n++) {
      forest.survey(world, stability, FLORA_STABILITY_SECONDS + n * FLORA_SURVEY_INTERVAL_SECONDS, rng);
      expect(forest.count).toBeLessThanOrEqual(target);
    }
    expect(forest.count).toBeGreaterThan(target / 2);

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
});

const RUN_BEFORE_WINDOW_SECONDS = FLORA_STABILITY_SECONDS - FLORA_SURVEY_INTERVAL_SECONDS * 2;
const RUN_FIRST_SURVEY_SECONDS = FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS + 1;
const RUN_GROWTH_INTERVALS = 12;

interface GrowthRun {
  readonly treesBeforeWindow: number;
  readonly changesBeforeWindow: number;
  readonly treesAfterFirstSurvey: number;
  readonly changesAfterFirstSurvey: number;
  readonly trees: readonly TreeCell[];
  readonly changes: readonly RecordedMessage[];
  readonly world: FloraWorld;
  readonly isCellUnlocked: (x: number, y: number) => boolean;
  readonly slice: unknown;
}

let run: GrowthRun;

beforeAll(() => {
  const harness = boot();
  join(harness);

  advance(harness, RUN_BEFORE_WINDOW_SECONDS);
  const treesBeforeWindow = standingTrees().length;
  const changesBeforeWindow = harness.sink.ofType(CHANGES_WIRE_TYPE).length;

  advance(harness, RUN_FIRST_SURVEY_SECONDS - RUN_BEFORE_WINDOW_SECONDS);
  const treesAfterFirstSurvey = standingTrees().length;
  const changesAfterFirstSurvey = harness.sink.ofType(CHANGES_WIRE_TYPE).length;

  advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * RUN_GROWTH_INTERVALS);
  const trees = [...standingTrees()];
  expect(trees.length).toBeGreaterThan(1);

  run = {
    treesBeforeWindow,
    changesBeforeWindow,
    treesAfterFirstSurvey,
    changesAfterFirstSurvey,
    trees,
    changes: harness.sink.ofType(CHANGES_WIRE_TYPE),
    world: floraView(harness.world),
    isCellUnlocked: (x, y) => harness.world.isCellUnlocked(x, y),
    slice: harness.host.collectPersistence()[FLORA_PLUGIN_NAME],
  };
});

function bootGrown(): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, stripedHeight, () => false), run.slice);
}

function grownOf(message: RecordedMessage): TreeCell[] {
  return parseTreeCells((message.payload as { grown: number[] }).grown) ?? [];
}

function felledOf(message: RecordedMessage): TreeCell[] {
  return parseTreeCells((message.payload as { felled: number[] }).felled) ?? [];
}

describe('growth', () => {
  it('grows nothing until the stability window has passed, then fills the meadow gradually', () => {
    expect(run.treesBeforeWindow).toBe(0);
    expect(run.treesAfterFirstSurvey).toBeGreaterThan(0);

    expect(run.treesAfterFirstSurvey).toBeLessThanOrEqual(FLORA_MAX_SPROUTS_PER_SURVEY);
    expect(run.trees.length).toBeGreaterThan(run.treesAfterFirstSurvey);
  });

  it('completes one survey per interval whatever the world size', () => {
    const sweeps = run.changes.length - run.changesAfterFirstSurvey;

    expect(sweeps).toBeLessThanOrEqual(RUN_GROWTH_INTERVALS);
    expect(sweeps).toBeGreaterThanOrEqual(RUN_GROWTH_INTERVALS - 2);
  });

  it('only ever plants on unlocked green ground', () => {
    for (const tree of run.trees) {
      expect(isPlantableCell(run.world, tree.x, tree.y)).toBe(true);
      expect(run.isCellUnlocked(tree.x, tree.y)).toBe(true);
      expect(tree.y).toBeGreaterThanOrEqual(CHUNK_SIZE);
    }
  });
});

describe('felling', () => {
  it('fells every tree the diff touched, and broadcasts the removals as a delta', () => {
    const harness = bootGrown();
    join(harness);
    const victim = standingTrees()[0];
    const before = standingTrees().length;
    harness.sink.clear();

    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: MAX_BRUSH_RADIUS, dir: -1 },
    );
    expect(outcome.applied).toBe(true);

    expect(currentForest().has(victim.x, victim.y)).toBe(false);
    expect(standingTrees().length).toBeLessThan(before);
    for (const tree of standingTrees()) {
      expect(isPlantableCell(floraView(harness.world), tree.x, tree.y)).toBe(true);
    }

    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    expect(felledOf(changes[0])).toContainEqual({ x: victim.x, y: victim.y });
    expect(grownOf(changes[0])).toHaveLength(0);
  });
});

describe('structure occupancy — buildings always win', () => {

  afterEach(() => {
    resetStructuresBridge();
  });

  it('fells a tree the instant its cell is named seeded or upgraded, broadcasts it, and does not replant when the structure dies', () => {
    const harness = bootGrown();
    join(harness);
    const [seededVictim, upgradedVictim] = standingTrees();
    expect(upgradedVictim).toBeDefined();
    harness.sink.clear();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [{ x: seededVictim.x, y: seededVictim.y, tier: 0 }],
      upgraded: [{ x: upgradedVictim.x, y: upgradedVictim.y, tier: 1 }],
      died: [],
    });

    expect(currentForest().has(seededVictim.x, seededVictim.y)).toBe(false);
    expect(currentForest().has(upgradedVictim.x, upgradedVictim.y)).toBe(false);
    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    expect(felledOf(changes[0])).toContainEqual({ x: seededVictim.x, y: seededVictim.y });
    expect(felledOf(changes[0])).toContainEqual({ x: upgradedVictim.x, y: upgradedVictim.y });
    harness.sink.clear();

    harness.host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      died: [{ x: seededVictim.x, y: seededVictim.y }],
    });

    expect(currentForest().has(seededVictim.x, seededVictim.y)).toBe(false);
    expect(harness.sink.ofType(CHANGES_WIRE_TYPE)).toHaveLength(0);
  });

  it('clears a pre-existing overlap on the first completed survey after structures resolves', () => {
    const harness = bootGrown();
    const victim = standingTrees()[0];

    resetStructuresBridge();
    loadStructuresBridge(
      worldWithSibling('structures', {
        standingStructures: () => [{ x: victim.x, y: victim.y }],
      }),
    );

    advance(harness, FLORA_SURVEY_INTERVAL_SECONDS + DT);
    expect(currentForest().has(victim.x, victim.y)).toBe(false);
  });

  it('is deterministic: the same growth, event and occupancy history produces the same forest twice', () => {
    const GROWTH_SURVEYS = 3;
    const SURVEYS_AFTER_EVENT = 1;

    function run(): TreeCell[] {
      const harness = boot(() => false);
      join(harness);
      advance(harness, FLORA_STABILITY_SECONDS + FLORA_SURVEY_INTERVAL_SECONDS * GROWTH_SURVEYS);
      const trees = standingTrees();
      expect(trees.length).toBeGreaterThan(1);

      harness.host.notifyWorldEvent('structures:changes', {
        cause: 'generation',
        seeded: [{ x: trees[0].x, y: trees[0].y, tier: 0 }],
        upgraded: [{ x: trees[1].x, y: trees[1].y, tier: 1 }],
        died: [],
      });
      advance(harness, FLORA_SURVEY_INTERVAL_SECONDS * SURVEYS_AFTER_EVENT);
      return [...standingTrees()];
    }

    const first = run();
    const second = run();
    expect(second).toEqual(first);
  });
});

describe('broadcast model', () => {
  it('sends growth as a delta, and says nothing when nothing changed', () => {
    expect(run.changesBeforeWindow).toBe(0);

    const firstGrown = grownOf(run.changes[0]);
    expect(firstGrown.length).toBeGreaterThan(0);
    expect(firstGrown.length).toBeLessThanOrEqual(FLORA_MAX_SPROUTS_PER_SURVEY);

    let announced = 0;
    for (const message of run.changes) announced += grownOf(message).length;
    expect(announced).toBe(run.trees.length);
    expect(run.changes.length).toBeGreaterThan(1);
  });

  it('sends each connected player only the trees inside their own unlocked view — the whole forest on join and on keepalive, nothing when empty', () => {
    const harness = bootGrown();
    join(harness);

    const joinSnapshots = harness.sink.ofType(FOREST_WIRE_TYPE);
    expect(joinSnapshots).toHaveLength(1);
    expect(joinSnapshots[0].target).toBe(PLAYER.id);
    const joinCells = parseTreeCells((joinSnapshots[0].payload as { trees: number[] }).trees) ?? [];
    expect(joinCells).toHaveLength(standingTrees().length);

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

    expect(forPlayer).toHaveLength(1);
    expect(forPlayer[0].target).toBe(PLAYER.id);
    const playerCells = parseTreeCells((forPlayer[0].payload as { trees: number[] }).trees) ?? [];
    expect(playerCells).toHaveLength(standingTrees().length);

    expect(forOutsider).toHaveLength(0);
  });

  it('pushes a targeted refresh when a player creeps into a chunk that already has trees', () => {
    const harness = bootGrown();
    const victim = standingTrees()[0];
    const cx = Math.floor(victim.x / CHUNK_SIZE);
    const cy = Math.floor(victim.y / CHUNK_SIZE);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);
    harness.sink.clear();

    expect(harness.world.unlockChunkForToken(outsider.token, cx, cy)).toBe(true);
    harness.host.notifyChunkUnlockedForToken(outsider.token, cx, cy);

    const changes = harness.sink
      .ofType(CHANGES_WIRE_TYPE)
      .filter((m) => m.target === outsider.id);
    expect(changes).toHaveLength(1);
    expect(grownOf(changes[0])).toContainEqual({ x: victim.x, y: victim.y });
    expect(felledOf(changes[0])).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('round-trips a forest across a restart', () => {
    const first = bootGrown();
    const before = standingTrees();
    expect(before.length).toBeGreaterThan(0);

    const slice = first.host.collectPersistence()[FLORA_PLUGIN_NAME];

    const second = bootOn(worldWithTerrain(WORLD_SIZE, stripedHeight), slice);
    expect(standingTrees()).toEqual(before);

    join(second);
    const snapshots = second.sink.ofType(FOREST_WIRE_TYPE).filter((m) => m.target === PLAYER.id);
    const cells = parseTreeCells((snapshots[0].payload as { trees: number[] }).trees) ?? [];
    expect(cells).toHaveLength(before.length);
  });

  it('survives a truncated, foreign or hand-edited slice, and caps one that claims more trees than the world may hold', () => {
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

    const mixed = loadForestSlice({
      version: FLORA_SLICE_VERSION,
      rngState: rng.state(),
      trees: [5, 6, -1, 3, 7, 1.5, 9, 9, 9, 9],
    });
    expect(mixed.cells).toEqual([
      { x: 5, y: 6 },
      { x: 9, y: 9 },
    ]);

    const trees: number[] = [];
    for (let n = 0; n < FLORA_TREE_CAP + 100; n++) trees.push(n % 512, Math.floor(n / 512));
    const restored = loadForestSlice({ version: FLORA_SLICE_VERSION, rngState: 1, trees });
    expect(restored.cells).toHaveLength(FLORA_TREE_CAP);
  });

  it('fells restored trees that no longer stand on green ground', () => {
    const rock = bootOn(
      worldWithTerrain(WORLD_SIZE, () => (FLORA_MAX_BAND + 2) * BAND_HEIGHT),
      run.slice,
    );
    expect(standingTrees().length).toBeGreaterThan(0);

    advance(rock, FLORA_SURVEY_INTERVAL_SECONDS + DT);
    expect(standingTrees()).toHaveLength(0);
  });

  it('writes a slice this plugin can read back verbatim', () => {
    const forest = new Forest();
    forest.plant(3, 4);
    forest.plant(40, 41);
    const rng = createFloraRng(99);
    rng.next();

    const slice = saveForest(forest, rng, new ScorchField(), 0);
    expect(slice.version).toBe(FLORA_SLICE_VERSION);

    const restored = loadForestSlice(JSON.parse(JSON.stringify(slice)));
    expect(restored.cells).toEqual([
      { x: 3, y: 4 },
      { x: 40, y: 41 },
    ]);
    expect(restored.rngState).toBe(rng.state());
  });
});

describe('crops (card 28) — the CropField survey', () => {
  const CROP_LAND_BAND = 3;
  const CROP_DEEP = SEA_LEVEL - BAND_HEIGHT;

  function coastalHeight(x: number, _y: number): number {
    return x === 0 ? CROP_DEEP : CROP_LAND_BAND * BAND_HEIGHT;
  }

  function coastalWorld(): World {
    return worldWithTerrain(WORLD_SIZE, coastalHeight);
  }

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

  it('finds exactly the cells with room for a plot — column 2, one cell BACK from the lip — whether surveyed at once, amortised, or twice over', () => {
    const world = coastalWorld();
    const view = floraView(world);
    const expected = expectedPlots(view, WORLD_SIZE);
    expect(isFarmlandCell(view, 1, 10)).toBe(true);
    expect(expected.has('1,10')).toBe(false);
    expect(expected.has('2,10')).toBe(true);
    expect(expected.size).toBe(WORLD_SIZE - 2);

    const field = new CropField();
    const result = field.survey(view, NEVER_OCCUPIED);
    const found = new Set(field.cells().map((c) => `${c.x},${c.y}`));
    expect(found).toEqual(expected);
    expect(result.sprouted).toHaveLength(expected.size);
    expect(result.withered).toHaveLength(0);

    const amortised = new CropField();
    const totalChunks = view.chunksPerEdge * view.chunksPerEdge;
    let outcome = null;
    for (let i = 0; i < totalChunks && outcome === null; i++) {
      outcome = amortised.advance(view, NEVER_OCCUPIED, 1);
    }
    expect(outcome).not.toBeNull();
    expect(new Set(amortised.cells().map((c) => `${c.x},${c.y}`))).toEqual(expected);

    const second = new CropField();
    second.survey(view, NEVER_OCCUPIED);
    expect(second.cells()).toEqual(field.cells());
  });

  it('buildings always win — an occupied farmland cell never shows a crop — and reactToEdit withers its own cell immediately', () => {
    const view = floraView(coastalWorld());
    const occupied = (x: number, y: number): boolean => x === 2 && y === 5;
    const field = new CropField();
    field.survey(view, occupied);
    expect(field.has(2, 5)).toBe(false);
    expect(field.has(2, 6)).toBe(true);

    expect(field.reactToEdit(2, 6)).toEqual({ x: 2, y: 6 });
    expect(field.has(2, 6)).toBe(false);
    expect(field.reactToEdit(2, 6)).toBeNull();
  });

  it('never exceeds FLORA_CROP_CAP, even when far more farmland exists', () => {
    const combSize = 256;
    const COMB_PERIOD_ROWS = 4;
    function combHeight(x: number, y: number): number {
      if (y % COMB_PERIOD_ROWS === 0) return CROP_DEEP;
      return CROP_LAND_BAND * BAND_HEIGHT;
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

  it('sprouts on its own cadence and broadcasts a delta; a sculpt on a crop\'s OWN cell withers it instantly, a NEIGHBOUR-only edit waits for the next survey — the named, accepted residual', () => {
    const harness = bootCoastal();
    join(harness);
    advance(harness, CROP_SURVEY_INTERVAL_SECONDS + DT);

    expect(standingCrops().length).toBeGreaterThan(0);
    const changes = harness.sink.ofType(CROP_CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const sprouted =
      parseCropCells((changes[0].payload as { sprouted: number[] }).sprouted) ?? [];
    expect(sprouted.length).toBeGreaterThan(0);

    const victim = standingCrops().find((c) => c.x === 2) as CropCell;
    expect(victim).toBeDefined();

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: 0, y: victim.y, radius: 1, dir: 1, tool: 'stamp' },
    );
    expect(currentCropField().has(victim.x, victim.y)).toBe(true);

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: 1, dir: 1 },
    );
    expect(currentCropField().has(victim.x, victim.y)).toBe(false);
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
    expect(slice).not.toHaveProperty('crops');

    const second = bootOn(worldWithTerrain(WORLD_SIZE, coastalHeight, () => false), slice);
    expect(standingCrops()).toHaveLength(0);
    advance(second, CROP_SURVEY_INTERVAL_SECONDS + DT);
    const after = new Set(standingCrops().map((c) => `${c.x},${c.y}`));
    expect(after).toEqual(before);
  });
});

describe('crop plot footprint (card 28)', () => {
  function reachAtScale(scale: number): number {
    return (CROP_PLOT_CLUSTER_CELL_SPAN * scale * Math.SQRT2) / 2;
  }

  it('never reaches past half a cell — at the LARGEST scale roll, the worst yaw, and every roll the hash can produce — so two adjacent plots cannot overlap', () => {
    expect(reachAtScale(CROP_SCALE_MAX)).toBeLessThanOrEqual(CROP_PLOT_MAX_REACH_CELLS);

    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        expect(reachAtScale(cropVariation(x, y).scale)).toBeLessThanOrEqual(
          CROP_PLOT_MAX_REACH_CELLS,
        );
      }
    }

    const worstCase = reachAtScale(CROP_SCALE_MAX) * 2;
    expect(worstCase).toBeLessThanOrEqual(1);
  });

  it('fills its cell rather than shrinking away from it — a field reads as a field, not as dots', () => {
    const smallestSpanInCells = CROP_PLOT_CLUSTER_CELL_SPAN * CROP_SCALE_MIN;
    expect(smallestSpanInCells).toBeGreaterThan(1 - smallestSpanInCells);
  });
});

describe('per-stalk variation (card 28)', () => {
  const STALK_INDICES = Array.from({ length: CROP_STALKS_PER_PLOT }, (_, i) => i);

  it('gives the four stalks of one plot, and neighbouring plots, different rolls — deterministically', () => {
    const rolls = STALK_INDICES.map((i) => cropStalkVariation(7, 11, i));
    expect(new Set(rolls.map((r) => r.yaw)).size).toBe(CROP_STALKS_PER_PLOT);
    expect(new Set(rolls.map((r) => r.height)).size).toBe(CROP_STALKS_PER_PLOT);

    const here = rolls[0];
    expect(cropStalkVariation(8, 11, 0).yaw).not.toBe(here.yaw);
    expect(cropStalkVariation(7, 12, 0).yaw).not.toBe(here.yaw);

    for (const i of STALK_INDICES) {
      for (let n = 0; n < 50; n++) expect(cropStalkVariation(7, 11, i)).toEqual(rolls[i]);
    }
  });

  it('keeps every roll inside its declared bounds over a whole board of cells, and those bounds keep every stalk inside its plot', () => {
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

    const plantedCorner =
      (CROP_STALK_OFFSET_IN_CLUSTER_SPANS + CROP_STALK_JITTER_IN_CLUSTER_SPANS) *
      CROP_PLOT_CLUSTER_CELL_SPAN *
      Math.SQRT2;
    expect(plantedCorner).toBeLessThan(CROP_PLOT_CLUSTER_CELL_SPAN / 2);
  });
});
