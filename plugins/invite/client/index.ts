// invite — the client half: listens for the server's share URL and puts the
// invite line in the HUD. No scene layer use; this is the smallest possible
// real plugin, which also makes it the best template for a hello-world HUD
// plugin in the docs.

// Type-only import of the client plugin contract, as every client half does.
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { INVITE_INFO_MESSAGE, INVITE_PLUGIN_NAME, parseInviteInfoPayload } from '../protocol.ts';
import { InvitePanel } from './InvitePanel.tsx';
import { setServerShareUrl } from './state.ts';

export const clientPlugin: TerraceClientPlugin = {
  name: INVITE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(INVITE_INFO_MESSAGE, (payload) => {
      setServerShareUrl(parseInviteInfoPayload(payload).shareUrl);
    });
    ctx.registerHudPanel(InvitePanel);
  },
};
