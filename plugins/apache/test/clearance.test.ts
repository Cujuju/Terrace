import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Vector3 } from 'three';
import { drawnWorldUnits } from '@terrace/shared';
import { APACHE_CLEARANCE_RADIUS_WORLD_UNITS, ROOFTOP_CLEARANCE } from '../protocol.ts';
import { corridorLift, terrainCapY } from '../clearance.ts';
import { planFlyby, settlements } from '../server/settlements.ts';
import { readAsset, testWorld } from './fixtures.ts';

test('the real watchtower fits below the approved aircraft envelope on raw-17 ground', () => {
  const asset = readAsset(new URL('../../structures/client/assets/authored/low/watchtower.glb', import.meta.url));
  const world = testWorld({ structures: [{ x: 230, y: 274 }] });
  try {
    const bounds = new Box3().setFromObject(asset.scene), size = bounds.getSize(new Vector3());
    // Documented copy: watchtower real bulk is 15 × 6 × 6 metres; the largest placement scale is 1.1.
    const bulk = drawnWorldUnits(15) * drawnWorldUnits(6) ** 2;
    const scale = Math.cbrt(bulk / (size.x * size.y * size.z)) * 1.1;
    const roofHeight = bounds.max.y * scale;
    assert.ok(roofHeight < ROOFTOP_CLEARANCE);
    assert.equal(terrainCapY(17), 0.25);
    settlements.load(world.api);
    let draws = 0;
    const plan = planFlyby(world.api, 1, () => draws++ === 0 ? 0.125 : 0.75, { x: 230, y: 274 });
    assert.ok(plan);
    assert.equal(plan.flight.heading, Math.PI / 4);
    assert.ok(plan.flight.altitude - APACHE_CLEARANCE_RADIUS_WORLD_UNITS > terrainCapY(17) + roofHeight);
  } finally { settlements.clear(); world.revoke(); asset.dispose(); }
});

test('the complete corridor detects off-centre terrain and clears maximum-height terrain', () => {
  const flight = { id: 1, centreX: 256, centreY: 256, heading: 0, turn: 1, altitude: 4.5, elapsed: 0 };
  const groundAt = (x: number, y: number) => x === 255 && y === 258 ? terrainCapY(640) : terrainCapY(17);
  assert.ok(corridorLift(flight, 10.5, 14, 512, groundAt, ROOFTOP_CLEARANCE) > 0);
  const world = testWorld({ heightAt: () => 1024, structures: [{ x: 256, y: 256 }] });
  try {
    settlements.load(world.api);
    const plan = planFlyby(world.api, 1, () => 0.125, { x: 256, y: 256 });
    assert.ok(plan);
    assert.ok(plan.flight.altitude - APACHE_CLEARANCE_RADIUS_WORLD_UNITS >= terrainCapY(1024) + ROOFTOP_CLEARANCE);
  } finally { settlements.clear(); world.revoke(); }
});
