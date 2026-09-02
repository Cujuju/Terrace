// World-admin message containment (issue #210).
//
// WHAT THIS PROTECTS: the process. Colyseus does not wrap handler dispatch —
// `Room._onMessage` try/catches only decode and validation, then emits to the
// handler unguarded — so anything the room's world-admin handler throws leaves
// as an uncaughtException, and anything it leaves un-awaited leaves as an
// unhandled rejection. Node's default for both is to exit. The failing work is
// a LISTING REFRESH: `pluginListing`/`listing()` open SQLite stores and read
// the worlds directory, outside the try/catch that `handle` and `reloadPlugin`
// put around the action itself.
//
// So the assertions below are all one assertion: nothing escapes, and the
// operator is told, in the shape their own request asked for.

import { describe, expect, it } from 'vitest';
import type {
  WorldAdminRequestMessage,
  WorldListMessage,
  WorldPluginListMessage,
  WorldAdminResultMessage,
} from '@terrace/shared';
import { containWorldAdminMessage } from '../src/world/world-admin.ts';

type Reply = WorldAdminResultMessage | WorldListMessage | WorldPluginListMessage;

const KEY = 'admin-key-long-enough';
const WORLD = 'world-1';

function collector(): { sent: Reply[]; reply: (message: Reply) => void } {
  const sent: Reply[] = [];
  return { sent, reply: (message: Reply) => sent.push(message) };
}

const reloadRequest: WorldAdminRequestMessage = {
  type: 'worldPluginReload',
  key: KEY,
  id: WORLD,
  plugin: 'fire',
};

const setRequest: WorldAdminRequestMessage = {
  type: 'worldPluginSet',
  key: KEY,
  id: WORLD,
  plugin: 'fire',
  enabled: false,
};

const listRequest: WorldAdminRequestMessage = { type: 'worldList', key: KEY };

const pluginListRequest: WorldAdminRequestMessage = {
  type: 'worldPluginList',
  key: KEY,
  id: WORLD,
};

describe('containWorldAdminMessage', () => {
  it('contains a rejection from the async path and answers with a refusal', async () => {
    const { sent, reply } = collector();

    // The exact #210 scenario: the reload resolved and its receipt was sent,
    // then the follow-up listing hit an unreadable worlds directory.
    await expect(
      containWorldAdminMessage(reloadRequest, reply, async () => {
        reply({ type: 'worldAdminResult', action: 'reloadPlugin', ok: true, id: WORLD });
        await Promise.resolve();
        throw new Error('EIO: listArchived');
      }),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: 'worldAdminResult',
      action: 'reloadPlugin',
      ok: false,
      refused: 'failed',
    });
  });

  it('contains a synchronous throw from a follow-up listing', async () => {
    const { sent, reply } = collector();

    await expect(
      containWorldAdminMessage(setRequest, reply, () => {
        reply({ type: 'worldAdminResult', action: 'setPlugin', ok: true, id: WORLD });
        throw new Error('SQLITE_CANTOPEN');
      }),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: 'worldAdminResult',
      action: 'setPlugin',
      ok: false,
      refused: 'failed',
    });
  });

  it('answers a failed world listing in the listing shape, not a receipt', async () => {
    const { sent, reply } = collector();

    await containWorldAdminMessage(listRequest, reply, () => {
      throw new Error('EIO: readdir');
    });

    expect(sent).toEqual([
      {
        type: 'worldListing',
        worlds: [],
        archived: [],
        activeId: null,
        refused: 'failed',
      },
    ]);
  });

  it('answers a failed plugin listing in the plugin-listing shape', async () => {
    const { sent, reply } = collector();

    await containWorldAdminMessage(pluginListRequest, reply, () => {
      throw new Error('SQLITE_CANTOPEN');
    });

    expect(sent).toEqual([
      {
        type: 'worldPluginListing',
        id: WORLD,
        installed: [],
        disabled: [],
        settings: [],
        actions: [],
        versions: {},
        refused: 'failed',
      },
    ]);
  });

  it('adds nothing to a healthy action, sync or async', async () => {
    const sync = collector();
    await containWorldAdminMessage(setRequest, sync.reply, () => {
      sync.reply({ type: 'worldAdminResult', action: 'setPlugin', ok: true, id: WORLD });
      sync.reply({
        type: 'worldPluginListing',
        id: WORLD,
        installed: ['fire'],
        disabled: ['fire'],
        settings: [],
        actions: [],
        versions: { fire: '1' },
      });
    });
    expect(sync.sent.map((m) => m.type)).toEqual(['worldAdminResult', 'worldPluginListing']);

    const async_ = collector();
    await containWorldAdminMessage(reloadRequest, async_.reply, async () => {
      await Promise.resolve();
      async_.reply({ type: 'worldAdminResult', action: 'reloadPlugin', ok: true, id: WORLD });
    });
    expect(async_.sent.map((m) => m.type)).toEqual(['worldAdminResult']);
  });

  it('sends the refusal once, even if the body already failed part-way', async () => {
    const { sent, reply } = collector();
    await containWorldAdminMessage(reloadRequest, reply, () => {
      throw new Error('boom');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('worldAdminResult');
  });
});
