// invite — the server half: tells every joining player where friends should
// point their browsers.
//
// Discovery reality check (why this plugin exists): a web client cannot browse
// mDNS/DNS-SD, so "finding a LAN server" in practice means a human passing a
// URL to another human. The best the platform can do is make that URL visible
// and copyable inside the game itself. The HOSTING player is the one who needs
// it most — their own address bar says `localhost`, which is exactly the one
// spelling that is useless to share — so the shareable address has to come
// from server configuration:
//
//   SHARE_URL=http://amd.local:5173   (dev box: Windows answers mDNS for
//                                      <ComputerName>.local natively)
//   SHARE_URL=http://terrace.example:8080   (self-hosters: whatever they
//                                            published in docker-compose)
//
// The env var is read at onWorldCreate, not module load, so tests (and a
// supervisor that restarts the world) see the current environment.

import type {
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { INVITE_INFO_MESSAGE, INVITE_PLUGIN_NAME } from '../protocol.ts';

/** Environment variable naming the address players should share. */
export const SHARE_URL_ENV = 'SHARE_URL';

let api: WorldApi | null = null;
let shareUrl: string | null = null;

export const plugin: TerracePlugin = {
  name: INVITE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    api = world;
    const configured = process.env[SHARE_URL_ENV];
    // Whitespace-only or empty degrades to "not configured" rather than
    // broadcasting a blank string for every HUD to render.
    shareUrl =
      typeof configured === 'string' && configured.trim().length > 0
        ? configured.trim()
        : null;
  },

  onPlayerJoin(player: Player): void {
    // Sent per join rather than broadcast: the value never changes while the
    // world runs, so each client needs to hear it exactly once.
    api?.sendTo(player.id, INVITE_INFO_MESSAGE, { shareUrl });
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetInviteState(): void {
  api = null;
  shareUrl = null;
}
