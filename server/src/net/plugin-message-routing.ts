// Live routing for namespaced plugin messages (issue #197).
//
// WHY THIS IS NOT A LIST OF onMessage REGISTRATIONS. The room used to register
// one Colyseus handler per `<plugin>:<type>` from the boot-time plugin set, so
// the set of deliverable message types was SNAPSHOTTED when the room was
// created. A plugin reloaded with a new message type (Phase 4 of
// docs/plans/plugin-hot-unload.md) would never be heard, and one that dropped a
// type left a dead registration behind. The room now registers a single
// wildcard and calls in here per message, so the routing table is whatever the
// live host says it is at that instant.
//
// Kept out of terrace-room.ts because that file is the Colyseus adapter and
// holds no logic — this is the routing decision, and it is testable with no
// network (test/plugin-message-routing.test.ts).

import type { PluginHost } from '../plugins/host.ts';
import { PLUGIN_MESSAGE_SEPARATOR } from '../plugins/world-api.ts';
import type { Player } from '../player.ts';

/**
 * The host of the world loaded RIGHT NOW, or null when none is. A function,
 * not a value: a room outlives every world it routes for.
 */
export type CurrentHost = () => PluginHost | null;

/**
 * Whether a wire message type belongs to a plugin — i.e. is namespaced. No core
 * type carries the separator (see terrace-room.ts's SCULPT_MESSAGE_TYPE,
 * RESTORE_POINTS_MESSAGE_TYPE, ROLLBACK_MESSAGE_TYPE and
 * WORLD_ADMIN_MESSAGE_TYPES), which is exactly the guarantee the namespace was
 * introduced for: a plugin can never shadow a core message.
 *
 * The test is the SEPARATOR, not membership of any known-plugin list, because a
 * list is the thing this module exists to stop snapshotting.
 */
export function isPluginMessageType(type: string | number): type is string {
  return typeof type === 'string' && type.includes(PLUGIN_MESSAGE_SEPARATOR);
}

/**
 * Routes one namespaced client → server message to the plugin that claims it,
 * on the world loaded right now.
 *
 * An unclaimed type is DROPPED IN SILENCE, exactly as it was before: with no
 * world loaded there is no host to ask, and a namespaced type no enabled plugin
 * claims (a disabled plugin's, a stale client's) has never been an error.
 * Callers filter with `isPluginMessageType` first — a type that is not
 * namespaced belongs to Colyseus's unregistered-type treatment, not here.
 */
export function routePluginMessage(
  currentHost: CurrentHost,
  player: Player,
  type: string,
  payload: unknown,
): void {
  const handler = currentHost()?.handlerFor(type);
  if (handler === undefined) return;
  handler(player, payload);
}
