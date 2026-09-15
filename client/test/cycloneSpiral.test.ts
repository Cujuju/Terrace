import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { countDrawObjects } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/cyclone/client/index.ts';
import {
  createCycloneRainField,
  type CycloneRainSource,
} from '../../plugins/cyclone/client/rain.ts';
import { MAX_SPIRALS } from '../../plugins/cyclone/client/spiralLayout.ts';
import { CYCLONE_ALL_MESSAGE } from '../../plugins/cyclone/protocol.ts';

const FRAME_SECONDS = 1 / 60;

const SPIRAL_NAME = 'cyclone:spiral:puffs';
const RAIN_NAME = 'cyclone:rain:precipitation';

const CYCLONE_DRAW_BUDGET = 2;

const FIRST_CELL = 20;
const SECOND_CELL = 70;

const STORM_RADIUS_CELLS = 30;

const RAIN_WORLD_RADIUS = 60;

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

const noClip = (_material: NodeMaterial, _label: string): void => {};

function rainDrop(id: number): CycloneRainSource {
  return { id, x: 0, z: 0, radiusWorldUnits: RAIN_WORLD_RADIUS, intensity: 1, vx: 0, vz: 0 };
}

let attached = false;

afterEach(() => {
  if (!attached) return;
  clientPlugin.dispose?.();
  attached = false;
});

describe('a world reset clears the cyclone', () => {
  it('stops drawing the deck and its rain, then draws the new world', () => {
    const live = harness();
    clientPlugin.attach(live.ctx);
    attached = true;

    live.send(CYCLONE_ALL_MESSAGE, storms(FIRST_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(true);
    expect(drawing(live.layer, RAIN_NAME)).toBe(true);

    live.resetWorld();
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(false);
    expect(drawing(live.layer, RAIN_NAME)).toBe(false);

    live.send(CYCLONE_ALL_MESSAGE, storms(SECOND_CELL));
    live.frame(FRAME_SECONDS);
    expect(drawing(live.layer, SPIRAL_NAME)).toBe(true);
    expect(drawing(live.layer, RAIN_NAME)).toBe(true);
  });
});

describe('cyclone rain slots', () => {
  it('come back when a storm dies, so a long sky never runs dry', () => {
    const rain = createCycloneRainField(noClip);

    for (let id = 1; id <= MAX_SPIRALS + 1; id++) {
      rain.apply([rainDrop(id)], 0);
      expect(drawing(rain.root, RAIN_NAME)).toBe(true);
      rain.apply([], 0);
      expect(drawing(rain.root, RAIN_NAME)).toBe(false);
    }

    rain.dispose();
  });

  it('come back on a world reset too', () => {
    const rain = createCycloneRainField(noClip);
    const living: CycloneRainSource[] = [];
    for (let id = 1; id <= MAX_SPIRALS; id++) living.push(rainDrop(id));

    rain.apply(living, 0);
    expect(drawing(rain.root, RAIN_NAME)).toBe(true);

    rain.reset();
    expect(drawing(rain.root, RAIN_NAME)).toBe(false);

    rain.apply(living, 0);
    expect(drawing(rain.root, RAIN_NAME)).toBe(true);

    rain.dispose();
  });
});

describe('the cyclone draw budget', () => {
  it('is one deck and one rain field, however many cyclones are in the air', () => {
    const live = harness();
    clientPlugin.attach(live.ctx);
    attached = true;

    expect(clientPlugin.drawBudget).toBe(CYCLONE_DRAW_BUDGET);

    live.send(CYCLONE_ALL_MESSAGE, storms(FIRST_CELL));
    live.frame(FRAME_SECONDS);
    expect(countDrawObjects(live.layer)).toBe(CYCLONE_DRAW_BUDGET);
  });
});
