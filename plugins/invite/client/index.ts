import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { INVITE_INFO_MESSAGE, INVITE_PLUGIN_NAME, parseInviteInfoPayload } from '../protocol.ts';
import { InvitePanel } from './InvitePanel.tsx';
import { setServerShareUrl } from './state.ts';

const INVITE_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: INVITE_PLUGIN_NAME,

  drawBudget: INVITE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(INVITE_INFO_MESSAGE, (payload) => {
      setServerShareUrl(parseInviteInfoPayload(payload).shareUrl);
    });
    ctx.registerHudPanel(InvitePanel, { placement: 'connection' });
  },
};
