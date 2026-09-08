import type { ChunkPayload, JoinSnapshotMessage } from '@terrace/shared';
import { collectAllChunkPayloads } from '../world/mask-filter.ts';
import type { PluginHost } from '../plugins/host.ts';
import type { World } from '../world/world.ts';
import { buildIdentity } from '../build-identity.ts';
import { SERVER_VERSION } from '../version.ts';

export function buildJoinSnapshot(
  world: World,
  host: PluginHost,
  token: string,
): JoinSnapshotMessage {
  return snapshotOf(world, host, world.chunkPayloadsForToken(token));
}

export function buildShowAllSnapshot(world: World, host: PluginHost): JoinSnapshotMessage {
  return snapshotOf(world, host, collectAllChunkPayloads(world.map));
}

function snapshotOf(
  world: World,
  host: PluginHost,
  chunks: ChunkPayload[],
): JoinSnapshotMessage {
  return {
    type: 'snapshot',
    worldSize: world.size,
    worldName: world.name,
    difficulty: world.difficulty,
    serverVersion: SERVER_VERSION,
    buildIdentity: buildIdentity(),
    livePlugins: host.pluginNames,
    chunks,
  };
}
