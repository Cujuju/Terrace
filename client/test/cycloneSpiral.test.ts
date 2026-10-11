import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { countDrawObjects } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/cyclone/client/index.ts';
import { CYCLONE_ALL_MESSAGE } from '../../plugins/cyclone/protocol.ts';

const FRAME_SECONDS = 1 / 60;

const SPIRAL_NAME = 'cyclone:spiral:puffs';

const CYCLONE_DRAW_BUDGET = 1;

const FIRST_CELL = 20;
const SECOND_CELL = 70;

const STORM_RADIUS_CELLS = 30;

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
    cameraPosition: () => ({ x: 0, y: 40, z: 0 }),
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
    terrainSampleAt: (): null => null,
    drawnGroundYAt: (): null => null,
    modulateSkyRig: (): (() => void) => () => {},
    publishGroundShade: (): (() => void) => () => {},
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
  return {
    storms: [
      { id: 1, x: cell, y: cell, radius: STORM_RADIUS_CELLS, intensity: 1, vx: 0, vy: 0 },
    ],
  };
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

describe('a world reset clears the cyclone', () => {
  it('stops drawing the spiral, then draws the new world', () => {
    const live = harness();
    clientPlugin.attach(live.ctx);
    attached = true;

    live.send(CYCLONE_ALL_MESSAGE, storms(FIRST_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(true);

    live.resetWorld();
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(false);

    live.send(CYCLONE_ALL_MESSAGE, storms(SECOND_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(true);
  });
});

describe('the cyclone draw budget', () => {
  it('is one spiral, however many cyclones are in the air', () => {
    const live = harness();
    clientPlugin.attach(live.ctx);
    attached = true;

    expect(clientPlugin.drawBudget).toBe(CYCLONE_DRAW_BUDGET);

    live.send(CYCLONE_ALL_MESSAGE, storms(FIRST_CELL));
    live.frame(FRAME_SECONDS);
    expect(countDrawObjects(live.layer)).toBe(CYCLONE_DRAW_BUDGET);
  });
});
