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
import { buildIdentity } from '../build-identity.ts';
import { SERVER_VERSION } from '../version.ts';

// STILL SYNCHRONOUS, AND STILL ON THE TICK THREAD (issue #272, half fixed).
// The payload got much cheaper — chunk heights are little-endian Int16 bytes
// rather than a boxed number[] (shared/src/chunks.ts, extractChunkPayload),
// which measured build + msgpackr encode at 2048² down from 2.6 -> 1.0 ms at
// the day-one 400 chunks, 21.8 -> 10.1 ms quarter-revealed, and 80.3 -> 29.9
// ms at the fully-revealed 16 384-chunk ceiling. What is NOT fixed is that the
// whole thing is still built and sent in one turn, once per joining player,
// and the three loop paths (rollback.ts, world-manager.ts world switch and
// plugin rebind) pay it N times in a row. Streaming the remainder across ticks
// under a chunks-per-tick budget is the other half of the fix and is
// deliberately NOT done here: it changes the client's join sequence, and the
// remaining cost is a rare event on an already-2.7x-cheaper payload.

/**
 * Builds the snapshot message for one token.
 *
 * ANTI-CHEAT: the chunks are the ones unlocked FOR THIS TOKEN (issue #17
 * decision 2), never the union of everyone's territory — locked terrain is
 * never on the wire (design doc). Keeping that rule inside this function is
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
    // Build identity is what a client keys its one-shot page reload on, and it
    // is deliberately NOT serverVersion — see JoinSnapshotMessage.buildIdentity
    // and server/src/build-identity.ts for why that stamp cannot do this job.
    buildIdentity: buildIdentity(),
    // The ENABLED subset, not everything installed: this is what the client
    // host mounts against, and a client half whose server half is not running
    // would sit there sending messages nothing answers.
    livePlugins: host.pluginNames,
    chunks: world.chunkPayloadsForToken(token),
  };
}
