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

/**
 * DRAW BUDGET: NOTHING. The invite plugin renders one HUD panel and no scene
 * geometry at all. Zero is a real budget: the first mesh added to this layer
 * breaches it.
 */
const INVITE_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: INVITE_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: INVITE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(INVITE_INFO_MESSAGE, (payload) => {
      setServerShareUrl(parseInviteInfoPayload(payload).shareUrl);
    });
    ctx.registerHudPanel(InvitePanel, { placement: 'connection' });
  },
};
