import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { TerraceClientPlugin } from '../src/plugins/types.ts';
import type { FramePhase, Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';
import { BOOT_MARKS } from '../src/bootMarks.ts';

const warmup = vi.hoisted(() => ({ calls: [] as boolean[], layerName: 'plugin:a' }));

vi.mock('../src/render/settleWarmup.ts', () => ({
  warmHiddenDrawables: (viewport: Viewport): Promise<void> => {
    warmup.calls.push(viewport.scene.getObjectByName(warmup.layerName)?.visible ?? false);
    return Promise.resolve();
  },
}));

const FRAME_DT_S = 1 / 60;

function rig(...plugins: TerraceClientPlugin[]) {
  const scene = new Scene();
  const pose = new Set<(dt: number) => void>();
  const draw = new Set<(dt: number) => void>();
  const terrainHandlers = new Set<(dirty: ReadonlySet<number>) => void>();
  let armed = false;
  const world = {
    terrainBuildHeld: () => armed,
    onTerrainChanged: (handler: (dirty: ReadonlySet<number>) => void) => {
      terrainHandlers.add(handler);
      return () => terrainHandlers.delete(handler);
    },
    worldSize: () => 0,
    terrainSampleAt: () => null,
    drawnGroundYAt: () => null,
    pickCell: () => null,
  } as unknown as World;
  const viewport = {
    scene,
    renderer: {
      domElement: { addEventListener: () => undefined, removeEventListener: () => undefined },
      info: { render: { calls: 0 } },
    },
    onFrame: (handler: (dt: number) => void, phase: FramePhase = 'draw') => {
      const set = phase === 'pose' ? pose : draw;
      set.add(handler);
      return () => set.delete(handler);
    },
  } as unknown as Viewport;
  const host = createClientPluginHost(plugins, {
    viewport,
    world,
    connection: () => ({}) as unknown as Connection,
    coreDrawBudget: () => 0,
    now: () => 0,
  });
  // The world reuses one set per notification; so does this stub.
  const scratch = new Set<number>();
  return {
    host,
    scene,
    arm: (): void => void (armed = true),
    disarm: (): void => void (armed = false),
    change: (...chunks: number[]): void => {
      scratch.clear();
      for (const chunk of chunks) scratch.add(chunk);
      for (const handler of terrainHandlers) handler(scratch);
    },
    frame: (): void => {
      for (const handler of pose) handler(FRAME_DT_S);
      for (const handler of draw) handler(FRAME_DT_S);
    },
  };
}

const layerOf = (scene: Scene, name: string) => scene.getObjectByName(`plugin:${name}`);

describe('the terrain build hold', () => {
  it('skips plugin frames while held and resumes them on release', () => {
    const onFrame = vi.fn();
    const r = rig({ name: 'a', drawBudget: 0, attach: (ctx) => void ctx.onFrame(onFrame) });
    r.arm();
    r.frame();
    r.frame();
    expect(onFrame).not.toHaveBeenCalled();
    r.disarm();
    r.frame();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(FRAME_DT_S);
  });

  it('holds changes from the moment the world arms, and delivers their union once on release', () => {
    const seen: number[][] = [];
    const r = rig({
      name: 'a',
      drawBudget: 0,
      attach: (ctx) => void ctx.onTerrainChanged((dirty) => seen.push([...dirty].sort())),
    });
    r.arm();
    r.change(1, 2);
    r.frame();
    r.change(2, 3);
    expect(seen).toEqual([]);
    r.disarm();
    r.frame();
    r.frame();
    expect(seen).toEqual([[1, 2, 3]]);
    r.change(4);
    expect(seen).toEqual([[1, 2, 3], [4]]);
  });

  it('delivers nothing on release to a plugin unmounted during the hold', () => {
    const gone = vi.fn();
    const kept = vi.fn();
    const r = rig(
      { name: 'gone', drawBudget: 0, attach: (ctx) => void ctx.onTerrainChanged(gone) },
      { name: 'kept', drawBudget: 0, attach: (ctx) => void ctx.onTerrainChanged(kept) },
    );
    r.arm();
    r.change(1);
    r.host.syncLivePlugins(['kept']);
    r.disarm();
    r.frame();
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('hides plugin layers while held, one mounted mid-hold included, and shows them on release', () => {
    const r = rig(
      { name: 'early', drawBudget: 0, attach: () => undefined },
      { name: 'late', drawBudget: 0, attach: () => undefined },
    );
    r.host.syncLivePlugins(['early']);
    r.arm();
    r.frame();
    r.host.syncLivePlugins(['early', 'late']);
    expect(layerOf(r.scene, 'early')?.visible).toBe(false);
    expect(layerOf(r.scene, 'late')?.visible).toBe(false);
    r.disarm();
    r.frame();
    expect(layerOf(r.scene, 'early')?.visible).toBe(true);
    expect(layerOf(r.scene, 'late')?.visible).toBe(true);
  });

  it('on release shows layers and delivers changes before any plugin frame, then warms with layers shown', () => {
    performance.mark(BOOT_MARKS.firstFrame);
    warmup.calls.length = 0;
    const log: string[] = [];
    const r = rig({
      name: 'a',
      drawBudget: 0,
      attach: (ctx) => {
        ctx.publishMovers(() => null);
        ctx.onTerrainChanged(() => log.push(`changed:${String(ctx.layer.visible)}`));
        ctx.onFrame(() => log.push(`frame:${String(ctx.layer.visible)}`));
      },
    });
    r.arm();
    r.change(1);
    r.frame();
    expect(warmup.calls).toEqual([]);
    r.disarm();
    r.frame();
    expect(log).toEqual(['changed:true', 'frame:true']);
    expect(warmup.calls).toEqual([true]);
  });
});
