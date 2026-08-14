// The world header: which world this is, and how hard it is rated.
//
// CORE, NOT A PLUGIN. A world's name and its difficulty rating are identity —
// core already owns the difficulty dial (WorldApi.difficulty) and the name is
// minted by the server at genesis — so the element that states them ships with
// the client rather than with any one plugin. It renders above the top-centre
// plugin stack (the mana gauge and anything else placed there), which is why it
// is the first child of .hud-top-center in Hud.tsx rather than a registered
// panel: core is not a plugin and must not compete for a placement slot.
//
// SOLID REACTIVITY: worldIdentity() is called at each use site, never captured
// in a component-body const — the header must follow a rejoin that lands on a
// different world.

import { Show, type JSX } from 'solid-js';
import { worldIdentity } from '../state/hudState.ts';

/**
 * Tooltip copy, held to the HUD's standard (see Hud.tsx): one sentence, plain
 * language, stating what the thing MEANS for the player.
 *
 * The difficulty sentence deliberately promises no specific mechanic. Core
 * attaches none — the rating is a neutral dial that each installed plugin
 * interprets for itself (design 2026-08-14) — so naming one here would be a lie
 * on any server whose plugin set reads it differently.
 */
const NAME_TITLE =
  'The world you are sculpting — it was named when the world was created and keeps that name forever.';
const DIFFICULTY_TITLE =
  'How harsh this world is rated, from 1 (forgiving) to 100 (punishing) — it is set by whoever hosts the world and never changes while you play.';

export function WorldHeader(): JSX.Element {
  // Nothing to show before the join snapshot arrives, and nothing to show on a
  // server too old to send either field. An empty header would be a box of
  // chrome around no information.
  return (
    <Show when={worldIdentity().name !== null || worldIdentity().difficulty !== null}>
      <div class="world-header">
        <Show when={worldIdentity().name}>
          {(name) => (
            <span class="world-header__name" title={NAME_TITLE}>
              {name()}
            </span>
          )}
        </Show>
        <Show when={worldIdentity().difficulty !== null}>
          <span class="world-header__rating" title={DIFFICULTY_TITLE}>
            Difficulty {worldIdentity().difficulty}
          </span>
        </Show>
      </div>
    </Show>
  );
}
