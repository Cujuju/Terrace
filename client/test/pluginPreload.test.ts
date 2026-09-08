import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { TerraceClientPlugin } from '../src/plugins/types.ts';
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
  worldSize: () => 0,
  terrainHeightAt: () => null,
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
