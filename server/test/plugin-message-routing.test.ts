// CONTRACT TEST for live plugin message routing (issue #197).
//
// The contract: the set of `<plugin>:<type>` messages the server can deliver is
// whatever the CURRENT host claims at the moment the message arrives — never a
// list snapshotted when the room was created. The room registers one Colyseus
// wildcard handler and asks `handlerFor` per message, so a plugin whose message
// types did not exist at room-create time (a reload, Phase 4) is still heard.
//
// Stated against the router rather than the room because the room is the
// Colyseus adapter and holds no logic: what has to hold is the routing
// DECISION, and that is this module.

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
    // The room exists first, routing against a host that claims no messages at
    // all — the boot-time picture.
    let host = hostWith({ name: 'early' });
    const currentHost = (): PluginHost | null => host;
    const received: unknown[] = [];

    routePluginMessage(currentHost, PLAYER, 'late:ping', { n: 1 });
    expect(received).toEqual([]);

    // A later host claims a type nothing knew about at room create.
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

  it('ignores an unroutable namespaced type without throwing', () => {
    const host = hostWith({ name: 'early' });
    expect(() => routePluginMessage(() => host, PLAYER, 'nobody:home', {})).not.toThrow();
  });

  it('ignores every plugin message while no world is loaded', () => {
    expect(() => routePluginMessage(() => null, PLAYER, 'late:ping', {})).not.toThrow();
  });

  it('claims namespaced types only', () => {
    // The room hands everything else back to Colyseus's unregistered-type
    // treatment, so a core type keeps degrading exactly as it does today.
    expect(isPluginMessageType('late:ping')).toBe(true);
    expect(isPluginMessageType('sculpt')).toBe(false);
    expect(isPluginMessageType('worldList')).toBe(false);
    expect(isPluginMessageType(42)).toBe(false);
  });
});
