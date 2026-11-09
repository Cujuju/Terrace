import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_WORLD_SIZE, CHUNK_SIZE, createSeededRng } from '@terrace/shared';
import { createFlightPose, sampleFlight } from '../flight.ts';
import { plugin } from '../server/index.ts';
import { planFlyby, settlements } from '../server/settlements.ts';
import { testWorld } from './fixtures.ts';

test('withholds a visible aircraft whose settlement is hidden, then reveals it when dependencies unlock', () => {
  let revealed = false;
  const world = testWorld({ visible: (id, x) => id === 'explorer' || revealed || x < 256 });
  try {
    plugin.onWorldCreate!(world.api);
    plugin.onTick!(world.api, 20);
    for (let i = 0; i < 140; i++) plugin.onTick!(world.api, 0.1);
    assert.ok(world.messages.some(({ playerId, payload }) => playerId === 'explorer' && payload.flight !== null));
    assert.ok(world.messages.filter(({ playerId }) => playerId === 'viewer').every(({ payload }) => payload.flight === null));
    revealed = true;
    plugin.onTick!(world.api, 0.1);
    assert.ok(world.messages.filter(({ playerId }) => playerId === 'viewer').at(-1)!.payload.flight);
  } finally { plugin.onWorldClose!(world.api); world.revoke(); }
});

test('keeps rejected-bearing terrain private even with a visible target and current aircraft', () => {
  const random = createSeededRng(0xa64 ^ 512 ^ 1).next;
  const heading = random() * Math.PI * 2;
  const first = sampleFlight({ id: 1, centreX: 256, centreY: 256, heading, turn: 1, altitude: 0, elapsed: 0 }, 0, createFlightPose());
  const ridge = { x: Math.round(first.x / CELL_WORLD_SIZE), y: Math.round(first.z / CELL_WORLD_SIZE) };
  const cx = Math.floor(ridge.x / CHUNK_SIZE), cy = Math.floor(ridge.y / CHUNK_SIZE);
  const world = testWorld({
    heightAt: (x, y) => x === ridge.x && y === ridge.y ? 1024 : 17,
    visible: (id, x, y) => id === 'explorer' || Math.floor(x / CHUNK_SIZE) !== cx || Math.floor(y / CHUNK_SIZE) !== cy,
  });
  try {
    plugin.onWorldCreate!(world.api);
    assert.equal(plugin.onAction!(world.api, 'flyby', { x: 256, y: 256 }).ok, true);
    const flight = world.messages.find(({ playerId, payload }) => playerId === 'explorer' && payload.flight)!.payload.flight!;
    assert.notEqual(flight.heading, heading);
    const current = sampleFlight(flight, 0, createFlightPose());
    assert.equal(world.api.isCellVisibleTo('viewer', current.x / CELL_WORLD_SIZE, current.z / CELL_WORLD_SIZE), true);
    assert.equal(world.api.isCellVisibleTo('viewer', flight.centreX, flight.centreY), true);
    assert.equal(world.messages.filter(({ playerId }) => playerId === 'viewer').at(-1)!.payload.flight, null);
  } finally { plugin.onWorldClose!(world.api); world.revoke(); }
});

test('does not require unrelated settlement chunks while retaining every actual terrain dependency', () => {
  const world = testWorld({ structures: [{ x: 256, y: 256 }, { x: 400, y: 400 }] });
  try {
    settlements.load(world.api);
    const plan = planFlyby(world.api, 1, () => 0.125, { x: 256, y: 256 });
    assert.ok(plan);
    const keys = new Set(plan.visibilityCells.map(({ x, y }) => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`));
    for (const cell of world.reads) {
      assert.ok(keys.has(`${Math.floor(cell.x / CHUNK_SIZE)},${Math.floor(cell.y / CHUNK_SIZE)}`));
    }
    assert.ok(!keys.has(`${Math.floor(400 / CHUNK_SIZE)},${Math.floor(400 / CHUNK_SIZE)}`));
  } finally { settlements.clear(); world.revoke(); }
});

test('omits locked corridor cells without reading or withholding on them', () => {
  let lockedQueries = 0;
  const world = testWorld({ unlocked: (x) => { if (x < 208) lockedQueries++; return x >= 208; },
    heightAt: (x, y) => {
      assert.ok(x >= 208);
      return 17;
    } });
  try {
    settlements.load(world.api);
    const plan = planFlyby(world.api, 1, () => 0.125, { x: 256, y: 256 });
    assert.ok(plan);
    assert.ok(lockedQueries > 0);
    assert.ok(plan.visibilityCells.every(({ x, y }) => world.api.isCellUnlocked(x, y)));
  } finally { settlements.clear(); world.revoke(); }
});

test('plans visible low passes at the starting territory frontier without reading locked terrain', () => {
  const unlocked = (x: number, y: number) => x >= 96 && x < 416 && y >= 96 && y < 416;
  for (const [x, y] of [[100, 100], [100, 256], [256, 256], [412, 412]]) {
    const world = testWorld({ structures: [{ x, y }], unlocked,
      heightAt: (sx, sy) => { assert.ok(unlocked(sx, sy)); return 17; } });
    try {
      settlements.load(world.api);
      const plan = planFlyby(world.api, 1, () => 0.3);
      assert.ok(plan, `no flight at frontier settlement (${x},${y})`);
      assert.ok(plan.visibilityCells.every(({ x: sx, y: sy }) => unlocked(sx, sy)));
    } finally { settlements.clear(); world.revoke(); }
  }
});
