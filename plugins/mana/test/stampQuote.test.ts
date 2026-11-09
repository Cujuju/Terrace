import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySculpt, bandLevelHeight, BEDROCK_BAND, createHeightmap, DEFAULT_SCULPT_AMOUNT,
  displacementOf, MAX_HEIGHT, packColumnSpans, sculptOptionsOf, setColumn, CHUNK_SIZE,
  snapshotSolidUnits, strokeSolidMeasure, type Heightmap, type SculptIntent,
} from '@terrace/shared';
import { dryRunDisplacement } from '../client/quote.ts';
import { closedStrokeChunks, sculptIntentCost, strokeChargeCost } from '../pricing.ts';

const SIZE = 64;
const CENTRE = SIZE / 2;
const FLOOR_BAND = 10;
const MANA_PER_CELL = 10;
let state: typeof import('../client/state.ts');
let hud: typeof import('../../../client/src/state/hudState.ts');

function territory(map: Heightmap) {
  return { worldSize: () => SIZE, revealedAt: () => true,
    terrainSampleAt: (x: number, y: number) => map.cells[y * SIZE + x],
    terrainSpansAt: (x: number, y: number) => packColumnSpans(map, x, y) };
}

function actual(map: Heightmap, intent: SculptIntent): number {
  const measure = strokeSolidMeasure('stamp');
  const before = snapshotSolidUnits(map, 0, 0, SIZE - 1, SIZE - 1, measure);
  const diff = applySculpt(map, intent.x, intent.y, intent.radius, DEFAULT_SCULPT_AMOUNT * intent.dir, sculptOptionsOf(intent));
  return displacementOf(before, map, diff, measure);
}

beforeEach(async () => {
  vi.resetModules();
  state = await import('../client/state.ts');
  hud = await import('../../../client/src/state/hudState.ts');
  state.setManaPool({ balance: 1000, capacity: 1000, manaPerBandCell: MANA_PER_CELL, regenPerSecond: 0 });
  hud.setBrushTool('stamp'); hud.setBrushProfile('hard'); hud.setBrushRadius(4); hud.setSculptMode('raise');
});

describe('stamp quotes describe the edited surface', () => {
  it.each([false, true])('shows the same admission boundary as the gate (funded: %s)', (funded) => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(FLOOR_BAND));
    const local = { ...territory(map), revealedAt: (x: number, y: number) =>
      Math.floor(x / CHUNK_SIZE) === CENTRE / CHUNK_SIZE &&
      Math.floor(y / CHUNK_SIZE) === CENTRE / CHUNK_SIZE };
    const intent: SculptIntent = { type: 'sculpt', x: CENTRE, y: CENTRE, radius: 4,
      dir: 1, tool: 'stamp', profile: 'stepped' };
    const required = sculptIntentCost(MANA_PER_CELL, intent,
      closedStrokeChunks(SIZE, intent, (cx, cy) => local.revealedAt(cx * CHUNK_SIZE, cy * CHUNK_SIZE)).length);
    state.setLocalTerritory(local);
    hud.setBrushProfile('stepped');
    hud.setHoverPick({ x: CENTRE, y: CENTRE, face: 'tread', band: FLOOR_BAND,
      sculptTarget: { x: CENTRE, y: CENTRE, spanBand: null } });
    const capacity = 1000;
    state.setManaPool({ balance: required - (funded ? 0 : 1), capacity,
      manaPerBandCell: MANA_PER_CELL, regenPerSecond: capacity });
    const quote = state.currentBrushQuote();
    expect(quote.cost).toBeLessThan(required);
    expect(quote).toMatchObject({ required, affordable: funded, estimated: false });
    const pool = state.manaPool();
    if (pool === null) throw new Error('missing pool');
    const regenWindowMs = 1000;
    expect(state.liveBalance(pool, performance.now() + regenWindowMs)).toBeGreaterThanOrEqual(required);
    expect(state.gateLocalSculpt(intent, local)).toBe(funded);
    if (!funded) expect(state.lastDeniedCost()).toBe(required);
  });

  it.each([1, -1] as const)('preserves spans for direction %i beneath a maximum-height roof', (dir) => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      setColumn(map, x, y, [{ floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(FLOOR_BAND) },
        { floorBand: 20, ceiling: MAX_HEIGHT }]);
    }
    const intent: SculptIntent = { type: 'sculpt', x: CENTRE, y: CENTRE, radius: 4, dir,
      tool: 'stamp', profile: 'hard', spanBand: FLOOR_BAND };
    state.setLocalTerritory(territory(map));
    hud.setSculptMode(dir > 0 ? 'raise' : 'lower');
    hud.setHoverPick({ x: CENTRE, y: CENTRE, face: 'tread', band: FLOOR_BAND,
      sculptTarget: { x: CENTRE, y: CENTRE, spanBand: FLOOR_BAND } });
    const measured = dryRunDisplacement(territory(map), intent);
    const quote = state.currentBrushQuote();
    const moved = actual(map, intent);
    expect(moved).toBeGreaterThan(0);
    expect(measured).toBe(moved);
    expect(quote).toEqual({ cost: strokeChargeCost(moved, MANA_PER_CELL, intent), estimated: false, unlockCost: 0,
      required: sculptIntentCost(MANA_PER_CELL, intent, 0), affordable: true });
  });

  it('quotes the riser foot rather than the maximum-height face cell', () => {
    const map = createHeightmap(SIZE); map.cells.fill(bandLevelHeight(0));
    for (let y = 0; y < SIZE; y++) for (let x = CENTRE + 1; x < SIZE; x++) map.cells[y * SIZE + x] = MAX_HEIGHT;
    hud.setBrushRadius(1);
    state.setLocalTerritory(territory(map));
    hud.setHoverPick({ x: CENTRE + 1, y: CENTRE, face: 'riser', band: FLOOR_BAND,
      sculptTarget: { x: CENTRE, y: CENTRE, spanBand: null } });
    const intent: SculptIntent = { type: 'sculpt', x: CENTRE, y: CENTRE, radius: 1, dir: 1, tool: 'stamp', profile: 'hard' };
    const quote = state.currentBrushQuote();
    expect(quote).toEqual({ cost: strokeChargeCost(actual(map, intent), MANA_PER_CELL, intent), estimated: false, unlockCost: 0,
      required: sculptIntentCost(MANA_PER_CELL, intent, 0), affordable: true });
    expect(quote.cost).toBeGreaterThan(0);
  });
});
