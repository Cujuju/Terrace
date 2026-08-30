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

/**
 * DRAW BUDGET: NOTHING. This plugin is a HUD gauge and a local-intent gate; it
 * never touches `ctx.layer` (part B of
 * docs/plans/frame-budget-growth-and-draw-calls.md). Zero is a real budget —
 * the sampler breaches on `objects >= budget`, so the first mesh added here
 * would be reported.
 */
const MANA_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: MANA_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: MANA_DRAW_OBJECTS,

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
    // Bottom right (owner move, 2026-08-25 — it began top-centre, then the
    // bottom centre, 2026-08-14): the gauge is a glanceable status instrument
    // (design of the panel itself is in ManaGauge.tsx) and the moment it
    // matters is the moment the brush stops responding. The toolbar now owns
    // the bottom-centre cell alone; the gauge sits beside the icon-button
    // column, where an instrument belongs among the chrome.
    ctx.registerHudPanel(ManaGauge, { placement: 'bottom-right' });

    // The client half of the interceptor chain: unaffordable sculpts stop
    // here, before they are sent or predicted (see gateLocalSculpt). The INTENT
    // is passed through — its radius and profile are what it costs.
    ctx.onLocalIntent((intent) => gateLocalSculpt(intent));
  },
};
