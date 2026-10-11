import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { countDrawObjects } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/tornado/client/index.ts';
import { createFunnel } from '../../plugins/tornado/client/funnel.ts';
import { MAX_FUNNELS } from '../../plugins/tornado/client/funnelSlots.ts';
import { TORNADO_ALL_MESSAGE } from '../../plugins/tornado/protocol.ts';

const FRAME_SECONDS = 1 / 60;

const GROUND_Y = 3;

const VORTEX_NAME = 'tornado:funnel:vortex';
const DEBRIS_NAME = 'tornado:funnel:debris';

const FIRST_CELL = 10;
const SECOND_CELL = 60;

interface Harness {
  readonly ctx: ClientPluginCtx;
  readonly layer: Group;
  send(type: string, payload: unknown): void;
  frame(dt: number): void;
  resetWorld(): void;
}

function harness(): Harness {
  const layer = new Group();
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const frames: ((dt: number) => void)[] = [];
  const resets: (() => void)[] = [];

  const ctx = {
    layer,
    terrainSampleAt: (): null => null,
    drawnGroundYAt: (): number => GROUND_Y,
    onMessage: (type: string, handler: (payload: unknown) => void): (() => void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {};
    },
    onFrame: (handler: (dt: number) => void): (() => void) => {
      frames.push(handler);
      return () => {};
    },
    onWorldReset: (handler: () => void): (() => void) => {
      resets.push(handler);
      return () => {};
    },
    applyRevealClip: (): void => {},
  } as unknown as ClientPluginCtx;

  return {
    ctx,
    layer,
    send(type, payload): void {
      for (const handler of handlers.get(type) ?? []) handler(payload);
    },
    frame(dt): void {
      for (const handler of frames) handler(dt);
    },
    resetWorld(): void {
      for (const handler of resets) handler();
    },
  };
}

function storms(cell: number): unknown {
  return { storms: [{ id: 1, x: cell, y: cell, radius: 2, intensity: 1, vx: 0, vy: 0 }] };
}

function drawing(layer: Group, name: string): boolean {
  const object = layer.getObjectByName(name);
  expect(object).toBeDefined();
  return object!.visible;
}

let attached = false;

afterEach(() => {
  if (!attached) return;
  clientPlugin.dispose?.();
  attached = false;
});

describe('a world reset clears the funnels', () => {
  it('stops drawing, then redraws id 1 where the new world put it', () => {
    const live = harness();
    clientPlugin.attach(live.ctx);
    attached = true;

    live.send(TORNADO_ALL_MESSAGE, storms(FIRST_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, VORTEX_NAME)).toBe(true);
    expect(drawing(live.layer, DEBRIS_NAME)).toBe(true);
    expect(countDrawObjects(live.layer)).toBe(clientPlugin.drawBudget);

    live.resetWorld();
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, VORTEX_NAME)).toBe(false);
    expect(drawing(live.layer, DEBRIS_NAME)).toBe(false);
    expect(countDrawObjects(live.layer)).toBe(0);

    live.send(TORNADO_ALL_MESSAGE, storms(SECOND_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, VORTEX_NAME)).toBe(true);
    expect(drawing(live.layer, DEBRIS_NAME)).toBe(true);
  });

  it('leaves no slot standing where the old world had one', () => {
    const noClip = (_material: NodeMaterial, _label: string): void => {};
    const funnel = createFunnel(noClip);
    const first = FIRST_CELL * CELL_WORLD_SIZE;
    const second = SECOND_CELL * CELL_WORLD_SIZE;

    funnel.apply([{ id: 1, x: first, groundY: GROUND_Y, z: first, intensity: 1 }]);
    funnel.update(FRAME_SECONDS, 0);
    expect(funnel.stand[0]!.toArray()).toEqual([first, GROUND_Y, first, 1]);
    expect(funnel.stand.filter((slot) => slot.w > 0)).toHaveLength(1);

    funnel.clear();
    expect(funnel.stand.filter((slot) => slot.w > 0)).toHaveLength(0);

    funnel.apply([{ id: 1, x: second, groundY: GROUND_Y, z: second, intensity: 1 }]);
    funnel.update(FRAME_SECONDS, 0);
    expect(funnel.stand[0]!.toArray()).toEqual([second, GROUND_Y, second, 1]);
    expect(funnel.stand.filter((slot) => slot.w > 0)).toHaveLength(1);
    expect(funnel.stand).toHaveLength(MAX_FUNNELS);

    funnel.dispose();
  });
});
