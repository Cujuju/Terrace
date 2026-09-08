import type { PluginHost } from '../plugins/host.ts';
import { PLUGIN_MESSAGE_SEPARATOR } from '../plugins/world-api.ts';
import type { Player } from '../player.ts';

export type CurrentHost = () => PluginHost | null;

export function isPluginMessageType(type: string | number): type is string {
  return typeof type === 'string' && type.includes(PLUGIN_MESSAGE_SEPARATOR);
}

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
