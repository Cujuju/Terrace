import type { WorldAdminRequestMessage } from '@terrace/shared';
import { logInfo } from '../log.ts';
import type { WorldAdminService } from '../world/world-admin.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { buildJoinSnapshot, buildShowAllSnapshot } from './join-snapshot.ts';
import type { TerraceClient } from './room-contract.ts';

export interface WorldAdminHandlerDeps {
  readonly manager: WorldManager;
  readonly admin: WorldAdminService;
}

export function answerWorldAdminMessage(
  deps: WorldAdminHandlerDeps,
  client: TerraceClient,
  request: WorldAdminRequestMessage,
): void | Promise<void> {
  const { admin, manager } = deps;

  if (request.type === 'worldList') {
    client.send('worldListing', admin.list(client.sessionId, request.key));
    return;
  }

  if (request.type === 'worldView') {
    const refusal = admin.authorize(client.sessionId, request.key);
    if (refusal !== null) {
      client.send('worldAdminResult', {
        type: 'worldAdminResult',
        action: 'view',
        ok: false,
        refused: refusal,
      });
      return;
    }
    const session = manager.current;
    const player = client.userData?.player;
    if (session === null || player === undefined) {
      client.send('worldAdminResult', {
        type: 'worldAdminResult',
        action: 'view',
        ok: false,
        refused: 'failed',
      });
      return;
    }
    const snapshot =
      request.scope === 'all'
        ? buildShowAllSnapshot(session.world, session.host)
        : buildJoinSnapshot(session.world, session.host, player.token);
    client.send('snapshot', snapshot);
    client.send('worldAdminResult', {
      type: 'worldAdminResult',
      action: 'view',
      ok: true,
      detail: request.scope,
    });
    logInfo(
      `player "${player.name}" set world view to ${request.scope} ` +
        `(${snapshot.chunks.length} chunks sent)`,
    );
    return;
  }

  if (request.type === 'worldPluginList') {
    client.send(
      'worldPluginListing',
      admin.plugins(client.sessionId, request.key, request.id),
    );
    return;
  }

  if (request.type === 'worldPluginReload') {
    return admin
      .reloadPlugin(client.sessionId, request)
      .then((reloaded) => {
        client.send('worldAdminResult', reloaded);
        if (!reloaded.ok) return;
        client.send('worldPluginListing', admin.pluginListing(request.id));
        client.send('worldListing', admin.listing());
      });
  }

  const result = admin.handle(client.sessionId, request);
  client.send('worldAdminResult', result);
  if (
    result.ok &&
    (request.type === 'worldPluginSet' || request.type === 'worldPluginConfigure')
  ) {
    client.send('worldPluginListing', admin.pluginListing(request.id));
  }
  if (result.ok && request.type !== 'worldPluginAct') {
    client.send('worldListing', admin.listing());
  }
}
