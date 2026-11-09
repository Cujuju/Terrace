import { afterEach, describe, expect, it } from 'vitest';
import { Group, PointLight } from 'three';
import { newStillness } from '@terrace/shared';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { clientPlugin } from '../client/index.ts';
import { monsterOriginY } from '../client/placement.ts';
import { MONSTER_KINDS } from '../protocol.ts';
import { SNOW_LINE_MIN_HEIGHT, type LairWorld } from '../server/habitat.ts';
import { advanceMonster } from '../server/lurk.ts';
import { setMonsterRandomSource } from '../server/rng.ts';
import type { Monster } from '../server/summoning.ts';

afterEach(() => setMonsterRandomSource(null));

describe('missing drawn support', () => {
  it.each(MONSTER_KINDS)('keeps %s support unknown', (kind) => {
    expect(monsterOriginY(kind, () => null, 15.5, 8.5)).toBeNull();
  });

  it('hides the body and dread, parks its banked light, and restores them when support arrives', () => {
    const layer = new Group();
    let ground: number | null = -20;
    let frame = (_dt: number): void => {};
    const messages = new Map<string, (payload: unknown) => void>();
    // This fixture supplies only the capabilities monsters uses during attach and frames.
    const ctx = {
      layer, drawnGroundYAt: () => ground, terrainRevisionAt: () => 0,
      requestShaderWarmup: () => {}, onWorldReset: () => () => {},
      onFrame: (handler: (dt: number) => void) => { frame = handler; return () => {}; },
      onMessage: (type: string, handler: (payload: unknown) => void) => {
        messages.set(type, handler);
        return () => messages.delete(type);
      },
    } as unknown as ClientPluginCtx;
    clientPlugin.attach(ctx);
    try {
      const state = { monsters: [{ id: 1, kind: 'cthulhu', x: 15.5, y: 8.5, heading: 0 }] };
      messages.get('state')!(state);
      frame(1 / 60);
      const living = layer.getObjectByName('monsters:living')!;
      const body = living.children.find((object) => object instanceof Group && object.name === '')!;
      const dread = living.children.find((object) => object.name === 'monsters:dread' &&
        object.children.some((child) => child.type === 'Mesh' && child.visible))!;
      const lights = living.children.filter((object): object is PointLight => object instanceof PointLight);
      const flash = lights.find((light) => light.position.x !== 0)!;
      expect(body.visible).toBe(true);
      expect(dread).toBeDefined();
      flash.intensity = 1;
      const parent = flash.parent;
      ground = null;
      frame(1 / 60);
      expect(body.visible).toBe(false);
      expect(dread.visible).toBe(false);
      expect(flash.intensity).toBe(0);
      expect(flash.visible).toBe(true);
      expect(flash.parent).toBe(parent);
      ground = -20;
      frame(1 / 60);
      expect(body.visible).toBe(true);
      expect(dread.visible).toBe(true);
      ground = null;
      frame(1 / 60);
      messages.get('state')!({ monsters: [] });
      frame(1 / 60);
      expect(flash.intensity).toBe(0);
      expect(living.children.filter((object) => object instanceof PointLight)).toEqual(lights);
    } finally {
      clientPlugin.dispose?.();
    }
  });
});

describe('yeti climbs before the walking fallback', () => {
  const SIZE = 64;
  const PIT = 32;
  const WALL_RISE = 128;
  const DT = 0.1;
  const ESCAPE_TICKS = 300;

  function yeti(): Monster {
    const x = PIT + 1.5, y = PIT + 0.5;
    return { id: 1, kind: 'yeti', x, y, heading: 0, climb: null, idle: false, ...newStillness(x, y) };
  }

  function basin(unlocked: (x: number, y: number) => boolean = () => true): LairWorld {
    return {
      worldSize: SIZE, isCellUnlocked: unlocked,
      heightAt: (x, y) => SNOW_LINE_MIN_HEIGHT +
        (Math.abs(x - PIT) <= 1 && Math.abs(y - PIT) <= 1 ? 0 : WALL_RISE),
    };
  }

  it('starts and completes a legal climb out of a basin', () => {
    setMonsterRandomSource(() => 0.5);
    const monster = yeti();
    let climbed = false;
    for (let tick = 0; tick < ESCAPE_TICKS; tick++) {
      advanceMonster(basin(), monster, DT);
      climbed ||= monster.climb !== null;
    }
    expect(climbed).toBe(true);
    expect(monster.x).toBeGreaterThan(PIT + 2);
    expect(monster.climb).toBeNull();
  });

  it('does not start a climb into locked habitat', () => {
    setMonsterRandomSource(() => 0.5);
    const monster = yeti();
    const world = basin((x) => x < PIT + 2);
    for (let tick = 0; tick < ESCAPE_TICKS; tick++) {
      advanceMonster(world, monster, DT);
      expect(monster.climb).toBeNull();
      expect(monster.x).toBeLessThan(PIT + 2);
    }
  });

  it('does not walk an idle yeti into its climb approach', () => {
    setMonsterRandomSource(() => 0.5);
    const monster = yeti();
    monster.idle = true;
    const before = { x: monster.x, y: monster.y };
    advanceMonster(basin(), monster, DT);
    expect({ x: monster.x, y: monster.y }).toEqual(before);
    expect(monster.climb).toBeNull();
  });
});
