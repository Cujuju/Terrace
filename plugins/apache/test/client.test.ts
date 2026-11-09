import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Group, Mesh, Vector3 } from 'three';
import { CELL_WORLD_SIZE, CHUNK_SIZE, WORLD_UNITS_PER_BAND, createHeightmap, drawnBandAt } from '@terrace/shared';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { ApacheModel } from '../client/model.ts';
import { APACHE_CLEARANCE_RADIUS_WORLD_UNITS, APACHE_DRAW_SCALE, ROOFTOP_CLEARANCE } from '../protocol.ts';
import { terrainCapY } from '../clearance.ts';
import { readAsset } from './fixtures.ts';

const bridge = globalThis as typeof globalThis & { apacheTestModel: ApacheModel };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === new URL('../client/index.ts', import.meta.url).href && specifier === './model.ts') {
      return { url: 'apache-test:model', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'apache-test:model') return {
      format: 'module', shortCircuit: true,
      source: 'export const createApache=()=>globalThis.apacheTestModel; export const preloadApache=async()=>{}; export const releaseApache=()=>{};',
    };
    return next(url, context);
  },
});
const { clientPlugin } = await import('../client/index.ts');
hooks.deregister();

for (const editAt of [2, 13]) for (const revealedOnEdit of [false, true]) test(
  `keeps rotor vertices above ${revealedOnEdit ? 'newly revealed' : 'edited'} terrain at ${editAt}s`, (t) => {
  const map = createHeightmap(512);
  map.cells.fill(17);
  const asset = readAsset(new URL('../../../client/src/assets/apache/apache.glb', import.meta.url));
  const pivot = asset.node('main_rotor_pivot');
  const rotor = asset.node('main_rotor').children[0] as Mesh;
  const point = new Vector3(), up = new Vector3(0, 1, 0);
  const root = new Group();
  let clock = 0, rotorSeconds = 0, rawReads = 0;
  let receive!: (payload: unknown) => void;
  let frame!: (dt: number) => void;
  let terrainChanged!: (dirty: ReadonlySet<number>) => void;
  bridge.apacheTestModel = {
    rig: { root, joints: [], meshes: [], dispose() {} }, materials: [],
    animateRotors(seconds) { rotorSeconds = seconds; }, dispose() {},
  };
  t.mock.method(performance, 'now', () => clock * 1000);
  const drawnAt = (x: number, z: number) => drawnBandAt(map, x + 0.5, z + 0.5) * WORLD_UNITS_PER_BAND;
  // This context exercises the production frame callback without starting a renderer or loading textures.
  const ctx = {
    layer: new Group(), worldSize: () => 512,
    onMessage(_type: string, handler: (payload: unknown) => void) { receive = handler; return () => {}; },
    onFrame(handler: (dt: number) => void) { frame = handler; return () => {}; },
    onWorldReset: () => () => {},
    onTerrainChanged(handler: (dirty: ReadonlySet<number>) => void) { terrainChanged = handler; return () => {}; },
    revealedAt: () => !revealedOnEdit || edited,
    drawnGroundYAt: (x: number, y: number) => revealedOnEdit && !edited ? null : drawnAt(x, y),
    terrainSampleAt(x: number, y: number) {
      if (revealedOnEdit && !edited) return null;
      rawReads++; return map.cells[y * map.size + x];
    },
  } as unknown as ClientPluginCtx;
  const flight = {
    id: 1, centreX: 256, centreY: 256, heading: 0, turn: 1, elapsed: 0,
    altitude: terrainCapY(17) + ROOFTOP_CLEARANCE + APACHE_CLEARANCE_RADIUS_WORLD_UNITS,
  };
  let edited = false, hiddenAfterEdit = false, raisedPassSeen = false;
  try {
    clientPlugin.attach(ctx);
    for (let i = 0; i < 28 * 60; i++) {
      clock = i / 60;
      if (!edited && clock >= editAt) {
        map.cells[258 * map.size + 255] = 640;
        terrainChanged(new Set([Math.floor(258 / CHUNK_SIZE) * (512 / CHUNK_SIZE) + Math.floor(255 / CHUNK_SIZE)]));
        edited = true;
      }
      receive({ flight: { ...flight, elapsed: clock } });
      frame(1 / 60);
      if (revealedOnEdit && !edited) assert.equal(root.visible, false);
      if (!root.visible) { if (edited) hiddenAfterEdit = true; continue; }
      if (clock >= 13 && clock <= 14 && root.position.y > flight.altitude + 1) raisedPassSeen = true;
      asset.scene.position.copy(root.position);
      asset.scene.quaternion.copy(root.quaternion);
      asset.scene.scale.setScalar(APACHE_DRAW_SCALE);
      pivot.quaternion.setFromAxisAngle(up, rotorSeconds * 31);
      asset.scene.updateMatrixWorld(true);
      const positions = rotor.geometry.getAttribute('position');
      for (let v = 0; v < positions.count; v++) {
        point.fromBufferAttribute(positions, v).applyMatrix4(rotor.matrixWorld);
        assert.ok(point.y >= drawnAt(point.x / CELL_WORLD_SIZE, point.z / CELL_WORLD_SIZE), `rotor intersects terrain at ${clock}s`);
      }
    }
    assert.ok(edited);
    if (editAt === 2) assert.ok(raisedPassSeen);
    else assert.ok(hiddenAfterEdit);
    assert.ok(rawReads < 10_000, `terrain cache read ${rawReads} cells`);
  } finally { clientPlugin.dispose!(); asset.dispose(); }
});
