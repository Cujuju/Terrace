import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/relics/client/index.ts';
import { armSkill, armedSkill, castDenial, relics, setCastDenial, skills } from '../../plugins/relics/client/state.ts';
import { CELL_WORLD_SIZE } from '../../plugins/relics/client/gems.ts';
vi.mock('../../plugins/relics/client/RelicsPanel.tsx', () => ({ RelicsHeaderLine: () => null, RelicsPanel: () => null }));

describe('relic views across world generations', () => {
  let attached = false;

  afterEach(() => {
    if (attached) clientPlugin.dispose?.();
    attached = false;
  });

  function harness() {
    const layer = new Group();
    const messages = new Map<string, (payload: unknown) => void>();
    const frames: ((dt: number) => void)[] = [];
    const resets: (() => void)[] = [];
    const ctx = {
      layer,
      drawnGroundYAt: () => 0,
      onMessage(type: string, handler: (payload: unknown) => void) {
        messages.set(type, handler);
        return () => {};
      },
      onFrame(handler: (dt: number) => void) {
        frames.push(handler);
        return () => {};
      },
      onWorldReset(handler: () => void) {
        resets.push(handler);
        return () => {};
      },
      onCanvasPress: () => () => {},
      registerHudPanel: () => {},
    } as unknown as ClientPluginCtx;
    clientPlugin.attach(ctx);
    attached = true;
    return {
      layer,
      messages,
      frame: () => frames.forEach((handler) => handler(0)),
      reset: () => resets.forEach((handler) => handler()),
    };
  }

  const OLD_CELL = 16;
  const NEW_CELL = 100;
  const gem = (cell: number) => ({ id: 'r1', x: cell, y: cell, skill: 'bedrock-ward' });

  it('clears every world view and signal, then rebuilds a reused ID in place', () => {
    const live = harness();
    live.messages.get('relics')!({ relics: [gem(OLD_CELL)] });
    live.messages.get('skills')!({ skills: [{ id: 'quake' }] });
    armSkill('quake');
    setCastDenial('warded');
    live.frame();
    const pool = [...live.layer.children];
    const mesh = live.layer.getObjectByName('relic:r1')!;
    expect(mesh.position.x).toBe(OLD_CELL * CELL_WORLD_SIZE);

    live.reset();
    live.frame();
    expect(live.layer.children.every((object) => !object.visible)).toBe(true);
    expect(live.layer.getObjectByName('relic:r1')).toBeUndefined();
    expect(relics()).toEqual([]);
    expect(skills()).toEqual([]);
    expect(armedSkill()).toBeNull();
    expect(castDenial()).toBeNull();

    live.messages.get('relics')!({ relics: [gem(NEW_CELL)] });
    live.frame();
    expect(live.layer.getObjectByName('relic:r1')).toBe(mesh);
    expect(mesh.visible).toBe(true);
    expect(mesh.position.x).toBe(NEW_CELL * CELL_WORLD_SIZE);
    expect(mesh.position.z).toBe(NEW_CELL * CELL_WORLD_SIZE);
    expect(live.layer.getObjectByName('relic-spire:r1')!.position.x).toBe(mesh.position.x);
    expect(live.layer.children).toEqual(pool);
  });

  it('repairs changed coordinates and skill metadata in a full replacement list', () => {
    const live = harness();
    live.messages.get('relics')!({ relics: [gem(OLD_CELL)] });
    live.frame();
    const original = live.layer.getObjectByName('relic:r1')!;

    live.messages.get('relics')!({ relics: [gem(NEW_CELL)] });
    live.frame();
    expect(original.position.x).toBe(NEW_CELL * CELL_WORLD_SIZE);

    live.messages.get('relics')!({ relics: [{ ...gem(NEW_CELL), skill: 'genesis' }] });
    live.frame();
    expect(original.visible).toBe(false);
    expect(live.layer.getObjectByName('relic:r1')).not.toBe(original);
    expect(live.layer.getObjectByName('relic:r1')!.position.x).toBe(NEW_CELL * CELL_WORLD_SIZE);
  });
});
