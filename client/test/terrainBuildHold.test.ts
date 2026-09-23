import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Scene, type Object3D } from 'three';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { TerraceClientPlugin } from '../src/plugins/types.ts';
import type { FramePhase, Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';
import { BOOT_MARKS } from '../src/bootMarks.ts';

interface WarmupCall {
  readonly layerUndrawn: boolean;
  readonly finish: () => void;
}

// Passes finish only when a test says so, unless `auto` finishes them on the spot.
const warmup = vi.hoisted(() => ({ calls: [] as WarmupCall[], auto: true, layerName: 'plugin:a' }));

vi.mock('../src/render/settleWarmup.ts', () => ({
  warmHiddenDrawables: (
    viewport: Viewport,
    _sideFlip: unknown,
    undrawn: ReadonlySet<Object3D>,
  ): Promise<{ flipped: number }> => {
    const layer = viewport.scene.getObjectByName(warmup.layerName);
    return new Promise((resolve) => {
      const finish = (): void => resolve({ flipped: 0 });
      warmup.calls.push({ layerUndrawn: layer !== undefined && undrawn.has(layer), finish });
      if (warmup.auto) finish();
    });
  },
}));

const FRAME_DT_S = 1 / 60;

// A release takes a frame per held subscriber, one to request the warmup, one to release.
const MAX_RELEASE_FRAMES = 10;

// Lets every promise continuation queued so far run.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  const drawn: Object3D[] = [];
  const renderObject = (object: Object3D): void => void drawn.push(object);
  let renderObjectFunction: ((object: Object3D) => void) | null = null;
  const viewport = {
    scene,
    renderer: {
      domElement: { addEventListener: () => undefined, removeEventListener: () => undefined },
      info: { render: { calls: 0 } },
      renderObject,
      setRenderObjectFunction: (fn: ((object: Object3D) => void) | null) => {
        renderObjectFunction = fn;
      },
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
  const frame = (): void => {
    for (const handler of pose) handler(FRAME_DT_S);
    for (const handler of draw) handler(FRAME_DT_S);
  };
  return {
    host,
    scene,
    frame,
    // What one render would draw of these objects, through whichever function is set.
    draw: (...objects: Object3D[]): Object3D[] => {
      drawn.length = 0;
      for (const object of objects) (renderObjectFunction ?? renderObject)(object);
      return [...drawn];
    },
    arm: (): void => void (armed = true),
    disarm: (): void => void (armed = false),
    change: (...chunks: number[]): void => {
      scratch.clear();
      for (const chunk of chunks) scratch.add(chunk);
      for (const handler of terrainHandlers) handler(scratch);
    },
    // Terrain drawn: frames run, warmups finish, until plugins draw again.
    release: async (): Promise<void> => {
      armed = false;
      let frames = 0;
      do {
        if (++frames > MAX_RELEASE_FRAMES) throw new Error('the hold never released');
        frame();
        await settle();
      } while (renderObjectFunction !== null);
    },
  };
}

const layerOf = (scene: Scene, name: string) => scene.getObjectByName(`plugin:${name}`);

beforeAll(() => {
  performance.mark(BOOT_MARKS.firstFrame);
});

beforeEach(() => {
  warmup.calls.length = 0;
  warmup.auto = true;
});

describe('the terrain build hold', () => {
  it('skips plugin frames while held and resumes them on release', async () => {
    const onFrame = vi.fn();
    const r = rig({ name: 'a', drawBudget: 0, attach: (ctx) => void ctx.onFrame(onFrame) });
    r.arm();
    r.frame();
    r.frame();
    expect(onFrame).not.toHaveBeenCalled();
    await r.release();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(FRAME_DT_S);
  });

  it('holds changes from the moment the world arms, and delivers their union once on release', async () => {
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
    await r.release();
    r.frame();
    expect(seen).toEqual([[1, 2, 3]]);
    r.change(4);
    expect(seen).toEqual([[1, 2, 3], [4]]);
  });

  it('delivers nothing on release to a plugin unmounted during the hold', async () => {
    const gone = vi.fn();
    const kept = vi.fn();
    const r = rig(
      { name: 'gone', drawBudget: 0, attach: (ctx) => void ctx.onTerrainChanged(gone) },
      { name: 'kept', drawBudget: 0, attach: (ctx) => void ctx.onTerrainChanged(kept) },
    );
    r.arm();
    r.change(1);
    r.host.syncLivePlugins(['kept']);
    await r.release();
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('draws no plugin object while held, one mounted mid-hold included, and never touches visibility', async () => {
    const early = new Mesh();
    const late = new Mesh();
    const core = new Mesh();
    const r = rig(
      { name: 'early', drawBudget: 0, attach: (ctx) => void ctx.layer.add(new Group().add(early)) },
      { name: 'late', drawBudget: 0, attach: (ctx) => void ctx.layer.add(late) },
    );
    r.scene.add(core);
    r.host.syncLivePlugins(['early']);
    r.arm();
    r.frame();
    r.host.syncLivePlugins(['early', 'late']);
    expect(r.draw(early, late, core)).toEqual([core]);
    expect(layerOf(r.scene, 'early')?.visible).toBe(true);
    expect(layerOf(r.scene, 'late')?.visible).toBe(true);
    await r.release();
    expect(r.draw(early, late, core)).toEqual([early, late, core]);
  });

  it('delivers held changes undrawn, then releases after a warmup begun once they were delivered', async () => {
    warmup.auto = false;
    const log: string[] = [];
    const mesh = new Mesh();
    const r = rig({
      name: 'a',
      drawBudget: 0,
      attach: (ctx) => {
        ctx.layer.add(mesh);
        ctx.publishMovers(() => null);
        ctx.onTerrainChanged(() => log.push(`changed:${String(r.draw(mesh).length)}`));
        ctx.onFrame(() => log.push(`frame:${String(r.draw(mesh).length)}`));
      },
    });
    r.arm();
    r.change(1);
    r.frame();
    expect(warmup.calls).toHaveLength(1);
    r.disarm();
    r.frame();
    expect(log).toEqual(['changed:0']);
    r.frame();
    // The release pass queues behind the one the hold began with.
    warmup.calls[0]!.finish();
    await settle();
    expect(warmup.calls).toHaveLength(2);
    r.frame();
    expect(log).toEqual(['changed:0']);
    warmup.calls[1]!.finish();
    await settle();
    r.frame();
    expect(log).toEqual(['changed:0', 'frame:1']);
    expect(warmup.calls.map((c) => c.layerUndrawn)).toEqual([true, true]);
  });

  it('a new snapshot while releasing voids that release; its own warmup releases it', async () => {
    warmup.auto = false;
    const onFrame = vi.fn();
    const r = rig({ name: 'a', drawBudget: 0, attach: (ctx) => void ctx.onFrame(onFrame) });
    r.arm();
    r.frame();
    warmup.calls[0]!.finish();
    await settle();
    r.disarm();
    r.frame();
    r.arm();
    r.frame();
    for (const call of warmup.calls) call.finish();
    await settle();
    r.disarm();
    r.frame();
    r.frame();
    expect(onFrame).not.toHaveBeenCalled();
    warmup.calls.at(-1)!.finish();
    await settle();
    r.frame();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });
});
