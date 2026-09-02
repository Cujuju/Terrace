// The world header: which world this is, how hard it is rated, and what time
// it is there — and, when a plugin has claimed it, the banner is that plugin's
// entry point.
//
// LAYOUT (owner pick, 2026-09-01): the name on the title row with the
// difficulty as a small superscript after it, and beneath it the almanac clock
// (AlmanacClock.tsx) — the sun or moon on the day's arc, with the weekday, the
// day number and the time laid out on the strip. The clock's painting fills
// the whole banner (`world-header--almanac`, hud.css): the title row and the
// SVG share one grid cell, the title row sets the card's width so the name
// always renders in full, and the SVG stretches to it and floats the title
// over its sky. Without a clock the banner is the plain chrome card it always
// was. Before this the rating row
// read `Difficulty 50 – Friday · Day 534 · 11:13 PM` as one line of text.
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
import { worldClock } from '../plugins/hudPanels.ts';
import { worldHeaderAction } from '../plugins/hudPanels.ts';
import { AlmanacClock } from './AlmanacClock.tsx';

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
const CLOCK_TITLE =
  'The time in this world — the sun or moon shows where in the day you are, and the tag reads the clock.';

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
        classList={{ 'world-header--action': claimed(), 'world-header--almanac': worldClock() !== null }}
        aria-label={worldHeaderAction()?.label}
        title={worldHeaderAction()?.label}
        onClick={() => worldHeaderAction()?.onClick()}
      >
        {/* Over the painting the row wears the HUD's frost (hud.css .hud-frost),
         * the same glass as the clock's time tag; the plain card is already
         * frosted as a whole. */}
        <span class="world-header__title-row" classList={{ 'hud-frost': worldClock() !== null }}>
          <Show when={worldIdentity().name}>
            {(name) => (
              <span class="world-header__name" title={NAME_TITLE}>
                {name()}
                {/* The difficulty rides the name as a superscript (owner
                 * move, 2026-09-01) so the clock below can have the whole
                 * second row. Inside the name's span so it ellipsises with
                 * the name rather than being orphaned by a long one. */}
                <Show when={worldIdentity().difficulty !== null}>
                  <sup class="world-header__difficulty" title={DIFFICULTY_TITLE}>
                    {worldIdentity().difficulty}
                  </sup>
                </Show>
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
        {/* A world with a rating but no name still states the rating — there
         * is no name to hang it on, so it gets the row to itself. */}
        <Show when={worldIdentity().name === null && worldIdentity().difficulty !== null}>
          <span class="world-header__rating" title={DIFFICULTY_TITLE}>
            Difficulty {worldIdentity().difficulty}
          </span>
        </Show>
        {/* No clock signal means no clock: a server without the day/night
         * plugin has no world time, and the header says nothing it does not
         * know. */}
        <Show when={worldClock()}>
          {(reading) => (
            <span class="world-header__clock" title={CLOCK_TITLE}>
              <AlmanacClock reading={reading()} />
            </span>
          )}
        </Show>
      </Dynamic>
    </Show>
  );
}
