import type {
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { INVITE_INFO_MESSAGE, INVITE_PLUGIN_NAME } from '../protocol.ts';

export const SHARE_URL_ENV = 'SHARE_URL';

let shareUrl: string | null = null;

export const plugin: TerracePlugin = {
  name: INVITE_PLUGIN_NAME,

  onWorldCreate(): void {
    const configured = process.env[SHARE_URL_ENV];
    shareUrl =
      typeof configured === 'string' && configured.trim().length > 0
        ? configured.trim()
        : null;
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.sendTo(player.id, INVITE_INFO_MESSAGE, { shareUrl });
  },
};

export function resetInviteState(): void {
  shareUrl = null;
}
