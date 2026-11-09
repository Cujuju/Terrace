import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, InstancedMesh, type Object3D } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/fire/client/index.ts';
import { createFireScar } from '../../plugins/fire/client/scar.ts';
import { FIRE_LIGHT_POOL_SIZE } from '../../plugins/fire/client/fireLights.ts';
import { packEntities, packFires } from '../../plugins/fire/protocol.ts';

vi.mock('../../plugins/fire/client/TorchIcon.tsx', () => ({ TorchIcon: () => null }));

type ToolOptions = Parameters<ClientPluginCtx['bindToolInput']>[0];
type Cell = { x: number; y: number };
const INITIAL_GROUND = 0;
const RAISED_GROUND = 8;
const FIRST_CELL: Cell = { x: 1, y: 2 };
const SECOND_CELL: Cell = { x: 9, y: 2 };
const liveFire = { x: 1, y: 2, fuelHeight: 1, ageSeconds: 1, burnSeconds: 22 };

function harness() {
  const layer = new Group();
  const messages = new Map<string, (payload: unknown) => void>();
  const sent: Array<{ type: string; payload: unknown }> = [];
  let frame = (_dt: number): void => {};
  let terrain = (): void => {};
  let reset = (): void => {};
  let select = (_selected: boolean): void => {};
  let binding: ToolOptions | null = null;
  let disposed = false;
  let ground: number | null = INITIAL_GROUND;
  let aim: Cell | null = FIRST_CELL;
  const currentAim = (): Cell | null => binding?.active() === true ? aim : null;
  const ctx = {
    layer,
    drawnGroundYAt: () => ground,
    onMessage: (type: string, handler: (payload: unknown) => void) => {
      messages.set(type, handler);
      return () => messages.delete(type);
    },
    onFrame: (handler: typeof frame) => { frame = handler; return () => {}; },
    onTerrainChanged: (handler: typeof terrain) => { terrain = handler; return () => {}; },
    onWorldReset: (handler: typeof reset) => { reset = handler; return () => {}; },
    registerTool: (tool: { onSelected(selected: boolean): void }) => { select = tool.onSelected; },
    bindToolInput: (options: ToolOptions) => {
      binding = options;
      return { aim: currentAim, dispose: () => { disposed = true; } };
    },
    moverPose: () => null,
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
  } as unknown as ClientPluginCtx;
  clientPlugin.attach(ctx);
  return {
    layer, sent,
    message: (type: string, payload: unknown) => messages.get(type)?.(payload),
    frame: (dt = 1) => frame(dt),
    reset: () => reset(),
    ground: (value: number | null) => { ground = value; terrain(); },
    select: (value: boolean) => select(value),
    aim: (value: Cell | null) => { aim = value; },
    press: () => binding?.onPress(currentAim()),
    input: () => binding,
    disposed: () => disposed,
  };
}

function mesh(layer: Group, name: string): InstancedMesh {
  const found = layer.getObjectByName(name);
  expect(found).toBeInstanceOf(InstancedMesh);
  return found as InstancedMesh;
}

function lights(layer: Group): Object3D[] {
  const found: Object3D[] = [];
  layer.traverse((object) => { if (object.type === 'PointLight') found.push(object); });
  return found;
}

afterEach(() => clientPlugin.dispose?.());

describe('fire client world lifetime', () => {
  it('clears all effects in place without replacing or hiding lights', () => {
    const h = harness();
    const bank = lights(h.layer);
    h.message('fires', { fires: packFires([liveFire]) });
    h.frame();
    const smoke = mesh(h.layer, 'fire:smoke:columns');
    const scar = mesh(h.layer, 'fire:scar:marks');
    expect(smoke.count).toBe(1);
    expect(scar.count).toBe(1);
    h.reset();
    h.message('fires', { fires: [] });
    h.message('entities', packEntities([]));
    h.frame();
    expect(smoke.count).toBe(0);
    expect(scar.count).toBe(0);
    expect(mesh(h.layer, 'fire:ribbons:tongues').count).toBe(0);
    expect(mesh(h.layer, 'fire:shaderPlume:plumes').count).toBe(0);
    expect(lights(h.layer)).toEqual(bank);
    expect(bank).toHaveLength(FIRE_LIGHT_POOL_SIZE);
    expect(bank.every((light) => light.visible)).toBe(true);
    h.message('fires', { fires: packFires([liveFire]) });
    h.frame();
    expect(smoke.count).toBe(1);
    expect(scar.count).toBe(1);
  });

  it('rebases a fading scar after terrain changes and hides unavailable ground', () => {
    const h = harness();
    h.message('fires', { fires: packFires([liveFire]) });
    h.frame();
    h.message('fires', { fires: [] });
    h.frame();
    const scar = mesh(h.layer, 'fire:scar:marks');
    const initial = scar.instanceMatrix.array[13]!;
    h.ground(RAISED_GROUND);
    h.frame();
    expect(scar.instanceMatrix.array[13]!).toBeCloseTo(initial + RAISED_GROUND);
    h.ground(null);
    h.frame();
    expect(scar.count).toBe(0);
    h.ground(INITIAL_GROUND);
    h.frame();
    expect(scar.count).toBe(1);
    expect(scar.instanceMatrix.array[13]!).toBeCloseTo(initial);
  });
});

describe('host-owned Pyro input', () => {
  it('uses the current shared aim after stationary-pointer camera movement', () => {
    const h = harness();
    h.select(true);
    expect(h.input()).toMatchObject({ pick: 'world' });
    h.frame();
    const marker = h.layer.getObjectByName('fire:torch-marker')!;
    expect(marker.position.x).toBe(FIRST_CELL.x * CELL_WORLD_SIZE);
    h.aim(SECOND_CELL);
    h.frame();
    expect(marker.position.x).toBe(SECOND_CELL.x * CELL_WORLD_SIZE);
    h.press();
    expect(h.sent).toEqual([{ type: 'ignite', payload: SECOND_CELL }]);
    h.aim(null);
    h.frame();
    h.press();
    expect(marker.visible).toBe(false);
    expect(h.sent).toHaveLength(1);
    clientPlugin.dispose?.();
    expect(h.disposed()).toBe(true);
  });
});

it('refreshes a live scar as well as its afterlife', () => {
  const scar = createFireScar();
  const instance = { key: 1, x: 1, z: 2, groundY: 0, fuelHeight: 1, intensity: 1, ageSeconds: 1, seed: 1 };
  scar.apply([instance], () => INITIAL_GROUND);
  scar.update(1);
  const drawing = mesh(scar.root, 'fire:scar:marks');
  const initial = drawing.instanceMatrix.array[13]!;
  scar.refreshGround(() => RAISED_GROUND);
  scar.apply([instance], () => RAISED_GROUND);
  scar.update(1);
  expect(drawing.instanceMatrix.array[13]!).toBeCloseTo(initial + RAISED_GROUND);
  scar.clear();
  expect(drawing.count).toBe(0);
  scar.dispose();
});
