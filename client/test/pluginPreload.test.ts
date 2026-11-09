import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { ClientPluginCtx, TerraceClientPlugin } from '../src/plugins/types.ts';
import type { Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';

function stubViewport(): Viewport {
  return {
    scene: new Scene(),
    renderer: {
      domElement: { addEventListener: () => undefined, removeEventListener: () => undefined },
      info: { render: { calls: 0 } },
    },
    onFrame: () => () => undefined,
  } as unknown as Viewport;
}

const stubWorld = {
  terrainBuildHeld: () => false,
  worldSize: () => 0,
  terrainSampleAt: () => null,
  drawnGroundYAt: () => null,
  pickCell: () => null,
} as unknown as World;

function hostWith(plugin: TerraceClientPlugin) {
  return createClientPluginHost([plugin], {
    viewport: stubViewport(),
    world: stubWorld,
    connection: () => ({}) as unknown as Connection,
    coreDrawBudget: () => 0,
  });
}

function deferredPlugin(): {
  plugin: TerraceClientPlugin;
  attach: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const attach = vi.fn();
  return {
    plugin: { name: 'loader', drawBudget: 0, attach, preload: () => pending },
    attach,
    resolve,
    reject,
  };
}

describe("a plugin's preload", () => {
  it('aborts a canceled pending preload immediately and gives a remount a fresh signal', async () => {
    const contexts: ClientPluginCtx[] = [];
    const plugin: TerraceClientPlugin = {
      name: 'cancelable', drawBudget: 0,
      preload: (ctx) => { contexts.push(ctx); return new Promise<void>(() => {}); },
      attach: () => {},
    };
    const host = hostWith(plugin);
    await Promise.resolve();
    expect(contexts[0]!.signal.aborted).toBe(false);
    host.syncLivePlugins([]);
    expect(contexts[0]!.signal.aborted).toBe(true);
    host.syncLivePlugins(['cancelable']);
    await Promise.resolve();
    expect(contexts[1]!.signal).not.toBe(contexts[0]!.signal);
    expect(contexts[1]!.signal.aborted).toBe(false);
    host.dispose();
    expect(contexts[1]!.signal.aborted).toBe(true);
  });

  it('aborts a mounted context before plugin disposal', () => {
    let context!: ClientPluginCtx;
    const disposed = vi.fn(() => expect(context.signal.aborted).toBe(true));
    const host = hostWith({ name: 'mounted', drawBudget: 0, attach: (ctx) => { context = ctx; }, dispose: disposed });
    expect(context.signal.aborted).toBe(false);
    host.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('holds attach until it resolves', async () => {
    const { plugin, attach, resolve } = deferredPlugin();
    const host = hostWith(plugin);

    expect(attach).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));

    host.dispose();
  });

  it('never attaches when the host went away while it was in flight', async () => {
    const { plugin, attach, resolve } = deferredPlugin();
    const host = hostWith(plugin);

    host.dispose();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
  });

  it('is a logged breach when it rejects, and attach never runs', async () => {
    const { plugin, attach, reject } = deferredPlugin();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = hostWith(plugin);

    const failure = new Error('war-boat.glb: no meshes');
    reject(failure);
    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith(
        '[terrace] client plugin "loader" threw in preload',
        failure,
      ),
    );
    expect(attach).not.toHaveBeenCalled();

    host.dispose();
    logged.mockRestore();
  });
});
