import { CELL_WORLD_SIZE, CHUNK_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import { PerspectiveCamera, Scene } from 'three';
import { expect, it } from 'vitest';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import { pickPointedCellByRay } from '../src/terrain/picking.ts';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import type { Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';
import { FLORA_PINE_MIN_HEIGHT } from '../../plugins/flora/protocol.ts';
import { clientPlugin } from '../../plugins/flora/client/index.ts';

it('registers flora anchors through the core host for occupancy and exact mesh hits', () => {
  const size = CHUNK_SIZE * 4, groundY = FLORA_PINE_MIN_HEIGHT * MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
  const mirror = createTerrainMirror(size);
  mirror.map.cells.fill(FLORA_PINE_MIN_HEIGHT);
  for (let i = 0; i < (size / CHUNK_SIZE) ** 2; i++) mirror.received.add(i);
  const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 100);
  camera.position.set(21 * CELL_WORLD_SIZE, groundY + 5, 20 * CELL_WORLD_SIZE);
  camera.lookAt(21 * CELL_WORLD_SIZE, groundY, 20 * CELL_WORLD_SIZE);
  camera.updateMatrixWorld(true);
  const scene = new Scene();
  const viewport = {
    camera, scene, onFrame: () => () => {},
    renderer: {
      domElement: {
        addEventListener: () => {}, removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      },
      info: { render: { calls: 0 } },
    },
  } as unknown as Viewport;
  let useOccupancy = false;
  const world = {
    terrainBuildHeld: () => false, worldSize: () => size,
    drawnGroundYAt: () => groundY, onTerrainChanged: () => () => {},
    pickPointedCell: (...args: Parameters<World['pickPointedCell']>) =>
      useOccupancy ? pickPointedCellByRay(mirror, ...args) : null,
  } as unknown as World;
  let driver!: ClientPluginCtx;
  const host = createClientPluginHost([
    clientPlugin,
    { name: 'driver', drawBudget: 0, attach: (ctx) => { driver = ctx; } },
  ], { viewport, world, connection: () => ({}) as Connection, coreDrawBudget: () => 0 });
  try {
    host.routeMessage('flora:forest', { trees: [20, 20] });
    scene.updateMatrixWorld(true);
    expect(driver.pickWorldCell(400, 300)).toEqual({ x: 20, y: 20 });
    useOccupancy = true;
    expect(driver.pickWorldCell(400, 300)).toEqual({ x: 20, y: 20 });
  } finally {
    host.dispose();
  }
});
