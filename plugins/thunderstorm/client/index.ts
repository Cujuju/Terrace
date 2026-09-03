// thunderstorm — client half. Draws whatever the server's `thunderstorm:systems`
// broadcast says exists, and flashes where its `thunderstorm:strikes` events say
// a bolt landed.
//
// It holds no authority: it never spawns a system, never moves one of its own
// accord, never predicts, and never decides that a bolt happened. The wiring —
// subscribe, interpolate, pool one rig per living system, animate — is core's
// client kit (client/src/plugins/kit/discSystemsView.ts), which four plugins
// share; what is here is this plugin's rig, its budget, and everything about
// lightning.
//
// No HUD panel, deliberately: weather is a thing you look up at.

import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { deckShadeDisc } from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  STRIKE_NO_SYSTEM,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  parseStrikesPayload,
} from '../protocol.ts';
import { LightningGovernor } from './lightning.ts';
import {
  createThunderstormRigs,
  DRY_BOLT_DRAW_OBJECTS,
  LIGHT_BANK_DRAW_OBJECTS,
  THUNDERSTORM_DECK_DRAW_OBJECTS,
  THUNDERSTORM_RIG_DRAW_OBJECTS,
  THUNDERSTORM_SHADE_DARKNESS,
  type ThunderstormRig,
  type ThunderstormRigs,
} from './rig.ts';

/**
 * THE ONE THING THAT MAY START A FLASH ANYWHERE ON THIS CLIENT. Shared by every
 * storm rig, which is what makes the photosensitivity floor hold across
 * concurrent storms rather than only within one — see MIN_FLASH_INTERVAL_SECONDS.
 */
const governor = new LightningGovernor();

/**
 * The pool, held here as well as by the view because the strike path needs the
 * dry bolt and the attach path needs the light bank. Null between attach and
 * dispose, exactly like the view's own state.
 */
let rigs: ThunderstormRigs | null = null;
let unsubscribeStrikes: (() => void) | null = null;
let unpublishShade: (() => void) | null = null;

const view = createDiscSystemsView<ThunderstormRig>({
  systemsMessage: THUNDERSTORM_SYSTEMS_MESSAGE,
  containerName: `${THUNDERSTORM_PLUGIN_NAME}:systems`,
  createPool: (ctx) => {
    rigs = createThunderstormRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed, dt, reduced) => {
    rig.update(disc, elapsed, dt, reduced);
  },
  // The view orders the deck against the camera once per frame — see
  // DiscSystemsViewSpec.deck.
  deck: () => rigs?.deck ?? null,
  attachExtras: (ctx: ClientPluginCtx) => {
    const pool = rigs;
    if (pool === null) return;
    // Beside the systems, not inside them: a dry bolt is positioned in world
    // space and must not ride any system's transform.
    ctx.layer.add(pool.dryBolt.root);
    // The storm flash lights, all of them, dark, for the plugin's whole life —
    // so the scene's light count is fixed from here on (rig.ts, lightBank).
    ctx.layer.add(pool.lightBank);
    // Beside the systems as well: ONE instanced draw carries every storm's
    // cloud, so it belongs to the layer and not to any rig.
    ctx.layer.add(pool.deck.object);
  },
  frameExtras: (dt, reduced) => {
    // Advanced once per frame, BEFORE any rig asks it for permission, so every
    // storm this frame is measured against the same clock.
    governor.advance(dt);
    // The dry bolt is advanced every frame whatever the weather: it belongs to
    // no system, so nothing else would ever decay its flash.
    rigs?.dryBolt.update(dt, reduced);
  },
  disposeExtras: () => {
    governor.reset();
    rigs = null;
  },
});

/**
 * A bolt landed. Finds the rig drawing the system that threw it and tells it
 * where, in that rig's OWN space — the rig's root sits at the system's centre, so
 * a strike is an offset from there rather than a world position.
 *
 * THE SYSTEM'S SAMPLED POSITION, not its last broadcast one: the rig is drawn at
 * the interpolated position this frame, so measuring the offset against anything
 * else would put the bolt a fraction of a cell away from where the storm is.
 *
 * A bolt for a system this client does not know about — one whose broadcast has
 * not landed yet, or one already retired — is drawn by the loose bolt at the
 * strike's own world position, exactly like a dry strike. Dropping it would show
 * a player a forest catching under a clear sky with no bolt at all.
 */
function applyStrike(systemId: number, cellX: number, cellY: number): void {
  const rig = systemId === STRIKE_NO_SYSTEM ? undefined : view.rigFor(systemId);
  const disc = rig === undefined ? undefined : view.poseFor(systemId);

  if (rig === undefined || disc === undefined) {
    rigs?.dryBolt.strike(cellX * CELL_WORLD_SIZE, cellY * CELL_WORLD_SIZE, governor);
    return;
  }

  rig.strike((cellX - disc.x) * CELL_WORLD_SIZE, (cellY - disc.y) * CELL_WORLD_SIZE, governor);
}

/** The shade this plugin's clouds throw — see rain's copy for the reasoning. */
const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const disc of view.poses().values()) {
    if (disc.intensity <= 0) continue;
    shade.push(deckShadeDisc(disc, THUNDERSTORM_SHADE_DARKNESS));
  }
  return shade;
}

export const clientPlugin: TerraceClientPlugin = {
  name: THUNDERSTORM_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants in ./rig.ts.
   */
  drawBudget:
    MAX_ACTIVE_SYSTEMS * THUNDERSTORM_RIG_DRAW_OBJECTS +
    DRY_BOLT_DRAW_OBJECTS +
    LIGHT_BANK_DRAW_OBJECTS +
    THUNDERSTORM_DECK_DRAW_OBJECTS,

  /** One shade disc per living storm, so the budget IS the storm cap. */
  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    unpublishShade = ctx.publishGroundShade(shadeDiscs);

    unsubscribeStrikes = ctx.onMessage(THUNDERSTORM_STRIKES_MESSAGE, (payload) => {
      const strikes = parseStrikesPayload(payload);
      if (strikes === null) return;
      // REDUCED MOTION DROPS THE BOLT HERE, at the door, rather than inside the
      // rig: it is the one place that knows the strike is a visual event at all.
      // The server's fire burns either way — a player who asked for less motion
      // asked for less motion, not for a different world.
      if (view.isReduced()) return;
      for (const strike of strikes) applyStrike(strike.systemId, strike.x, strike.y);
    });
  },

  dispose(): void {
    unsubscribeStrikes?.();
    unsubscribeStrikes = null;
    unpublishShade?.();
    unpublishShade = null;
    view.dispose();
  },
};
