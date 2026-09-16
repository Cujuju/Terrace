import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  MANA_BALANCE_MESSAGE,
  MANA_DENIED_MESSAGE,
  MANA_PLUGIN_NAME,
  parseManaBalancePayload,
} from '../protocol.ts';
import { ManaGauge } from './ManaGauge.tsx';
import {
  applyBalancePush,
  gateLocalSculpt,
  handleManaDenied,
  setLocalTerritory,
} from './state.ts';

const MANA_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: MANA_PLUGIN_NAME,

  drawBudget: MANA_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    // The HUD quote prices the frontier under the aim, and has no intent to
    // read the reveal mask from; the gate still gets it per intent.
    setLocalTerritory(ctx);

    ctx.onMessage(MANA_BALANCE_MESSAGE, (payload) => {
      const pool = parseManaBalancePayload(payload);
      if (pool !== null) applyBalancePush(pool);
    });
    ctx.onMessage(MANA_DENIED_MESSAGE, (payload) => {
      // Brush-refused pulse + denied cost for the hint; the gauge flash reads
      // deniedCount and the cost hint reads lastDeniedCost (see state.ts).
      handleManaDenied(payload);
    });
    ctx.registerHudPanel(ManaGauge, { placement: 'bottom-right' });

    ctx.onLocalIntent((intent) => gateLocalSculpt(intent, ctx));
  },
};
