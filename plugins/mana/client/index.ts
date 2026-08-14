// mana — the client half: renders the pool the server half already broadcasts.
// Message-and-HUD only; no scene layer.

// Type-only import of the client plugin contract, as every client half does.
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
import { gateLocalSculpt, recordDenial, setManaPool } from './state.ts';

export const clientPlugin: TerraceClientPlugin = {
  name: MANA_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    ctx.onMessage(MANA_BALANCE_MESSAGE, (payload) => {
      const pool = parseManaBalancePayload(payload);
      if (pool !== null) setManaPool(pool);
    });
    ctx.onMessage(MANA_DENIED_MESSAGE, (payload) => {
      const denied = parseManaDeniedPayload(payload);
      if (denied === null) return;
      // The denial carries the authoritative balance; keep the gauge honest
      // even if a balance push was lost. Capacity and rate are whatever we last
      // heard — a refusal says nothing about either.
      setManaPool((pool) =>
        pool === null ? null : { ...pool, balance: denied.balance },
      );
      recordDenial();
    });
    // Top centre, not the corner panel: the gauge is a glanceable status
    // instrument (design of the panel itself is in ManaGauge.tsx), and the
    // moment it matters is the moment the brush stops responding — when the
    // player's eyes are on the terrain, not on a list of controls.
    ctx.registerHudPanel(ManaGauge, { placement: 'top-center' });

    // The client half of the interceptor chain: unaffordable sculpts stop
    // here, before they are sent or predicted (see gateLocalSculpt). The INTENT
    // is passed through — its radius and profile are what it costs.
    ctx.onLocalIntent((intent) => gateLocalSculpt(intent));
  },
};
