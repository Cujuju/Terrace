import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  MANA_BALANCE_MESSAGE,
  MANA_DENIED_MESSAGE,
  MANA_PLUGIN_NAME,
  parseManaBalancePayload,
  parseManaDeniedPayload,
} from '../protocol.ts';
import { ManaGauge } from './ManaGauge.tsx';
import { applyBalancePush, applyDenial, gateLocalSculpt, recordDenial } from './state.ts';

const MANA_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: MANA_PLUGIN_NAME,

  drawBudget: MANA_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(MANA_BALANCE_MESSAGE, (payload) => {
      const pool = parseManaBalancePayload(payload);
      if (pool !== null) applyBalancePush(pool);
    });
    ctx.onMessage(MANA_DENIED_MESSAGE, (payload) => {
      const denied = parseManaDeniedPayload(payload);
      if (denied === null) return;
      applyDenial(denied);
      recordDenial();
    });
    ctx.registerHudPanel(ManaGauge, { placement: 'bottom-right' });

    ctx.onLocalIntent((intent) => gateLocalSculpt(intent, ctx));
  },
};
