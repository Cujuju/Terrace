// chronicle — the client half. Two responsibilities, in the things the ctx
// grants it: onMessage keeps the replicated scroll current (a `log` replace
// on join, `append` deltas after); the world banner is claimed as the
// chronicle's entry point (owner move, 2026-08-19 — the world's name IS its
// history's title) and a bare top-center host mounts the reader overlay. No
// scene layer, no canvas claims — history has no meshes.

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

export const clientPlugin: TerraceClientPlugin = {
  name: CHRONICLE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    // The offset is applied FIRST in both handlers, so the entries it explains
    // are never rendered against a stale one. A payload that omits it (an
    // older server) leaves whatever offset is already held — see
    // parseGenesisDay on why that is not treated as an error.
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
    // The reader overlay still needs a mounted component; see the host's own
    // comment for why it lives top-center.
    ctx.registerHudPanel(ChronicleReaderHost, { placement: 'top-center' });
  },
};
