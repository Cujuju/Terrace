// The world header: which world this is, and how hard it is rated — and,
// when a plugin has claimed it, the banner is that plugin's entry point.
//
// CORE, NOT A PLUGIN. A world's name and its difficulty rating are identity —
// core already owns the difficulty dial (WorldApi.difficulty) and the name is
// minted by the server at genesis — so the element that states them ships with
// the client rather than with any one plugin. It renders above the top-centre
// plugin stack (the mana gauge and anything else placed there), which is why it
// is the first child of .hud-top-center in Hud.tsx rather than a registered
// panel: core is not a plugin and must not compete for a placement slot.
//
// THE BANNER AS A BUTTON (owner move, 2026-08-19): one plugin may claim the
// banner through the world-header action registry (plugins/hudPanels.ts) —
// core then renders the claimant's icon to the right of the name and the
// whole banner becomes a button firing the claimant's onClick. Core still
// imports no plugin: it renders whatever action was registered, and with no
// claimant the banner is the same inert title card it always was.
//
// SOLID REACTIVITY: worldIdentity() and worldHeaderAction() are called at each
// use site, never captured in a component-body const — the header must follow
// a rejoin that lands on a different world, and the action registers when the
// plugin host attaches, after first render.

import { Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { worldIdentity } from '../state/hudState.ts';
import { worldTimeText } from '../plugins/hudPanels.ts';
import { worldHeaderAction } from '../plugins/hudPanels.ts';

/**
 * Tooltip copy, held to the HUD's standard (see Hud.tsx): one sentence, plain
 * language, stating what the thing MEANS for the player.
 *
 * The difficulty sentence deliberately promises no specific mechanic. Core
 * attaches none — the rating is a neutral dial that each installed plugin
 * interprets for itself (design 2026-08-14) — so naming one here would be a lie
 * on any server whose plugin set reads it differently.
 *
 * When the banner is a button, its own title comes from the action's label;
 * the name and rating spans keep these titles, and the browser shows the
 * innermost one under the cursor — hovering the name still explains the name.
 */
const NAME_TITLE =
  'The world you are sculpting — it was named when the world was created and keeps that name forever.';
const DIFFICULTY_TITLE =
  'How harsh this world is rated, from 1 (forgiving) to 100 (punishing) — it is set by whoever hosts the world and never changes while you play.';

export function WorldHeader(): JSX.Element {
  // Nothing to show before the join snapshot arrives, and nothing to show on a
  // server too old to send either field. An empty header would be a box of
  // chrome around no information — so an action with no identity to hang on
  // also waits for the snapshot (its data arrives on join too).
  const claimed = (): boolean => worldHeaderAction() !== null;
  return (
    <Show when={worldIdentity().name !== null || worldIdentity().difficulty !== null}>
      <Dynamic
        component={claimed() ? 'button' : 'div'}
        // `type` only means something on the button variant; undefined leaves
        // the div's DOM untouched.
        type={claimed() ? 'button' : undefined}
        class="world-header"
        classList={{ 'world-header--action': claimed() }}
        aria-label={worldHeaderAction()?.label}
        title={worldHeaderAction()?.label}
        onClick={() => worldHeaderAction()?.onClick()}
      >
        <span class="world-header__title-row">
          <Show when={worldIdentity().name}>
            {(name) => (
              <span class="world-header__name" title={NAME_TITLE}>
                {name()}
              </span>
            )}
          </Show>
          <Show when={worldHeaderAction()}>
            {(action) => (
              <span class="world-header__icon" aria-hidden="true">
                <Dynamic component={action().icon} />
              </span>
            )}
          </Show>
        </span>
        <Show when={worldIdentity().difficulty !== null || worldTimeText() !== null}>
          <span class="world-header__rating" title={DIFFICULTY_TITLE}>
            <Show when={worldIdentity().difficulty !== null}>
              Difficulty {worldIdentity().difficulty}
            </Show>
            {/* The clock rides the rating row (owner ask): `Difficulty 50 –
             * 3:45 p.m.` — one line, so identity and difficulty stay together
             * even when a plugin supplies the time. No time signal means no
             * separator either: an empty dash would be chrome around nothing. */}
            <Show when={worldTimeText() !== null}>
              {' – '}
              <span class="world-header__time">{worldTimeText()}</span>
            </Show>
          </span>
        </Show>
      </Dynamic>
    </Show>
  );
}
