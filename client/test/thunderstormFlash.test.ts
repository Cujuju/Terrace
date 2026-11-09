import { afterEach, describe, expect, it } from 'vitest';
import { Group, PointLight, type Mesh } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { countDrawObjects } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/thunderstorm/client/index.ts';
import {
  createFlashLight,
  FLASH_LIGHT_DRAW_OBJECTS,
} from '../../plugins/thunderstorm/client/flashLight.ts';
import { DRY_BOLT_DRAW_OBJECTS } from '../../plugins/thunderstorm/client/bolt.ts';
import { FLASH_DRAW_OBJECTS } from '../../plugins/thunderstorm/client/rig.ts';
import {
  FLASH_DURATION_SECONDS,
  LightningGovernor,
  LightningSchedule,
  MIN_FLASH_INTERVAL_SECONDS,
} from '../../plugins/thunderstorm/client/lightning.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  packStrikes,
} from '../../plugins/thunderstorm/protocol.ts';

const FRAME_SECONDS = 1 / 60;

const SIMULATED_MINUTES = 10;

const SECONDS_PER_MINUTE = 60;

const FLASH_LIGHT_NAME = 'thunderstorm:flash-light';

const DRY_BOLT_NAME = 'thunderstorm:dry-bolt';

const STORM_ID = 1;

const UNSEEN_SYSTEM_ID = 77;

interface Harness {
  readonly ctx: ClientPluginCtx;
  readonly layer: Group;
  readonly sfx: string[];
  send(type: string, payload: unknown): void;
  frame(dt: number): void;
  resetWorld(): void;
}

function harness(): Harness {
  const layer = new Group();
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const frames: ((dt: number) => void)[] = [];
  const resets: (() => void)[] = [];
  const sfx: string[] = [];

  const ctx = {
    layer,
    audio: {
      preload: (): void => {},
      playSfx: (url: string): void => {
        sfx.push(url);
      },
      ambience: (): void => {},
      setMusic: (): void => {},
      setMusicGenerator: (): void => {},
    },
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
    cameraPosition: () => ({ x: 0, y: 40, z: 0 }),
    applyRevealClip: (): void => {},
    publishGroundShade: (): (() => void) => () => {},
    publishGauge: (): (() => void) => () => {},
  } as unknown as ClientPluginCtx;

  return {
    ctx,
    layer,
    sfx,
    send(type: string, payload: unknown): void {
      for (const handler of handlers.get(type) ?? []) handler(payload);
    },
    frame(dt: number): void {
      for (const handler of frames) handler(dt);
    },
    resetWorld(): void {
      for (const handler of resets) handler();
    },
  };
}

function storm(id: number): Record<string, number> {
  return { id, x: 40, y: 60, radius: 30, intensity: 1, vx: 0, vy: 0 };
}

function flashLightIn(layer: Group): PointLight {
  const light = layer.getObjectByName(FLASH_LIGHT_NAME);
  expect(light).toBeInstanceOf(PointLight);
  return light as PointLight;
}

let attached: Harness | null = null;

function attach(): Harness {
  const live = harness();
  clientPlugin.attach(live.ctx);
  attached = live;
  return live;
}

afterEach(() => {
  if (attached === null) return;
  clientPlugin.dispose?.();
  attached = null;
});

describe('one flash light, never a bank', () => {
  it('lights at most one flash at any instant over a long run', () => {
    const governor = new LightningGovernor();
    const schedules = Array.from({ length: MAX_ACTIVE_SYSTEMS + 1 }, () => new LightningSchedule());
    let flashes = 0;

    for (let frame = 0; frame < SIMULATED_MINUTES * SECONDS_PER_MINUTE * 60; frame++) {
      governor.advance(FRAME_SECONDS);
      let contributing = 0;
      for (const schedule of schedules) {
        schedule.advance(FRAME_SECONDS);
        if (schedule.strike(governor)) flashes++;
        if (schedule.brightness() > 0) contributing++;
      }
      expect(contributing).toBeLessThanOrEqual(1);
    }

    expect(flashes).toBeGreaterThan(0);
    expect(MIN_FLASH_INTERVAL_SECONDS).toBeGreaterThan(FLASH_DURATION_SECONDS);
  });

  it('parks to intensity 0 without ever leaving the lit set', () => {
    const flash = createFlashLight();
    expect(flash.light.visible).toBe(true);
    expect(flash.light.intensity).toBe(0);

    flash.flash(3, 4, 5, 0.5);
    expect(flash.light.visible).toBe(true);
    expect(flash.light.intensity).toBeGreaterThan(0);
    expect([flash.light.position.x, flash.light.position.y, flash.light.position.z]).toEqual([
      3, 4, 5,
    ]);

    flash.park();
    expect(flash.light.visible).toBe(true);
    expect(flash.light.intensity).toBe(0);

    flash.dispose();
  });

  it('adds exactly one point light to the layer, and it draws nothing', () => {
    const live = attach();
    let lights = 0;
    live.layer.traverse((object) => {
      if (object instanceof PointLight) lights++;
    });
    expect(lights).toBe(1);
    expect(FLASH_LIGHT_DRAW_OBJECTS).toBe(0);
    expect(countDrawObjects(flashLightIn(live.layer))).toBe(FLASH_LIGHT_DRAW_OBJECTS);
  });
});

