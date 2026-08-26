// The join snapshot, built in ONE place.
//
// Two different events hand a client a whole world: joining one, and having
// the one it is looking at rolled back underneath it (world/rollback.ts). Both
// send the same message, because to a client they are the same event — "the
// terrain you have is not the terrain there is; here is all of it". The
// client's `onSnapshot` was already written for the rejoin case and resets its
// mirror, meshes, fog, water and rivers wholesale (client/src/world.ts), so
// nothing on that side needed a second path either.
//
// It lives in its own module rather than on TerraceRoom because the rollback
// path must not import Colyseus: the room is the transport adapter, and a
// rollback is a world operation that happens to need to tell people about it.

import type { JoinSnapshotMessage } from '@terrace/shared';
import type { PluginHost } from '../plugins/host.ts';
import type { World } from '../world/world.ts';
import { SERVER_VERSION } from '../version.ts';

/**
 * Builds the snapshot message for one token.
 *
 * ANTI-CHEAT: the chunks are the ones unlocked FOR THIS TOKEN (issue #17
 * decision 2), never the union of everyone's territory — locked terrain is
 * never on the wire (design §3.4). Keeping that rule inside this function is
 * the reason it exists: a second hand-rolled snapshot builder is exactly how a
 * server starts leaking terrain, and the rollback path would have been the
 * second one.
 *
 * The HOST is taken rather than a name list for the same reason: the live
 * plugin set is read off the thing that actually runs them, so no caller can
 * announce a set the world is not running.
 */
export function buildJoinSnapshot(
  world: World,
  host: PluginHost,
  token: string,
): JoinSnapshotMessage {
  return {
    type: 'snapshot',
    worldSize: world.size,
    // World identity (name, difficulty) and build identity (serverVersion) are
    // constant for the life of the process, so the snapshot is the only
    // message that ever needs to carry them — see the protocol's doc comments.
    worldName: world.name,
    difficulty: world.difficulty,
    serverVersion: SERVER_VERSION,
    // The ENABLED subset, not everything installed: this is what the client
    // host mounts against, and a client half whose server half is not running
    // would sit there sending messages nothing answers.
    livePlugins: host.pluginNames,
    chunks: world.chunkPayloadsForToken(token),
  };
}
