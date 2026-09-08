import { CHUNK_SIZE } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/plugins/host.ts';
import { isPluginMessageType, routePluginMessage } from '../src/net/plugin-message-routing.ts';
import type { TerracePlugin } from '../src/plugins/types.ts';
import type { Player } from '../src/player.ts';
import { asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

function hostWith(plugin: TerracePlugin): PluginHost {
  return new PluginHost(worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]), [asLoadedPlugin(plugin)]);
}

describe('routePluginMessage', () => {
  it('delivers to a handler registered after the room was created', () => {
    let host = hostWith({ name: 'early' });
    const currentHost = (): PluginHost | null => host;
    const received: unknown[] = [];

    routePluginMessage(currentHost, PLAYER, 'late:ping', { n: 1 });
    expect(received).toEqual([]);

    host = hostWith({
      name: 'late',
      messages: {
        ping(_api, player, payload): void {
          received.push({ player: player.id, payload });
        },
      },
    });

    routePluginMessage(currentHost, PLAYER, 'late:ping', { n: 2 });
    expect(received).toEqual([{ player: PLAYER.id, payload: { n: 2 } }]);
  });

  it('claims namespaced types only', () => {
    expect(isPluginMessageType('late:ping')).toBe(true);
    expect(isPluginMessageType('sculpt')).toBe(false);
    expect(isPluginMessageType('worldList')).toBe(false);
    expect(isPluginMessageType(42)).toBe(false);
  });
});
