import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MAX_DRAG_SWEEP_CELLS,
  applySculpt,
  bandLevelHeight,
  cellIndex,
  createHeightmap,
  displacementOf,
  sculptOptionsOf,
  snapshotSolidUnits,
  strokeReachBox,
  type Heightmap,
  type SculptIntent,
} from '@terrace/shared';
import { dryRunDisplacement } from '../client/quote.ts';
import { displacementManaCost, sculptManaCost } from '../pricing.ts';

type ManaClientState = typeof import('../client/state.ts');

let state: ManaClientState;
let hud: typeof import('../../../client/src/state/hudState.ts');

const WORLD_SIZE = CHUNK_SIZE * 8;

const GROUND_BAND = 8;

const SEA_FLOOR = 0;

const MANA_PER_BAND_CELL = 10;

const POOL_CAPACITY = 100000;

const AIM = { x: 40, y: 40, face: 'tread', band: GROUND_BAND } as const;

function groundedWorld(height: number): Heightmap {
  const map = createHeightmap(WORLD_SIZE);
  map.cells.fill(height);
  return map;
}

/** A territory that knows every cell of `map` and owns every chunk. */
function territoryOf(map: Heightmap) {
  return {
    worldSize: () => map.size,
    revealedAt: () => true,
    terrainHeightAt: (x: number, y: number) =>
      x < 0 || y < 0 || x >= map.size || y >= map.size
        ? null
        : map.cells[cellIndex(map, x, y)]!,
  };
}

const UNKNOWN_GROUND = {
  worldSize: () => WORLD_SIZE,
  revealedAt: () => true,
  terrainHeightAt: () => null,
};

/** What the server would charge: the same applier, run on the same ground. */
function serverDisplacement(map: Heightmap, intent: SculptIntent): number {
  const box = strokeReachBox(map.size, intent);
  const before = snapshotSolidUnits(map, box.minX, box.minY, box.maxX, box.maxY);
  const diff = applySculpt(
    map,
    intent.x,
    intent.y,
    intent.radius,
    DEFAULT_SCULPT_AMOUNT * intent.dir,
    sculptOptionsOf(intent),
  );
  return displacementOf(before, map, diff);
}

beforeEach(async () => {
  vi.resetModules();
  state = await import('../client/state.ts');
  hud = await import('../../../client/src/state/hudState.ts');
  state.clearInFlightDebits();
  state.setManaPool({
    balance: POOL_CAPACITY,
    capacity: POOL_CAPACITY,
    manaPerBandCell: MANA_PER_BAND_CELL,
    regenPerSecond: 0,
  });
  state.setLocalTerritory(null);
  hud.setHoverPick(null);
  hud.setBrushTool('stamp');
  hud.setBrushProfile('hard');
  hud.setBrushRadius(4);
  hud.setSculptMode('raise');
});

/** A two-band step across the middle: something for a smooth to melt. */
function stepped(height: number): Heightmap {
  const map = groundedWorld(height);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = AIM.x; x < WORLD_SIZE; x++) {
      map.cells[cellIndex(map, x, y)] = bandLevelHeight(GROUND_BAND + 2);
    }
  }
  return map;
}

/** A plateau with a face: a carve needs one, and flat ground shows none. */
function plateaued(height: number): Heightmap {
  const map = groundedWorld(height);
  for (let y = AIM.y - 6; y <= AIM.y + 6; y++) {
    for (let x = AIM.x - 6; x <= AIM.x + 6; x++) {
      map.cells[cellIndex(map, x, y)] = bandLevelHeight(GROUND_BAND + 2);
    }
  }
  return map;
}

/** A lip at the leg's origin for the drag to carry along its sweep. */
function lipped(height: number): Heightmap {
  const map = groundedWorld(height);
  const from = AIM.x - MAX_DRAG_SWEEP_CELLS;
  for (let y = AIM.y - 4; y <= AIM.y + 4; y++) {
    for (let x = from - 4; x <= from + 4; x++) {
      map.cells[cellIndex(map, x, y)] = bandLevelHeight(GROUND_BAND + 1);
    }
  }
  return map;
}