describe('the thunderstorm draw budget', () => {
  it('draws nothing on an empty sky', () => {
    const live = attach();
    live.frame(FRAME_SECONDS);
    expect(countDrawObjects(live.layer)).toBe(0);
  });

  it('stays inside the declared budget with a storm mid-flash', () => {
    const live = attach();
    live.send(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: [storm(STORM_ID)] });
    live.frame(FRAME_SECONDS);

    const lit = countDrawObjects(live.layer);
    expect(lit).toBeGreaterThan(0);

    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([{ systemId: STORM_ID, x: 45, y: 62 }]),
    });
    live.frame(FRAME_SECONDS);

    const flashing = countDrawObjects(live.layer);
    expect(flashing).toBeGreaterThan(lit);
    expect(flashing).toBeLessThanOrEqual(clientPlugin.drawBudget);
    expect(flashLightIn(live.layer).intensity).toBeGreaterThan(0);
    expect(DRY_BOLT_DRAW_OBJECTS).toBeLessThanOrEqual(FLASH_DRAW_OBJECTS);
  });
});

describe('a strike with no storm the client knows about', () => {
  it('plays no sound while frames are held and sounds once its flash is drawable', () => {
    const live = attach();
    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([{ systemId: UNSEEN_SYSTEM_ID, x: 10, y: 10 }]),
    });
    expect(live.sfx).toHaveLength(0);
    live.frame(FRAME_SECONDS);
    expect(flashLightIn(live.layer).intensity).toBeGreaterThan(0);
    expect(live.sfx).toHaveLength(1);
    live.frame(FRAME_SECONDS);
    expect(live.sfx).toHaveLength(1);
  });

  it('uses a drawable dry bolt when a known storm has not gathered intensity', () => {
    const live = attach();
    live.send(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: [{ ...storm(STORM_ID), intensity: 0 }] });
    live.frame(FRAME_SECONDS);
    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([{ systemId: STORM_ID, x: 45, y: 62 }]),
    });
    live.frame(FRAME_SECONDS);
    expect(flashLightIn(live.layer).intensity).toBeGreaterThan(0);
    expect(live.sfx).toHaveLength(1);
    const dryBolt = live.layer.getObjectByName(DRY_BOLT_NAME)!;
    expect(dryBolt.children[0]!.children[0]!.visible).toBe(true);
  });

  it('clears an active dry bolt and parks the same permanently visible light on reset', () => {
    const live = attach();
    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([{ systemId: UNSEEN_SYSTEM_ID, x: 10, y: 10 }]),
    });
    live.frame(FRAME_SECONDS);
    const light = flashLightIn(live.layer);
    expect(light.intensity).toBeGreaterThan(0);
    live.resetWorld();
    expect(light.intensity).toBe(0);
    expect(light.visible).toBe(true);
    expect(light.parent).toBe(live.layer);
    expect(countDrawObjects(live.layer)).toBe(0);
    live.frame(FRAME_SECONDS);
    expect(light.intensity).toBe(0);
    expect(live.sfx).toHaveLength(1);
  });

  it('routes to the dry bolt at the strike cell', () => {
    const live = attach();
    const cell = { x: 48, y: 96 };
    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([{ systemId: UNSEEN_SYSTEM_ID, ...cell }]),
    });
    live.frame(FRAME_SECONDS);

    const dryBolt = live.layer.getObjectByName(DRY_BOLT_NAME);
    expect(dryBolt).not.toBeUndefined();
    const pivot = dryBolt!.children[0]!;
    expect(pivot.position.x).toBeCloseTo(cell.x * CELL_WORLD_SIZE, 9);
    expect(pivot.position.z).toBeCloseTo(cell.y * CELL_WORLD_SIZE, 9);

    const light = flashLightIn(live.layer);
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.position.x).toBeCloseTo(cell.x * CELL_WORLD_SIZE, 9);
    expect(light.position.z).toBeCloseTo(cell.y * CELL_WORLD_SIZE, 9);
  });

  it('stays silent for a strike the governor swallowed — no flash, no thunder', () => {
    const live = attach();
    live.send(THUNDERSTORM_STRIKES_MESSAGE, {
      strikes: packStrikes([
        { systemId: UNSEEN_SYSTEM_ID, x: 10, y: 10 },
        { systemId: UNSEEN_SYSTEM_ID, x: 200, y: 200 },
      ]),
    });
    live.frame(FRAME_SECONDS);

    expect(live.sfx).toHaveLength(1);
    const pivot = live.layer.getObjectByName(DRY_BOLT_NAME)!.children[0]!;
    expect(pivot.position.x).toBeCloseTo(10 * CELL_WORLD_SIZE, 9);
  });
});

describe('the attach-time shader catalogue', () => {
  it('keeps every prebuilt storm glow in the scene for the hidden-drawable warmup', () => {
    const live = attach();
    const glowMaterials = new Set();
    live.layer.getObjectByName('thunderstorm:warmup')!.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.vertexColors) {
        glowMaterials.add(mesh.material);
      }
    });
    expect(glowMaterials.size).toBe(MAX_ACTIVE_SYSTEMS);
    expect(countDrawObjects(live.layer)).toBe(0);
  });
});
