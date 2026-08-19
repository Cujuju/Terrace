// chronicle — the client half. Two responsibilities, in the two things the
// ctx grants it: onMessage keeps the replicated scroll current (a `log`
// replace on join, `append` deltas after), and registerHudPanel mounts the
// panel + reader. No scene layer, no canvas claims — history has no meshes.

import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  CHRONICLE_APPEND_MESSAGE,
  CHRONICLE_LOG_MESSAGE,
  CHRONICLE_PLUGIN_NAME,
  parseEntries,
} from '../protocol.ts';
import { ChroniclePanel } from './ChroniclePanel.tsx';
import { appendEntries, replaceEntries } from './state.ts';

export const clientPlugin: TerraceClientPlugin = {
  name: CHRONICLE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(CHRONICLE_LOG_MESSAGE, (payload) => {
      const parsed = parseEntries(payload);
      if (parsed !== null) replaceEntries(parsed);
    });
    ctx.onMessage(CHRONICLE_APPEND_MESSAGE, (payload) => {
      const parsed = parseEntries(payload);
      if (parsed !== null) appendEntries(parsed);
    });

    ctx.registerHudPanel(ChroniclePanel);
  },
};