describe('the client dry-runs the stroke it is about to price', () => {
  const cases: ReadonlyArray<{
    name: string;
    build: () => Heightmap;
    intent: SculptIntent;
  }> = [
    {
      name: 'a hard stamp on land',
      build: () => groundedWorld(bandLevelHeight(GROUND_BAND)),
      intent: { type: 'sculpt', x: AIM.x, y: AIM.y, radius: 4, dir: 1, tool: 'stamp', profile: 'hard' },
    },
    {
      name: 'a soft stamp on land',
      build: () => groundedWorld(bandLevelHeight(GROUND_BAND)),
      intent: { type: 'sculpt', x: AIM.x, y: AIM.y, radius: 8, dir: 1, tool: 'stamp', profile: 'soft' },
    },
    {
      name: 'a raise out of the sea',
      build: () => groundedWorld(SEA_FLOOR),
      intent: { type: 'sculpt', x: AIM.x, y: AIM.y, radius: 4, dir: 1, tool: 'stamp', profile: 'hard' },
    },
    {
      name: 'a smooth on a step',
      build: () => stepped(bandLevelHeight(GROUND_BAND)),
      intent: { type: 'sculpt', x: AIM.x, y: AIM.y, radius: 4, dir: 1, tool: 'smooth' },
    },
    {
      name: 'a carve into a plateau',
      build: () => plateaued(bandLevelHeight(GROUND_BAND)),
      intent: {
        type: 'sculpt',
        x: AIM.x + 5,
        y: AIM.y,
        radius: 4,
        dir: -1,
        tool: 'carve',
        spanBand: GROUND_BAND + 1,
        depthBands: CARVE_DEFAULT_DEPTH_BANDS,
      },
    },
    {
      name: 'a drag leg off a lip',
      build: () => lipped(bandLevelHeight(GROUND_BAND)),
      intent: {
        type: 'sculpt',
        x: AIM.x,
        y: AIM.y,
        radius: 4,
        dir: 1,
        tool: 'drag',
        targetBand: GROUND_BAND + 1,
        fromX: AIM.x - MAX_DRAG_SWEEP_CELLS,
        fromY: AIM.y,
      },
    },
  ];

  it.each(cases)('measures what the server will charge for $name', ({ build, intent }) => {
    const server = serverDisplacement(build(), intent);
    expect(server).toBeGreaterThan(0);
    expect(dryRunDisplacement(territoryOf(build()), intent)).toBe(server);
  });

  it('measures the same units at the world edge, where the scratch has nowhere to grow', () => {
    const intent: SculptIntent = {
      type: 'sculpt',
      x: 0,
      y: 0,
      radius: MAX_BRUSH_RADIUS,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
    };
    const server = serverDisplacement(groundedWorld(bandLevelHeight(GROUND_BAND)), intent);
    expect(server).toBeGreaterThan(0);
    expect(dryRunDisplacement(territoryOf(groundedWorld(bandLevelHeight(GROUND_BAND))), intent)).toBe(
      server,
    );
  });

  it('refuses to guess on ground it has not received', () => {
    const intent: SculptIntent = {
      type: 'sculpt',
      x: AIM.x,
      y: AIM.y,
      radius: 4,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
    };
    expect(dryRunDisplacement(UNKNOWN_GROUND, intent)).toBeNull();
  });
});

describe('the HUD quote says whether it measured or guessed', () => {
  it('quotes the measured price on ground it holds', () => {
    const map = groundedWorld(bandLevelHeight(GROUND_BAND));
    state.setLocalTerritory(territoryOf(map));
    hud.setHoverPick(AIM);

    const intent: SculptIntent = {
      type: 'sculpt',
      x: AIM.x,
      y: AIM.y,
      radius: 4,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
    };
    const moved = dryRunDisplacement(territoryOf(map), intent);
    expect(moved).not.toBeNull();

    const quote = state.currentBrushQuote();
    expect(quote.estimated).toBe(false);
    expect(quote.cost).toBe(displacementManaCost(moved!, MANA_PER_BAND_CELL));
  });

  it('quotes a raise out of the sea for what it moves, far under the nominal', () => {
    const sea = groundedWorld(SEA_FLOOR);
    state.setLocalTerritory(territoryOf(sea));
    hud.setHoverPick(AIM);
    hud.setBrushRadius(MAX_BRUSH_RADIUS);

    const nominal = sculptManaCost(
      MANA_PER_BAND_CELL,
      MAX_BRUSH_RADIUS,
      'hard',
      'stamp',
      CARVE_DEFAULT_DEPTH_BANDS,
    );
    const quote = state.currentBrushQuote();

    expect(quote.estimated).toBe(false);
    expect(quote.cost).toBeGreaterThan(0);
    expect(quote.cost).toBeLessThan(nominal);
  });

  it('falls back to the nominal, and says so, on ground it has not received', () => {
    state.setLocalTerritory(UNKNOWN_GROUND);
    hud.setHoverPick(AIM);

    const quote = state.currentBrushQuote();
    expect(quote.estimated).toBe(true);
    expect(quote.cost).toBe(
      sculptManaCost(MANA_PER_BAND_CELL, 4, 'hard', 'stamp', CARVE_DEFAULT_DEPTH_BANDS),
    );
  });

  it('falls back to the nominal for a tool the hover alone does not describe', () => {
    const map = groundedWorld(bandLevelHeight(GROUND_BAND));
    state.setLocalTerritory(territoryOf(map));
    hud.setHoverPick(AIM);
    hud.setBrushTool('carve');

    expect(state.currentBrushQuote().estimated).toBe(true);
  });

  it('has no quote to measure until the pointer picks a cell', () => {
    const map = groundedWorld(bandLevelHeight(GROUND_BAND));
    state.setLocalTerritory(territoryOf(map));

    expect(state.currentBrushQuote().estimated).toBe(true);
  });
});
