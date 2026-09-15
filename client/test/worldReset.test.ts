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
  worldSize: () => 0,
  terrainHeightAt: () => null,
  drawnGroundYAt: () => null,
  pickCell: () => null,
} as unknown as World;

function hostWith(...plugins: TerraceClientPlugin[]) {
  return createClientPluginHost(plugins, {
    viewport: stubViewport(),
    world: stubWorld,
    connection: () => ({}) as unknown as Connection,
    coreDrawBudget: () => 0,
  });
}

describe('onWorldReset', () => {
  it('fires every subscribed plugin on resetWorld, once each', () => {
    const reset = vi.fn();
    const host = hostWith({
      name: 'sky',
      drawBudget: 0,
      attach: (ctx: ClientPluginCtx) => {
        ctx.onWorldReset(reset);
      },
    });
    host.resetWorld();
    host.resetWorld();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('stops firing once the plugin is unmounted, and a throwing handler cannot block the rest', () => {
    const first = vi.fn(() => {
      throw new Error('boom');
    });
    const second = vi.fn();
    const host = hostWith(
      { name: 'a', drawBudget: 0, attach: (ctx) => void ctx.onWorldReset(first) },
      { name: 'b', drawBudget: 0, attach: (ctx) => void ctx.onWorldReset(second) },
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.resetWorld();
    expect(second).toHaveBeenCalledTimes(1);
    host.syncLivePlugins(['b']);
    host.resetWorld();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
