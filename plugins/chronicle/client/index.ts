import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  CHRONICLE_APPEND_MESSAGE,
  CHRONICLE_LOG_MESSAGE,
  CHRONICLE_PLUGIN_NAME,
  parseEntries,
  parseGenesisDay,
} from '../protocol.ts';
import { BookIcon, ChronicleReaderHost } from './ChroniclePanel.tsx';
import { appendEntries, replaceEntries, setGenesisDay, setReaderOpen } from './state.ts';

const CHRONICLE_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: CHRONICLE_PLUGIN_NAME,

  drawBudget: CHRONICLE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(CHRONICLE_LOG_MESSAGE, (payload) => {
      const offset = parseGenesisDay(payload);
      if (offset !== null) setGenesisDay(offset);
      const parsed = parseEntries(payload);
      if (parsed !== null) replaceEntries(parsed);
    });
    ctx.onMessage(CHRONICLE_APPEND_MESSAGE, (payload) => {
      const offset = parseGenesisDay(payload);
      if (offset !== null) setGenesisDay(offset);
      const parsed = parseEntries(payload);
      if (parsed !== null) appendEntries(parsed);
    });

    ctx.registerWorldHeaderAction({
      icon: BookIcon,
      label: 'Read the chronicle',
      onClick: () => setReaderOpen(true),
    });
    ctx.registerHudPanel(ChronicleReaderHost, { placement: 'top-center' });
  },
};
